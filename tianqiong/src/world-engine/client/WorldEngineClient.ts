/* ============================================================
   WorldEngineClient —— 天穹 → 外部 World Engine 的唯一通道
   ------------------------------------------------------------
   方案 Phase 1 交付物（§八）：Tianqiong 的所有世界读写必须收口在
   这里，游戏业务代码禁止直接 fetch/WS 世界端点（AI 端点另有
   gateway 通道，Phase 8 迁移）。

   能力（与方案 §Phase1 一一对应）：
     connect()          拉世界概要 + 状态快照，开 WS 实时流
     getWorld()         GET  /v1/worlds/{id}
     getState()         GET  /v1/worlds/{id}/state
     getEntity(id)      GET  /v1/worlds/{id}/entities/{id}
     getEvents()        GET  /v1/worlds/{id}/events?n=…
     sendCommand(cmd)   POST /v1/worlds/{id}/commands（自动补幂等键）
     sendIntent(intent) 意图 → 命令映射后走 sendCommand
     subscribeEvents()  WS 事件流（幂等消费 + 断线补齐）
     onStatus()         连接状态机（idle/connecting/online/reconnecting/offline/closed）

   断线语义（方案 §22）：断开后**绝不回落本地引擎**——状态机停在
   reconnecting/offline，写操作直接抛 OfflineError 由上层进入
   重连 UI；恢复时用「REST 事件史 + WS ?replay=N 双窗口 + eventId
   幂等去重」补齐缺口，不丢事实、不重放副作用。

   零业务逻辑：本文件不知道「米露」是谁，也不知道地图长什么样——
   它只搬运协议。
   ============================================================ */
import type {
  CommandResult,
  EntitySummary,
  GameIntent,
  WireCommand,
  WireEvent,
  WireFrame,
  WorldInfo,
  WorldStateSnapshot,
} from './types';

/* ---------------- 连接状态机 ---------------- */

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline' | 'closed';

/** 断线期的写操作拒绝（方案 §22：停止提交世界写操作，绝不偷偷切本地） */
export class WorldEngineOfflineError extends Error {
  readonly status: ConnectionStatus;
  constructor(status: ConnectionStatus) {
    super(`World Engine 不可用（status=${status}）；已拒绝世界写操作——客户端不回落本地引擎`);
    this.name = 'WorldEngineOfflineError';
    this.status = status;
  }
}

/** 非 2xx 响应（保留引擎的错误码，如 409 world_paused） */
export class WorldEngineHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    const reason =
      body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : '';
    super(`World Engine HTTP ${status}${reason ? `：${reason}` : ''}`);
    this.name = 'WorldEngineHttpError';
    this.status = status;
    this.body = body;
  }
}

/* ---------------- 可注入的最小 WS 接口（测试用假件也走它） ---------------- */

export interface MinimalWebSocket {
  close(code?: number): void;
  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close', cb: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: 'error', cb: (ev: unknown) => void): void;
  removeEventListener?(type: string, cb: unknown): void;
}

export type WebSocketFactory = (url: string) => MinimalWebSocket;

/* ---------------- 客户端选项 ---------------- */

export interface WorldEngineClientOptions {
  baseUrl: string;
  worldId: string;
  apiKey?: string;
  /** 注入 fetch（测试）；缺省全局 fetch（Node 18+ / 浏览器都有） */
  fetchImpl?: typeof fetch;
  /** 注入 WebSocket 工厂（测试）；缺省全局 WebSocket（Node 22+ / 浏览器都有） */
  wsFactory?: WebSocketFactory;
  /** 单次 fetch 超时；缺省 8s */
  fetchTimeoutMs?: number;
  /** 断线重连的退避起点/上限；缺省 500ms → 8s */
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** 断线补齐：rest=事件史接口 / replay=WS ?replay=N / both（缺省）/ off */
  backfill?: 'rest' | 'replay' | 'both' | 'off';
  /** 补齐窗口大小（REST ?n 与 WS ?replay 共用）；缺省 200 */
  backfillWindow?: number;
  /** 幂等去重环容量（eventId 集合上限）；缺省 4096 */
  seenCapacity?: number;
}

/* ---------------- 客户端 ---------------- */

export class WorldEngineClient {
  private readonly baseUrl: string;
  readonly worldId: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly wsFactory: WebSocketFactory;
  private readonly fetchTimeoutMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly backfillMode: NonNullable<WorldEngineClientOptions['backfill']>;
  private readonly backfillWindow: number;
  private readonly seenCapacity: number;

  private _status: ConnectionStatus = 'idle';
  private readonly statusCbs = new Set<(s: ConnectionStatus) => void>();
  private readonly eventCbs = new Set<(e: WireEvent) => void>();
  private readonly snapshotCbs = new Set<(s: WorldStateSnapshot) => void>();

  /** 幂等消费：见过的 eventId（有界 FIFO，防长会话膨胀） */
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];

  private ws: MinimalWebSocket | null = null;
  private wsWanted = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: WorldEngineClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.worldId = opts.worldId;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    /* WebSocket 是类：必须经 new 构造（直接以函数调用会 TypeError）。
       注入的 wsFactory 已是工厂函数；缺省把全局类包一层 new。 */
    const injected = opts.wsFactory;
    const globalCtor = globalThis.WebSocket as unknown as (new (url: string | URL) => unknown) | undefined;
    if (injected) {
      this.wsFactory = injected;
    } else if (typeof globalCtor === 'function') {
      this.wsFactory = (url: string) => new globalCtor(url) as MinimalWebSocket;
    } else {
      throw new Error('当前环境没有 WebSocket（请用 Node 22+ / 浏览器，或注入 wsFactory）');
    }
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 8_000;
    this.baseDelayMs = opts.reconnectBaseDelayMs ?? 500;
    this.maxDelayMs = opts.reconnectMaxDelayMs ?? 8_000;
    this.backfillMode = opts.backfill ?? 'both';
    this.backfillWindow = opts.backfillWindow ?? 200;
    this.seenCapacity = opts.seenCapacity ?? 4_096;
  }

  /* ---------------- 状态与订阅 ---------------- */

  get status(): ConnectionStatus {
    return this._status;
  }

  get canWrite(): boolean {
    return this._status === 'online';
  }

  onStatus(cb: (s: ConnectionStatus) => void): () => void {
    this.statusCbs.add(cb);
    cb(this._status);
    return () => this.statusCbs.delete(cb);
  }

  /** 实时事实流（已按 eventId 幂等去重；补齐的旧事实也会从这里流过） */
  onEvent(cb: (e: WireEvent) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  /** 每次拿到全量快照（connect 成功时）触发 */
  onSnapshot(cb: (s: WorldStateSnapshot) => void): () => void {
    this.snapshotCbs.add(cb);
    return () => this.snapshotCbs.delete(cb);
  }

  /* ---------------- 连接生命周期 ---------------- */

  /** 连接：世界概要 → 状态快照 → WS 实时流。世界不存在时抛 404。 */
  async connect(): Promise<{ info: WorldInfo; snapshot: WorldStateSnapshot }> {
    this.ensureLive();
    this.setStatus('connecting');
    const info = await this.getWorld();
    const snapshot = await this.getState();
    for (const cb of this.snapshotCbs) cb(snapshot);
    this.openStream(0);
    this.setStatus('online');
    this.reconnectAttempt = 0;
    return { info, snapshot };
  }

  /** 主动关闭：不再重连；写死 status=closed。 */
  close(): void {
    this.disposed = true;
    this.wsWanted = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000);
    this.ws = null;
    this.setStatus('closed');
  }

  /* ---------------- 读面 ---------------- */

  async getWorld(): Promise<WorldInfo> {
    return this.getJson<WorldInfo>(`/v1/worlds/${encodeURIComponent(this.worldId)}`);
  }

  async getState(): Promise<WorldStateSnapshot> {
    return this.getJson<WorldStateSnapshot>(`/v1/worlds/${encodeURIComponent(this.worldId)}/state`);
  }

  async getEntity(id: string): Promise<{ entity: EntitySummary; relations: unknown[]; raw: unknown }> {
    return this.getJson(`/v1/worlds/${encodeURIComponent(this.worldId)}/entities/${encodeURIComponent(id)}`);
  }

  async getEvents(n = 50): Promise<{ events: WireEvent[]; total?: number }> {
    return this.getJson(`/v1/worlds/${encodeURIComponent(this.worldId)}/events?n=${Math.min(Math.max(1, n), 500)}`);
  }

  /* ---------------- 写面 ---------------- */

  /** 提交命令。缺 commandId 时自动生成 UUID（幂等：重试安全）。 */
  async sendCommand(cmd: WireCommand): Promise<CommandResult> {
    if (!this.canWrite) throw new WorldEngineOfflineError(this._status);
    const body: WireCommand = cmd.commandId ? cmd : { ...cmd, commandId: newCommandId() };
    return this.postJson<CommandResult>(`/v1/worlds/${encodeURIComponent(this.worldId)}/commands`, body);
  }

  /** 提交玩家意图（方案 §4.2/§23：Intent → Command，由引擎规则裁定）。
   *  这里只做机械映射，不做任何本地裁定。 */
  async sendIntent(intent: GameIntent): Promise<CommandResult> {
    return this.sendCommand(intentToCommand(intent));
  }

  /* ---------------- 内部：HTTP ---------------- */

  private ensureLive(): void {
    if (this.disposed || this._status === 'closed') {
      throw new WorldEngineOfflineError(this._status);
    }
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    this.ensureLive();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.fetchTimeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.apiKey) headers['x-api-key'] = this.apiKey;
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
        signal: ctrl.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new WorldEngineHttpError(res.status, body);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    return (await this.request(path)) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    return (await this.request(path, { method: 'POST', body: JSON.stringify(body) })) as T;
  }

  /* ---------------- 内部：WS 事件流 + 断线补齐 ---------------- */

  private openStream(replay: number): void {
    this.wsWanted = true;
    const url = new URL(`${this.baseUrl}/v1/worlds/${encodeURIComponent(this.worldId)}/events/stream`);
    if (replay > 0) url.searchParams.set('replay', String(replay));
    if (this.apiKey) url.searchParams.set('key', this.apiKey);

    let ws: MinimalWebSocket;
    try {
      ws = this.wsFactory(url.toString());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      /* 重连成功：先落 REST 事件史补缺口，再把 WS replay/实时帧放行 */
      if (replay > 0 && (this.backfillMode === 'rest' || this.backfillMode === 'both')) {
        void this.backfillFromRest();
      }
      this.reconnectAttempt = 0;
      this.setStatus('online');
    });

    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      let frame: WireFrame;
      try {
        frame = JSON.parse(String(ev.data)) as WireFrame;
      } catch {
        return;
      }
      if (frame?.type !== 'event') return;
      if (frame.worldId && frame.worldId !== this.worldId) return;
      /* backfill=rest 时丢弃 WS 的 replay 段不可行（无法区分段位）——
         靠 eventId 去重消化重叠，见 ingest() */
      this.ingest(frame.event);
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.disposed || !this.wsWanted) return;
      this.setStatus('reconnecting');
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      /* error 后必有 close；这里不重复调度 */
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.wsWanted || this.reconnectTimer !== null) return;
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || !this.wsWanted) return;
      this.openStream(this.backfillWindow);
    }, delay);
  }

  /** REST 事件史补齐：按 eventId 幂等，乱序安全（按 id 内序重排）。 */
  private async backfillFromRest(): Promise<void> {
    try {
      const res = await this.getEvents(this.backfillWindow);
      const chronological = orderByEventId(res.events ?? []);
      for (const e of chronological) this.ingest(e);
    } catch {
      /* 补齐失败不致命：还有 WS replay 窗口；两边都失败则等下一轮重连 */
    }
  }

  /** 幂等入口：去重后分发给订阅者。补齐与实时共用这一条路。 */
  private ingest(e: WireEvent): void {
    if (!e || typeof e.id !== 'string') return;
    if (this.seenIds.has(e.id)) return;
    this.seenIds.add(e.id);
    this.seenOrder.push(e.id);
    while (this.seenOrder.length > this.seenCapacity) {
      const drop = this.seenOrder.shift();
      if (drop !== undefined) this.seenIds.delete(drop);
    }
    for (const cb of this.eventCbs) cb(e);
  }

  private setStatus(s: ConnectionStatus): void {
    if (this._status === s) return;
    this._status = s;
    for (const cb of this.statusCbs) cb(s);
  }
}

/* ---------------- 意图 → 命令映射（方案 §4.2） ----------------
   天穹说「我想做什么」，引擎决定「世界发生了什么」。
   映射是纯机械的；wait 的 1440 刻上限由引擎钳制并发
   time_advance_clamped 事实，客户端不预判结果。 */

export function intentToCommand(intent: GameIntent): WireCommand {
  switch (intent.type) {
    case 'travel':
      return { type: 'move', targetId: intent.target };
    case 'wait':
      return { type: 'advance_time', amount: Math.max(1, Math.floor(intent.ticks)) };
    case 'talk':
      return { type: 'talk', targetId: intent.target, text: intent.text };
    case 'attack':
      return { type: 'attack', targetId: intent.target, amount: intent.amount };
    case 'setAttitude':
      return { type: 'set_attitude', targetId: intent.target, amount: intent.delta };
    case 'changeWeather':
      return { type: 'change_weather', text: intent.weather };
    case 'raw':
      return intent.command;
  }
}

/* ---------------- 工具 ---------------- */

export function newCommandId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 事件 id 形如 evt_<day>_<seq>（引擎 EventSchema）：提取 (day, seq) 用于时序重排 */
export function eventOrderKey(id: string): [number, number] {
  const m = /^evt_(\d+)_(\d+)$/.exec(id);
  if (!m) return [Number.MAX_SAFE_INTEGER, 0];
  return [Number(m[1]), Number(m[2])];
}

export function orderByEventId(events: WireEvent[]): WireEvent[] {
  return [...events].sort((a, b) => {
    const [da, sa] = eventOrderKey(a.id);
    const [db, sb] = eventOrderKey(b.id);
    return da !== db ? da - db : sa - sb;
  });
}

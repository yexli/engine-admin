/* ============================================================
   GameSessionClient —— 游戏会话通道（Phase 3 终局形态的客户端面）
   ------------------------------------------------------------
   服务端（server/game-host.ts，npm run host:game）原样运行天穹
   裁定栈；客户端只发 GameCommand，收到「本次命令的事实流 + 状态
   快照 + CB/curShop 瞬态槽」整体回灌。协议形状：

     GET  /game/health  → { ok, t, loc, ... }
     GET  /game/state   → { snapshot, cb, curShop, t, loc }
     POST /game/command → { ok, events, snapshot, cb, curShop, t, loc }
     POST /game/new     → { ok, events, snapshot, cb, curShop, t, loc }

   分层纪律：这里只搬运协议——events 是**不透明**的 `{type,...}`
   信封（语义翻译在 plugins/extSession），snapshot 是 plain JSON
   记录。本文件不 import 游戏层（arch-external-client 守卫）。
   ============================================================ */
import { WorldEngineHttpError } from './WorldEngineClient';

/** 会话事实信封（不透明；type 是路由键，_seq 是宿主侧单调序号——迟到事实
 *  去重与断点续传的凭据，其余字段语义在客户端侧翻译） */
export interface SessionEvent {
  type: string;
  _seq?: number;
  [k: string]: unknown;
}

export interface SessionStatePayload {
  snapshot: Record<string, unknown> | null;
  cb: unknown;
  curShop: unknown;
  t: number | null;
  loc: string | null;
}

export interface SessionCommandResult extends SessionStatePayload {
  ok: boolean;
  events: SessionEvent[];
}

export interface GameSessionOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** 单次请求超时；缺省 15s（服务端裁定是同步的，长命令如上学一学期也是毫秒级） */
  timeoutMs?: number;
}

export class GameSessionClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: GameSessionOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async health(): Promise<{
    ok: boolean;
    boot?: number;
    t: number | null;
    loc: string | null;
    lastSeq?: number;
    ai?: string;
    gateway?: string;
  }> {
    return this.get('/game/health') as Promise<{
      ok: boolean;
      boot?: number;
      t: number | null;
      loc: string | null;
      lastSeq?: number;
      ai?: string;
      gateway?: string;
    }>;
  }

  async state(): Promise<SessionStatePayload> {
    return this.get('/game/state') as Promise<SessionStatePayload>;
  }

  async newGame(spec: { name?: string; race?: string; cls?: string; gender?: string } = {}): Promise<SessionCommandResult> {
    return this.post('/game/new', spec) as Promise<SessionCommandResult>;
  }

  async command<T extends { type: string }>(cmd: T): Promise<SessionCommandResult> {
    return this.post('/game/command', cmd) as Promise<SessionCommandResult>;
  }

  /** 注入 AI 配置（客户端转发本地已配的 LlmConfig；服务端重建 AiPort +
   *  向量通道；都没有则 ruleSim 兜底）。返回服务端实际生效形态。 */
  async setAiConfig(llm: unknown): Promise<{ ok: boolean; ai: string; llmUsable: boolean; embeddingUsable: boolean }> {
    return this.post('/game/ai-config', { llm }) as Promise<{
      ok: boolean;
      ai: string;
      llmUsable: boolean;
      embeddingUsable: boolean;
    }>;
  }

  /** 事件轮询兜底（SSE 不可用环境）：取 after 之后的全部事实 */
  async eventsSince(after: number): Promise<{ events: SessionEvent[]; last: number }> {
    return this.get(`/game/events?after=${Math.max(0, Math.floor(after))}`) as Promise<{
      events: SessionEvent[];
      last: number;
    }>;
  }

  /** 订阅 SSE 事实流（迟到事实的实时通道）。返回取消订阅。
   *  用 fetch 流式读实现（浏览器/Node 通用，不依赖 EventSource 全局）。 */
  streamEvents(handlers: {
    after?: number;
    onEvent: (e: SessionEvent) => void;
    onOpen?: () => void;
    onError?: (err: unknown) => void;
  }): () => void {
    const ctrl = new AbortController();
    void readSse(
      `${this.baseUrl}/game/events/stream?after=${handlers.after ?? 0}`,
      { signal: ctrl.signal },
      (payload) => handlers.onEvent(payload as SessionEvent),
      { onOpen: handlers.onOpen, onError: handlers.onError },
    );
    return () => ctrl.abort();
  }


  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },
        signal: ctrl.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new WorldEngineHttpError(res.status, body);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  private get(path: string): Promise<unknown> {
    return this.request(path);
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: 'POST', body: JSON.stringify(body) });
  }
}

/**
 * SSE 读取器（协议层）：fetch 流式读 + 帧切分，浏览器/Node 通用。
 * 只取 `data:` 行；`:` 心跳注释忽略；流结束即返回，abort 静默返回。
 */
export async function readSse(
  url: string,
  opts: { signal?: AbortSignal },
  onData: (payload: unknown) => void,
  life: { onOpen?: () => void; onError?: (err: unknown) => void } = {},
): Promise<void> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'text/event-stream' },
      signal: opts.signal,
    });
    if (!res.ok || !res.body) throw new WorldEngineHttpError(res.status, await res.text().catch(() => null));
    life.onOpen?.();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        /* 干净断流也算「流不可用」：监督器必须重开（审查 P0-1） */
        if (!opts.signal?.aborted) life.onError?.(new Error('sse stream closed'));
        break;
      }
      buf += decoder.decode(value, { stream: true });
      /* SSE 帧：以空行分隔 */
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            onData(JSON.parse(payload) as unknown);
          } catch {
            /* 坏帧忽略 */
          }
        }
      }
    }
  } catch (err) {
    if (!opts.signal?.aborted) life.onError?.(err);
  }
}

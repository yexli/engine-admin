/* ============================================================
   World HTTP 协议适配器（V0.4→V1.0.1 · 方案 §64）
   ------------------------------------------------------------
   把 §64 的 HTTP 路由映射到 World API——**World API 形状不变，
   这里只加传输层**（§19）。纯路由协议：输入已解析的
   { method, path, query, body }，输出 { status, body }——不碰
   socket、不碰 JSON 字符串，可无网络全量测试。

   路由（方案 §64 + M1 只读数据面）：
     POST /v1/worlds                  创建世界（可带 name/description 元数据）
     GET  /v1/worlds                  世界清单
     GET  /v1/worlds/{id}             世界信息（含元数据）
     GET  /v1/worlds/{id}/state       完整世界状态
     POST /v1/worlds/{id}/commands    提交命令（body = WorldCommand）
     GET  /v1/worlds/{id}/commands    最近命令历史（环形缓冲，?n=50）
     GET  /v1/worlds/{id}/events?n=20 最近的世界事实
     GET  /v1/worlds/{id}/scheduler   调度观测（stats / scheduled / deferred / deadLetters）
     GET  /v1/worlds/{id}/entities    实体独立端点（分页 + 筛选）
     GET  /v1/worlds/{id}/entities/{eid}  单实体详情（含关系边）
     GET  /v1/worlds/{id}/locations   地点端点（分页 + 驻留统计）
     GET  /v1/worlds/{id}/relations   关系端点（状态关系表 + 实体关系边）
     POST /v1/worlds/{id}/time        推进时间（body = { ticks })

   两种模式（V0.9，DR-003 兑现）：
   · 单世界模式（缺省）：服务器只持有一个世界，重复创建 409；
   · 注册表模式（init.registry）：POST /v1/worlds 可多次（每世界
     独立作用域），{id} 为真实路由键。路由形状两种模式完全一致。

   鉴权（G2，1.1.0）：可选中间件（init.auth 声明式钥匙表，缺省关）——
   开启后全路由 401 闸门 + 写入类 worlds:write（403）+ 游戏方世界
   可见域隔离。缺省仍只绑 127.0.0.1（见 server.ts）。
   ============================================================ */
import { createWorld, type CreateWorldOptions, type WorldHandle, type WorldTimeView } from '../api/WorldAPI.ts';
import { WorldRegistryError, type WorldRegistry } from '../api/WorldRegistry.ts';
import type { CommandHistoryEntry } from '../runtime/WorldRuntime.ts';
import type { EngineWorldState, EntityDynamic, LocationRecord, RelationRecord } from '../types.ts';

/** 已解析的 HTTP 请求（传输层负责解析 URL / query / JSON body / headers） */
export interface HttpRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  /** 键为小写 header 名（传输层统一小写）；鉴权面只读 x-api-key / authorization */
  headers?: Record<string, string>;
  /** 已 JSON.parse 的请求体（GET 无 body；解析失败由传输层直接回 400） */
  body?: unknown;
}

/** 待序列化的 HTTP 响应 */
export interface HttpResponse {
  status: number;
  body: unknown;
}

/** 世界概要（GET /v1/worlds[/{id}] 的载荷；M1.5 起带注册表层元数据） */
export interface WorldInfo {
  worldId: string;
  location: string | null;
  entities: number;
  time: WorldTimeView | null;
  /** 元数据（经 definition.metadata 挂载；未设置时缺省） */
  name?: string;
  description?: string;
  /** ISO 8601 */
  createdAt?: string;
  updatedAt?: string;
  /** 服务面状态（G1 软暂停，1.0.3）：paused = HTTP 层拒绝 commands/time 推进；关闭态不出现于任何响应 */
  status?: 'running' | 'paused';
  /** 归属游戏方（G2）：metadata.ownerGame 通道；按游戏方隔离与聚合的依据 */
  ownerGame?: string;
}

/* ---------------- G2 鉴权（1.1.0 · 可选中间件，缺省关） ----------------
   复用平台 KeyStore 语义的**声明式**钥匙表：接入方（平台/宿主进程）
   持有钥匙事实，引擎只认传入的 keys 映射——引擎不存钥匙、不联网
   校验，保持零依赖。缺省不传 auth = 维持 1.0 行为（本机无鉴权）。 */

export const WORLD_SCOPES = ['worlds:read', 'worlds:write'] as const;

/** 一把钥匙的身份：gameId 决定世界可见域（缺省 = 管理钥匙，可见全部）；scopes 决定读写 */
export interface WorldAuthKey {
  /** 归属游戏方；缺省视为管理钥匙（跨游戏方可见，可指定任意 ownerGame） */
  gameId?: string;
  /** 缺省按钥匙类型分级：游戏方钥匙（带 gameId，第三方不可信）= ['worlds:read']
      只读；管理钥匙（无 gameId，平台自签）= 读写全量。显式声明 always wins */
  scopes?: string[];
  /** 人类可读名（仅诊断回显） */
  name?: string;
}

export interface WorldAuthInit {
  /** 钥匙 → 身份；请求经 x-api-key 头（或 Authorization: Bearer）匹配 */
  keys: Record<string, WorldAuthKey>;
}

/** 从请求头提取 API Key（x-api-key 优先，兼容 Bearer） */
export function apiKeyOf(req: HttpRequest): string | undefined {
  const h = req.headers ?? {};
  const x = h['x-api-key'];
  if (typeof x === 'string' && x.length > 0) return x;
  const auth = h['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const bearer = auth.slice(7).trim();
    if (bearer) return bearer;
  }
  return undefined;
}

export interface WorldHttpInit<W extends EngineWorldState = EngineWorldState> {
  /** 单世界模式：预建世界（给了它，POST /v1/worlds 返回 409） */
  world?: WorldHandle<W>;
  /** 未预建时，POST /v1/worlds 的创建参数（body 字段覆盖同名项；rules 不可跨 HTTP 传入） */
  createOptions?: CreateWorldOptions<W>;
  /** V0.9 注册表模式：多世界共存（每世界独立作用域）；给了它则单世界 world 被忽略 */
  registry?: WorldRegistry<W>;
  /** G2：API Key 鉴权（缺省关）。开启后全部路由需有效钥匙；写入类需 worlds:write */
  auth?: WorldAuthInit;
}

/* ---------------- 载荷净化（纵深防御，0.4.1 起） ----------------
   HTTP 是不可信输入面：命令与创建参数在此**白名单重建**后才进引擎——
   只放行引擎契约认识的字段，字符串限量，payload 只收一层基本类型。
   引擎没有 SQL（持久化走 SavePort 抽象）；净化的意义是
   「不可信对象不裸进运行时」：超长串、嵌套深结构、未知键在门口截下。 */

const MAX_STR = (n: number) => (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= n ? v : undefined;

/** 命令白名单重建；不合法（缺 type / 超长）返回 null → 400 */
function sanitizeCommand(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const type = MAX_STR(64)(b['type']);
  if (!type) return null;
  const cmd: Record<string, unknown> = { type };
  const commandId = MAX_STR(128)(b['commandId']);
  if (commandId !== undefined) cmd['commandId'] = commandId; // V2.4-02 幂等键透传
  const actorId = MAX_STR(128)(b['actorId']);
  const targetId = MAX_STR(128)(b['targetId']);
  const text = MAX_STR(2000)(b['text']);
  if (actorId !== undefined) cmd['actorId'] = actorId;
  if (targetId !== undefined) cmd['targetId'] = targetId;
  if (text !== undefined) cmd['text'] = text;
  if (typeof b['amount'] === 'number' && Number.isFinite(b['amount'])) cmd['amount'] = b['amount'];
  if (b['payload'] && typeof b['payload'] === 'object' && !Array.isArray(b['payload'])) {
    const raw = b['payload'] as Record<string, unknown>;
    const payload: Record<string, string | number | boolean> = {};
    let n = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (n >= 32) break; // 键数上限
      if (k.length > 64) continue;
      if (typeof v === 'string') {
        if (v.length > 2000) continue;
        payload[k] = v;
        n++;
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        payload[k] = v;
        n++;
      } else if (typeof v === 'boolean') {
        payload[k] = v;
        n++;
      }
      // 嵌套对象/数组不放行：HTTP 命令载荷契约是一层基本类型
    }
    cmd['payload'] = payload;
  }
  return cmd;
}

const strArray = (v: unknown, maxLen: number): string[] | undefined =>
  Array.isArray(v) && v.length > 0 && v.length <= 24 && v.every((s) => typeof s === 'string' && s.length <= maxLen)
    ? (v as string[])
    : undefined;

/** 创建参数白名单重建（labels / name / description 逐字段校验；未知键不透传） */
function sanitizeCreateOptions(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const b = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const worldId = MAX_STR(64)(b['worldId']);
  const playerName = MAX_STR(64)(b['playerName']);
  const startLoc = MAX_STR(64)(b['startLoc']);
  const weather = MAX_STR(32)(b['weather']);
  const name = MAX_STR(128)(b['name']);
  const description = MAX_STR(512)(b['description']);
  const ownerGame = MAX_STR(64)(b['ownerGame']);
  if (worldId) out['worldId'] = worldId;
  if (playerName) out['playerName'] = playerName;
  if (startLoc) out['startLoc'] = startLoc;
  if (weather) out['weather'] = weather;
  if (name || description) out['meta'] = { ...(name ? { name } : {}), ...(description ? { description } : {}) };
  if (ownerGame) out['ownerGame'] = ownerGame;
  /* locations（P2 additive）：HTTP 建世界可直接声明地点表（id/type/name 精简面） */
  if (Array.isArray(b['locations'])) {
    const locs: Record<string, unknown>[] = [];
    for (const raw of b['locations'].slice(0, 512)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const l = raw as Record<string, unknown>;
      const id = MAX_STR(64)(l['id']);
      if (!id) continue;
      const type = MAX_STR(32)(l['type']);
      const locName = MAX_STR(128)(l['name']);
      locs.push({ id, ...(type ? { type } : {}), ...(locName ? { name: locName } : {}) });
    }
    if (locs.length) out['locations'] = locs;
  }
  if (b['labels'] && typeof b['labels'] === 'object' && !Array.isArray(b['labels'])) {
    const l = b['labels'] as Record<string, unknown>;
    const labels: Record<string, unknown> = {};
    const months = strArray(l['months'], 16);
    const shichen = strArray(l['shichen'], 16);
    const periodOf = strArray(l['periodOf'], 16);
    if (months) labels['months'] = months;
    if (shichen) labels['shichen'] = shichen;
    if (periodOf) labels['periodOf'] = periodOf;
    if (typeof l['baseYear'] === 'number' && Number.isFinite(l['baseYear'])) labels['baseYear'] = l['baseYear'];
    if (typeof l['daysPerMonth'] === 'number' && l['daysPerMonth'] >= 1 && l['daysPerMonth'] <= 366) {
      labels['daysPerMonth'] = l['daysPerMonth'];
    }
    if (Object.keys(labels).length) out['labels'] = labels;
  }
  return out;
}

/* ---------------- 查询参数净化（M1 只读端点） ---------------- */

const clampInt = (v: string | undefined, dflt: number, lo: number, hi: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
};

const queryStr = (v: string | undefined, maxLen = 128): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= maxLen ? v : undefined;

/** 分页参数（page 从 1 起；pageSize 上限 200） */
function pageOf(query: Record<string, string> | undefined): { page: number; pageSize: number } {
  return { page: clampInt(query?.['page'], 1, 1, 100_000), pageSize: clampInt(query?.['pageSize'], 20, 1, 200) };
}

/** 实体列表行（服务端从状态派生；世界变大后前端不再全量拉 state，G3） */
export interface EntitySummary {
  id: string;
  type: string;
  att: number;
  met: boolean;
  location: string;
  gold?: number;
  bagCount: number;
  relCount: number;
  effectCount: number;
  memCount: number;
  attributes?: Record<string, unknown>;
}

/** 创建 HTTP 协议适配器。 */
export function createWorldHttp<W extends EngineWorldState = EngineWorldState>(
  init: WorldHttpInit<W> = {},
): { handle(req: HttpRequest): Promise<HttpResponse> | HttpResponse; readonly world: WorldHandle<W> | null } {
  let world: WorldHandle<W> | null = init.world ?? null;
  const registry = init.registry ?? null;
  /* ---------------- G1 软暂停（1.0.3 · 零 Core；裁定记录见 docs/G1-PAUSE-DESIGN-REVIEW.md） ----------------
     服务面运营标记：暂停中的世界拒绝 commands/time 推进（409 world_paused），读照常；
     进程内状态，不进存档——重启即解除（世界状态持久化属 SavePort 范畴）。 */
  const pausedWorlds = new Set<string>();

  /* ---------------- 元数据（M1.5 · G2：注册表/定义层挂载，零 Core） ---------------- */

  function metaOf(w: WorldHandle<W>): Record<string, unknown> {
    return (w.getState()?.metadata as Record<string, unknown> | undefined) ?? {};
  }

  function metaStr(m: Record<string, unknown>, key: string): string | undefined {
    const v = m[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  }

  function info(h: WorldHandle<W>): WorldInfo {
    const m = metaOf(h);
    return {
      worldId: h.worldId,
      location: h.query.get_location(),
      entities: h.query.get_entities().length,
      time: h.query.get_time(),
      status: pausedWorlds.has(h.worldId) ? 'paused' : 'running',
      ...(metaStr(m, 'name') ? { name: metaStr(m, 'name') } : {}),
      ...(metaStr(m, 'description') ? { description: metaStr(m, 'description') } : {}),
      ...(metaStr(m, 'ownerGame') ? { ownerGame: metaStr(m, 'ownerGame') } : {}),
      ...(metaStr(m, 'createdAt') ? { createdAt: metaStr(m, 'createdAt') } : {}),
      ...(metaStr(m, 'updatedAt') ? { updatedAt: metaStr(m, 'updatedAt') } : {}),
    };
  }

  /** 创建/活动时间戳写入 state.metadata（协议层挂载；随 SavePort 持久化） */
  function stampMeta(w: WorldHandle<W>, patch: Record<string, string>): void {
    const s = w.getState();
    if (!s) return;
    s.metadata = { ...(s.metadata as Record<string, unknown> | undefined), ...patch };
    w.container.sync();
  }

  /** 命令 / 推进成功后的活动时间戳（诚实语义：updatedAt = 最近一次成功的世界推进） */
  function touch(w: WorldHandle<W>, res: { ok: boolean }): void {
    if (res.ok) stampMeta(w, { updatedAt: new Date().toISOString() });
  }

  /* ---------------- M1.3 · G3：实体 / 地点 / 关系服务端派生 ---------------- */

  function entityLocation(s: EngineWorldState, dy: EntityDynamic): string {
    const attrLoc = dy.attributes?.['location'];
    return typeof attrLoc === 'string' ? attrLoc : (s.player?.loc ?? '—');
  }

  function summarize(s: EngineWorldState, id: string, dy: EntityDynamic): EntitySummary {
    return {
      id,
      type: dy.type ?? 'npc',
      att: dy.att,
      met: dy.met,
      location: entityLocation(s, dy),
      ...(dy.gold !== undefined ? { gold: dy.gold } : {}),
      bagCount: dy.bag?.length ?? 0,
      relCount: Object.keys(dy.rels ?? {}).length,
      effectCount: dy.effects?.length ?? 0,
      memCount: dy.mem?.length ?? 0,
      ...(dy.attributes && Object.keys(dy.attributes).length ? { attributes: dy.attributes } : {}),
    };
  }

  function listEntitiesResponse(w: WorldHandle<W>, query: Record<string, string> | undefined): HttpResponse {
    const s = w.getState();
    if (!s) return { status: 409, body: { error: 'world not started' } };
    const type = queryStr(query?.['type'], 64);
    const q = queryStr(query?.['q'])?.toLowerCase();
    const { page, pageSize } = pageOf(query);

    const all = Object.entries(s.npcs)
      .map(([id, dy]) => ({ id, dy, sum: summarize(s, id, dy) }))
      .filter(({ id, sum }) => (!type || sum.type === type) && (!q || id.toLowerCase().includes(q)))
      .sort((a, b) => a.id.localeCompare(b.id));

    return {
      status: 200,
      body: {
        total: all.length,
        page,
        pageSize,
        player: s.player ? { name: s.player.name, loc: s.player.loc, bagCount: s.player.bag?.length ?? 0 } : null,
        entities: all.slice((page - 1) * pageSize, page * pageSize).map(({ sum }) => sum),
      },
    };
  }

  function entityDetailResponse(w: WorldHandle<W>, eid: string): HttpResponse {
    const s = w.getState();
    const dy = s?.npcs[eid];
    if (!s || !dy) return { status: 404, body: { error: 'entity not found', entityId: eid } };
    const relations = [];
    for (const [other, edges] of Object.entries(dy.rels ?? {})) {
      /* rels 是宿主侧邻接面：声明形状为单边（RelEdge），宿主也可能给
         数组——两种都接受，声明的单边形状不得被静默丢弃 */
      for (const edge of Array.isArray(edges) ? edges : [edges]) {
        relations.push({ source: eid, target: other, type: edge.type, value: edge.val });
      }
    }
    return {
      status: 200,
      body: { entity: { ...summarize(s, eid, dy), id: eid, raw: dy }, relations },
    };
  }

  function listLocationsResponse(w: WorldHandle<W>, query: Record<string, string> | undefined): HttpResponse {
    const s = w.getState();
    if (!s) return { status: 409, body: { error: 'world not started' } };
    const q = queryStr(query?.['q'])?.toLowerCase();
    const { page, pageSize } = pageOf(query);

    /* 驻留统计（与既有前端派生同语义）：实体 attributes.location 优先，回退玩家位置 */
    const occupants = new Map<string, string[]>();
    const push = (loc: string | null | undefined, who: string) => {
      if (!loc) return;
      const arr = occupants.get(loc) ?? [];
      arr.push(who);
      occupants.set(loc, arr);
    };
    push(s.player?.loc, `player:${s.player?.name ?? 'player'}`);
    for (const [npcId, dy] of Object.entries(s.npcs)) {
      const loc = entityLocation(s, dy);
      push(loc === '—' ? undefined : loc, npcId);
    }

    const all = Object.entries(s.locations ?? {})
      .map(([id, rec]: [string, LocationRecord]) => ({ ...rec, id, occupants: occupants.get(id) ?? [], entityCount: occupants.get(id)?.length ?? 0 }))
      .filter((l) => !q || l.id.toLowerCase().includes(q))
      .sort((a, b) => a.id.localeCompare(b.id));

    const known = new Set(all.map((l) => l.id));
    return {
      status: 200,
      body: {
        total: all.length,
        page,
        pageSize,
        locations: all.slice((page - 1) * pageSize, page * pageSize),
        /* 出现在实体档案但不在地点表中的位置 id（数据完整性观察） */
        unknown: [...occupants.keys()].filter((k) => !known.has(k)).sort(),
      },
    };
  }

  function listRelationsResponse(w: WorldHandle<W>, query: Record<string, string> | undefined): HttpResponse {
    const s = w.getState();
    if (!s) return { status: 409, body: { error: 'world not started' } };
    const q = queryStr(query?.['q'])?.toLowerCase();
    const { page, pageSize } = pageOf(query);
    const match = (r: RelationRecord) =>
      !q || r.source.toLowerCase().includes(q) || r.target.toLowerCase().includes(q) || r.type.toLowerCase().includes(q);

    const stateAll = (s.relations ?? []).filter(match);
    const edgeAll: RelationRecord[] = [];
    for (const [owner, dy] of Object.entries(s.npcs)) {
      for (const [other, edges] of Object.entries(dy.rels ?? {})) {
        /* 同 entityDetail：单边与数组两种宿主形状都接受 */
        for (const edge of Array.isArray(edges) ? edges : [edges]) {
          const rec: RelationRecord = { source: owner, target: other, type: edge.type, value: edge.val };
          if (match(rec)) edgeAll.push(rec);
        }
      }
    }
    return {
      status: 200,
      body: {
        totals: { state: stateAll.length, edges: edgeAll.length },
        page,
        pageSize,
        stateRelations: stateAll.slice((page - 1) * pageSize, page * pageSize),
        edgeRelations: edgeAll.slice((page - 1) * pageSize, page * pageSize),
      },
    };
  }

  /* ---------------- M1.2 · G4：调度观测 ---------------- */

  function schedulerResponse(w: WorldHandle<W>, query: Record<string, string> | undefined): HttpResponse {
    const n = clampInt(query?.['n'], 50, 1, 500);
    const bus = w.bus;
    return {
      status: 200,
      body: {
        stats: bus.stats(),
        scheduled: bus.scheduledEvents().slice(0, n),
        deferred: bus.deferredEvents().slice(0, n),
        deadLetters: bus.deadLetters().slice(0, n),
      },
    };
  }

  function resolveWorld(id: string): WorldHandle<W> | null {
    if (registry) return registry.get(id);
    return world && world.worldId === id ? world : null;
  }

  async function handle(req: HttpRequest): Promise<HttpResponse> {
    const method = req.method.toUpperCase();
    const segments = req.path.replace(/\/+$/, '').split('/').filter(Boolean);

    /* ---------- G2 鉴权闸门（1.1.0）：auth 缺省关 = 1.0 行为不变；
       开启后全路由需有效钥匙（401），写入类还需 worlds:write（403）。
       游戏方钥匙（带 gameId）只见 ownerGame 匹配的世界——越权访问
       回 404 不泄露存在性。钥匙事实在接入方（平台 KeyStore 语义），
       引擎只认传入映射：不存钥匙、不联网校验、零依赖。 ---------- */
    let identity: WorldAuthKey | null = null;
    let canWrite = true;
    if (init.auth) {
      const key = apiKeyOf(req);
      const rec = key !== undefined ? init.auth.keys[key] : undefined;
      if (!rec) {
        return { status: 401, body: { error: 'unauthorized', hint: '需要有效的 x-api-key（或 Authorization: Bearer）' } };
      }
      identity = rec;
      canWrite = (rec.scopes ?? (rec.gameId ? ['worlds:read'] : ['worlds:read', 'worlds:write'])).includes(
        'worlds:write',
      );
    }
    const gameId = identity?.gameId;
    /** 世界可见域：管理钥匙（无 gameId）全可见；游戏方钥匙只认 ownerGame 匹配 */
    const owns = (w: WorldHandle<W>): boolean => !gameId || metaStr(metaOf(w), 'ownerGame') === gameId;
    const forbidden = (): HttpResponse => ({ status: 403, body: { error: 'forbidden', need: 'worlds:write' } });

    /* ---------- /v1/worlds ---------- */
    if (segments[0] === 'v1' && segments[1] === 'worlds' && segments.length === 2) {
      if (method === 'POST') {
        if (!canWrite) return forbidden();
        const jsonOpts = sanitizeCreateOptions(req.body);
        const now = new Date().toISOString();
        const meta = (jsonOpts['meta'] as Record<string, string> | undefined) ?? {};
        delete jsonOpts['meta'];
        /* ownerGame（G2）：游戏方钥匙强制打自己的 gameId；管理钥匙可指定 */
        const bodyOwner = typeof jsonOpts['ownerGame'] === 'string' ? (jsonOpts['ownerGame'] as string) : undefined;
        delete jsonOpts['ownerGame'];
        const owner = gameId ?? bodyOwner;
        /* name/description 走 World Definition 的 metadata 通道（零 Core；随存档持久化） */
        const defMeta = {
          ...(init.createOptions?.definition?.metadata ?? {}),
          ...meta,
          ...(owner ? { ownerGame: owner } : {}),
          createdAt: now,
          updatedAt: now,
        };
        /* locations（P2 additive）：body 声明的地点表转 World Definition——
           与 G1 种子同约定（name → attributes.desc；type 缺省 urban），
           随 createWorld 的 applyDefinition 物化、随档持久化、可经 GET locations 查询 */
        const bodyLocations = Array.isArray(jsonOpts['locations'])
          ? (jsonOpts['locations'] as { id: string; type?: string; name?: string }[])
          : [];
        delete jsonOpts['locations'];
        const definition = {
          ...(init.createOptions?.definition ?? {}),
          ...(bodyLocations.length
            ? {
                locations: bodyLocations.map((l) => ({
                  id: l.id,
                  type: l.type ?? 'urban',
                  attributes: { ...(l.name ? { desc: l.name } : {}) },
                })),
              }
            : {}),
          metadata: defMeta,
        };
        if (registry) {
          /* 注册表模式：多世界共存（DR-003 兑现；id 必填，重复 409） */
          const worldId = typeof jsonOpts['worldId'] === 'string' ? (jsonOpts['worldId'] as string) : init.createOptions?.worldId;
          if (!worldId) {
            return { status: 400, body: { error: 'registry mode requires "worldId"' } };
          }
          try {
            const created = registry.create({
              ...(init.createOptions ?? {}),
              ...jsonOpts,
              definition,
              worldId,
            } as CreateWorldOptions<W> & { worldId: string });
            return { status: 201, body: info(created) };
          } catch (e) {
            if (e instanceof WorldRegistryError) {
              return { status: 409, body: { error: e.message } };
            }
            throw e;
          }
        }
        /* 单世界模式：已有即 409（DR-003） */
        if (world) {
          return { status: 409, body: { error: 'world already exists', worldId: world.worldId, hint: 'one world per server（DR-001/DR-003）；传 registry 启用多世界' } };
        }
        world = createWorld<W>({ ...(init.createOptions ?? {}), ...jsonOpts, definition } as CreateWorldOptions<W>);
        return { status: 201, body: info(world) };
      }
      if (method === 'GET') {
        /* 可见域（G2）：游戏方钥匙只见自己游戏的世界；?game= 供管理台按方过滤（取交集） */
        const gameFilter = queryStr(req.query?.['game'], 64);
        const all = (registry ? registry.list() : world ? [world] : []).filter(
          (w) => owns(w) && (!gameFilter || metaStr(metaOf(w), 'ownerGame') === gameFilter),
        );
        return { status: 200, body: { worlds: all.map(info) } };
      }
      return { status: 405, body: { error: 'method not allowed' } };
    }

    /* ---------- /v1/worlds/{id}[...] ---------- */
    if (segments[0] === 'v1' && segments[1] === 'worlds' && segments.length >= 3) {
      const id = decodeURIComponent(segments[2]);
      const w = resolveWorld(id);
      if (!w || !owns(w)) {
        return { status: 404, body: { error: 'world not found', worldId: id } };
      }
      const leaf = segments[3];

      if (segments.length === 3) {
        if (method === 'GET') return { status: 200, body: info(w) };
        if (method === 'DELETE') {
          /* G1 关闭：注册表摘除（V0.9 既有能力）；单世界模式不支持（单世界即进程本体） */
          if (!canWrite) return forbidden();
          if (!registry) {
            return { status: 409, body: { error: 'close requires registry mode', worldId: id } };
          }
          registry.close(id);
          pausedWorlds.delete(id);
          return { status: 200, body: { closed: true, worldId: id } };
        }
        return { status: 405, body: { error: 'method not allowed' } };
      }

      /* ---------- G1 软暂停 / 恢复 ---------- */
      if (segments.length === 4 && leaf === 'pause') {
        if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
        if (!canWrite) return forbidden();
        if (pausedWorlds.has(id)) {
          return { status: 409, body: { error: 'world already paused', worldId: id } };
        }
        pausedWorlds.add(id);
        return { status: 200, body: info(w) };
      }
      if (segments.length === 4 && leaf === 'resume') {
        if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
        if (!canWrite) return forbidden();
        if (!pausedWorlds.has(id)) {
          return { status: 409, body: { error: 'world not paused', worldId: id } };
        }
        pausedWorlds.delete(id);
        return { status: 200, body: info(w) };
      }

      if (segments.length === 4 && leaf === 'state') {
        if (method === 'GET') return { status: 200, body: w.getState() };
        return { status: 405, body: { error: 'method not allowed' } };
      }

      if (segments.length === 4 && leaf === 'events') {
        if (method === 'GET') {
          const n = Number(req.query?.['n'] ?? 20);
          /* 上界钳制（V2.4 加固）：n 无上界时一次可倒出全量世界史（DoS 面）；
             全量检索走过滤参数（queryEvents），这里只是窗口快路径 */
          const cap = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : 20;
          /* V2.4-01：世界事件史过滤查询（可按实体/类型/时间/因果检索全量历史；
             任一过滤参数出现即走事件史，否则保持热窗口快路径） */
          const q = req.query ?? {};
          const filter: Record<string, unknown> = {};
          for (const k of ['id', 'type', 'actor', 'target', 'location', 'causedBy'] as const) {
            const v = q[k];
            if (typeof v === 'string' && v.length > 0) filter[k] = v;
          }
          for (const k of ['dayFrom', 'dayTo'] as const) {
            const v = Number(q[k]);
            if (Number.isFinite(v)) filter[k] = Math.floor(v);
          }
          if (Object.keys(filter).length > 0 || q['log'] === '1') {
            if (typeof w.queryEvents !== 'function') {
              return { status: 501, body: { error: '本世界未装配事件史查询' } };
            }
            const all = w.queryEvents(filter as never);
            return { status: 200, body: { events: all.slice(0, cap), total: all.length } };
          }
          return { status: 200, body: { events: w.getEvents(cap) } };
        }
        return { status: 405, body: { error: 'method not allowed' } };
      }

      if (segments.length === 4 && leaf === 'commands') {
        if (method === 'POST') {
          if (!canWrite) return forbidden();
          if (pausedWorlds.has(id)) {
            return { status: 409, body: { error: 'world paused：暂停中的世界不接受命令推进（G1 软暂停；读操作不受影响）', worldId: id, code: 'world_paused' } };
          }
          const cmd = sanitizeCommand(req.body);
          if (!cmd) {
            return { status: 400, body: { error: 'command body must be an object with a short string "type"' } };
          }
          const res = w.executeCommand(cmd as unknown as Parameters<WorldHandle<W>['executeCommand']>[0]);
          touch(w, res);
          return { status: 200, body: res };
        }
        if (method === 'GET') {
          /* M1.4 · G5：最近命令历史（Runtime 侧环形缓冲；新 → 旧） */
          const n = clampInt(req.query?.['n'], 50, 1, 500);
          const commands: CommandHistoryEntry[] = w.runtime.recentCommands(n);
          return { status: 200, body: { total: commands.length, commands } };
        }
        return { status: 405, body: { error: 'method not allowed' } };
      }

      if (segments.length === 4 && leaf === 'scheduler') {
        if (method === 'GET') return schedulerResponse(w, req.query);
        return { status: 405, body: { error: 'method not allowed' } };
      }

      if (leaf === 'entities') {
        if (segments.length === 4) {
          if (method === 'GET') return listEntitiesResponse(w, req.query);
          return { status: 405, body: { error: 'method not allowed' } };
        }
        if (segments.length === 5 && method === 'GET') {
          return entityDetailResponse(w, decodeURIComponent(segments[4]));
        }
        return { status: 405, body: { error: 'method not allowed' } };
      }

      if (segments.length === 4 && leaf === 'locations') {
        if (method === 'GET') return listLocationsResponse(w, req.query);
        return { status: 405, body: { error: 'method not allowed' } };
      }

      if (segments.length === 4 && leaf === 'relations') {
        if (method === 'GET') return listRelationsResponse(w, req.query);
        return { status: 405, body: { error: 'method not allowed' } };
      }

      if (segments.length === 4 && leaf === 'time') {
        if (method === 'POST') {
          if (!canWrite) return forbidden();
          if (pausedWorlds.has(id)) {
            return { status: 409, body: { error: 'world paused：暂停中的世界不接受时间推进（G1 软暂停；读操作不受影响）', worldId: id, code: 'world_paused' } };
          }
          const ticks = (req.body as { ticks?: unknown } | undefined)?.ticks;
          const n = typeof ticks === 'number' ? ticks : Number(ticks);
          if (!Number.isFinite(n) || Math.floor(n) < 1) {
            return { status: 400, body: { error: 'body must be {"ticks": <positive number>}' } };
          }
          const res = w.advanceTime(Math.floor(n));
          touch(w, res);
          return { status: 200, body: res };
        }
        return { status: 405, body: { error: 'method not allowed' } };
      }

      return { status: 404, body: { error: 'no such resource' } };
    }

    return { status: 404, body: { error: 'no such route', path: req.path } };
  }

  return {
    handle,
    get world(): WorldHandle<W> | null {
      return world;
    },
  };
}

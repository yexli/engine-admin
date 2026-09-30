/* ============================================================
   World HTTP 协议适配器（V0.4→V0.9 · 方案 §64）
   ------------------------------------------------------------
   把 §64 的 HTTP 路由映射到 World API——**World API 形状不变，
   这里只加传输层**（§19）。纯路由协议：输入已解析的
   { method, path, query, body }，输出 { status, body }——不碰
   socket、不碰 JSON 字符串，可无网络全量测试。

   路由（方案 §64）：
     POST /v1/worlds                  创建世界
     GET  /v1/worlds                  世界清单
     GET  /v1/worlds/{id}             世界信息
     GET  /v1/worlds/{id}/state       完整世界状态
     POST /v1/worlds/{id}/commands    提交命令（body = WorldCommand）
     GET  /v1/worlds/{id}/events?n=20 最近的世界事实
     POST /v1/worlds/{id}/time        推进时间（body = { ticks })

   两种模式（V0.9，DR-003 兑现）：
   · 单世界模式（缺省）：服务器只持有一个世界，重复创建 409；
   · 注册表模式（init.registry）：POST /v1/worlds 可多次（每世界
     独立作用域），{id} 为真实路由键。路由形状两种模式完全一致。

   鉴权 / 多租户不做（方案 §3）——服务器默认只绑 127.0.0.1（见 server.ts）。
   ============================================================ */
import { createWorld, type CreateWorldOptions, type WorldHandle, type WorldTimeView } from '../api/WorldAPI.ts';
import { WorldRegistryError, type WorldRegistry } from '../api/WorldRegistry.ts';
import type { EngineWorldState } from '../types.ts';

/** 已解析的 HTTP 请求（传输层负责解析 URL / query / JSON body） */
export interface HttpRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  /** 已 JSON.parse 的请求体（GET 无 body；解析失败由传输层直接回 400） */
  body?: unknown;
}

/** 待序列化的 HTTP 响应 */
export interface HttpResponse {
  status: number;
  body: unknown;
}

/** 世界概要（GET /v1/worlds[/{id}] 的载荷） */
export interface WorldInfo {
  worldId: string;
  location: string | null;
  entities: number;
  time: WorldTimeView | null;
}

export interface WorldHttpInit<W extends EngineWorldState = EngineWorldState> {
  /** 单世界模式：预建世界（给了它，POST /v1/worlds 返回 409） */
  world?: WorldHandle<W>;
  /** 未预建时，POST /v1/worlds 的创建参数（body 字段覆盖同名项；rules 不可跨 HTTP 传入） */
  createOptions?: CreateWorldOptions<W>;
  /** V0.9 注册表模式：多世界共存（每世界独立作用域）；给了它则单世界 world 被忽略 */
  registry?: WorldRegistry<W>;
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

/** 创建参数白名单重建（labels 逐字段校验；未知键不透传） */
function sanitizeCreateOptions(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const b = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const worldId = MAX_STR(64)(b['worldId']);
  const playerName = MAX_STR(64)(b['playerName']);
  const startLoc = MAX_STR(64)(b['startLoc']);
  const weather = MAX_STR(32)(b['weather']);
  if (worldId) out['worldId'] = worldId;
  if (playerName) out['playerName'] = playerName;
  if (startLoc) out['startLoc'] = startLoc;
  if (weather) out['weather'] = weather;
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

/** 创建 HTTP 协议适配器。 */
export function createWorldHttp<W extends EngineWorldState = EngineWorldState>(
  init: WorldHttpInit<W> = {},
): { handle(req: HttpRequest): Promise<HttpResponse> | HttpResponse; readonly world: WorldHandle<W> | null } {
  let world: WorldHandle<W> | null = init.world ?? null;
  const registry = init.registry ?? null;

  function info(h: WorldHandle<W>): WorldInfo {
    return {
      worldId: h.worldId,
      location: h.query.get_location(),
      entities: h.query.get_entities().length,
      time: h.query.get_time(),
    };
  }

  function resolveWorld(id: string): WorldHandle<W> | null {
    if (registry) return registry.get(id);
    return world && world.worldId === id ? world : null;
  }

  async function handle(req: HttpRequest): Promise<HttpResponse> {
    const method = req.method.toUpperCase();
    const segments = req.path.replace(/\/+$/, '').split('/').filter(Boolean);

    /* ---------- /v1/worlds ---------- */
    if (segments[0] === 'v1' && segments[1] === 'worlds' && segments.length === 2) {
      if (method === 'POST') {
        const jsonOpts = sanitizeCreateOptions(req.body);
        if (registry) {
          /* 注册表模式：多世界共存（DR-003 兑现；id 必填，重复 409） */
          const worldId = typeof jsonOpts['worldId'] === 'string' ? (jsonOpts['worldId'] as string) : init.createOptions?.worldId;
          if (!worldId) {
            return { status: 400, body: { error: 'registry mode requires "worldId"' } };
          }
          try {
            const created = registry.create({ ...(init.createOptions ?? {}), ...jsonOpts, worldId } as CreateWorldOptions<W> & { worldId: string });
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
        world = createWorld<W>({ ...(init.createOptions ?? {}), ...jsonOpts } as CreateWorldOptions<W>);
        return { status: 201, body: info(world) };
      }
      if (method === 'GET') {
        if (registry) {
          return { status: 200, body: { worlds: registry.list().map(info) } };
        }
        return { status: 200, body: { worlds: world ? [info(world)] : [] } };
      }
      return { status: 405, body: { error: 'method not allowed' } };
    }

    /* ---------- /v1/worlds/{id}[...] ---------- */
    if (segments[0] === 'v1' && segments[1] === 'worlds' && segments.length >= 3) {
      const id = decodeURIComponent(segments[2]);
      const w = resolveWorld(id);
      if (!w) {
        return { status: 404, body: { error: 'world not found', worldId: id } };
      }
      const leaf = segments[3];

      if (segments.length === 3) {
        if (method === 'GET') return { status: 200, body: info(w) };
        return { status: 405, body: { error: 'method not allowed' } };
      }

      if (segments.length === 4 && leaf === 'state') {
        if (method === 'GET') return { status: 200, body: w.getState() };
        return { status: 405, body: { error: 'method not allowed' } };
      }

      if (segments.length === 4 && leaf === 'events') {
        if (method === 'GET') {
          const n = Number(req.query?.['n'] ?? 20);
          return { status: 200, body: { events: w.getEvents(Number.isFinite(n) && n > 0 ? Math.floor(n) : 20) } };
        }
        return { status: 405, body: { error: 'method not allowed' } };
      }

      if (segments.length === 4 && leaf === 'commands') {
        if (method === 'POST') {
          const cmd = sanitizeCommand(req.body);
          if (!cmd) {
            return { status: 400, body: { error: 'command body must be an object with a short string "type"' } };
          }
          return { status: 200, body: w.executeCommand(cmd as unknown as Parameters<WorldHandle<W>['executeCommand']>[0]) };
        }
        return { status: 405, body: { error: 'method not allowed' } };
      }

      if (segments.length === 4 && leaf === 'time') {
        if (method === 'POST') {
          const ticks = (req.body as { ticks?: unknown } | undefined)?.ticks;
          const n = typeof ticks === 'number' ? ticks : Number(ticks);
          if (!Number.isFinite(n) || Math.floor(n) < 1) {
            return { status: 400, body: { error: 'body must be {"ticks": <positive number>}' } };
          }
          return { status: 200, body: w.advanceTime(Math.floor(n)) };
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

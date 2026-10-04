/* ============================================================
   私有管理 HTTP 监听（Model Control Plane · Task 3；M2/M3 扩展）
   ------------------------------------------------------------
   独立于公共 Platform 端口的 loopback 管理面：

     GET  /v1/admin/model-config              脱敏配置投影
     PUT  /v1/admin/model-config              If-Match 提交 + 热替换 [gateway:manage]
     POST /v1/admin/model-config/rollback     回滚到上一版本（If-Match）[gateway:manage]
     PUT  /v1/admin/providers/:id/credential  凭证写入（新引用）[gateway:manage]
     POST /v1/admin/models/:id/test           有界实测（允许禁用模型）[gateway:manage]
     POST /v1/admin/routes/:capability/test   有界实测（只用生效路由）[gateway:manage]
     GET  /v1/admin/keys                      API Key 脱敏清单（M2.1）
     POST /v1/admin/keys                      创建（明文仅此一次）[gateway:manage]
     PUT  /v1/admin/keys/:id                  撤销 / 设置过期 [gateway:manage]
     GET  /v1/admin/usage                     用量查询（过滤/汇总/分组，M2.2）
     GET  /v1/admin/pipelines                 管线 spec 只读清单（M2.3）
     POST /v1/admin/pipelines/:id/test        管线有界试跑 [gateway:manage]
     POST /v1/admin/session/login             登录签发会话（M3.1；免鉴权 + 节流）
     POST /v1/admin/session/refresh-token     刷新并轮换会话（免鉴权）
     POST /v1/admin/session/logout            吊销当前会话
     GET  /v1/admin/session/me                当前身份与权限
     GET  /v1/admin/system/users              用户清单 [system:manage]
     POST /v1/admin/system/users              创建用户 [system:manage]
     PUT  /v1/admin/system/users/:id          改资料/角色/状态/重置口令 [system:manage]
     GET  /v1/admin/system/permissions        权限码目录与三档角色（只读）
     GET  /v1/admin/system/settings           设置目录与当前值
     PUT  /v1/admin/system/settings/:key      更新设置 [system:manage]
     GET  /v1/obs/logs                        平台请求日志（M2.2 数据面投影，M4.1）
     GET  /v1/obs/events                      跨世界事件流（引擎只读聚合，M4.1）
     GET  /v1/obs/errors                      失败请求登记（数据面投影，只读，M4.1）
     GET  /v1/obs/overview                    Dashboard 聚合（M4.1）
     GET  /v1/evolution/worlds                演化账本世界清单（Phase C）
     POST /v1/evolution/worlds/:id/tick      触发一次演化闭环 [gateway:manage]
     GET  /v1/evolution/worlds/:id/runs      演化运行留痕（新 → 旧）
     GET  /v1/evolution/worlds/:id/runs/:rid 单次运行完整因果链
     POST /v1/evolution/worlds/:id/intent    意图处置（OOC 隔离闸）[gateway:manage]
     GET  /healthz                            零信息探活

   安全姿态（M3 起双凭证）：
   · 监听地址缺省 127.0.0.1；鉴权按序识别 x-admin-token（主令牌，
     由服务端反代/启动器注入，全权——浏览器永不持有）与
     x-admin-session（登录签发的角色会话，12h，刷新轮换 7d）；
   · authorization 头一律忽略——浏览器持有的公共 API Key 不得
     借道访问管理面；
   · 会话写请求按角色校验权限码（gateway:manage / system:manage），
     viewer 只读会话直访写端点 403；主令牌等同 *:*:*；
   · 登录失败全局节流（60s 窗口内 ≥10 次失败 → 429）；
   · 非 session/login|refresh 的写请求校验 Origin：拒绝非回环来源；
   · 请求体上限 1 MiB；日志只记方法/路径/状态/耗时/请求 ID，
     不记任何请求体或令牌。

   错误契约：{error:{code,message}} —— 400 malformed / 401 unauthorized /
   403 cross_origin_forbidden|insufficient_permission / 409
   revision_conflict|pipeline_disabled / 422 invalid_configuration /
   429 too_many_attempts / 502 upstream_test_failed / 503 no_model_configured。
   ============================================================ */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { ManagedRuntime, ProbeResult } from './managed-runtime.ts';
import { redactConfig, MANAGED_CAPABILITIES } from './model-config.ts';
import { ConfigValidationError, RevisionConflictError } from './errors.ts';
import { PipelineStore, PipelineStoreError } from './pipelines.ts';
import type { PipelineDoc } from './pipelines.ts';
import { SessionStore, type Identity } from './sessions.ts';
import { UserStore, UserStoreError } from './users.ts';
import { SettingsStore } from './settings.ts';
import {
  PERMISSION_CATALOG,
  ROLE_NICKNAME,
  hasPerm,
  isAdminRole,
  permissionsOfRole,
} from './permissions.ts';
import type { KeyStore } from '../keys/keystore.ts';
import type { ApiKeyRecord, PlatformPermission } from '../types.ts';
import { PLATFORM_PERMISSIONS } from '../types.ts';
import type { UsageReader } from '../usage/recorder.ts';
import { queryUsage, PAGE_SIZE_CAP } from '../usage/query.ts';
import type { EvolutionRuntime } from '../evolution/runtime.ts';
import { sanitizeScheduleTable, type ScheduleStore } from '../npc/scheduleStore.ts';

const MAX_BODY_BYTES = 1024 * 1024;

export interface AdminServerOptions {
  runtime: ManagedRuntime;
  adminToken: string;
  port?: number;
  /** **缺省 127.0.0.1（仅本机）**——私有管理面不允许公开暴露 */
  host?: string;
  /** 访问日志（默认开启；测试可关） */
  accessLog?: boolean;
  /** 额外允许的写请求 Origin（回环来源始终放行；生产经反代同源化） */
  allowedOrigins?: readonly string[];
  /** API Key 生命周期（M2.1；缺省未装配 → keys 路由 404 not_configured） */
  keys?: KeyStore;
  /** 用量数据面读取口（M2.2；缺省未装配 → usage 路由 404 not_configured） */
  usage?: UsageReader;
  /** 管线只读存储（M2.3；缺省未装配 → pipelines 路由 404 not_configured） */
  pipelines?: PipelineStore;
  /** 管理会话（M3.1；缺省未装配 → session 路由 404 not_configured，鉴权退回仅主令牌） */
  sessions?: SessionStore;
  /** 本地用户（M3.3；缺省未装配 → users 路由 404 not_configured，登录不可用） */
  users?: UserStore;
  /** 系统设置（M3.4；缺省未装配 → settings 路由 404 not_configured） */
  settings?: SettingsStore;
  /** AI World Evolution Runtime（Phase C；缺省未装配 → evolution 路由 404 not_configured） */
  evolution?: EvolutionRuntime;
  /** NPC 日程表存储（P6 · 方案 §九；缺省未装配 → schedules 路由 404 not_configured） */
  scheduleStore?: ScheduleStore;
  /** Trigger Runtime（P3；缺省未装配 → runtime 观测面无 trigger 段） */
  triggerRuntime?: import('../evolution/triggerRuntime.ts').TriggerRuntime;
  /** Schedule Runtime（P6；缺省未装配 → runtime 观测面无 schedule 段） */
  scheduleRuntime?: import('../npc/scheduler.ts').ScheduleRuntime;
  /** Memory Runtime + 记忆服务（P7；缺省未装配 → runtime 观测面无 memory 段） */
  memoryRuntime?: import('../memory/runtime.ts').MemoryRuntime;
  memoryService?: import('../memory/service.ts').WorldMemoryService;
}

export interface AdminServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/** 路由内抛出的 HTTP 语义错误（由请求 catch 归一化响应） */
class AdminHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function httpErr(status: number, code: string, message: string, extra?: Record<string, unknown>): never {
  throw new AdminHttpError(status, code, message, extra);
}

/** 常量时间令牌比较 */
function tokenMatches(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 回环来源（任意端口）——本地 Admin Web 开发服务器 */
function isLoopbackOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

interface ReqLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

export function startAdminServer(opts: AdminServerOptions): Promise<AdminServer> {
  const accessLog = opts.accessLog ?? true;
  const host = opts.host ?? '127.0.0.1';
  const extraOrigins = new Set((opts.allowedOrigins ?? []).map((o) => o.trim().toLowerCase()).filter((o) => o !== ''));

  /* 登录节流：60s 窗口内全局失败 ≥10 次 → 429（loopback 管理面的暴力破解兜底） */
  const LOGIN_FAIL_MAX = 10;
  const LOGIN_FAIL_WINDOW_MS = 60_000;
  let loginFailures: number[] = [];

  function loginThrottled(): boolean {
    const cutoff = Date.now() - LOGIN_FAIL_WINDOW_MS;
    loginFailures = loginFailures.filter((t) => t > cutoff);
    return loginFailures.length >= LOGIN_FAIL_MAX;
  }
  function recordLoginFailure(): void {
    loginFailures.push(Date.now());
  }

  /** 会话/刷新端点免鉴权（登录是会话的起点） */
  const AUTH_EXEMPT = new Set(['/v1/admin/session/login', '/v1/admin/session/refresh-token']);

  async function handle(req: ReqLike, url: URL, raw: Buffer): Promise<{ status: number; body: unknown }> {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/\/+$/, '') || '/';

    /* ---------- /healthz：免令牌、零信息 ---------- */
    if (path === '/healthz' && method === 'GET') {
      return { status: 200, body: { ok: true, service: 'world-platform-admin' } };
    }

    /* ---------- 身份识别（M3：主令牌或会话；authorization 一律忽略） ---------- */
    let identity: Identity | null = null;
    const masterSupplied = headerOf(req, 'x-admin-token');
    if (masterSupplied !== undefined) {
      if (!tokenMatches(masterSupplied, opts.adminToken)) {
        /* 带了主令牌但不对：即便同时带合法会话也拒绝（防降级混淆） */
        httpErr(401, 'unauthorized', '无效的管理令牌（x-admin-token 必须由服务端代理注入，浏览器不持有）');
      }
      identity = { kind: 'master' };
    } else if (opts.sessions) {
      const session = opts.sessions.verify(headerOf(req, 'x-admin-session'));
      if (session) identity = { kind: 'session', session };
    }
    if (!identity && !AUTH_EXEMPT.has(path)) {
      httpErr(401, 'unauthorized', '未认证：缺少有效的管理令牌或管理会话（x-admin-session，经登录签发）');
    }

    /** 会话写权限闸：主令牌等同 *:*:*；会话按角色权限码校验 */
    function requirePerm(code: string): void {
      if (!identity) httpErr(401, 'unauthorized', '未认证');
      if (identity.kind === 'master') return;
      const perms = permissionsOfRole(identity.session.role);
      if (!hasPerm(perms, code)) {
        httpErr(403, 'insufficient_permission', `当前会话角色 '${identity.session.role}' 缺少权限：${code}（只读观察员无写权限，属预期行为）`);
      }
    }

    /* ---------- 写请求：Origin 检查（回环或显式允许） ---------- */
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = headerOf(req, 'origin');
      if (origin && !isLoopbackOrigin(origin) && !extraOrigins.has(origin.toLowerCase())) {
        httpErr(403, 'cross_origin_forbidden', '管理面拒绝跨源写请求；Admin Web 应经同源反代访问');
      }
    }

    /* ---------- GET /v1/admin/model-config：脱敏投影 ---------- */
    if (path === '/v1/admin/model-config' && method === 'GET') {
      return { status: 200, body: redactConfig(opts.runtime.config) };
    }

    /* ---------- PUT /v1/admin/model-config：If-Match 提交 + 热替换 ---------- */
    if (path === '/v1/admin/model-config' && method === 'PUT') {
      requirePerm('gateway:manage');
      const ifMatch = requireIfMatch(req);
      const body = parseJson(raw);
      const committed = opts.runtime.apply(body, ifMatch);
      return { status: 200, body: { revision: committed.revision } };
    }

    /* ---------- POST /v1/admin/model-config/rollback：回滚上一版本 ---------- */
    if (path === '/v1/admin/model-config/rollback' && method === 'POST') {
      requirePerm('gateway:manage');
      const ifMatch = requireIfMatch(req);
      const restored = opts.runtime.rollback(ifMatch);
      return { status: 200, body: { revision: restored.revision } };
    }

    /* ---------- PUT /v1/admin/providers/:id/credential ---------- */
    const credMatch = path.match(/^\/v1\/admin\/providers\/([^/]+)\/credential$/);
    if (credMatch && method === 'PUT') {
      requirePerm('gateway:manage');
      const providerId = decodeURIComponent(credMatch[1]!);
      const body = parseJson(raw) as { value?: unknown };
      if (typeof body?.value !== 'string' || body.value.length === 0 || body.value.length > 4096) {
        httpErr(400, 'malformed', '请求体必须形如 {value: string}（1-4096 字符）');
      }
      const exists = opts.runtime.config.providers.some((p) => p.id === providerId);
      if (!exists) httpErr(404, 'provider_not_found', `供应商 '${providerId}' 不在配置中`);
      const committed = opts.runtime.applyCredential(providerId, body.value as string);
      const p = committed.providers.find((x) => x.id === providerId);
      return {
        status: 200,
        body: { revision: committed.revision, hasCredential: p?.auth.kind === 'secret' && !!p.auth.secretId },
      };
    }

    /* ---------- POST /v1/admin/models/:id/test ---------- */
    const modelTestMatch = path.match(/^\/v1\/admin\/models\/([^/]+)\/test$/);
    if (modelTestMatch && method === 'POST') {
      requirePerm('gateway:manage');
      const modelId = decodeURIComponent(modelTestMatch[1]!);
      const target = opts.runtime.config.models.find((x) => x.id === modelId);
      if (!target) {
        httpErr(404, 'model_not_found', `模型 '${modelId}' 不在配置中`);
      }
      /* 按模型类型选实测语义（Embedding 统一治理）：embedding 标签模型走
         embed(['ping']) 并返回实测维度——chat ping 对嵌入模型是假测试 */
      const result = target.tags.includes('embedding')
        ? await opts.runtime.probeEmbedding(modelId)
        : await opts.runtime.probeModel(modelId);
      return probeResponse(result);
    }

    /* ---------- POST /v1/admin/routes/:capability/test ---------- */
    const routeTestMatch = path.match(/^\/v1\/admin\/routes\/([^/]+)\/test$/);
    if (routeTestMatch && method === 'POST') {
      requirePerm('gateway:manage');
      const capability = decodeURIComponent(routeTestMatch[1]!);
      if (!(MANAGED_CAPABILITIES as readonly string[]).includes(capability)) {
        httpErr(400, 'malformed', `未知能力 '${capability}'（可用：${MANAGED_CAPABILITIES.join('/')}）`);
      }
      const route = opts.runtime.config.routes[capability as (typeof MANAGED_CAPABILITIES)[number]];
      if (!route?.primary) {
        httpErr(503, 'no_model_configured', `能力 '${capability}' 未配置 primary 模型`);
      }
      /* Embedding 统一治理：embedding 能力走 embed(['ping']) 语义实测
         （chat ping 对嵌入模型通常是假测试），并返回实测维度 */
      const result =
        capability === 'embedding'
          ? await opts.runtime.probeEmbedding(route.primary!)
          : await opts.runtime.probeModel(route.primary!);
      return probeResponse(result);
    }

    /* ---------- GET /v1/admin/routes/:capability：路由实况（Embedding 统一治理） ----------
       只读解析：primary/fallback 槽位 → 模型/供应商投影 + 冷却状态 + 当前
       select() 结果。诊断页据此展示"当前实际生效的模型"，不读任何副本配置。 */
    const routeLiveMatch = path.match(/^\/v1\/admin\/routes\/([^/]+)$/);
    if (routeLiveMatch && method === 'GET') {
      requirePerm('gateway:manage');
      const capability = decodeURIComponent(routeLiveMatch[1]!);
      if (!(MANAGED_CAPABILITIES as readonly string[]).includes(capability)) {
        httpErr(400, 'malformed', `未知能力 '${capability}'（可用：${MANAGED_CAPABILITIES.join('/')}）`);
      }
      const cap = capability as (typeof MANAGED_CAPABILITIES)[number];
      const route = opts.runtime.config.routes[cap] ?? { primary: null, fallback: null };
      const resolveSlot = (modelId: string | null) => {
        if (!modelId) return null;
        const m = opts.runtime.config.models.find((x) => x.id === modelId);
        const p = m ? opts.runtime.config.providers.find((x) => x.id === m.providerId) : undefined;
        return {
          modelId,
          wireModel: m?.wireModel ?? null,
          enabled: m?.enabled ?? false,
          providerId: m?.providerId ?? null,
          providerName: p?.name ?? null,
          coolingDown: opts.runtime.router.isCoolingDown(modelId),
        };
      };
      const selected = opts.runtime.router.select(cap);
      return {
        status: 200,
        body: {
          capability: cap,
          route: { primary: route.primary ?? null, fallback: route.fallback ?? null },
          primary: resolveSlot(route.primary ?? null),
          fallback: resolveSlot(route.fallback ?? null),
          resolved: selected ? { modelId: selected.model, usedFallback: selected.usedFallback } : null,
        },
      };
    }

    /* ---------- GET /v1/admin/keys：API Key 脱敏清单（M2.1；删除为硬删，清单即全部在档） ---------- */
    if (path === '/v1/admin/keys' && method === 'GET') {
      if (!opts.keys) httpErr(404, 'not_configured', '本管理面未装配 API Key 存储');
      let list = opts.keys.list();
      list = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      const { page, pageSize } = pageParams(url);
      return {
        status: 200,
        body: { total: list.length, page, pageSize, list: list.slice((page - 1) * pageSize, page * pageSize).map(maskedKeyRow) },
      };
    }

    /* ---------- POST /v1/admin/keys：创建（明文仅此一次；M2.1） ---------- */
    if (path === '/v1/admin/keys' && method === 'POST') {
      requirePerm('gateway:manage');
      if (!opts.keys) httpErr(404, 'not_configured', '本管理面未装配 API Key 存储');
      const body = parseJson(raw) as Record<string, unknown>;
      const name = body['name'];
      if (typeof name !== 'string' || name.trim().length === 0 || name.length > 64) {
        httpErr(400, 'malformed', 'name 必须是 1-64 字符的字符串');
      }
      const permissions = validateKeyPermissions(body['permissions']);
      /* gameId（G2）：非空 = 游戏方钥匙（对齐引擎 auth 中间件的 WorldAuthKey.gameId） */
      let gameId: string | undefined;
      if (body['gameId'] !== undefined && body['gameId'] !== null) {
        if (typeof body['gameId'] !== 'string' || body['gameId'].trim().length === 0 || body['gameId'].length > 64) {
          httpErr(400, 'malformed', 'gameId 必须是 1-64 字符的字符串');
        }
        gameId = (body['gameId'] as string).trim();
      }
      let expiresAt: string | null = null;
      if (body['expiresAt'] !== undefined && body['expiresAt'] !== null) {
        if (typeof body['expiresAt'] !== 'string' || body['expiresAt'].length > 64 || Number.isNaN(Date.parse(body['expiresAt']))) {
          httpErr(400, 'malformed', 'expiresAt 必须是可解析的 ISO 日期字符串或 null');
        }
        expiresAt = body['expiresAt'] as string;
      }
      const created = opts.keys.create({ name: name.trim(), permissions, gameId, expiresAt: expiresAt ?? undefined });
      return { status: 201, body: { key: maskedKeyRow(created.record), plaintext: created.plaintext } };
    }

    /* ---------- PUT /v1/admin/keys/:id：设置过期（M2.1；0.5.1 起不再有撤销语义） ---------- */
    const keyIdMatch = path.match(/^\/v1\/admin\/keys\/([^/]+)$/);
    if (keyIdMatch && method === 'PUT') {
      requirePerm('gateway:manage');
      if (!opts.keys) httpErr(404, 'not_configured', '本管理面未装配 API Key 存储');
      const id = decodeURIComponent(keyIdMatch[1]!);
      const body = parseJson(raw) as Record<string, unknown>;
      if (body['status'] !== undefined) {
        /* 0.5.1 移除撤销语义：状态随删除/过期自然派生，不再有可写字段 */
        httpErr(400, 'malformed', "已不支持 status 字段（撤销语义移除）；停用请设 expiresAt，彻底移除请用 DELETE");
      }
      if (body['expiresAt'] === undefined) {
        httpErr(400, 'malformed', '请求体必须包含 expiresAt（ISO 日期字符串或 null = 清除）');
      }
      const rawExp = body['expiresAt'];
      if (rawExp !== null && (typeof rawExp !== 'string' || rawExp.length > 64 || Number.isNaN(Date.parse(rawExp)))) {
        httpErr(400, 'malformed', 'expiresAt 必须是可解析的 ISO 日期字符串或 null');
      }
      if (!opts.keys.setExpiresAt(id, rawExp as string | null)) httpErr(404, 'key_not_found', `Key '${id}' 不存在`);
      const updated = opts.keys.list().find((k) => k.id === id) ?? null;
      if (!updated) httpErr(404, 'key_not_found', `Key '${id}' 不存在`);
      return { status: 200, body: { key: maskedKeyRow(updated) } };
    }

    /* ---------- DELETE /v1/admin/keys/:id：硬删（0.5.1；出站即 401，记录移除） ---------- */
    if (keyIdMatch && method === 'DELETE') {
      requirePerm('gateway:manage');
      if (!opts.keys) httpErr(404, 'not_configured', '本管理面未装配 API Key 存储');
      const id = decodeURIComponent(keyIdMatch[1]!);
      if (!opts.keys.remove(id)) httpErr(404, 'key_not_found', `Key '${id}' 不存在`);
      return { status: 200, body: { deleted: true, id } };
    }

    /* ---------- GET /v1/admin/usage：用量查询（M2.2） ---------- */
    if (path === '/v1/admin/usage' && method === 'GET') {
      if (!opts.usage) httpErr(404, 'not_configured', '本管理面未装配用量数据面');
      const sp = url.searchParams;
      const kind = sp.get('kind');
      if (kind && kind !== 'chat' && kind !== 'worlds' && kind !== 'embeddings') httpErr(400, 'malformed', `kind 只接受 chat|worlds|embeddings，收到 '${kind.slice(0, 32)}'`);
      const status = sp.get('status');
      if (status && status !== 'success' && status !== 'error') httpErr(400, 'malformed', `status 只接受 success|error，收到 '${status.slice(0, 32)}'`);
      const route = sp.get('route');
      if (route && route !== 'world-agent' && route !== 'proxy' && route !== 'embedding') httpErr(400, 'malformed', `route 只接受 world-agent|proxy|embedding，收到 '${route.slice(0, 32)}'`);
      const groupBy = sp.get('group_by');
      if (groupBy !== null && !['day', 'key', 'model', 'capability', 'world', 'game'].includes(groupBy)) {
        httpErr(400, 'malformed', `group_by 只接受 day|key|model|capability|world|game，收到 '${groupBy.slice(0, 32)}'`);
      }
      for (const bound of ['from', 'to']) {
        const v = sp.get(bound);
        if (v !== null && Number.isNaN(Date.parse(v))) httpErr(400, 'malformed', `${bound} 必须是可解析的 ISO 日期`);
      }
      const { page, pageSize } = pageParams(url, PAGE_SIZE_CAP);
      const out = queryUsage(opts.usage.readAll(), {
        from: sp.get('from') ?? undefined,
        to: sp.get('to') ?? undefined,
        keyId: sp.get('key_id') ?? undefined,
        worldId: sp.get('world_id') ?? undefined,
        /* G3：游戏方维度。game_id=__platform__ 约定为平台钥匙（无 gameId） */
        gameId: sp.get('game_id') === '__platform__' ? '' : (sp.get('game_id') ?? undefined),
        model: sp.get('model') ?? undefined,
        capability: sp.get('capability') ?? undefined,
        kind: (kind as 'chat' | 'worlds') ?? undefined,
        status: (status as 'success' | 'error') ?? undefined,
        route: (route as 'world-agent' | 'proxy') ?? undefined,
        groupBy: (groupBy as undefined | 'day' | 'key' | 'model' | 'capability' | 'world' | 'game') ?? undefined,
        page,
        pageSize,
      });
      const providerOf = (modelId: string | undefined): string | null => {
        if (!modelId || modelId === 'world-agent') return null;
        return opts.runtime.config.models.find((m) => m.id === modelId)?.providerId ?? null;
      };
      return {
        status: 200,
        body: {
          total: out.total,
          page: out.page,
          pageSize: out.pageSize,
          summary: out.summary,
          groups: out.groups,
          list: out.list.map((e) => ({
            id: e.requestId,
            time: e.ts,
            kind: e.kind,
            keyId: e.keyId,
            method: e.method,
            path: e.path,
            route: e.route ?? null,
            model: e.model ?? null,
            modelUsed: e.modelUsed ?? null,
            provider: e.route === 'proxy' ? providerOf(e.model) : providerOf(e.modelUsed),
            worldId: e.worldId ?? null,
            capability: e.capability ?? null,
            promptTokens: e.promptTokens ?? null,
            completionTokens: e.completionTokens ?? null,
            totalTokens: e.totalTokens ?? null,
            tokensEstimated: e.tokensEstimated === true,
            latencyMs: e.latencyMs,
            status: e.status < 400 ? 'success' : 'error',
            error: e.error ?? null,
          })),
        },
      };
    }

    /* ---------- GET /v1/admin/pipelines：管线 spec 只读清单（M2.3） ---------- */
    if (path === '/v1/admin/pipelines' && method === 'GET') {
      if (!opts.pipelines) httpErr(404, 'not_configured', '本管理面未装配管线存储');
      /* 文件损坏/校验失败 → PipelineStoreError → 422（页面进错误态，诚实暴露） */
      const docs = opts.pipelines.list();
      return {
        status: 200,
        body: {
          pipelines: docs.map((d) => ({
            id: d.id,
            description: d.description ?? null,
            enabled: d.enabled,
            deadlineMs: d.spec.deadlineMs ?? null,
            nodes: d.spec.nodes,
          })),
        },
      };
    }

    /* ---------- POST /v1/admin/pipelines/:id/test：有界试跑（M2.3） ---------- */
    const pipelineTestMatch = path.match(/^\/v1\/admin\/pipelines\/([^/]+)\/test$/);
    if (pipelineTestMatch && method === 'POST') {
      requirePerm('gateway:manage');
      if (!opts.pipelines) httpErr(404, 'not_configured', '本管理面未装配管线存储');
      const id = decodeURIComponent(pipelineTestMatch[1]!);
      const doc: PipelineDoc | null = opts.pipelines.get(id);
      if (!doc) httpErr(404, 'pipeline_not_found', `管线 '${id}' 不在描述文件中`);
      if (!doc!.enabled) httpErr(409, 'pipeline_disabled', `管线 '${id}' 已被禁用（enabled: false），试跑被拒绝`);
      const body = (raw.length > 0 ? (parseJson(raw) as Record<string, unknown>) : {}) as {
        input?: unknown;
        deadlineMs?: unknown;
        maxCalls?: unknown;
      };
      let input: Record<string, string> | undefined;
      if (body['input'] !== undefined) {
        if (!body['input'] || typeof body['input'] !== 'object' || Array.isArray(body['input'])) {
          httpErr(400, 'malformed', 'input 必须是对象 { key: string }');
        }
        const entries = Object.entries(body['input'] as Record<string, unknown>);
        if (entries.length > 16) httpErr(400, 'malformed', 'input 最多 16 个键');
        input = {};
        for (const [k, v] of entries) {
          if (typeof k !== 'string' || k.length === 0 || k.length > 64 || typeof v !== 'string' || v.length > 2000) {
            httpErr(400, 'malformed', 'input 的键必须是 1-64 字符、值必须是 ≤2000 字符的字符串');
          }
          input[k] = v;
        }
      }
      let deadlineMs: number | undefined;
      if (body['deadlineMs'] !== undefined) {
        if (typeof body['deadlineMs'] !== 'number' || !Number.isInteger(body['deadlineMs']) || body['deadlineMs'] < 1 || body['deadlineMs'] > 30_000) {
          httpErr(400, 'malformed', 'deadlineMs 必须是 1-30000 的整数（毫秒，试跑硬性封顶 30s）');
        }
        deadlineMs = body['deadlineMs'] as number;
      }
      let maxCalls: number | undefined;
      if (body['maxCalls'] !== undefined) {
        if (typeof body['maxCalls'] !== 'number' || !Number.isInteger(body['maxCalls']) || body['maxCalls'] < 1 || body['maxCalls'] > 32) {
          httpErr(400, 'malformed', 'maxCalls 必须是 1-32 的整数（试跑硬性封顶）');
        }
        maxCalls = body['maxCalls'] as number;
      }
      const startedAt = Date.now();
      const out = await opts.runtime.runPipelineSpec(doc!.spec, { input, deadlineMs, maxCalls });
      return {
        status: 200,
        body: {
          ok: out.result.ok,
          elapsedMs: Date.now() - startedAt,
          timedOut: out.result.timedOut,
          result: out.result,
          excludedModels: out.excludedModels,
        },
      };
    }

    /* ---------- POST /v1/admin/session/login：登录签发会话（M3.1，免鉴权） ---------- */
    if (path === '/v1/admin/session/login' && method === 'POST') {
      if (!opts.users || !opts.sessions) httpErr(404, 'not_configured', '本管理面未装配用户/会话存储');
      if (loginThrottled()) {
        httpErr(429, 'too_many_attempts', '登录失败次数过多，请 1 分钟后重试');
      }
      const body = parseJson(raw) as Record<string, unknown>;
      const username = typeof body['username'] === 'string' ? body['username'] : '';
      const password = typeof body['password'] === 'string' ? body['password'] : '';
      if (!username || !password || username.length > 64 || password.length > 128) {
        recordLoginFailure();
        httpErr(400, 'malformed', '请求体必须形如 {username, password}');
      }
      const user = opts.users.authenticate(username, password);
      if (!user) {
        recordLoginFailure();
        /* 与既有前端契约一致：HTTP 200 + success:false（不泄露用户名存在性） */
        return { status: 200, body: { success: false, msg: '账号或密码错误' } };
      }
      loginFailures = [];
      const session = opts.sessions.issue(user.id, user.username, user.role);
      return {
        status: 200,
        body: {
          success: true,
          data: {
            avatar: '',
            username: user.username,
            nickname: user.nickname || ROLE_NICKNAME[user.role],
            roles: [user.role],
            permissions: permissionsOfRole(user.role),
            accessToken: session.token,
            refreshToken: session.refreshToken,
            expires: session.expiresAt,
          },
        },
      };
    }

    /* ---------- POST /v1/admin/session/refresh-token：刷新并轮换（免鉴权） ---------- */
    if (path === '/v1/admin/session/refresh-token' && method === 'POST') {
      if (!opts.users || !opts.sessions) httpErr(404, 'not_configured', '本管理面未装配用户/会话存储');
      const body = parseJson(raw) as Record<string, unknown>;
      const refreshToken = typeof body['refreshToken'] === 'string' ? body['refreshToken'] : '';
      const fresh = refreshToken ? opts.sessions.refresh(refreshToken) : null;
      if (!fresh) {
        /* 与既有前端 Mock 契约一致：HTTP 200 + success:false */
        return { status: 200, body: { success: false, data: {} } };
      }
      return {
        status: 200,
        body: {
          success: true,
          data: {
            accessToken: fresh.token,
            refreshToken: fresh.refreshToken,
            expires: fresh.expiresAt,
          },
        },
      };
    }

    /* ---------- POST /v1/admin/session/logout：吊销当前会话 ---------- */
    if (path === '/v1/admin/session/logout' && method === 'POST') {
      if (!opts.sessions) httpErr(404, 'not_configured', '本管理面未装配会话存储');
      const token = headerOf(req, 'x-admin-session');
      if (!token) httpErr(400, 'malformed', '缺少 x-admin-session（主令牌无会话可吊销）');
      opts.sessions.revoke(token);
      return { status: 200, body: { success: true } };
    }

    /* ---------- GET /v1/admin/session/me：当前身份 ---------- */
    if (path === '/v1/admin/session/me' && method === 'GET') {
      if (!identity) httpErr(401, 'unauthorized', '未认证');
      if (identity.kind === 'master') {
        return {
          status: 200,
          body: {
            username: '(master-token)',
            nickname: '服务端注入令牌',
            role: 'admin',
            permissions: ['*:*:*'],
            expiresAt: null,
          },
        };
      }
      const s = identity.session;
      return {
        status: 200,
        body: {
          username: s.username,
          nickname: opts.users?.list().find((u) => u.id === s.userId)?.nickname || ROLE_NICKNAME[s.role],
          role: s.role,
          permissions: permissionsOfRole(s.role),
          expiresAt: s.expiresAt,
        },
      };
    }

    /* ---------- GET /v1/admin/system/users：用户清单 [system:manage] ---------- */
    if (path === '/v1/admin/system/users' && method === 'GET') {
      requirePerm('system:manage');
      if (!opts.users) httpErr(404, 'not_configured', '本管理面未装配用户存储');
      let list = opts.users.list();
      const keyword = url.searchParams.get('keyword');
      if (keyword) list = list.filter((u) => u.username.includes(keyword) || u.nickname.includes(keyword));
      const role = url.searchParams.get('role');
      if (role) list = list.filter((u) => u.role === role);
      const status = url.searchParams.get('status');
      if (status) list = list.filter((u) => u.status === status);
      const { page, pageSize } = pageParams(url);
      return {
        status: 200,
        body: { total: list.length, page, pageSize, list: list.slice((page - 1) * pageSize, page * pageSize) },
      };
    }

    /* ---------- POST /v1/admin/system/users：创建用户 [system:manage] ---------- */
    if (path === '/v1/admin/system/users' && method === 'POST') {
      requirePerm('system:manage');
      if (!opts.users) httpErr(404, 'not_configured', '本管理面未装配用户存储');
      const body = parseJson(raw) as Record<string, unknown>;
      const username = body['username'];
      const password = body['password'];
      if (typeof username !== 'string' || typeof password !== 'string') {
        httpErr(400, 'malformed', '请求体必须形如 {username, password, nickname?, role, remark?}');
      }
      if (!isAdminRole(body['role'])) httpErr(400, 'malformed', `role 必须是 admin|operator|viewer，收到 '${String(body['role']).slice(0, 32)}'`);
      UserStore.validateNewPassword(password);
      try {
        const user = opts.users.create({
          username,
          password,
          role: body['role'],
          nickname: typeof body['nickname'] === 'string' ? body['nickname'] : undefined,
          remark: typeof body['remark'] === 'string' ? body['remark'] : undefined,
        });
        return { status: 201, body: { user } };
      } catch (e) {
        if (e instanceof UserStoreError) httpErr(400, 'malformed', e.message);
        throw e;
      }
    }

    /* ---------- PUT /v1/admin/system/users/:id：改资料/角色/状态/重置口令 [system:manage] ---------- */
    const userUpdateMatch = path.match(/^\/v1\/admin\/system\/users\/([^/]+)$/);
    if (userUpdateMatch && method === 'PUT') {
      requirePerm('system:manage');
      if (!opts.users) httpErr(404, 'not_configured', '本管理面未装配用户存储');
      const id = decodeURIComponent(userUpdateMatch[1]!);
      const body = parseJson(raw) as Record<string, unknown>;
      const patch: Parameters<UserStore['update']>[1] = {};
      if (body['nickname'] !== undefined) patch.nickname = body['nickname'] as string;
      if (body['remark'] !== undefined) patch.remark = body['remark'] as string;
      if (body['role'] !== undefined) {
        if (!isAdminRole(body['role'])) httpErr(400, 'malformed', `role 必须是 admin|operator|viewer，收到 '${String(body['role']).slice(0, 32)}'`);
        patch.role = body['role'];
      }
      if (body['status'] !== undefined) patch.status = body['status'] as 'active' | 'disabled';
      if (body['password'] !== undefined) UserStore.validateNewPassword(body['password']);
      patch.password = body['password'] as string | undefined;
      try {
        const user = opts.users.update(id, patch);
        /* 停用或重置口令 → 立即吊销该用户全部会话（改权限同理不让旧会话延续） */
        if (body['status'] === 'disabled' || body['password'] !== undefined || body['role'] !== undefined) {
          opts.sessions?.revokeUser(user.id);
        }
        return { status: 200, body: { user } };
      } catch (e) {
        if (e instanceof UserStoreError) httpErr(400, 'malformed', e.message);
        throw e;
      }
    }

    /* ---------- GET /v1/admin/system/permissions：权限码目录与三档角色（只读） ---------- */
    if (path === '/v1/admin/system/permissions' && method === 'GET') {
      return {
        status: 200,
        body: {
          catalog: PERMISSION_CATALOG,
          roles: (['admin', 'operator', 'viewer'] as const).map((name) => ({
            name,
            nickname: ROLE_NICKNAME[name],
            description:
              name === 'admin'
                ? '拥有全部权限（*:*:*）'
                : name === 'operator'
                  ? '可操作世界与命令，可读写记忆，可查看监控'
                  : '只读：世界、记忆、监控',
            permissions: [...permissionsOfRole(name)],
            builtin: true,
          })),
        },
      };
    }

    /* ---------- GET /v1/admin/system/settings：设置目录与当前值 ---------- */
    if (path === '/v1/admin/system/settings' && method === 'GET') {
      if (!opts.settings) httpErr(404, 'not_configured', '本管理面未装配设置存储');
      return { status: 200, body: opts.settings.list() };
    }

    /* ---------- PUT /v1/admin/system/settings/:key：更新设置 [system:manage] ---------- */
    const settingMatch = path.match(/^\/v1\/admin\/system\/settings\/([^/]+)$/);
    if (settingMatch && method === 'PUT') {
      requirePerm('system:manage');
      if (!opts.settings) httpErr(404, 'not_configured', '本管理面未装配设置存储');
      const key = decodeURIComponent(settingMatch[1]!);
      const body = parseJson(raw) as Record<string, unknown>;
      try {
        const row = opts.settings.set(key, body['value']);
        return { status: 200, body: { row } };
      } catch (e) {
        httpErr(400, 'malformed', e instanceof Error ? e.message : String(e));
      }
    }

    /* ---------- GET /v1/obs/logs：平台请求日志（M4.1 · M2.2 数据面投影） ---------- */
    if (path === '/v1/obs/logs' && method === 'GET') {
      if (!opts.usage) httpErr(404, 'not_configured', '本管理面未装配用量数据面');
      const sp = url.searchParams;
      const level = sp.get('level');
      if (level && !['info', 'warn', 'error'].includes(level)) httpErr(400, 'malformed', `level 只接受 info|warn|error，收到 '${level.slice(0, 32)}'`);
      const world = sp.get('world') ?? undefined;
      const q = (sp.get('q') ?? '').toLowerCase() || undefined;
      const levelOf = (status: number): string => (status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info');
      let entries = opts.usage.readAll().filter((e) => {
        if (level && levelOf(e.status) !== level) return false;
        if (world && (e.worldId ?? '') !== world) return false;
        if (q && !e.path.toLowerCase().includes(q) && !e.requestId.includes(q)) return false;
        return true;
      });
      entries.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      const { page, pageSize } = pageParams(url);
      return {
        status: 200,
        body: {
          total: entries.length,
          page,
          pageSize,
          list: entries.slice((page - 1) * pageSize, page * pageSize).map((e) => ({
            id: e.requestId,
            time: e.ts,
            level: levelOf(e.status),
            service: 'platform',
            worldId: e.worldId ?? null,
            requestId: e.requestId,
            kind: e.kind,
            keyId: e.keyId,
            status: e.status,
            message: `${e.method} ${e.path} -> ${e.status} ${e.latencyMs}ms`,
          })),
        },
      };
    }

    /* ---------- GET /v1/obs/events：跨世界事件流（M4.1 · 引擎只读聚合） ---------- */
    if (path === '/v1/obs/events' && method === 'GET') {
      const sp = url.searchParams;
      const world = sp.get('world') ?? undefined;
      const rawN = Number(sp.get('n') ?? 20);
      const n = Number.isFinite(rawN) ? Math.min(Math.max(Math.floor(rawN), 1), 100) : 20;
      const worldsRes = await opts.runtime.engine.proxy('GET', '/v1/worlds');
      const worlds = (worldsRes.body as { worlds?: { worldId: string }[] })?.worlds ?? [];
      const targets = world ? [world] : worlds.map((w) => w.worldId).slice(0, 16);
      const rows: Record<string, unknown>[] = [];
      for (const wid of targets) {
        const res = await opts.runtime.engine.getEvents(wid, n);
        if (res.ok) {
          for (const e of res.events as Record<string, unknown>[]) {
            rows.push({ worldId: wid, ...e });
          }
        }
      }
      rows.sort((a, b) => {
        const da = Number(a['day'] ?? 0);
        const db = Number(b['day'] ?? 0);
        if (da !== db) return db - da;
        return Number(b['tick'] ?? 0) - Number(a['tick'] ?? 0);
      });
      return { status: 200, body: { worlds: targets, total: rows.length, events: rows.slice(0, 500) } };
    }

    /* ---------- GET /v1/obs/errors：失败请求登记（M4.1 · M2.2 数据面投影，只读） ---------- */
    if (path === '/v1/obs/errors' && method === 'GET') {
      if (!opts.usage) httpErr(404, 'not_configured', '本管理面未装配用量数据面');
      const sp = url.searchParams;
      const world = sp.get('world') ?? undefined;
      const kind = sp.get('kind');
      if (kind && kind !== 'chat' && kind !== 'worlds' && kind !== 'embeddings') httpErr(400, 'malformed', `kind 只接受 chat|worlds|embeddings，收到 '${kind.slice(0, 32)}'`);
      let entries = opts.usage.readAll().filter((e) => {
        if (e.status < 400) return false;
        if (world && (e.worldId ?? '') !== world) return false;
        if (kind && e.kind !== kind) return false;
        return true;
      });
      entries.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      const { page, pageSize } = pageParams(url);
      return {
        status: 200,
        body: {
          total: entries.length,
          page,
          pageSize,
          list: entries.slice((page - 1) * pageSize, page * pageSize).map((e) => ({
            id: e.requestId,
            time: e.ts,
            service: 'platform',
            worldId: e.worldId ?? null,
            kind: e.kind,
            keyId: e.keyId,
            method: e.method,
            path: e.path,
            type: e.error ?? `http_${e.status}`,
            message: `${e.method} ${e.path} -> ${e.status}${e.error ? `（${e.error}）` : ''}`,
          })),
        },
      };
    }

    /* ---------- GET /v1/obs/overview：Dashboard 聚合（M4.1） ---------- */
    if (path === '/v1/obs/overview' && method === 'GET') {
      if (!opts.usage) httpErr(404, 'not_configured', '本管理面未装配用量数据面');
      const now = Date.now();
      const from24 = new Date(now - 24 * 3600_000).toISOString();
      const from12 = now - 12 * 3600_000;
      const all = opts.usage.readAll();
      const chat24 = all.filter((e) => e.kind === 'chat' && e.ts >= from24);
      const ok24 = chat24.filter((e) => e.status < 400).length;
      const providerOf = (modelId: string | undefined): string | null => {
        if (!modelId || modelId === 'world-agent') return null;
        return opts.runtime.config.models.find((m) => m.id === modelId)?.providerId ?? null;
      };
      const providers = new Map<string, number>();
      for (const e of chat24) {
        const p = providerOf(e.route === 'proxy' ? e.model : e.modelUsed) ?? '—';
        providers.set(p, (providers.get(p) ?? 0) + 1);
      }
      /* 12 个整点小时桶（UTC，与记录时间戳同源） */
      const buckets = new Map<string, number>();
      for (const e of chat24) {
        const t = Date.parse(e.ts);
        if (t < from12) continue;
        const d = new Date(t);
        const label = `${String(d.getUTCHours()).padStart(2, '0')}:00`;
        buckets.set(label, (buckets.get(label) ?? 0) + 1);
      }
      const hourly: { hour: string; calls: number }[] = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now - i * 3600_000);
        const label = `${String(d.getUTCHours()).padStart(2, '0')}:00`;
        hourly.push({ hour: label, calls: buckets.get(label) ?? 0 });
      }
      const errors = all
        .filter((e) => e.status >= 400)
        .sort((a, b) => (a.ts < b.ts ? 1 : -1))
        .slice(0, 5)
        .map((e) => ({
          id: e.requestId,
          time: e.ts,
          type: e.error ?? `http_${e.status}`,
          message: `${e.method} ${e.path} -> ${e.status}${e.error ? `（${e.error}）` : ''}`,
        }));
      let worlds = { total: 0, running: 0, paused: 0 };
      let entities = 0;
      try {
        const worldsRes = await opts.runtime.engine.proxy('GET', '/v1/worlds');
        const list = (worldsRes.body as { worlds?: { entities?: number; status?: string }[] })?.worlds ?? [];
        worlds = {
          total: list.length,
          running: list.filter((w) => (w.status ?? 'running') === 'running').length,
          paused: list.filter((w) => w.status === 'paused').length,
        };
        entities = list.reduce((s, w) => s + (w.entities ?? 0), 0);
      } catch {
        /* 引擎不可达：世界字段诚实为零值（前端已有引擎直读卡兜底） */
      }
      return {
        status: 200,
        body: {
          generatedAt: new Date(now).toISOString(),
          worlds,
          entities,
          ai: {
            requests24h: chat24.length,
            tokens24h: chat24.reduce((s, e) => s + (e.totalTokens ?? 0), 0),
            successRate: chat24.length ? Number(((ok24 / chat24.length) * 100).toFixed(1)) : 100,
            byProvider: [...providers.entries()].map(([provider, requests]) => ({ provider, requests })).sort((a, b) => b.requests - a.requests),
            hourly,
          },
          recentErrors: errors,
        },
      };
    }

    /* ---------- Runtime 统一观测面（P9 · 方案 §十二：Admin 的数据面，不是 CRUD） ----------
       GET /v1/admin/runtime：World Runtime / Evolution / Events / NPC Runtime /
       AI Calls / Causal Trace 的单点入口——各子系统的运行真相聚合在这里，
       管理台/运维/审计从这一个端点看「世界现在是什么状态、为什么」。 */
    if (path === '/v1/admin/runtime' && method === 'GET') {
      const worldsRes = await opts.runtime.engine.proxy('GET', '/v1/worlds');
      const worlds = (worldsRes.body as { worlds?: Record<string, unknown>[] })?.worlds ?? [];
      const evo = opts.evolution;
      const evolution = evo
        ? {
            worlds: [...new Set([...evo.knownWorlds(), ...worlds.map((w) => w['worldId']).filter((v): v is string => typeof v === 'string')])].map((id) => {
              const latest = evo.runs(id, 1)[0] ?? null;
              return {
                worldId: id,
                runsTotal: evo.runs(id, 200).length,
                latestRun: latest
                  ? {
                      id: latest.id,
                      status: latest.status,
                      trigger: latest.trigger,
                      triggerGrade: latest.triggerGrade ?? null,
                      modelUsed: latest.modelUsed ?? null,
                      finishedAt: latest.finishedAt ?? null,
                      accepted: latest.acceptedCount ?? 0,
                      rejected: latest.rejectedCount ?? 0,
                    }
                  : null,
              };
            }),
          }
        : null;
      return {
        status: 200,
        body: {
          generatedAt: new Date().toISOString(),
          worlds,
          evolution,
          ...(opts.triggerRuntime ? { trigger: opts.triggerRuntime.status() } : {}),
          ...(opts.scheduleRuntime ? { schedule: opts.scheduleRuntime.status() } : {}),
          ...(opts.memoryRuntime || opts.memoryService
            ? {
                memory: {
                  ...(opts.memoryRuntime ? { runtime: opts.memoryRuntime.status() } : {}),
                  ...(opts.memoryService
                    ? {
                        stats: opts.memoryService.worlds().map((worldId) => opts.memoryService!.stats(worldId)),
                        writeFailures: opts.memoryService.writeFailures(),
                      }
                    : {}),
                },
              }
            : {}),
          pointers: {
            aiCalls: '/v1/obs/overview（AI 汇总/小时桶/最近错误）',
            causalTrace: '/v1/evolution/worlds/:id/events/:eventId/trace（因果链）',
            evolutionRuns: '/v1/evolution/worlds/:id/runs',
          },
        },
      };
    }

    /* ---------- NPC 日程注册（P6 · 方案 §九：作息数据归宿主，确定性执行归平台） ----------
       GET    /v1/npc/worlds/:id/schedules  当前日程表
       PUT    /v1/npc/worlds/:id/schedules  整表注册/覆盖（游戏方是日程的唯一作者）[gateway:manage]
       DELETE /v1/npc/worlds/:id/schedules  清除
       未装配 scheduleStore → 404 not_configured（与 keys/usage 同姿态）。 */
    const npcSchedMatch = path.match(/^\/v1\/npc\/worlds\/([^/]+)\/schedules$/);
    if (npcSchedMatch) {
      if (!opts.scheduleStore) httpErr(404, 'not_configured', '本管理面未装配 NPC 日程存储');
      const worldId = decodeURIComponent(npcSchedMatch[1]!);
      const store = opts.scheduleStore;
      if (method === 'GET') {
        const table = store.get(worldId);
        return { status: 200, body: { worldId, ...(table ? { schedules: table } : { schedules: null }) } };
      }
      if (method === 'PUT') {
        requirePerm('gateway:manage');
        const clean = sanitizeScheduleTable(parseJson(raw ?? Buffer.from('{}')));
        if (!clean) httpErr(400, 'bad_schedule', '日程表形状非法（需 {npcId: [{from,to,location}...]}，0<=from<to<=48）');
        store.set(worldId, clean);
        return { status: 200, body: { worldId, schedules: clean } };
      }
      if (method === 'DELETE') {
        requirePerm('gateway:manage');
        const removed = store.delete(worldId);
        return { status: 200, body: { worldId, removed } };
      }
      httpErr(405, 'method_not_allowed', '仅 GET / PUT / DELETE');
    }

    /* ---------- AI World Evolution Runtime（Phase C：演化控制台数据面） ----------
       GET  /v1/evolution/worlds                 有演化账本的世界清单
       POST /v1/evolution/worlds/:id/tick        触发一次演化闭环 [gateway:manage]
       GET  /v1/evolution/worlds/:id/runs        运行留痕清单（新 → 旧）
       GET  /v1/evolution/worlds/:id/runs/:rid   单次运行完整因果链
       POST /v1/evolution/worlds/:id/intent      意图处置（OOC 隔离闸）[gateway:manage]
       未装配 evolution 运行时 → 404 not_configured（与 keys/usage 同姿态）。 */
    if (path === '/v1/evolution/worlds' && method === 'GET') {
      if (!opts.evolution) httpErr(404, 'not_configured', '本管理面未装配演化运行时');
      const worldsRes = await opts.runtime.engine.proxy('GET', '/v1/worlds');
      const list = (worldsRes.body as { worlds?: { worldId?: string }[] })?.worlds ?? [];
      const engineIds = new Set(list.map((w) => w.worldId).filter((v): v is string => typeof v === 'string'));
      const evo = opts.evolution;
      const ids = [...new Set([...evo.knownWorlds(), ...engineIds])];
      return {
        status: 200,
        body: {
          worlds: ids.map((id) => {
            const latest = evo.runs(id, 1)[0] ?? null;
            return {
              worldId: id,
              inEngine: engineIds.has(id),
              hasRuns: latest !== null,
              latestRunStatus: latest?.status ?? null,
            };
          }),
        },
      };
    }

    const evoWorldMatch = path.match(/^\/v1\/evolution\/worlds\/([^/]+)$/);
    const evoRunsMatch = path.match(/^\/v1\/evolution\/worlds\/([^/]+)\/runs$/);
    const evoRunMatch = path.match(/^\/v1\/evolution\/worlds\/([^/]+)\/runs\/([^/]+)$/);
    const evoTickMatch = path.match(/^\/v1\/evolution\/worlds\/([^/]+)\/tick$/);
    const evoIntentMatch = path.match(/^\/v1\/evolution\/worlds\/([^/]+)\/intent$/);
    const evoTraceMatch = path.match(/^\/v1\/evolution\/worlds\/([^/]+)\/events\/([^/]+)\/trace$/);

    if (evoWorldMatch || evoRunsMatch || evoRunMatch || evoTickMatch || evoIntentMatch || evoTraceMatch) {
      if (!opts.evolution) httpErr(404, 'not_configured', '本管理面未装配演化运行时');
      const evo = opts.evolution;
      const worldId = decodeURIComponent((evoWorldMatch ?? evoRunsMatch ?? evoRunMatch ?? evoTickMatch ?? evoIntentMatch ?? evoTraceMatch)![1]!);

      /* ---------- GET .../events/:eventId/trace：Event 反向追溯因果链（V2 §九） ---------- */
      if (evoTraceMatch && method === 'GET') {
        const eventId = decodeURIComponent(evoTraceMatch[2]!);
        const hit = evo.traceEvent(worldId, eventId);
        if (!hit) httpErr(404, 'trace_not_found', `事件 '${eventId}' 不在演化账本中（可能不是演化产生的，或账本窗口外）`);
        /* P9 · 方案 §十二：因果链完整呈现——World Event → Trigger → Context →
           Model → Proposal → Validation → Command → Mutation → New Event。
           全部来自 run 留痕，不补叙事。 */
        const run = hit.run;
        const outcomes = run.outcomes ?? [];
        const chain = [
          { step: 'trigger', detail: `${run.trigger}${run.triggerGrade ? `（分级 ${run.triggerGrade}）` : ''}${run.wakePlan ? `；唤醒 ${(run.wakePlan.wakes ?? []).filter((w) => w.grade === 'high').map((w) => w.entityId).join('/') || '无'}` : ''}` },
          ...(run.context
            ? [{
                step: 'context',
                detail: `D${run.context.day} 刻${run.context.tick} @ ${run.context.location?.id ?? '-'}；在场 ${Object.keys(run.context.entities).length}；事实 ${run.context.events.length} 条${
                  run.context.memory?.length ? `；记忆 ${run.context.memory.length} 条` : ''
                }${run.context.budgetReport ? `；预算估算 ${run.context.budgetReport.estimatedTokens} tokens` : ''}`,
              }]
            : []),
          ...(run.modelUsed ? [{ step: 'model', detail: run.modelUsed }] : []),
          ...(run.proposal ? [{ step: 'proposal', detail: `${run.proposal.id}：${run.proposal.reason}（${run.proposal.changes.length} 条变化）` }] : []),
          ...(outcomes.length
            ? [{
                step: 'validation',
                detail: outcomes
                  .map((o) => `${o.change.targetId}.${o.change.action} → ${o.status}${o.rejectedBy ? `（${o.rejectedBy}）` : ''}`)
                  .join('；'),
              }]
            : []),
          ...(outcomes.some((o) => o.commandId)
            ? [{ step: 'command', detail: outcomes.filter((o) => o.commandId).map((o) => `${o.commandId}=${o.change.action}`).join('；') }]
            : []),
          ...(run.entitiesAffected?.length ? [{ step: 'mutation', detail: run.entitiesAffected.join('/') }] : []),
          ...(run.eventIds.length ? [{ step: 'new_events', detail: run.eventIds.join(',') }] : []),
        ];
        return { status: 200, body: { ...hit, chain } };
      }


      if (evoTickMatch && method === 'POST') {
        requirePerm('gateway:manage');
        const trigger = parseJson(raw ?? Buffer.from('{}')) as { trigger?: unknown; idempotencyKey?: unknown };
        const t = trigger?.trigger === 'api' || trigger?.trigger === 'auto' ? trigger.trigger : 'admin';
        const idempotencyKey = typeof trigger?.idempotencyKey === 'string' && trigger.idempotencyKey.length <= 128 ? trigger.idempotencyKey : undefined;
        try {
          const run = await evo.tick(worldId, t, idempotencyKey ? { idempotencyKey } : undefined);
          return { status: 200, body: run };
        } catch (e) {
          if (e instanceof Error && e.message.includes('演化冷却中')) {
            httpErr(429, 'evolution_cooldown', e.message);
          }
          throw e;
        }
      }
      if (evoIntentMatch && method === 'POST') {
        requirePerm('gateway:manage');
        const body = parseJson(raw) as { kind?: unknown; text?: unknown; actorId?: unknown; command?: unknown };
        if (body?.kind !== 'ic_action' && body?.kind !== 'ooc' && body?.kind !== 'narrative') {
          httpErr(400, 'malformed', "kind 必须是 'ic_action' | 'ooc' | 'narrative'");
        }
        if (typeof body.text !== 'string' || body.text.length === 0 || body.text.length > 2000) {
          httpErr(400, 'malformed', 'text 必须是 1-2000 字符的字符串');
        }
        if (body.command !== undefined && (typeof body.command !== 'object' || body.command === null || Array.isArray(body.command))) {
          httpErr(400, 'malformed', 'command 必须是对象或缺省');
        }
        const cmd = body.command as Record<string, unknown> | undefined;
        if (cmd !== undefined && typeof cmd['type'] !== 'string') {
          httpErr(400, 'malformed', 'command.type 必须是字符串');
        }
        const outcome = await evo.dispatchIntent(worldId, {
          kind: body.kind,
          text: body.text,
          ...(typeof body.actorId === 'string' ? { actorId: body.actorId } : {}),
          ...(cmd !== undefined
            ? {
                command: {
                  type: cmd['type'] as string,
                  ...(cmd['targetId'] !== undefined ? { targetId: String(cmd['targetId']) } : {}),
                  ...(typeof cmd['amount'] === 'number' ? { amount: cmd['amount'] as number } : {}),
                  ...(cmd['text'] !== undefined ? { text: String(cmd['text']) } : {}),
                  ...(cmd['payload'] !== undefined && typeof cmd['payload'] === 'object' && !Array.isArray(cmd['payload'])
                    ? { payload: cmd['payload'] as Record<string, unknown> }
                    : {}),
                },
              }
            : {}),
        });
        return { status: 200, body: outcome };
      }
      if (evoRunsMatch && method === 'GET') {
        const sp = url.searchParams;
        const nRaw = Number(sp.get('n') ?? 20);
        const n = Number.isFinite(nRaw) ? Math.max(1, Math.min(200, Math.floor(nRaw))) : 20;
        return { status: 200, body: { worldId, runs: evo.runs(worldId, n) } };
      }
      if (evoRunMatch && method === 'GET') {
        const run = evo.run(worldId, decodeURIComponent(evoRunMatch[2]!));
        if (!run) httpErr(404, 'run_not_found', `演化运行 '${evoRunMatch[2]}' 不在世界 '${worldId}' 的账本中`);
        return { status: 200, body: run };
      }
      if (evoWorldMatch && method === 'GET') {
        const runs = evo.runs(worldId, 50);
        return { status: 200, body: { worldId, runs } };
      }
    }

    /* ---------- 嵌入模型配置代理已删除（Embedding 配置统一治理） ----------
       唯一配置真相源 = Model Router（/v1/admin/model-config 的
       routes.embedding）；路由实况见 GET /v1/admin/routes/embedding，
       语义实测见 POST /v1/admin/routes/embedding/test（embed 语义）。
       原 /v1/admin/memory/embedding-config[/test] 鉴权代理随 memory
       服务配置端点一并下线。 */

    httpErr(404, 'not_found', `no such admin route: ${method} ${path}`);
  }

  const server: Server = createServer((req, res) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    res.setHeader('x-request-id', requestId);
    res.setHeader('cache-control', 'no-store');

    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        if (aborted) return;
        aborted = true;
        respond(res, 413, { error: { code: 'payload_too_large', message: '请求体超过 1 MiB 上限' } });
        /* 丢弃余量并排空连接（不提前 destroy，避免截断已写出的 413 响应） */
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        req.resume();
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (aborted) return;
      handle(req, url, Buffer.concat(chunks))
        .then((out) => {
          respond(res, out.status, out.body);
          logLine(accessLog, req.method, url.pathname, requestId, out.status, startedAt);
        })
        .catch((e: unknown) => {
          const out = normalizeError(e);
          respond(res, out.status, out.body);
          logLine(accessLog, req.method, url.pathname, requestId, out.status, startedAt);
        });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8791, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 8791);
      resolve({
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

/* ---------------- 辅助 ---------------- */

/** Key 脱敏投影：绝不外露 keyHash（不可逆也是秘密——不给人可比对的材料） */
function maskedKeyRow(rec: ApiKeyRecord): Record<string, unknown> {
  return {
    id: rec.id,
    name: rec.name,
    tenantId: rec.tenantId,
    prefix: rec.prefix,
    permissions: rec.permissions,
    /* 存量记录（G2 之前）缺 gameId → 归一为 null（平台管理钥匙） */
    gameId: rec.gameId ?? null,
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    lastUsedAt: rec.lastUsedAt,
  };
}

/** 权限校验：省略 = 平台缺省全量；显式空数组拒绝（防「全不勾 → 意外拿到全量」） */
function validateKeyPermissions(input: unknown): PlatformPermission[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) httpErr(400, 'malformed', 'permissions 必须是字符串数组');
  if (input.length === 0) {
    httpErr(400, 'malformed', 'permissions 不能是空数组（要缺省全量请省略该字段）');
  }
  for (const p of input) {
    if (typeof p !== 'string' || !(PLATFORM_PERMISSIONS as readonly string[]).includes(p)) {
      httpErr(400, 'malformed', `未知权限 '${String(p).slice(0, 32)}'（可用：${PLATFORM_PERMISSIONS.join('/')}）`);
    }
  }
  return input as PlatformPermission[];
}

/** 分页参数：默认第 1 页、每页 50；上限由调用方给（usage 500，keys 200） */
function pageParams(url: URL, cap = 200): { page: number; pageSize: number } {
  const rawPage = url.searchParams.get('page');
  const rawSize = url.searchParams.get('page_size');
  let page = 1;
  let pageSize = 50;
  if (rawPage !== null) {
    const n = Number(rawPage);
    if (!Number.isInteger(n) || n < 1) httpErr(400, 'malformed', `page 必须是正整数，收到 '${rawPage.slice(0, 32)}'`);
    page = n;
  }
  if (rawSize !== null) {
    const n = Number(rawSize);
    if (!Number.isInteger(n) || n < 1 || n > cap) httpErr(400, 'malformed', `page_size 必须是 1-${cap} 的整数，收到 '${rawSize.slice(0, 32)}'`);
    pageSize = n;
  }
  return { page, pageSize };
}

function headerOf(req: ReqLike, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function requireIfMatch(req: ReqLike): number {
  const raw = headerOf(req, 'if-match');
  if (raw === undefined || raw === '') {
    httpErr(400, 'malformed', '缺少 If-Match 头（当前 revision 乐观锁）');
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    httpErr(400, 'malformed', `If-Match 必须是非负整数 revision，收到 '${String(raw).slice(0, 32)}'`);
  }
  return n;
}

function parseJson(raw: Buffer): unknown {
  if (raw.length === 0) httpErr(400, 'malformed', '请求体不能为空');
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    httpErr(400, 'malformed', '请求体不是合法 JSON');
  }
}

/** 领域错误 → HTTP：冲突 409 / 校验 422（带逐条 issues）/ 其余 500 */
function normalizeError(e: unknown): { status: number; body: unknown } {
  if (e instanceof AdminHttpError) {
    return {
      status: e.status,
      body: { error: { code: e.code, message: e.message, ...(e.extra ?? {}) } },
    };
  }
  if (e instanceof PipelineStoreError) {
    return {
      status: 422,
      body: { error: { code: 'invalid_configuration', message: e.message, issues: e.issues } },
    };
  }
  if (e instanceof UserStoreError) {
    return {
      status: 400,
      body: { error: { code: 'malformed', message: e.message } },
    };
  }
  if (e instanceof RevisionConflictError) {
    return {
      status: 409,
      body: { error: { code: 'revision_conflict', message: e.message, expected: e.expected, actual: e.actual } },
    };
  }
  if (e instanceof ConfigValidationError) {
    return {
      status: 422,
      body: { error: { code: 'invalid_configuration', message: e.message, issues: e.issues } },
    };
  }
  return { status: 500, body: { error: { code: 'internal_error', message: e instanceof Error ? e.message : String(e) } } };
}

/** 探测结果 → HTTP：成功 200；配置态问题 404/422/503；上游失败 502（均已脱敏） */
function probeResponse(out: ProbeResult): { status: number; body: unknown } {
  if (out.ok) {
    return {
      status: 200,
      body: {
        ok: true,
        modelId: out.modelId,
        elapsedMs: out.elapsedMs,
        reply: out.reply,
        /* embedding 语义探测附实测维度（chat 探测无此字段） */
        ...(out.dimension !== undefined ? { dimension: out.dimension } : {}),
      },
    };
  }
  const statusMap: Record<string, number> = {
    model_not_found: 404,
    provider_not_found: 422,
    no_credential: 422,
    not_resolvable: 422,
    no_model_configured: 503,
  };
  const status = statusMap[out.code ?? ''] ?? 502;
  return {
    status,
    body: {
      ok: false,
      modelId: out.modelId,
      elapsedMs: out.elapsedMs,
      error: { code: out.code ?? 'upstream_test_failed', message: out.message ?? '上游测试失败' },
    },
  };
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function logLine(
  enabled: boolean,
  method: string | undefined,
  path: string,
  requestId: string,
  status: number,
  startedAt: number,
): void {
  if (!enabled) return;
  console.log(
    `[admin] ${new Date().toISOString()} ${method ?? '-'} ${path} -> ${status} ${Date.now() - startedAt}ms ${requestId}`,
  );
}

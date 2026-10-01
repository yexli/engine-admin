/* ============================================================
   World Platform · 类型（Phase 1 · 平台 API 标准化 / 方案 §6）
   ------------------------------------------------------------
   平台层是「公共入口」：外部应用只认识
     Base URL + API Key + model
   平台负责 鉴权 → 分层（Public/Admin/Internal）→ 任务分析 →
   能力路由 → 世界上下文 → 网关模型调用 → 结果整合。

   边界（方案 §4 / §37）：
   · 不重写 World Engine / Gateway / Memory——平台只做组合与编排；
   · Admin API 本阶段只定义形状（501），管理面真实化在后续阶段；
   · world-agent 是平台级虚拟模型：客户端永远不需要知道底层厂商。
   ============================================================ */

/* ---------------- API Key（方案 §7-8 的最小可行子集） ---------------- */

/** 公共 API 权限码（与 docs/ADMIN-PERMISSION.md 的权限模型同族，平台侧子集） */
export type PlatformPermission =
  | 'chat:completions'
  | 'worlds:read'
  | 'worlds:write';

export const PLATFORM_PERMISSIONS: readonly PlatformPermission[] = [
  'chat:completions',
  'worlds:read',
  'worlds:write',
];

/** 密钥记录：明文只在创建时返回一次；落盘只存 SHA-256 哈希与展示前缀。
 *  生命周期只有两层：过期时间（可设可清）与删除（硬删，记录移除）。 */
export interface ApiKeyRecord {
  id: string;
  name: string;
  /** Phase 2 将引入完整 Tenant 体系；Phase 1 统一挂 default 租户（前向兼容字段） */
  tenantId: string;
  /** sha256(hex) */
  keyHash: string;
  /** 展示用前缀（如 sk-world-ab12），不可反推明文 */
  prefix: string;
  permissions: PlatformPermission[];
  /** 归属游戏方（G2 多游戏托管）：非空 = 该 Key 是这把游戏方的世界 API 钥匙；
   *  与引擎 auth 中间件的 WorldAuthKey.gameId 对齐。null = 平台管理钥匙 */
  gameId: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/* ---------------- 模型路由（方案 §13-14 的最小可行子集） ---------------- */

/** 平台能力标签（§12 集合的 Phase 1 子集；Phase 4 产品化） */
export type Capability =
  | 'roleplay'
  | 'narrative'
  | 'reasoning'
  | 'fast'
  | 'cheap'
  | 'memory';

export interface CapabilityRoute {
  /** 主模型（= Gateway 能力通道名）；null = 未配置（→ 503 可诊断） */
  primary: string | null;
  /** 备用模型；主模型失败时自动接管 */
  fallback: string | null;
}

/** 路由文件形状（platform/data/router.json） */
export interface RouterConfig {
  version: 1;
  routes: Partial<Record<Capability, CapabilityRoute>>;
}

/* ---------------- world-agent 管线（方案 §20 / §38 最小闭环） ---------------- */

export interface TaskAnalysis {
  capability: Capability;
  /** 判定依据（可观测；随响应回传便于调试） */
  reason: string;
}

export interface WorldAgentResult {
  text: string;
  analysis: TaskAnalysis;
  modelUsed: string;
  fallbackUsed: boolean;
  worldId: string | null;
}

/* ---------------- 请求 / 响应（协议适配器形状，同 engine/gateway 惯例） ---------------- */

/** 已解析的 HTTP 请求（传输层负责解析 URL / query / JSON body） */
export interface PlatformRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  /** 传输层生成的请求 ID（用量记录与访问日志凭它对账，M2.2） */
  requestId?: string;
}

/** JSON 响应 */
export interface JsonResponse {
  kind: 'json';
  status: number;
  body: unknown;
}

/** 流式透传响应（非 world-agent 模型的原样代理，含 SSE） */
export interface StreamResponse {
  kind: 'stream';
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
  /** 计量元数据（M2.2）：流在传输层泵完才产生时延，由 server.ts 代记 */
  usageMeta?: { keyId: string; tenantId: string; model: string; gameId?: string | null };
}

export type PlatformResponse = JsonResponse | StreamResponse;

/* ---------------- 组合接口（依赖注入；测试用假实现替换） ---------------- */

export interface EngineClient {
  /** 透传任意引擎请求（worlds 系列代理用） */
  proxy(
    method: string,
    pathWithQuery: string,
    body?: unknown
  ): Promise<{ status: number; body: unknown }>;
  /** world-agent 内部取世界状态（GET /v1/worlds/{id}/state） */
  getState(worldId: string): Promise<{ ok: true; state: unknown } | { ok: false; status: number; error: string }>;
  /** world-agent 内部取最近世界事实 */
  getEvents(worldId: string, n: number): Promise<{ ok: true; events: unknown[] } | { ok: false; status: number; error: string }>;
  /** 演化运行时提交命令（POST /v1/worlds/{id}/commands；命令链结果原样返回） */
  executeCommand(
    worldId: string,
    cmd: { type: string; actorId?: string; targetId?: string; amount?: number; text?: string; payload?: Record<string, unknown> },
  ): Promise<
    | { ok: true; result: { ok: boolean; events: string[]; reason?: string } }
    | { ok: false; status: number; error: string }
  >;
}

export interface GatewayChatOk {
  ok: true;
  text: string;
}

export interface GatewayChatFail {
  ok: false;
  status: number;
  error: string;
  /** 网关结构化错误码（如 upstream_credential_rejected）；用于区分配置错误与瞬时故障 */
  code?: string;
}

export interface GatewayClient {
  /** 非流式补全（world-agent 管线用） */
  chat(model: string, messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<GatewayChatOk | GatewayChatFail>;
  /** 原样透传（非 world-agent 模型的完整代理，含 SSE 流） */
  proxyChat(body: unknown): Promise<{ ok: true; status: number; headers: Record<string, string>; stream: ReadableStream<Uint8Array> } | { ok: false; status: number; error: string }>;
}

/** world-agent 上游通道缺失/失败时的错误码 */
export type PlatformErrorCode =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'no_model_configured'
  | 'upstream_error'
  | 'upstream_credential_rejected'
  | 'not_implemented';

/**
 * Model Control Plane 控制面客户端（真实 API，非 Mock）
 * ------------------------------------------------------------
 * 前端只访问同源 /control-api/v1/admin/*：Vite/Nginx 把它改写到
 * 私有管理监听（127.0.0.1:8791）并在服务端注入 x-admin-token——
 * 浏览器 JS 永远不持有管理令牌，也不经此客户端发送任何令牌头。
 *
 * 错误契约：非 2xx → ControlApiError（status/code/message/payload）。
 * 409 = revision 冲突（他人已保存），调用方应重新加载后重试。
 *
 * 本模块保持零框架依赖（纯 TS + fetch），便于脱离 Vue 单测。
 */

export const MANAGED_CAPABILITIES = [
  "roleplay",
  "narrative",
  "reasoning",
  "fast",
  "cheap",
  "memory"
] as const;

export type ManagedCapability = (typeof MANAGED_CAPABILITIES)[number];

/** 能力中文指代与语义（与 platform/src/tasks.ts 的任务分析规则对齐） */
export const CAPABILITY_META: Record<
  ManagedCapability,
  { zh: string; desc: string }
> = {
  roleplay: {
    zh: "角色扮演",
    desc: "携带世界上下文的请求缺省走此能力（world-agent 主通道：玩家 / NPC 世界内交互）"
  },
  narrative: {
    zh: "叙事生成",
    desc: "故事 / 剧情 / 叙述 / 描写类请求（任务分析按关键词命中）"
  },
  reasoning: {
    zh: "推理分析",
    desc: "问为什么 / 原因 / 分析 / 策略 / 推演类请求（任务分析按关键词命中）"
  },
  fast: {
    zh: "快速响应",
    desc: "无世界上下文的请求缺省走此能力；轻量、低延迟回复"
  },
  cheap: {
    zh: "低成本通道",
    desc: "成本敏感 / 批量任务；任务分析不会自动选中，供显式指定 capability 的调用方使用"
  },
  memory: {
    zh: "记忆总结",
    desc: "总结 / 摘要 / 记住 / 回忆类请求（任务分析按关键词命中）"
  }
};

export const ALLOWED_TAGS = [
  "fast",
  "cheap",
  "reasoning",
  "roleplay",
  "narrative",
  "memory",
  "embedding",
  "structured-output",
  "long-context"
] as const;

export interface AdminAuthView {
  kind: "secret" | "none";
  hasCredential: boolean;
}

export interface AdminProvider {
  id: string;
  name: string;
  endpoint: string;
  auth: AdminAuthView;
  enabled: boolean;
}

export interface AdminModel {
  id: string;
  providerId: string;
  wireModel: string;
  tags: string[];
  enabled: boolean;
  /** 思考强度（可选；服务端按 wireModel 前缀检测厂商并校验档位） */
  thinking?: string;
}

/** 思考强度元数据（服务端配置投影下发 → 前端零改动扩展） */
export interface ThinkingMeta {
  levels: string[];
  vendors: {
    id: string;
    label: string;
    match: string[];
    levels: string[];
    hints: Record<string, string>;
  }[];
}

/** 按 wireModel 前缀检测厂商（与服务端 vendors.ts 同一匹配语义的最小前端镜像） */
export function detectVendorOf(
  meta: ThinkingMeta | undefined,
  wireModel: string
): { id: string; label: string; levels: string[]; hints: Record<string, string> } {
  const w = wireModel.toLowerCase();
  const v =
    (meta?.vendors ?? []).find(x => x.match.some(m => w.startsWith(m.toLowerCase()))) ??
    (meta?.vendors ?? []).find(x => x.id === "generic") ?? {
      id: "generic",
      label: "通用",
      levels: ["low", "medium", "high"],
      hints: {}
    };
  return v;
}

export interface AdminRoute {
  primary: string | null;
  fallback: string | null;
}

export interface AdminModelConfig {
  version: 1;
  revision: number;
  providers: AdminProvider[];
  models: AdminModel[];
  routes: Record<ManagedCapability, AdminRoute>;
  /** 思考强度元数据（0.5.0 起下发；旧服务端无此字段 → undefined） */
  thinking?: ThinkingMeta;
}

export interface TestResult {
  ok: boolean;
  modelId: string | null;
  elapsedMs: number;
  reply?: string | null;
  error?: { code: string; message: string };
}

const BASE = "/control-api/v1/admin";

/** 测试/嵌入式部署可注入基址；缺省保持同源相对路径（经反代改写） */
let apiBase = BASE;

export function setControlApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, "");
}

export class ControlApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    /** 服务端原始错误体（探测失败时含 modelId/elapsedMs/error） */
    public readonly payload: any = null
  ) {
    super(message);
  }
}

async function request(
  method: string,
  path: string,
  opts: { body?: unknown; ifMatch?: number } = {}
): Promise<any> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.ifMatch !== undefined) headers["if-match"] = String(opts.ifMatch);

  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    throw new ControlApiError(
      "无法连接管理面（控制面服务未启动或反代未配置）",
      0,
      "network_error",
      null
    );
  }
  const text = await res.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) {
    const err = payload?.error ?? {};
    throw new ControlApiError(
      err.message ?? `管理面返回 ${res.status}`,
      res.status,
      err.code ?? `http_${res.status}`,
      payload
    );
  }
  return payload;
}

/** 把探测类失败（非 2xx 但带结构化探测结果）折叠为 ok:false 结果而非异常 */
function probeFailureToResult(e: unknown, fallbackModelId: string): TestResult {
  if (e instanceof ControlApiError && e.payload) {
    return {
      ok: false,
      modelId: e.payload.modelId ?? fallbackModelId,
      elapsedMs: e.payload.elapsedMs ?? 0,
      reply: null,
      error: e.payload.error ?? { code: e.code, message: e.message }
    };
  }
  if (e instanceof ControlApiError) {
    return {
      ok: false,
      modelId: fallbackModelId,
      elapsedMs: 0,
      reply: null,
      error: { code: e.code, message: e.message }
    };
  }
  throw e;
}

export const modelControlApi = {
  getConfig(): Promise<AdminModelConfig> {
    return request("GET", "/model-config");
  },

  /** 保存完整配置（If-Match 乐观锁）；409 → ControlApiError(status=409) */
  putConfig(
    doc: AdminModelConfig,
    revision: number
  ): Promise<{ revision: number }> {
    return request("PUT", "/model-config", { body: doc, ifMatch: revision });
  },

  putCredential(
    providerId: string,
    value: string
  ): Promise<{ revision: number; hasCredential: boolean }> {
    return request("PUT", `/providers/${encodeURIComponent(providerId)}/credential`, {
      body: { value }
    });
  },

  /** 有界实测一个模型（允许禁用态）；失败返回 ok:false 而不抛 */
  testModel(modelId: string): Promise<TestResult> {
    return request("POST", `/models/${encodeURIComponent(modelId)}/test`).catch(
      e => probeFailureToResult(e, modelId)
    );
  },

  /** 有界实测一个能力路由（只用当前生效 primary） */
  testRoute(capability: ManagedCapability): Promise<TestResult> {
    return request(
      "POST",
      `/routes/${encodeURIComponent(capability)}/test`
    ).catch(e => probeFailureToResult(e, null as unknown as string));
  },

  rollback(revision: number): Promise<{ revision: number }> {
    return request("POST", "/model-config/rollback", { ifMatch: revision });
  }
};

/* ---------------- 纯函数：草稿变换（UI 与单测共用） ---------------- */

export function emptyRoutes(): Record<ManagedCapability, AdminRoute> {
  return Object.fromEntries(
    MANAGED_CAPABILITIES.map(c => [c, { primary: null, fallback: null }])
  ) as Record<ManagedCapability, AdminRoute>;
}

export function cloneConfig(doc: AdminModelConfig): AdminModelConfig {
  return JSON.parse(JSON.stringify(doc)) as AdminModelConfig;
}

export function modelIdsOf(doc: AdminModelConfig, providerId: string): string[] {
  return doc.models.filter(m => m.providerId === providerId).map(m => m.id);
}

/** 删除模型（草稿内）：清掉模型本身与所有指向它的路由槽位 */
export function removeModelDeep(doc: AdminModelConfig, modelId: string): void {
  doc.models = doc.models.filter(m => m.id !== modelId);
  for (const cap of MANAGED_CAPABILITIES) {
    const r = doc.routes[cap];
    if (r.primary === modelId) r.primary = null;
    if (r.fallback === modelId) r.fallback = null;
  }
}

/** 删除供应商（草稿内）：连带删除其模型并清空指向它们的路由槽位 */
export function removeProviderDeep(doc: AdminModelConfig, providerId: string): void {
  for (const modelId of modelIdsOf(doc, providerId)) {
    removeModelDeep(doc, modelId);
  }
  doc.providers = doc.providers.filter(p => p.id !== providerId);
}

/** 客户端预检：返回问题列表（空数组 = 可尝试保存；服务端仍是权威） */
export function clientValidate(doc: AdminModelConfig): string[] {
  const issues: string[] = [];
  const providerIds = new Set<string>();
  for (const p of doc.providers) {
    if (!p.id.trim()) issues.push("存在没有 ID 的供应商");
    else if (providerIds.has(p.id)) issues.push(`供应商 ID 重复：${p.id}`);
    else providerIds.add(p.id);
    if (!p.endpoint.trim()) issues.push(`供应商 ${p.id} 缺少端点`);
  }
  const modelIds = new Set<string>();
  for (const m of doc.models) {
    if (!m.id.trim()) issues.push("存在没有 ID 的模型");
    else if (modelIds.has(m.id)) issues.push(`模型 ID 重复：${m.id}`);
    else modelIds.add(m.id);
    if (!m.providerId || !providerIds.has(m.providerId))
      issues.push(`模型 ${m.id} 引用了不存在的供应商`);
    if (!m.wireModel.trim()) issues.push(`模型 ${m.id} 缺少出站模型名（wireModel）`);
    if (m.enabled) {
      const p = doc.providers.find(x => x.id === m.providerId);
      if (p && !p.enabled) issues.push(`模型 ${m.id} 已启用但其供应商处于禁用状态`);
    }
  }
  for (const cap of MANAGED_CAPABILITIES) {
    const r = doc.routes[cap];
    for (const slot of ["primary", "fallback"] as const) {
      const ref = r[slot];
      if (ref && !modelIds.has(ref))
        issues.push(`能力 ${cap} 的 ${slot} 指向不存在的模型 ${ref}`);
    }
  }
  return issues;
}

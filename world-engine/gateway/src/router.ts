/* ============================================================
   Model Router（V0.6 · 方案 §65/§66）
   ------------------------------------------------------------
   按能力标签选模型：任务 → 需求标签集 → 候选模型。
   网关不关心 Qwen / DeepSeek / GPT / Claude / Gemini——厂商只出现在
   **配置条目**里（§66「World Engine 不关心」的 AI 层版本）。

   六标准角色（§65 角色图）预置路由：
     Intent → fast          NPC → roleplay        Complex Rule → reasoning
     Narrative → narrative  Memory → memory        Embedding → embedding

   选择纪律：
   · 确定性——同配置同任务必选同一模型（按匹配数→prefer→id 序稳定排序），
     世界模拟的可复现纪律延伸到 AI 层；
   · 降级链——全标签命中优先，部分命中退化，无候选返回 null
     （调用方回退宿主缺省端点——渐进增强，不是报错）；
   · 密钥缺失的模型在选型时剔除并留痕（不是崩溃）。
   ============================================================ */

/* ---------------- 标签字典（§66 固定集） ---------------- */

export const CAPABILITY_TAGS = [
  'fast',
  'cheap',
  'reasoning',
  'roleplay',
  'narrative',
  'memory',
  'embedding',
  'structured-output',
  'long-context',
] as const;

export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

/** 六标准角色（§65 角色图）→ 必需标签。未登记的角色按「角色名即标签」处理。 */
export const STANDARD_ROUTES: Readonly<Record<string, readonly CapabilityTag[]>> = {
  intent: ['fast'],
  npc: ['roleplay'],
  reasoning: ['reasoning'],
  narrative: ['narrative'],
  memory: ['memory'],
  embedding: ['embedding'],
};

/* ---------------- 模型描述（W6.1） ---------------- */

/** 密钥只存引用：env 变量名在调用时解析，密钥本体永不进配置文件（V1.0 计费/多租户在此留位） */
export interface ApiKeyRef {
  env: string;
}

export interface ModelRef {
  /** 模型 id（配置内的唯一名，如 'deepseek-chat' / 'local-qwen'） */
  id: string;
  /** OpenAI 兼容端点（如 https://api.deepseek.com/v1 或 http://127.0.0.1:11434/v1）。
      仅接受 http/https；端点是**管理员配置**（可信面）——用户请求永不影响 URL，
      只影响出站 body（SSRF 边界，见 README）。本地推理端点（环回/内网）是合法场景。 */
  endpoint: string;
  apiKeyRef: ApiKeyRef;
  tags: readonly CapabilityTag[];
  /** 上下文上限（千 token，可选；预算策略用） */
  maxContextK?: number;
  /** 出站时的 wire model 名（缺省 = id） */
  wireModel?: string;
}

/** 通道路由覆盖：角色 → 追加需求标签 / 偏好模型 id（缺省走 STANDARD_ROUTES） */
export interface RoleRoute {
  tags?: readonly CapabilityTag[];
  prefer?: readonly string[];
}

export interface RouteConfig {
  models: ModelRef[];
  routes?: Record<string, RoleRoute>;
}

/* ---------------- 配置 fail-fast 校验（W6.3） ---------------- */

export class RouteConfigError extends Error {
  constructor(message: string) {
    super('路由配置错误：' + message);
  }
}

function requireString(b: Record<string, unknown>, key: string, what: string, max: number): string {
  const v = b[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new RouteConfigError(`${what} 的 ${key} 必须是 1-${max} 字符的字符串`);
  }
  return v;
}

/** 解析并校验路由配置：任何错误当场抛（启动即失败，不等到首个请求——W6.3 fail-fast） */
export function parseRouteConfig(json: unknown): RouteConfig {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new RouteConfigError('配置必须是一个对象 { models: [...], routes?: {...} }');
  }
  const root = json as Record<string, unknown>;
  if (!Array.isArray(root['models']) || root['models'].length === 0) {
    throw new RouteConfigError('models 必须是非空数组');
  }
  if (root['models'].length > 64) {
    throw new RouteConfigError('models 上限 64 条');
  }
  const models: ModelRef[] = root['models'].map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RouteConfigError(`models[${i}] 必须是对象`);
    }
    const b = raw as Record<string, unknown>;
    const id = requireString(b, 'id', `models[${i}]`, 64);
    const endpoint = requireString(b, 'endpoint', `models[${i}]`, 256);
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      throw new RouteConfigError(`models[${i}].endpoint 不是合法 URL`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new RouteConfigError(`models[${i}].endpoint 仅接受 http/https`);
    }
    const ref = b['apiKeyRef'];
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
      throw new RouteConfigError(`models[${i}].apiKeyRef 必须是 { env: '变量名' }（密钥本体不进配置文件）`);
    }
    const env = (ref as Record<string, unknown>)['env'];
    if (typeof env !== 'string' || !/^[A-Z_][A-Z0-9_]{0,63}$/i.test(env)) {
      throw new RouteConfigError(`models[${i}].apiKeyRef.env 必须是合法环境变量名`);
    }
    if (!Array.isArray(b['tags']) || b['tags'].length === 0 || b['tags'].length > CAPABILITY_TAGS.length) {
      throw new RouteConfigError(`models[${i}].tags 必须是 1-${CAPABILITY_TAGS.length} 个标签的数组`);
    }
    for (const t of b['tags']) {
      if (typeof t !== 'string' || !(CAPABILITY_TAGS as readonly string[]).includes(t)) {
        throw new RouteConfigError(`models[${i}].tags 含未知标签 '${String(t)}'（可用：${CAPABILITY_TAGS.join('/')}）`);
      }
    }
    const out: ModelRef = {
      id,
      endpoint,
      apiKeyRef: { env },
      tags: b['tags'] as CapabilityTag[],
    };
    if (b['wireModel'] !== undefined) {
      out.wireModel = requireString(b, 'wireModel', `models[${i}]`, 128);
    }
    if (b['maxContextK'] !== undefined) {
      if (typeof b['maxContextK'] !== 'number' || !Number.isFinite(b['maxContextK']) || b['maxContextK'] < 1 || b['maxContextK'] > 10_000_000) {
        throw new RouteConfigError(`models[${i}].maxContextK 必须是正数（千 token）`);
      }
      out.maxContextK = b['maxContextK'];
    }
    return out;
  });

  const ids = new Set(models.map((m) => m.id));
  if (ids.size !== models.length) {
    throw new RouteConfigError('models 存在重复 id');
  }

  let routes: Record<string, RoleRoute> | undefined;
  if (root['routes'] !== undefined) {
    if (!root['routes'] || typeof root['routes'] !== 'object' || Array.isArray(root['routes'])) {
      throw new RouteConfigError('routes 必须是对象');
    }
    routes = {};
    for (const [role, raw] of Object.entries(root['routes'] as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new RouteConfigError(`routes.${role} 必须是对象`);
      }
      const rb = raw as Record<string, unknown>;
      const rr: RoleRoute = {};
      if (rb['tags'] !== undefined) {
        if (!Array.isArray(rb['tags']) || rb['tags'].length === 0 || (rb['tags'] as unknown[]).some((t) => !(CAPABILITY_TAGS as readonly string[]).includes(t as string))) {
          throw new RouteConfigError(`routes.${role}.tags 含未知标签`);
        }
        rr.tags = rb['tags'] as CapabilityTag[];
      }
      if (rb['prefer'] !== undefined) {
        if (!Array.isArray(rb['prefer']) || (rb['prefer'] as unknown[]).some((p) => typeof p !== 'string')) {
          throw new RouteConfigError(`routes.${role}.prefer 必须是模型 id 字符串数组`);
        }
        rr.prefer = rb['prefer'] as string[];
      }
      routes[role] = rr;
    }
  }

  return { models, routes };
}

/* ---------------- 路由器（W6.2） ---------------- */

export interface RouteDecisionTrace {
  role: string;
  requiredTags: readonly string[];
  /** 每个候选的判定（留痕：为什么选它/为什么没选它，W6.5 可观测） */
  candidates: { id: string; matched: number; keyMissing: boolean; chosen: boolean; why: string }[];
  chosen: ModelRef | null;
  apiKey: string | null;
  why: string;
}

export interface ModelRouter {
  /** 按角色路由；返回选中的模型与已解析密钥。无候选 → null（调用方回退宿主缺省） */
  route(role: string, extraTags?: readonly string[]): { model: ModelRef; apiKey: string } | null;
  /** 同 route，但带完整决策轨迹（W6.5 可观测 / 排障） */
  explain(role: string, extraTags?: readonly string[]): RouteDecisionTrace;
  /** 可路由的角色（§65 标准六角色 ∪ 配置里声明的角色）——网关按它暴露「模型名」 */
  roles(): string[];
  /** 全部已配置模型（观测用） */
  models(): readonly ModelRef[];
}

export interface RouterOptions {
  /** 密钥解析（缺省 process.env）；测试注入 */
  resolveEnv?: (name: string) => string | undefined;
  /** 路由决策留痕（缺省静默；宿主接 RunLog/网关日志，W6.5） */
  onDecision?: (trace: RouteDecisionTrace) => void;
}

export function createModelRouter(config: RouteConfig, opts: RouterOptions = {}): ModelRouter {
  const resolveEnv = opts.resolveEnv ?? ((name: string) => process.env[name]);

  function explain(role: string, extraTags?: readonly string[]): RouteDecisionTrace {
    const standard = STANDARD_ROUTES[role] ?? [role as CapabilityTag];
    const routeOverride = config.routes?.[role];
    const required: string[] = [...(routeOverride?.tags ?? standard), ...(extraTags ?? [])];
    const prefer = routeOverride?.prefer ?? [];

    const trace: RouteDecisionTrace = { role, requiredTags: required, candidates: [], chosen: null, apiKey: null, why: '' };
    const scored: { model: ModelRef; matched: number; keyMissing: boolean }[] = [];
    for (const m of config.models) {
      const matched = required.filter((t) => m.tags.includes(t as CapabilityTag)).length;
      const key = resolveEnv(m.apiKeyRef.env);
      const keyMissing = key === undefined || key === '';
      trace.candidates.push({
        id: m.id,
        matched,
        keyMissing,
        chosen: false,
        why: keyMissing ? `密钥环境变量 ${m.apiKeyRef.env} 未设置，剔除` : `命中 ${matched}/${required.length}`,
      });
      if (!keyMissing) scored.push({ model: m, matched, keyMissing });
    }

    /* 排序纪律：匹配数降序 → prefer 顺序 → 配置顺序（确定性：同配置同任务同结果） */
    scored.sort((a, b) => {
      if (b.matched !== a.matched) return b.matched - a.matched;
      const pa = prefer.indexOf(a.model.id);
      const pb = prefer.indexOf(b.model.id);
      if (pa !== pb) {
        if (pa === -1) return 1;
        if (pb === -1) return -1;
        return pa - pb;
      }
      return config.models.indexOf(a.model) - config.models.indexOf(b.model);
    });

    const best = scored[0];
    if (!best || best.matched === 0) {
      trace.why = best ? '无候选命中任何必需标签（部分命中也被拒绝：宁可回退宿主缺省，不瞎选）' : '没有可用候选（全部缺密钥或配置为空）';
      return trace;
    }
    trace.chosen = best.model;
    trace.apiKey = resolveEnv(best.model.apiKeyRef.env) ?? null;
    trace.candidates.find((c) => c.id === best.model.id)!.chosen = true;
    trace.why = best.matched === required.length ? '全标签命中' : `部分命中（${best.matched}/${required.length}，降级链放行）`;
    return trace;
  }

  function route(role: string, extraTags?: readonly string[]): { model: ModelRef; apiKey: string } | null {
    const trace = explain(role, extraTags);
    opts.onDecision?.(trace);
    return trace.chosen && trace.apiKey ? { model: trace.chosen, apiKey: trace.apiKey } : null;
  }

  return {
    route,
    explain,
    roles: () => [...new Set([...Object.keys(STANDARD_ROUTES), ...Object.keys(config.routes ?? {})])],
    models: () => config.models,
  };
}

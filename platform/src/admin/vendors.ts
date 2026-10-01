/* ============================================================
   厂商思考强度适配器（M5 后特性 · 可复用注册表）
   ------------------------------------------------------------
   目标：AI 网关里配置的每个模型可以声明「思考强度」（off/low/
   medium/high），出站时由**厂商画像**把抽象档位翻译成各家请求
   字段——优先适配 DeepSeek / GLM / Kimi / Qwen，新厂商加一条
   profile 即可，不改调用方。

   四家的现实（2026-09 口径，实现以 profile 为准可随时修订）：
   · DeepSeek：思考模式由**模型名**切换（deepseek-chat ↔
     deepseek-reasoner），无请求参数——profile 提供 modelSwitch 映射；
   · GLM（智谱 4.5/4.6）：请求参数 `thinking: { type }`（enabled/
     disabled）；
   · Kimi（月之暗面）：思考版由**模型名**选择（如 kimi-k2-thinking），
     未见可靠的参数开关——profile 声明 modelSwitch 缺省空（用户在
     wireModel 里直接选思考版即可，不强行翻转）；
   · Qwen（3 代）：请求参数 `enable_thinking`（true/false），
     high 追加 `thinking_budget`；
   · generic（缺省回退）：OpenAI 风格 `reasoning_effort`
     （low/medium/high）——大量 OpenAI 兼容实现跟进该字段。

   复用方式：新厂商 = 往 VENDOR_PROFILES 数组加一条（match 前缀 +
   apply 映射），检测/出站/UI 档位全部自动生效。
   ============================================================ */

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ThinkingPayload {
  /** 并入出站请求体顶层的厂商字段 */
  extra: Record<string, unknown>;
  /** 出站模型名覆盖（按模型名切换思考模式的厂商） */
  modelOverride?: string;
}

export interface VendorProfile {
  id: string;
  label: string;
  /** wireModel 前缀匹配（大小写不敏感；数组顺序即优先级） */
  match: readonly string[];
  /** 该厂商支持的抽象档位（UI 下拉与服务端校验共用） */
  levels: readonly ThinkingLevel[];
  /** 档位 → 该厂商语义的说明（UI 提示） */
  levelHint: Partial<Record<ThinkingLevel, string>>;
  /**
   * 把档位落到请求体。level 必在 levels 内（调用方保证）。
   * 不支持参数控制的厂商（纯模型名切换）不实现本字段。
   */
  apply?(level: ThinkingLevel): ThinkingPayload['extra'];
  /** 按模型名切换思考模式的厂商：off/on → 出站模型名
   *  （旧机制钩子；当前 DeepSeek/Kimi 已参数化/声明性提示，保留供未来厂商） */
  modelSwitch?: { off?: string; on?: string };
}

export const VENDOR_PROFILES: readonly VendorProfile[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    match: ['deepseek'],
    /* 官方 thinking_mode 指南（api-docs.deepseek.com/zh-cn/guides/thinking_mode）：
       思考经一等参数控制（thinking.type + reasoning_effort），原生三档 low/high/max；
       默认打开且 effort=high；思考模式不支持 temperature。需 V3.2+/flash 级模型。 */
    levels: ['off', 'low', 'medium', 'high'],
    levelHint: {
      off: 'thinking.type = disabled（关闭思考）',
      low: 'reasoning_effort = low（快速）',
      medium: 'reasoning_effort = high（官方 medium 映射到 high）',
      high: 'reasoning_effort = max（最深推演）',
    },
    apply: (level) => {
      if (level === 'off') return { thinking: { type: 'disabled' } };
      const effort = level === 'low' ? 'low' : level === 'high' ? 'max' : 'high';
      return { thinking: { type: 'enabled' }, reasoning_effort: effort };
    },
  },
  {
    id: 'glm',
    label: 'GLM（智谱）',
    match: ['glm'],
    levels: ['off', 'medium'],
    levelHint: {
      off: 'thinking.type = disabled（关闭深度思考）',
      medium: 'thinking.type = enabled（深度思考）',
    },
    apply: (level) => ({ thinking: { type: level === 'off' ? 'disabled' : 'enabled' } }),
  },
  {
    id: 'kimi',
    label: 'Kimi（月之暗面）',
    match: ['kimi', 'moonshot'],
    levels: ['off', 'medium'],
    levelHint: {
      off: '标准模型（按 wireModel 出站）',
      medium: '思考模式（K2 思考版由模型名选择——请在 wireModel 填思考版模型名）',
    },
    /* Kimi 思考版是独立模型名，不做自动翻转（避免与用户配置打架） */
  },
  {
    id: 'qwen',
    label: 'Qwen（通义）',
    match: ['qwen'],
    levels: ['off', 'medium', 'high'],
    levelHint: {
      off: 'enable_thinking = false',
      medium: 'enable_thinking = true',
      high: 'enable_thinking = true + thinking_budget（深度推演）',
    },
    apply: (level) =>
      level === 'off'
        ? { enable_thinking: false }
        : level === 'high'
          ? { enable_thinking: true, thinking_budget: 8192 }
          : { enable_thinking: true },
  },
];

/** 缺省画像：OpenAI 风格 reasoning_effort（大量兼容实现跟进） */
const GENERIC_PROFILE: VendorProfile = {
  id: 'generic',
  label: '通用（OpenAI 风格）',
  match: [],
  levels: ['off', 'low', 'medium', 'high'],
  levelHint: {
    off: '关闭思考（reasoning_effort 不发送）',
    low: 'reasoning_effort = low',
    medium: 'reasoning_effort = medium',
    high: 'reasoning_effort = high',
  },
  apply: (level) => (level === 'off' ? {} : { reasoning_effort: level }),
};

/** 按 wireModel 检测厂商画像（前缀匹配，大小写不敏感；无命中 → generic） */
export function detectVendor(wireModel: string): VendorProfile {
  const w = wireModel.toLowerCase();
  return VENDOR_PROFILES.find((p) => p.match.some((m) => w.startsWith(m))) ?? GENERIC_PROFILE;
}

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === 'string' && (THINKING_LEVELS as readonly string[]).includes(v);
}

/**
 * 思考强度 → 出站载荷（唯一出口，platform/网关调用方共用）。
 * 档位不被该厂商支持 → null（调用方按未配置处理并如实提示）。
 */
export function thinkingOutbound(thinking: ThinkingLevel | undefined, wireModel: string): ThinkingPayload | null {
  if (!thinking) return null;
  const profile = detectVendor(wireModel);
  if (!profile.levels.includes(thinking)) return null;
  const extra = profile.apply?.(thinking) ?? {};
  let modelOverride: string | undefined;
  if (profile.modelSwitch) {
    const switched = thinking === 'off' ? profile.modelSwitch.off : profile.modelSwitch.on;
    if (switched) modelOverride = switched;
  }
  return Object.keys(extra).length || modelOverride ? { extra, modelOverride } : null;
}

/** UI/服务端共用的档位合法性（off 对所有厂商都有意义） */
export function vendorSupportsLevel(vendorId: string, level: ThinkingLevel): boolean {
  const p = vendorId === 'generic' ? GENERIC_PROFILE : VENDOR_PROFILES.find((x) => x.id === vendorId);
  return p ? p.levels.includes(level) : false;
}

export function vendorProfileOf(vendorId: string): VendorProfile {
  return vendorId === 'generic' ? GENERIC_PROFILE : (VENDOR_PROFILES.find((x) => x.id === vendorId) ?? GENERIC_PROFILE);
}

/** UI 元数据（服务端下发 → 前端零改动扩展：新增厂商自动进下拉） */
export function thinkingMeta() {
  const all = [...VENDOR_PROFILES, GENERIC_PROFILE];
  return {
    levels: [...THINKING_LEVELS],
    vendors: all.map((p) => ({
      id: p.id,
      label: p.label,
      match: [...p.match],
      levels: [...p.levels],
      hints: { ...p.levelHint } as Partial<Record<ThinkingLevel, string>>,
    })),
  };
}

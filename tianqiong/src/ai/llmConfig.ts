/* ============================================================
   LLM 运行时配置（系统面板可改，存 localStorage；不落仓库）
   默认端点为 DeepSeek（OpenAI 兼容协议），baseURL 可换成任意
   兼容端点（本地 Ollama / GLM / Kimi / OpenAI…）。
   ============================================================ */
import { DEFAULT_PROMPT, type PromptConfig } from './promptPreset';

/**
 * 向量模型配置（记忆方案 §11/§12）。
 * 刻意与对话模型分开：两者常常不是同一个服务
 * （对话可以是 DeepSeek，向量往往是本地 BGE 或另一家的 embedding 端点）。
 * `reuseLlm` 打开时直接沿用对话模型的端点与 Key，省得填两遍。
 */
export interface EmbeddingConfig {
  enabled: boolean;
  reuseLlm: boolean;
  baseURL: string;
  model: string;
  apiKey: string;
}

/**
 * §24 分层 AI 的接入点：不同复杂度的事件可以走不同的模型
 * （轻量模型处理普通 NPC 与简单事件，高性能模型处理复杂世界事件）。
 * **尚未接入**：「哪级事件走哪档模型」是产品与成本决策；
 * 而判定本身已经就位（`WorldReasoner.shouldReason` 给出质量分级）。
 * 未配置 `tiers` 时 `resolveTier` 一律回落主模型——行为与单模型时逐字节相同。
 */
export interface ModelSlot {
  baseURL: string;
  model: string;
  apiKey: string;
}
export type ModelTier = 'light' | 'heavy';

/**
 * 思考等级（模型「先想一遍再开口」的程度）。
 * 三家的参数名**不同**，所以这里存**意图**，翻译交给 chatParams：
 *   · DeepSeek / GLM：thinking: { type: 'enabled' | 'disabled' }（开关式）
 *   · Gemini（OpenAI 兼容层）：reasoning_effort: low | medium | high（档位式）
 * default 表示**一个字段都不发**——端点怎么默认就怎么用。它既是新装默认值，
 * 也是老档（没有这个字段）读回来的值：升级后请求体逐字节不变。
 */
export type ReasoningLevel = 'default' | 'off' | 'low' | 'medium' | 'high';

/**
 * 思考参数的「风格」：
 *   auto（默认）= 按 model / baseURL 认出端点是谁，就发它认识的那个字段；
 *   认不出（自建代理、转发网关）则两个都发——未知字段被忽略是这三家的常态。
 * 严格端点若对不认识的字段报 400，切成 effort / thinking 即可。
 */
export type ReasoningParam = 'auto' | 'effort' | 'thinking';

export const REASONING_LEVELS: { id: ReasoningLevel; label: string; hint: string }[] = [
  { id: 'default', label: '默认', hint: '不下发思考参数，由端点自己决定（与升级前完全一致）' },
  { id: 'off', label: '关闭', hint: '明确关掉思考：DeepSeek / GLM 认这个开关，Gemini 无此档' },
  { id: 'low', label: '低', hint: '想得少：最快，适合意图解析与 NPC 对话' },
  { id: 'medium', label: '中', hint: '中等：叙事编织与 NPC 权衡的均衡档' },
  { id: 'high', label: '高', hint: '想得多：最慢，长文编织与复杂推演更稳' },
];

export const REASONING_PARAMS: { id: ReasoningParam; label: string; hint: string }[] = [
  { id: 'auto', label: '自动', hint: 'Gemini 发 reasoning_effort；DeepSeek / GLM 发 thinking' },
  { id: 'effort', label: '仅档位', hint: '只发 reasoning_effort（OpenAI / Gemini 系）' },
  { id: 'thinking', label: '仅开关', hint: '只发 thinking.type（DeepSeek / GLM 系）' },
];

const LEVEL_SET: ReadonlySet<string> = new Set(REASONING_LEVELS.map((x) => x.id));
const PARAM_SET: ReadonlySet<string> = new Set(REASONING_PARAMS.map((x) => x.id));

/**
 * system 消息的处理方式。
 *   fold（默认）= 把 system 内容并进第一条 user；
 *   native      = 保持 system 单列（只对真正支持 system 的端点有意义）。
 *
 * 为什么默认 fold：实测有些中转网关在 OpenAI → 上游的转换里把 role:system 整条丢掉
 * （openclawroot 现网如此）。丢了不报错，只是「静默变质」——意图通道拿到一段散文、
 * 叙事通道把玩家的输入写成 NPC 的台词、NPC 权衡退化成规则台词。
 * 同一段指令放进 user 的服从度与 system 等价（实测），归并一次即可救回；
 * 而真正支持 system 的端点也照吃不误，所以默认开着。
 */
export type SystemMode = 'fold' | 'native';

export function clampSystemMode(v: unknown): SystemMode {
  return v === 'native' ? 'native' : 'fold';
}

/**
 * baseURL 规范化：把「从别处整段粘过来」的几种常见形态收敛成规范端点。
 *   · 去掉所有空白 —— URL 里本就不该有裸空格，而它一旦进了主机名就会被编码成 %20，
 *     域名直接解析不到，请求死在 DNS 层，面板上却什么都看不出来；
 *   · 剥掉结尾误粘的 /chat/completions、/embeddings —— 适配器自己会拼，留着就是路径双写；
 *   · 去掉结尾多余的斜杠。
 * 实机踩过：这一格被填成 `https://openclawroot.com /v1/chat/completions`（空格 + 双写），
 * 于是每一发请求都抛 Failed to fetch，而配置看着「填了、也像对的」。
 */
export function normalizeBaseURL(raw: unknown): string {
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  s = s.replace(/\s+/g, '');
  s = s.replace(/\/(chat\/completions|embeddings|completions)\/?$/i, '');
  return s.replace(/\/+$/, '');
}

/**
 * 端点是否**真的**可用。原来的判断只有 `/^https?:\/\//` 一条，
 * 于是 `https://openclawroot.com /v1/chat/completions` 一路过审、游戏挂上真实适配器，
 * 之后每一发请求都在 URL 解析阶段炸掉 —— 校验形同虚设。
 * 这里要求：能过 normalize、协议是 http(s)、`new URL()` 解析得出非空 hostname。
 */
export function isUsableBaseURL(raw: unknown): boolean {
  const s = normalizeBaseURL(raw);
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    return !!new URL(s).hostname;
  } catch {
    return false;
  }
}

/** 非法值 / 老档缺字段 → 回落 default（不下发）：坏值绝不能变出一发 400 */
export function clampReasoning(v: unknown): ReasoningLevel {
  return typeof v === 'string' && LEVEL_SET.has(v) ? (v as ReasoningLevel) : 'default';
}
export function clampReasoningParam(v: unknown): ReasoningParam {
  return typeof v === 'string' && PARAM_SET.has(v) ? (v as ReasoningParam) : 'auto';
}

/** W6.4 · 通道路由收口：只留合法档位（light/heavy），键数封顶 32；坏条目直接丢——缺失 = 走主模型 */
export function clampChannelRoutes(v: unknown): Record<string, ModelTier> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, ModelTier> = {};
  for (const [k, tier] of Object.entries(v as Record<string, unknown>).slice(0, 32)) {
    if (k.length > 0 && k.length <= 64 && (tier === 'light' || tier === 'heavy')) out[k] = tier;
  }
  return Object.keys(out).length ? out : undefined;
}

export interface LlmConfig {
  enabled: boolean;
  baseURL: string;
  model: string;
  apiKey: string;
  /** 分层模型槽（可选）：未配置 = 一切都用主模型 */
  tiers?: Partial<Record<ModelTier, ModelSlot>>;
  /**
   * W6.4 · 通道路由（§66 通道→能力→端点）：通道名 → 档位。
   * 配置后该通道的 LLM 调用改走对应槽的端点/模型（如 intent→light、narrative→heavy）；
   * 未配置的通道走主模型——行为与单模型时逐字节相同。收口见 clampChannelRoutes。
   */
  channelRoutes?: Record<string, ModelTier>;
  /** 单次调用超时（毫秒） */
  timeoutMs: number;
  /** 思考等级（default = 不下发思考参数；见 ReasoningLevel 注释） */
  reasoningEffort: ReasoningLevel;
  /** 思考参数风格（auto = 按端点自动选字段） */
  reasoningParam: ReasoningParam;
  /** system 消息处理方式（fold = 归并进 user，兼容丢 system 的中转网关；见 SystemMode） */
  systemMode?: SystemMode;
  /**
   * 流式输出（SSE）：开 = 正文边生成边上屏，首字即刻可见。
   * 只影响「怎么收」，不影响「收到什么」——端点不认 stream 时自动回退整包重发一次。
   */
  stream: boolean;
  /** 是否把 lore canon 注入叙事/NPC prompt（关则纯模板，false 才关，默认开） */
  loreEnabled?: boolean;
  /** 向量模型（未配置时记忆系统退回关键词检索，不影响其它功能） */
  embedding: EmbeddingConfig;
  /** 提示词预设：系统提示词 / 叙事方式 / 人称 / 嵌入条目 / 剧情推进选项 */
  prompts: PromptConfig;
}

export const DEFAULT_EMBEDDING: EmbeddingConfig = {
  enabled: false,
  reuseLlm: true,
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'BAAI/bge-m3',
  apiKey: '',
};

const KEY = 'tq2_ai_cfg_v1';

export const DEFAULT_LLM: LlmConfig = {
  enabled: false,
  baseURL: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  timeoutMs: 12000,
  reasoningEffort: 'default',
  reasoningParam: 'auto',
  systemMode: 'fold',
  stream: false,
  loreEnabled: true,
  embedding: { ...DEFAULT_EMBEDDING },
  prompts: DEFAULT_PROMPT,
};

type Listener = (c: LlmConfig) => void;
const listeners = new Set<Listener>();

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

let mem: LlmConfig | null = null; // 无 localStorage 环境（测试）或写盘失败时的内存兜底

/** 超时取值域（F-26）：0/负数/NaN 会让所有请求立即 abort，四通道全灭 */
export const LLM_TIMEOUT_MIN = 1000;
export const LLM_TIMEOUT_MAX = 60000;

export function clampTimeout(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : DEFAULT_LLM.timeoutMs;
  return Math.min(LLM_TIMEOUT_MAX, Math.max(LLM_TIMEOUT_MIN, n));
}

/** 收口：磁盘 / 老档里的坏值一律夹回合法域；读与写走同一条，行为可预期 */
function normalize(c: LlmConfig): LlmConfig {
  return {
    ...c,
    /* 端点地址在读与写两侧同一条收口：粘贴带进来的空白与多余路径在建适配器**之前**就清掉，
       否则校验、展示、请求三处会各自看到不同的字符串。 */
    baseURL: normalizeBaseURL(c.baseURL),
    embedding: { ...c.embedding, baseURL: normalizeBaseURL(c.embedding?.baseURL) },
    timeoutMs: clampTimeout(c.timeoutMs),
    reasoningEffort: clampReasoning(c.reasoningEffort),
    reasoningParam: clampReasoningParam(c.reasoningParam),
    systemMode: clampSystemMode(c.systemMode),
    stream: c.stream === true, // 非布尔（老档 undefined / 手改存档）按关处理
    channelRoutes: clampChannelRoutes(c.channelRoutes),
  };
}

function readDisk(): LlmConfig {
  const st = storage();
  if (!st) return { ...DEFAULT_LLM };
  try {
    const raw = st.getItem(KEY);
    if (!raw) return { ...DEFAULT_LLM };
    const saved = JSON.parse(raw) as Partial<LlmConfig>;
    /* embedding 要深合并：浅展开会让旧档（无此字段）拿到 undefined，
       而半截的 embedding（只存过一部分字段）会丢掉其余默认值。 */
    return {
      ...DEFAULT_LLM,
      ...saved,
      embedding: { ...DEFAULT_EMBEDDING, ...(saved.embedding ?? {}) },
      /* prompts 里的 embeds/options 是数组：整取用户的，不逐元素合并（否则删掉的条目会"复活"） */
      prompts: { ...DEFAULT_PROMPT, ...(saved.prompts ?? {}) },
    };
  } catch {
    return { ...DEFAULT_LLM };
  }
}

export function loadLlmConfig(): LlmConfig {
  /* 内存分支与磁盘分支做同样的深合并，否则写盘失败后读回会缺 embedding 字段 */
  const cfg = mem
    ? {
        ...DEFAULT_LLM,
        ...mem,
        embedding: { ...DEFAULT_EMBEDDING, ...(mem.embedding ?? {}) },
        prompts: { ...DEFAULT_PROMPT, ...(mem.prompts ?? {}) },
      }
    : readDisk();
  return normalize(cfg);
}

export function saveLlmConfig(patch: Partial<LlmConfig>): LlmConfig {
  /* 写入侧同样收口（timeoutMs / 思考等级 / 流式开关）：磁盘里不留非法值，
     否则一次手改过的存档能让之后每一发请求都带错字段 */
  const next = normalize({ ...loadLlmConfig(), ...patch });
  const st = storage();
  if (st) {
    try {
      st.setItem(KEY, JSON.stringify(next));
      mem = null; // F-26：写盘成功即释放内存分支——否则一次失败后读取永远走旧值
    } catch {
      mem = next; // 仅在写不进去时用内存兜底
    }
  } else {
    mem = next;
  }
  for (const fn of listeners) fn(next);
  return next;
}

export function onLlmConfig(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 配置是否足以启用真实模型 */
export function llmUsable(c: LlmConfig = loadLlmConfig()): boolean {
  return c.enabled && !!c.apiKey.trim() && isUsableBaseURL(c.baseURL);
}

/**
 * 取某一档模型。未配置该档（或缺 model）→ 回落主模型：
 * 这是**默认行为**而不是降级路径，所以调用方可以无条件按档位取。
 * 空串按「未配置」处理：档位只写了端点却把 Key 留空，会**沿用主模型的 Key**——
 * 跨端点配档位时必须把 Key 一起填上，否则等于把主服务的 Key 发到别人家。
 */
export function resolveTier(tier: ModelTier, c: LlmConfig = loadLlmConfig()): ModelSlot {
  const slot = c.tiers?.[tier];
  if (slot?.model) {
    return { baseURL: slot.baseURL || c.baseURL, model: slot.model, apiKey: slot.apiKey || c.apiKey };
  }
  return { baseURL: c.baseURL, model: c.model, apiKey: c.apiKey };
}

/** 向量模型的最终生效配置（把「复用对话模型」就地解析掉） */
export function resolveEmbedding(c: LlmConfig = loadLlmConfig()): EmbeddingConfig {
  return c.embedding.reuseLlm ? { ...c.embedding, baseURL: c.baseURL, apiKey: c.apiKey } : c.embedding;
}

/** 向量模型是否可用（与对话模型互相独立：任一不可用都不影响另一个） */
export function embeddingUsable(c: LlmConfig = loadLlmConfig()): boolean {
  const e = resolveEmbedding(c);
  return e.enabled && !!e.apiKey.trim() && !!e.model.trim() && isUsableBaseURL(e.baseURL);
}

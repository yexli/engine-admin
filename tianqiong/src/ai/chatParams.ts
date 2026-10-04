/* ============================================================
   请求体组装（openai-compat）
   ------------------------------------------------------------
   单独成文件的原因：思考等级在这三家端点上**字段名不同**，翻译规则
   要能被单测钉住，而不是埋在 fetch 调用里靠读代码确认。

     Gemini（OpenAI 兼容层）: reasoning_effort = low | medium | high
     DeepSeek / GLM          : thinking = { type: 'enabled' | 'disabled' }
     其它兼容端点            : 认不出就两个都发（未知字段被忽略是常态）

   行为契约：reasoningEffort === 'default' 时**一个字段都不发**，请求体与
   没有这个功能时逐字节相同——老档升级后不会因为多带一个字段而 400。
   ============================================================ */
import type { LlmConfig, ReasoningLevel, ReasoningParam } from './llmConfig';

/** 这次该往请求体里塞哪一种思考字段 */
export type ThinkingStyle = 'effort' | 'thinking' | 'both';

/**
 * 端点识别：先看模型名，再看 host。
 * 认不出（自建代理 / 转发网关）返回 both —— 覆盖大多数宽松端点；
 * 真遇到严格端点，用户在面板上切成 effort / thinking 即可。
 */
export function resolveThinkingStyle(cfg: { baseURL: string; model: string; reasoningParam?: ReasoningParam }): ThinkingStyle {
  const p = cfg.reasoningParam ?? 'auto';
  if (p === 'effort' || p === 'thinking') return p;
  const s = (cfg.model + ' ' + cfg.baseURL).toLowerCase();
  if (s.includes('gemini') || s.includes('generativelanguage') || s.includes('googleapis')) return 'effort';
  if (s.includes('deepseek') || s.includes('glm') || s.includes('zhipu') || s.includes('bigmodel')) return 'thinking';
  return 'both';
}

/**
 * 思考等级 → 请求体字段。
 * off 只关得掉「开关式」的端点（DeepSeek / GLM 的 thinking.type）；
 * Gemini 的档位式没有"关"这一档，于是 off 对它等于什么都不发——
 * 这是刻意的：宁可退回端点默认，也不要塞一个它不认识的取值换 400。
 */
/**
 * 「短结构化输出」的预算上限（token）。低于它的 JSON 通道自动关思考，理由见 thinkingFields。
 * 200 这条线是照着实码画的：四个结构化通道的预算是 greet 90 / decide 120 / chat 130 / intent 140，
 * 全在线下；World Reasoner 的 900 明确在上（长 JSON 推演正是思考该出力的时候）。
 */
export const SHORT_OUTPUT_MAX_TOKENS = 200;

export function thinkingFields(level: ReasoningLevel, style: ThinkingStyle, short = false): Record<string, unknown> {
  if (level === 'default') {
    /* 短结构化通道在 default 档下**主动关思考**。
       思考型端点（deepseek-flash / deepseek-reasoner）的思维链与正文**共用**同一个 max_tokens：
       预算 90~140 时思维链先花掉大半，正文被挤成空串——通道静默降级回规则模拟，
       玩家那边只表现为「AI 台词变成了模板」，没有任何报错可查。
       实测（2026-09 · deepseek-flash · api.deepseek.com）：
         · max_tokens=8   → 正文长度 0，finish_reason=length（思维链 8 token 全吃光）；
         · 加 thinking.type=disabled 后同一发正文正常，且 1073ms → 596ms。
       长文通道（输出几十到几百字）刻意不在此列：那里思考的收益大、预算也够。
       用户显式选过档位（off / low / medium / high）时一律以用户为准，这里不越权。 */
    if (short && style !== 'effort') return { thinking: { type: 'disabled' } };
    return {};
  }
  const out: Record<string, unknown> = {};
  if (style !== 'thinking' && level !== 'off') out.reasoning_effort = level;
  if (style !== 'effort') out.thinking = { type: level === 'off' ? 'disabled' : 'enabled' };
  return out;
}

export interface ChatBodyOpts {
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** 本次是否走 SSE。false / 缺省 = 整包 */
  stream?: boolean;
  /** 端点拒了思考字段（HTTP 400）之后的重发：一个思考字段都不带 */
  dropThinking?: boolean;
  /**
   * 本请求**强制尝试关思考**（意图/权衡/台词/问候这类机械性短 JSON 通道用）。
   * 与 default 档的 short 自动关思考同一条语义，但**越过用户显式档位**：
   * 这些通道的预算本就按「无思维链」画，用户全局开高思考时思维链会把 JSON 挤空，
   * 通道只能静默降级。开关式端点发 thinking.type=disabled；档位式（Gemini）没有
   * 「关」档，什么都不发——关不掉的端点由调用方的大预算与重试兜底。
   */
  noThinking?: boolean;
}

/** noThinking 的字段翻译：档位式端点关不掉，交由预算兜底（宁可退回端点默认，也不塞不认识的取值换 400） */
export function noThinkingFields(style: ThinkingStyle): Record<string, unknown> {
  return style === 'effort' ? {} : { thinking: { type: 'disabled' } };
}

/** /chat/completions 的请求体（纯函数，便于逐字段断言） */
export function buildChatBody(
  cfg: Pick<LlmConfig, 'model' | 'baseURL' | 'reasoningEffort' | 'reasoningParam'>,
  messages: { role: string; content: string }[],
  opts: ChatBodyOpts = {},
): Record<string, unknown> {
  const maxTokens = opts.maxTokens ?? 300;
  /* 短结构化通道的判据：**走 JSON 且预算很小**。只有这两个条件同时成立，
     思维链吃掉预算才会挤掉正文（长文通道与 900 token 的推演通道都不在此列）。 */
  const short = opts.json === true && maxTokens <= SHORT_OUTPUT_MAX_TOKENS;
  const fields = opts.dropThinking
    ? {}
    : opts.noThinking
      ? noThinkingFields(resolveThinkingStyle(cfg))
      : thinkingFields(cfg.reasoningEffort, resolveThinkingStyle(cfg), short);
  return {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.9,
    max_tokens: maxTokens,
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    ...(opts.stream ? { stream: true } : {}),
    ...fields,
  };
}

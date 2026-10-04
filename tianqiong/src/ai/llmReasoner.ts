/* ============================================================
   LLM 推演端口（《插件化世界模拟架构方案》§13 / §14 / §35 / §42）
   —— 把 ai/gateway 的真实模型通道接到 World Reasoner 上。
   与规则推演器同契约：只产出 Consequence Plan 原始对象，
   是否落地由 Rule Validator 决定；解析失败一律返回 null（§42 不猜测）。
   ============================================================ */
import { extractJson, plannerPrompt } from './ConsequencePlanner';
import { ruleReasoner } from './ruleReasoner';
import type { ReasonerContext } from './ContextBuilder';
import type { ReasonerPort } from './WorldReasoner';

/** 一次结构化模型调用：给系统提示与用户提示，拿回模型原文（失败 null） */
export type ReasonerChat = (system: string, user: string) => Promise<string | null>;

const SYSTEM_PROMPT =
  '你是世界推演器：根据已发生的事实推导哪些实体可能受到何种影响、可能采取哪些合法行动。' +
  '只输出严格 JSON，不写散文，不发明上下文中未出现的实体或能力。' +
  '注意各实体的认知边界：不要让某个实体对自己不知道的事做出反应。';

export function makeLlmReasoner(chat: ReasonerChat, id = 'llm'): ReasonerPort {
  return {
    id,
    async reason(ctx: ReasonerContext) {
      const text = await chat(SYSTEM_PROMPT, plannerPrompt(ctx));
      return text ? extractJson(text) : null;
    },
  };
}

/**
 * 混合端口（组合根的默认装配）：有真实模型就走模型；
 * 模型不可用 / 调用失败 / 输出不合规时退回规则推演——
 * 保证「没配 Key 世界照样运转」（§38.3 不破坏现有玩法）。
 */
export function makeHybridReasoner(chat: ReasonerChat): ReasonerPort {
  const llm = makeLlmReasoner(chat);
  return {
    id: 'hybrid(llm→rule)',
    async reason(ctx: ReasonerContext) {
      const raw = await llm.reason(ctx);
      if (raw) return raw;
      return ruleReasoner.reason(ctx);
    },
  };
}

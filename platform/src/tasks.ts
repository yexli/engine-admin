/* ============================================================
   任务分析（Phase 1 · 方案 §14「请求 → 任务识别 → 能力标签」最小实现）
   ------------------------------------------------------------
   确定性规则（可测试、可解释），Phase 4 产品化时可替换为模型判别：
   1. 显式 capability（body.capability，高级客户端直连）；
   2. 最后一条 user 消息的关键词规则（中文优先）；
   3. 缺省：携带世界 → roleplay；否则 → fast。
   ============================================================ */
import type { Capability, TaskAnalysis } from './types.ts';

export const KNOWN_CAPABILITIES: readonly Capability[] = [
  'roleplay',
  'narrative',
  'reasoning',
  'fast',
  'cheap',
  'memory',
];

interface ChatMessageLike {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const RULES: Array<{ pattern: RegExp; capability: Capability; label: string }> = [
  { pattern: /总结|摘要|记住|回忆|记下|summar|remember/i, capability: 'memory', label: '关键词命中:记忆' },
  { pattern: /为什么|原因|分析|推理|策略|推演|为什么会|why|analyze|reason/i, capability: 'reasoning', label: '关键词命中:推理' },
  { pattern: /故事|剧情|叙述|描写|讲个|故事线|故事|story|narrate/i, capability: 'narrative', label: '关键词命中:叙事' },
];

export function analyzeTask(
  body: unknown,
  hasWorld: boolean,
): TaskAnalysis {
  const b = (body ?? {}) as Record<string, unknown>;
  const explicit = b['capability'];
  if (typeof explicit === 'string' && (KNOWN_CAPABILITIES as readonly string[]).includes(explicit)) {
    return { capability: explicit as Capability, reason: '显式指定 capability' };
  }

  const messages = Array.isArray(b['messages']) ? (b['messages'] as ChatMessageLike[]) : [];
  const lastUser = [...messages].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string');
  if (lastUser) {
    for (const rule of RULES) {
      if (rule.pattern.test(lastUser.content)) {
        return { capability: rule.capability, reason: rule.label };
      }
    }
  }
  return hasWorld
    ? { capability: 'roleplay', reason: '携带世界上下文，缺省 roleplay' }
    : { capability: 'fast', reason: '无世界上下文，缺省 fast' };
}

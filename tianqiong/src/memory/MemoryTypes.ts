/* ============================================================
   记忆的类型判定与数值表（《Memory Engine 记忆系统设计方案》§7/§8/§9）
   —— 领域类型定义在 types/world.ts（维持分层零依赖）；
      本模块只做「数值配置化 + 按场景查表」，代码里不出现魔法数字。
   ============================================================ */
import cfg from '@/data/world/memory.json';
import type { Memory, MemorySource } from '@/types/world';

export type { Memory, MemorySource, MemoryType, MemoryVisibility, EmotionType } from '@/types/world';

const CONFIDENCE = cfg.confidence as unknown as Record<string, number>;
const IMPORTANCE = cfg.importance as unknown as Record<string, number>;
const DECAY = cfg.decay as unknown as Record<string, number>;
const CAPS = cfg.caps as unknown as Record<string, number>;

/** §7 来源 → 默认置信度（亲眼所见 1.0 / 传闻 0.3 / 推测 0.1） */
export const confidenceOf = (source: MemorySource): number => CONFIDENCE[source] ?? CONFIDENCE.default;

/** §8 场景 → 默认重要度 */
export const importanceOf = (kind: string): number => IMPORTANCE[kind] ?? IMPORTANCE.default;

/** §9 重要度分档 → 衰减率；人生重大事件为 0，永不衰减（因此天然不会被淘汰） */
export function decayRateFor(importance: number): number {
  if (importance >= 0.9) return DECAY.life_changing;
  if (importance >= 0.6) return DECAY.important;
  if (importance >= 0.3) return DECAY.event;
  return DECAY.chat;
}

/**
 * §9 记忆强度 = 重要度 × 置信度 × exp(-衰减率 × 经过天数)
 * **衰减锚点取「最后一次被想起」**：反复回忆的记忆留得更久（§10 强化的真实落点），
 * 从未被想起的则从记住那天算起。
 */
export function strengthOf(m: Memory, nowDay: number): number {
  const anchor = m.lastRecalledAt ?? m.createdAt;
  const elapsed = Math.max(0, nowDay - anchor);
  return m.importance * m.confidence * Math.exp(-m.decayRate * elapsed);
}

/** 低于此强度的记忆视为已遗忘（仍保留存档，只退出检索） */
export const FORGOTTEN_BELOW = 0.02;

export const MEMORY_CAP = CAPS.perOwner;
export const CONTEXT_TOKENS = CAPS.contextTokens;
export const CHARS_PER_TOKEN = CAPS.charsPerToken;
export const PROPAGATION = cfg.propagation as unknown as { perStep: number; minConfidence: number; importanceFalloff: number };
export const RETRIEVAL_WEIGHTS = (cfg.retrieval as unknown as { weights: Record<string, number> }).weights;
export const RETRIEVAL_PROFILES = (cfg.retrieval as unknown as { profiles: Record<string, { topK: number; includeRecent: boolean; includeRumor: boolean; minImportance: number }> }).profiles;

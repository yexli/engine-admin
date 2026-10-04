/* ============================================================
   混合检索（《Memory Engine 记忆系统设计方案》§15/§16/§17/§35）
   —— 结构化过滤 → 多路打分 → 加权融合 → 排序取前 K。
   无 Embedding Provider 时（Phase 2 之前）语义项权重会被剔除并**重新归一化**，
   避免分数被不存在的维度稀释——这是「可插拔」而非「降级残废」。
   ============================================================ */
import { RETRIEVAL_WEIGHTS, strengthOf } from '../MemoryTypes';
import { cachedMemoryVec, cachedQueryVec, cosine, touchMemoryVec } from '../embedding/EmbeddingCache';
import { keywordScore } from './KeywordRetriever';
import { memoriesOfOwner, structuredFilter, type MemoryQuery } from './StructuredRetriever';

/**
 * 语义打分由**缓存命中**决定，而不是一个硬编码开关：
 * 查询向量与记忆向量都在缓存里时才计入 semantic 项，否则该项权重整体剔除
 * （计入却算不出分量 = 把所有记忆的分数等比稀释，排序阈值会失真）。
 * 预热见 WorldReasoner：检索是同步的，向量化在推演开始前异步完成。
 */
import type { Memory, WorldState } from '@/types/world';

export interface ScoredMemory {
  memory: Memory;
  score: number;
  parts: Record<string, number>;
}

/** §16 各分项（0..1） */
function scoreParts(m: Memory, q: MemoryQuery, nowDay: number, qv?: number[]): Record<string, number> {
  const recency = 1 / (1 + Math.max(0, nowDay - m.createdAt));
  const entityMatch = q.entityIds?.length
    ? q.entityIds.filter((id) => (m.entities ?? []).includes(id)).length / q.entityIds.length
    : 0;
  const trust = (m.emotion?.weight ?? 0) > 0.5 ? 0.5 + (m.emotion!.weight - 0.5) : 0;
  const mv = qv ? cachedMemoryVec(m.id, m.content) : undefined;
  if (mv) touchMemoryVec(m.id, nowDay); // 命中即记账：LRU 与落盘截断都按「最近被检索」排
  return {
    semantic: qv && mv ? cosine(qv, mv) : 0,
    keyword: q.query ? keywordScore(m.content, q.query) : 0,
    recency,
    importance: m.importance,
    confidence: m.confidence,
    entityMatch,
    relationship: trust,
  };
}

/**
 * 混合检索主入口。
 * embedding 可用时并入 semantic 项，否则该项权重剔除后归一化。
 */
export function hybridRetrieve(q: MemoryQuery, s: WorldState, nowDay: number): ScoredMemory[] {
  const pool = structuredFilter(memoriesOfOwner(s, q.ownerId), q);
  /* 语义项只在「查询向量 + 该条记忆向量都在缓存里」时才计入 */
  const qv = q.query ? cachedQueryVec(q.query) : undefined;
  const weights: Record<string, number> = { ...RETRIEVAL_WEIGHTS };
  if (!qv) delete weights.semantic;
  if (!q.query) delete weights.keyword;

  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const scored = pool.map((m) => {
    const parts = scoreParts(m, q, nowDay, qv);
    let score = 0;
    for (const [k, w] of Object.entries(weights)) score += ((parts[k] ?? 0) * w) / total;
    /* 强度作为最终的「还记得多清楚」因子（§9）：衰减到 0 的记忆自然沉底 */
    parts.strength = strengthOf(m, nowDay);
    score *= 0.5 + 0.5 * Math.min(1, parts.strength);
    return { memory: m, score, parts };
  });

  scored.sort((a, b) => b.score - a.score);
  const limit = q.limit ?? 10;
  return scored.slice(0, limit);
}

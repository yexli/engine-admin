/* ============================================================
   记忆上下文构建（《Memory Engine 记忆系统设计方案》§19/§28/§35）
   —— 检索结果**不原样塞给 AI**：排序 → 去重 → 压缩 → Token 预算 → 上下文。
   不同场景用不同档位（§28）：对话 / 推演 / 委托各有取舍。
   ============================================================ */
import { CHARS_PER_TOKEN, CONTEXT_TOKENS, RETRIEVAL_PROFILES } from '../MemoryTypes';
import { hybridRetrieve } from '../retrieval/HybridRetriever';
import type { MemoryQuery } from '../retrieval/StructuredRetriever';
import type { WorldState } from '@/types/world';

export interface MemoryContextLine {
  id: string;
  text: string;
  score: number;
  confidence: number;
}

export type ProfileName = 'npc_dialogue' | 'world_reasoner' | 'quest';

/** §35 超预算时的取舍次序：高重要度 → 高相关度 → 最近（排序已含，此处只做截断） */
export function buildMemoryContext(
  q: MemoryQuery,
  s: WorldState,
  nowDay: number,
  profileName: ProfileName = 'world_reasoner',
  /* 卡 2026-09 · NPC 分级：调用方可按上下文档位收紧名额与预算。
     不传时逐位等于旧行为——档位只是**上限**，不是新的一刀切。 */
  opts: { topK?: number; tokens?: number } = {},
): MemoryContextLine[] {
  const profile = RETRIEVAL_PROFILES[profileName];
  /* 多取候选再筛选：先截断再去重的话，重复内容会白白吃掉名额 */
  const scored = hybridRetrieve(
    { ...q, minImportance: q.minImportance ?? profile.minImportance, limit: (opts.topK ?? profile.topK) * 4 },
    s,
    nowDay,
  );
  const rows = profile.includeRumor ? scored : scored.filter((r) => r.memory.type !== 'rumor');

  const budgetChars = (opts.tokens ?? CONTEXT_TOKENS) * CHARS_PER_TOKEN;
  const out: MemoryContextLine[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const r of rows) {
    if (out.length >= (opts.topK ?? profile.topK)) break; // 去重之后才按名额截断
    const key = r.memory.content.slice(0, 10);
    if (seen.has(key)) continue; // 去重：压缩后的摘要与原始条目可能同义
    seen.add(key);
    const how = r.memory.source === 'direct_observation' ? '亲历' : '听说';
    const text = '（' + how + '·第' + r.memory.createdAt + '日）' + r.memory.content;
    /* 单条超预算时跳过它继续找后面的短句，而不是整段放弃——
       §35 要求的是按优先级降级取用，不是被第一条长记忆一票否决。 */
    if (used + text.length > budgetChars) continue;
    used += text.length;
    out.push({ id: r.memory.id, text, score: r.score, confidence: r.memory.confidence });
  }
  return out;
}

/** 供提示词直接消费的一行式文本 */
export const memoryContextText = (lines: MemoryContextLine[]): string => lines.map((l) => '- ' + l.text).join('\n');

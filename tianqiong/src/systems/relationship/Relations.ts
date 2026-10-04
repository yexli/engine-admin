/* ============================================================
   卡 D2 · NPC 关系网 + 消息传播 + 记忆分级压缩
   《项目方案》§17 关系网 / §19 记忆分层 / §52 记忆压缩
   纯 core：只读写 WorldState，不产文本、不触 UI。关系边由世界书种子
   经 hydrate 投影进 NpcDynamic.rels；传播沿关系边一跳、imp 单调衰减、
   visited 去环。压缩把短期记忆按重要度归档为长期、封顶数量。
   ============================================================ */
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { clamp } from '@/events/EventBus';
import { addMem, npcDyn } from '@/systems/npc/Npcs';
import { need, stripTies } from '@/world/WorldState';

/** 取某 NPC 的关系边集合（投影已在 npcDyn 建档时完成——单一投影点，见 §4/§14） */
export function relsOf(id: string, s: WorldState = need()): Record<string, { type: string; val: number }> {
  return npcDyn(id, s).rels ?? {};
}

/**
 * 只读投影：**不建档**。给「遍历全表找关系边」的调用点用。
 * relsOf 会经 npcDyn → mutate.npcEntry 落一条 NpcDynamic，而 LOD 的唯一判据正是
 * 「有没有条目」（npc/Lod.ts）——遍历全表取边等于给整个世界建档，L2 全部降到 L1。
 * 未建档时答案与世界书种子等价：npcEntry 的投影就是 stripTies(种子)。
 */
export function peekRelsOf(id: string, s: WorldState): Record<string, { type: string; val: number }> {
  const dy = s.npcs[id];
  if (dy?.rels) return dy.rels;
  return stripTies(WB.npcs[id]?.rels ?? {});
}

/** 读 a 对 b 的关系边（无则 null） */
export function relOf(a: string, b: string, s: WorldState = need()) {
  return relsOf(a, s)[b] ?? null;
}

/** 调整 a 对 b 的关系强度（clamp ±100）；不自动反向（关系可不对称） */
export function adjRel(a: string, b: string, dv: number, why = '') {
  const s = need();
  const rels = relsOf(a, s);
  const edge = rels[b] ?? (rels[b] = { type: '中立', val: 0 });
  edge.val = clamp(edge.val + dv, -100, 100);
  if (why) addMem(a, `关系·${b}：${why}`, Math.min(3, (Math.abs(dv) / 10 | 0) + 1), 'rel');
}

/* 记忆压缩（compressMem）已退役：老表不再被写入，容量与归档统一由
   MemoryEngine 的 putMemory / pruneMemories 负责（§26 按强度淘汰）。 */

/** 消息传播（§17「传播消息」）：src 处的话题沿关系边一跳扩散，imp 衰减，visited 去环。
 *  仅当关系强度绝对值 >= minVal 才扩散。返回收到消息的 NPC id 列表。 */
export function spreadRumor(srcId: string, topic: string, imp: number, s: WorldState = need(), visited = new Set<string>()): string[] {
  if (imp <= 0 || visited.has(srcId)) return [];
  visited.add(srcId);
  const heard: string[] = [];
  for (const [other, edge] of Object.entries(relsOf(srcId, s))) {
    if (Math.abs(edge.val) < 10) continue; // 无深交不传话
    if (visited.has(other)) continue;
    addMem(other, `传闻·${WB.npcs[srcId]?.name ?? srcId}：${topic}`, imp - 1, 'event');
    heard.push(other);
    // 递归一跳衰减（visited 防环，深度由 imp 递减自然收敛）
    spreadRumor(other, topic, imp - 1, s, visited);
  }
  return heard;
}

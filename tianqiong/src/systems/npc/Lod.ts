/* ============================================================
   NPC 关注度分层（LOD · 规模化 Phase 4）
   ——「这个 NPC 与玩家有多少牵连」的**唯一判据源**。
   为什么必须只有一份：判据一旦有两处实现，两处迟早漂移成两套世界观——
   记忆按一套分层、状态按另一套分层，最后没人说得清「谁算相关」。
   判据用**关联度**而不是距离：文字 RPG 里「远处但有关系的人」
   比「同城路人」更值得被记住、被 tick。
   零系统依赖（只读世界书 + WorldState），因此记忆侧与关系侧都能消费它。
   ============================================================ */
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';

export type NpcLod = 'L0' | 'L1' | 'L2';

/** 各层的处理周期（天）：L0 相关每天 / L1 接触过每 3 天 / L2 未接触每 7 天 */
export const LOD_PERIOD: Record<NpcLod, number> = { L0: 1, L1: 3, L2: 7 };

/**
 * 分层判据：
 * - 世界书里没有这个人（势力 / 玩家 / 用例占位）→ L0。它们数量恒定，
 *   与 NPC 规模无关，按最保守的频率处理；分级只该省「随 NPC 增长的那部分」成本。
 * - 世界书里有名有姓，但运行时没有条目 → L2。条目由 npcDyn() 惰性建出，
 *   不是世界书预置的，所以「没有条目」精确等于「玩家从未触及过」。
 * - 有条目但既没好感也没正式见过面 → L1。
 * - 好感不为 0、正式见过面、或当天刚聊过/刚收过礼 → L0。
 */
export function lodOfNpc(id: string, s: WorldState, nowDay?: number): NpcLod {
  if (!WB.npcs[id]) return 'L0';
  const dy = s.npcs[id];
  if (!dy) return 'L2';
  if (dy.att !== 0 || dy.met) return 'L0';
  /* 当天刚聊过 / 刚收过礼也算「相关」——不把正在发生的交互降级处理 */
  if (nowDay !== undefined && (dy.chatDay?.day === nowDay || dy.giftDay?.day === nowDay)) return 'L0';
  return 'L1';
}

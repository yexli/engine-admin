/* ============================================================
   话题深度判据与进展落档（P3 · 《NPC 立体化与深入对话方案》§4.3）
   ——「他肯说到哪一层」的唯一判据源。

   为什么必须落档、不能从对话窗口里数：
   Chat 的窗口有 CAP_TURNS=20 封顶（超出丢最旧）。从窗口里数「问过几次」，
   会在写满窗口之后掉头向下——第三次问的话题看起来只问过一次，深水区当场
   退回表层，追问链也会把已经问过的标签重新吐出来。
   （同一个坑 applyChat 的轮次计时早就踩过一次，解法同样是「记在状态里」。）

   为什么记「次数」而不是「层数」：
   层数 = f(次数, gate)，而 gate 里的好感会回落（att<60 时亲密度权益冻结）。
   记层数就会出现「曾经谈透、关系变差后记录倒退」的谎；次数是单调的，层数每
   次现算——关系变差时「他这次不肯说了」是真实反应，不是记录被抹掉。

   本模块零依赖：只读 WorldState 与传进来的话题卡，不 import 任何系统。
   判据不掷随机、不读时间——同输入必得同输出（分级方案的硬约束 §15）。
   ============================================================ */
import type { NpcDynamic, NpcTopicCard, WorldState } from '@/types/world';

/** 落档键数上限：只记谈过的话题，不让存档随内容量无界膨胀 */
export const TALK_MAX_KEYS = 8;

export interface TopicGateCtx {
  att: number;
  /** 「权益有效档」（Bond.bondOf 的冻结口径）：由调用方给出，本模块不自己判 */
  intimacy?: number;
  questOk?: boolean;
  flagOk?: boolean;
}

function dynOf(s: WorldState, id: string): NpcDynamic | undefined {
  return s.npcs[id];
}

/** 这个话题被玩家问过几次（旧档无字段 → 0，行为与从前一致） */
export function askedOf(s: WorldState, id: string, label: string): number {
  return dynOf(s, id)?.talkProg?.[label] ?? 0;
}

/** 记一次提问，返回累计次数。键数满时丢「问得最少」的那条（并列按字典序，保持确定性） */
export function markAsked(s: WorldState, id: string, label: string): number {
  const dy = dynOf(s, id);
  if (!dy) return 0;
  const p = (dy.talkProg = dy.talkProg || {});
  if (!(label in p) && Object.keys(p).length >= TALK_MAX_KEYS) {
    const coldest = Object.keys(p).sort((a, b) => p[a] - p[b] || (a < b ? -1 : a > b ? 1 : 0))[0];
    delete p[coldest];
  }
  p[label] = (p[label] ?? 0) + 1;
  return p[label];
}

/** 标记谈透；**首次**返回 true——图鉴解锁与代价都只付一次 */
export function markDeep(s: WorldState, id: string, label: string): boolean {
  const dy = dynOf(s, id);
  if (!dy) return false;
  const list = (dy.talkDeep = dy.talkDeep || []);
  if (list.includes(label)) return false;
  list.push(label);
  if (list.length > TALK_MAX_KEYS) list.splice(0, list.length - TALK_MAX_KEYS);
  return true;
}

/** 深水区门槛：卡上写了哪几条就要过哪几条（缺省 = 无门） */
export function topicGateOk(card: NpcTopicCard, g: TopicGateCtx): boolean {
  const c = card.gate;
  if (!c) return true;
  if (c.att && g.att < c.att) return false;
  if (c.intimacy && (g.intimacy ?? 0) < c.intimacy) return false;
  if (c.quest && !g.questOk) return false;
  if (c.flag && !g.flagOk) return false;
  /* item 门：数据层目前无人使用，而判定要查背包（会把 systems/character 拉进来，
     多一条跨系统边）。保守取「未满足」——宁可停在 inner，也不让深水区在没有依据时开口。 */
  if (c.item) return false;
  return true;
}

/**
 * 该话题这一轮说到第几层：0 表层 say / 1 内层 inner / 2 深水区 core。
 * 层进由「问过几次」与「过没过 gate」两个确定性条件决定，不掷随机。
 */
export function topicDepth(
  card: NpcTopicCard,
  asked: number,
  att: number,
  gate: Omit<TopicGateCtx, 'att'> = {},
): 0 | 1 | 2 {
  const ok = topicGateOk(card, { ...gate, att });
  if (asked >= 3 && card.core && ok) return 2;
  if (asked >= 2 && card.inner) return 1;
  return 0;
}

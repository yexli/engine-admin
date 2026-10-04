/* ============================================================
   世界事件标准结构（《插件化世界模拟架构方案》§6 / §12 / §22 / §29 / §30 / §44）
   ------------------------------------------------------------
   【World Engine 抽取】事件结构（WorldEvent / makeEvent / 序号 /
   traceChain / 通道推导）已抽入独立引擎；分级表（level）与通道覆盖
   表（channel）是**天穹的世界观**——什么算大事、哪些节律事实走
   critical 通道——它们留在这里，并在模块加载时注册进引擎
   （未注册的类型按 Level 1 / ambient 处理）。
   CoreEvent 是「给界面看的信号」；WorldEvent 是「世界已经发生的事实」。
   铁律 §22：Action ≠ Event。意图进系统校验，事实才进事件总线。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { registerEventTables } from 'world-engine';

/** 有名有姓的人物（世界书 NPC 表；可选的 runtime 表用于尚未投影的动态条目）。
    「玩家砍翻一头野狼」与「某个人死了」是两类事实——分级、目击者反应、
    推演门槛都要做这个区分，因此判定只此一处。 */
export function isNamedPerson(id?: string, runtime?: Record<string, unknown>): boolean {
  if (!id) return false;
  return !!(WB.npcs[id] || runtime?.[id]);
}

/* ---------------- 天穹的世界观：分级表（§12）与通道覆盖表 ----------------
   引擎保证结构（字段 / 幂等 / 因果 / 配额）；这两张表声明天穹如何判定
   事件的重要性。它们同时被引擎的 levelOf / channelOf 消费——单一来源。 */

const LEVEL_TABLE: Record<string, import('world-engine').WorldEventLevel> = {
  /* Level 0 · 内部事件：不进总线，不需要任何系统响应 */
  /** §21 时辰边界（WorldClock 发布，NPC 系统据此刷新自主位置）。
      刻意定级 L0：它不是「有人看见的事」——进 L1 会被感知层抽样，
      每时辰 12×在场人数 次 rng 抽取足以让主随机流与改造前错开（二期审查 I1）。 */
  hour_advanced: 0,
  damage_applied: 0,
  heal_applied: 0,
  mp_spent: 0,
  cooldown_ticked: 0,
  item_consumed: 0,
  xp_gained: 0,

  /* Level 1 · 局部事件：由对应系统自行处理 */
  /** §27 时辰边界：WorldClock 跨时辰发布，NPC 系统据此刷新自主位置 */
  /** 二期 H-09 事件化：生产方不再直调消费方（图鉴解锁 / 传闻扩散 / 结仇） */
  lore_unlocked: 1,
  rumor_spread: 1,
  grudge_formed: 2,
  npc_moved: 1,
  gold_changed: 1,
  item_gained: 1,
  item_lost: 1,
  dialogue_completed: 1,
  combat_round: 1,
  item_crafted: 1,
  travel_arrived: 1,
  weather_changed: 1,
  time_advanced: 1,

  /* Level 2 · 跨系统事件：上总线，通知相关系统（§34：一个事件 → 多系统响应） */
  character_died: 2,
  npc_missing: 2,
  crime_committed: 2,
  quest_completed: 2,
  quest_failed: 2,
  faction_relation_changed: 2,
  reputation_changed: 2,
  relationship_changed: 2,
  large_trade: 2,
  /** §27 日边界：WorldClock 在天气抽取前发布（日结算订阅者的事实来源） */
  new_day: 2,
  item_stolen: 2,
  npc_attitude_shift: 2,
  title_granted: 2,

  /* Level 3 · 复杂世界事件：进入 World Reasoner 推演（§13-§15）
     产出点现状（§37 把 Politics / War / Crime 等系统列在第五阶段，尚未接入）：
       · abyss_breach —— **已通电**：Abyss.abyssTick 在 leak 跨过 crisisAtLeak 时发布，
         ruleReasoner 据此重估星枢诸势力立场，是当前唯一在跑的 L3 链路；
       · 其余七类是**先摆好的接线位**，目前没有产生者。新增玩法时按此分级发布即可，
         ruleReasoner 已备好 faction_conflict / city_at_war 的后果推理。
     不要因为「表里有」就以为它们在跑——推演门槛认的是实际发布的事件。 */
  ruler_died: 3,
  npc_assassinated: 3,
  city_at_war: 3,
  faction_conflict: 3,
  player_betrayed_faction: 3,
  city_disaster: 3,
  major_political_event: 3,
  abyss_breach: 3,
};

const CHANNEL_TABLE: Record<string, import('world-engine').EventChannel> = {
  /* 节律事实：每天固定 ≤ 12 + 1 条，量级不随玩法波动，所以不计普通配额。
     也正因如此必须配独立熔断（见 EventBus 的 MAX_CRITICAL_PER_TICK）——
     「不计配额」不等于「可以无限执行」（改进版 §8.1）。 */
  hour_advanced: 'critical',
  new_day: 'critical',
};

/* 天穹分级/通道表注册进引擎（本模块被任何 emit 路径引用，注册时序天然满足） */
registerEventTables(LEVEL_TABLE, CHANNEL_TABLE);

/* ---------------- 结构与工具：单一来源在引擎 ---------------- */
export {
  makeEvent,
  levelOf,
  channelOf,
  eventSeq,
  setEventSeq,
  resetEventSeq,
  nextEventId,
  traceChain,
  ALL_EVENT_TYPES,
} from 'world-engine';
export type {
  WorldEvent,
  EventDraft,
  EventChannel,
  WorldEventLevel,
} from 'world-engine';

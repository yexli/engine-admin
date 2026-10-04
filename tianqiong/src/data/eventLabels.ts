/* ============================================================
   世界事件的中文标签（纯数据 · 零逻辑）
   —— worldEventLog 里的 type 是 snake_case 事实名（§6 事件标准），
      玩家侧需要可读标签。刻意做在数据层而不是组件里：新增事件类型时
      只往这张表里加一行，不碰任何组件。
   兜底：未登记的 type **直接显示原名**（不隐藏、不猜测）——
      漏登记的结果是「显示英文名」，而不是「显示错名字」。
   ============================================================ */
export const EVENT_LABELS: Record<string, string> = {
  /* Level 0 · 内部账目（不入世界史，登记只为表完整） */
  hour_advanced: '时辰推移',
  damage_applied: '受到伤害',
  heal_applied: '得到治疗',
  mp_spent: '消耗法力',
  cooldown_ticked: '冷却推进',
  item_consumed: '消耗物品',
  xp_gained: '获得经验',

  /* Level 1 · 局部事件 */
  lore_unlocked: '文献解锁',
  rumor_spread: '流言扩散',
  grudge_formed: '结下仇怨',
  npc_moved: '有人走动',
  gold_changed: '钱货往来',
  item_gained: '得到物品',
  item_lost: '失去物品',
  dialogue_completed: '一场交谈',
  combat_round: '交手一合',
  item_crafted: '制成器物',
  travel_arrived: '远行抵达',
  weather_changed: '天候转变',
  time_advanced: '时日推移',

  /* Level 2 · 跨系统事件 */
  character_died: '有人殒命',
  npc_missing: '有人失踪',
  crime_committed: '罪行发生',
  quest_completed: '委托完成',
  quest_failed: '委托失败',
  faction_relation_changed: '势力关系变动',
  reputation_changed: '声望变动',
  relationship_changed: '关系变动',
  large_trade: '大笔交易',
  new_day: '新的一日',
  item_stolen: '物品失窃',
  npc_attitude_shift: '态度转变',
  title_granted: '获授称号',

  /* Level 3 · 复杂世界事件（推演门槛） */
  ruler_died: '统治者之死',
  npc_assassinated: '刺杀发生',
  city_at_war: '兵戈相见',
  faction_conflict: '势力冲突',
  player_betrayed_faction: '背叛势力',
  city_disaster: '城邦灾祸',
  major_political_event: '政局剧变',
  abyss_breach: '星渊失守',
};

/** 取事件的中文标签；未登记则回落原名（绝不猜测） */
export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

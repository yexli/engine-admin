/* ============================================================
   Evolution Policy · 触发分级（V2 · 方案 §四/§五）
   ------------------------------------------------------------
   两件事：
   1) 事件分级（Trigger Grade）：禁止「每个 Event → 所有 NPC → AI」。
      High 立即触发（玩家进入 NPC 所在地点 / 主动交互 / 重大关系变化）；
      Medium 延迟或批量（时间推进 / 天气 / 日程 / 区域状态）；
      Low 后台（普通移动 / 无关小行为 / 低价值环境变化）。
   2) 自动触发判定（shouldAutoTrigger）：观察窗口里出现 High 事件才
      值得打断 AI；Medium/Low 攒着，等 High 或管理台手动。
   分级表是「类型级」的保守缺省（不认识具体游戏）；游戏方可按
   事件类型覆盖（override 表）——天穹专属语义不进平台。
   ============================================================ */
import type { TriggerEventView, TriggerGrade } from './types.ts';

/** 缺省分级表：按事件类型（snake_case 前缀匹配，* 兜底） */
export const DEFAULT_TRIGGER_GRADES: Record<string, TriggerGrade> = {
  // High：玩家与 NPC 的直接相遇 / 交互 / 关系变化（方案 §五 High 清单）。
  // P13 同源修正：键必须匹配引擎真实事实类型——态度变化实际发 npc_attitude_shift
  // （原 attitude_changed 永不匹配，态度事实被漏判为 low）；战斗事实为 attack_*。
  player_moved: 'high',
  entity_moved: 'high',
  talk_started: 'high',
  talk: 'high',
  relation_set: 'high',
  npc_attitude_shift: 'high',
  quest: 'high',
  attack_: 'high',
  // Medium：世界节拍变化，延迟/批量处理
  time_advanced: 'medium',
  weather_changed: 'medium',
  schedule_changed: 'medium', // 前瞻键：日程变更事件（P6 机制已备，事件未定义）
  // Low：环境噪音，后台处理（未列出的类型兜底也是 low）
  '*': 'low',
};

export interface TriggerPolicyOptions {
  /** 游戏方覆盖表（键 = 事件类型前缀或 *；值 = 级别） */
  grades?: Record<string, TriggerGrade>;
}

function gradeOf(type: string, grades: Record<string, TriggerGrade>): TriggerGrade {
  if (grades[type]) return grades[type]!;
  for (const [prefix, g] of Object.entries(grades)) {
    if (prefix !== '*' && type.startsWith(prefix)) return g!;
  }
  return grades['*'] ?? 'low';
}

/**
 * 给一批新事实定级：取窗口内最高级别。
 * 感知边界纪律：事件有 witnesses 时，只有玩家在场（witnesses 含
 * 'player' 或未声明 witnesses = 公开事实）才算 High 依据——
 * 玩家不在场的事不该由玩家视角触发演化。
 */
export function gradeEvents(events: TriggerEventView[], opts: TriggerPolicyOptions = {}): TriggerGrade {
  const grades = { ...DEFAULT_TRIGGER_GRADES, ...(opts.grades ?? {}) };
  let best: TriggerGrade = 'low';
  const rank: Record<TriggerGrade, number> = { low: 0, medium: 1, high: 2 };
  for (const e of events) {
    const witnessed = !e.witnesses || e.witnesses.length === 0 || e.witnesses.includes('player');
    const g = gradeOf(e.type, grades);
    if (witnessed && rank[g]! > rank[best]!) best = g;
  }
  return best;
}

/** High 事件清单（自动触发依据；给 Journal/管理台展示「为什么触发」） */
export function highEventsOf(events: TriggerEventView[], opts: TriggerPolicyOptions = {}): TriggerEventView[] {
  const grades = { ...DEFAULT_TRIGGER_GRADES, ...(opts.grades ?? {}) };
  return events.filter((e) => {
    const witnessed = !e.witnesses || e.witnesses.length === 0 || e.witnesses.includes('player');
    return witnessed && gradeOf(e.type, grades) === 'high';
  });
}

/** 是否值得自动触发演化：窗口内存在 High 级事实 */
export function shouldAutoTrigger(events: TriggerEventView[], opts: TriggerPolicyOptions = {}): boolean {
  return highEventsOf(events, opts).length > 0;
}

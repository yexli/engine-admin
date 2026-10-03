/* ============================================================
   Trigger Engine · Wake Assessment（P3 · 方案 §六：哪些实体值得被 AI 唤醒）
   ------------------------------------------------------------
   世界发生事件后，Trigger 只回答一个问题：**谁值得被考虑**。
   它不决定 NPC 做什么——被唤醒 ≠ 必须反应；反应与否仍由
   Context → AI 提案 → Rules 裁决（P1 已验证的空提案纪律）。

   纯函数、确定性、可解释：每个实体的裁决带 reasons（命中了哪些
   因素），「谁没被唤醒」与「为什么」同样可查——管理台/审计从
   run.wakePlan 能看到完整唤醒面，而不只是被触发的那个。

   判定因素（方案 §六输入清单 → 引擎已有事实的映射）：
     距离/地点   → 实体 location 与事件地点（或玩家位置）同地
     感知边界    → 事件 witnesses：列名者才「看见」（无 witnesses = 公开事实）
     事件类型    → gradeEvents 的世界级分级（玩家发起的 High 事实才有 AI）
     事件牵涉    → 实体是事件的 actor/target
     关系        → 实体↔玩家（或事件发起者）的最强关系值
     NPC 状态    → met（见过玩家）/ att（对玩家态度）
     最近互动    → 本批新事实里的直接牵涉（跨批记忆归 P7 Memory）
     世界时间/NPC 目标 → 引擎暂无对应事实，留待 P5/P6（缺因素不编造）

   结构性纪律：worthWaking = false 时，本批事实 **零 AI 调用**——
   这是「同一个 Event 不能导致所有 NPC 同时调用 AI」的直接实现。
   ============================================================ */
import { gradeEvents, type TriggerPolicyOptions } from './policy.ts';
import type { TriggerEventView, TriggerGrade, WakeAssessment, WakeGrade, WakePlan } from './types.ts';

/** 唤醒评估输入的实体最小面（引擎 GET /state 的 npcs 投影） */
export interface WakeEntityView {
  id: string;
  /** 实体当前所在地（attributes.location 的宿主约定） */
  location?: string;
  att?: number;
  met?: boolean;
}

/** 唤醒评估输入的状态最小面 */
export interface WakeStateView {
  /** 玩家当前位置（事件无地点时的回退锚点） */
  playerLoc?: string;
  entities: Record<string, WakeEntityView>;
  /** 关系读取：实体 ↔ 对方（玩家或事件发起者）的最强关系值；缺省视为无关系 */
  relationValue?: (entityId: string, otherId: string) => number | undefined;
}

/** 唤醒评估输入的事件面（引擎事实 + 位置归一化） */
export interface WakeEventView extends TriggerEventView {
  id?: string;
  /** 事件地点（player_moved 在事件字段；entity_moved 在 data.location） */
  location?: string;
  target?: string;
  data?: Record<string, unknown>;
}

export interface WakeOptions extends TriggerPolicyOptions {
  /** 「有关系」的关系值阈值（缺省 10） */
  relationThreshold?: number;
  /** 「有态度」的 att 阈值（缺省 20） */
  attitudeThreshold?: number;
}

/** 事件地点归一化：事件字段 → data.location → 玩家发起回退玩家位置 */
function eventLocation(e: WakeEventView, state: WakeStateView): string | undefined {
  const direct = e.location ?? (typeof e.data?.['location'] === 'string' ? (e.data['location'] as string) : undefined);
  if (direct) return direct;
  if (e.actor === 'player') return state.playerLoc;
  return undefined;
}

/**
 * 对一批新事实做逐实体唤醒评估。
 * 返回完整 WakePlan：世界级分级 + 每个实体的裁决（含 none）+ worthWaking。
 */
export function assessWake(state: WakeStateView, events: WakeEventView[], opts: WakeOptions = {}): WakePlan {
  const worldGrade = gradeEvents(events, opts);
  const relationThreshold = opts.relationThreshold ?? 10;
  const attitudeThreshold = opts.attitudeThreshold ?? 20;

  /* 主事件：窗口内最高级的玩家可见事实（同分取最新；事件顺序为新 → 旧）。
     唤醒评估锚定主事件——一批事实一次评估，一个批次至多一次 AI 调用。 */
  const rank: Record<TriggerGrade, number> = { low: 0, medium: 1, high: 2 };
  const witnessed = (e: WakeEventView): boolean => !e.witnesses || e.witnesses.length === 0 || e.witnesses.includes('player');
  const candidates = events.filter(witnessed);
  let primary: WakeEventView | undefined;
  for (const e of candidates) {
    if (!primary || rank[gradeEvents([e], opts)]! > rank[gradeEvents([primary], opts)]!) primary = e;
  }
  if (!primary) {
    return {
      worldGrade,
      wakes: Object.keys(state.entities).map((id) => ({ entityId: id, grade: 'none' as WakeGrade, reasons: ['no_player_visible_event'] })),
      worthWaking: false,
    };
  }

  const loc = eventLocation(primary, state);
  const relOf = (entityId: string): number | undefined => {
    if (!state.relationValue) return undefined;
    const withPlayer = state.relationValue(entityId, 'player');
    const withActor = primary!.actor && primary!.actor !== 'player' ? state.relationValue(entityId, primary!.actor) : undefined;
    const vals = [withPlayer, withActor].filter((v): v is number => typeof v === 'number');
    return vals.length ? Math.max(...vals) : undefined;
  };

  const wakes: WakeAssessment[] = Object.entries(state.entities).map(([id, e]) => {
    const sameLoc = loc !== undefined && e.location !== undefined && e.location === loc;
    const involved = primary!.actor === id || primary!.target === id;
    const inWitnesses = primary!.witnesses?.includes(id) ?? false;
    const reasons: string[] = [];
    if (sameLoc) reasons.push('same_location');
    if (involved) reasons.push('involved');
    if (inWitnesses) reasons.push('witnessed');

    /* 感知边界（方案 §五 witnesses 纪律的实体版）：事件声明了 witnesses 时，
       只有列名者/直接牵涉者感知得到——同地但不在 witnesses（在后厨睡觉）
       也不算看见。未声明 witnesses = 公开事实，同地即可感知。 */
    const perceived = primary!.witnesses && primary!.witnesses.length > 0 ? inWitnesses || involved : sameLoc || involved;
    if (!perceived) return { entityId: id, grade: 'none' as WakeGrade, reasons: reasons.length ? reasons : ['not_perceived'] };

    let score = 1; // 感知基线：值得「考虑」
    if (sameLoc) score++;
    if (involved) score++;
    if (inWitnesses) score++;
    const related =
      e.met === true ||
      (typeof e.att === 'number' && e.att >= attitudeThreshold) ||
      (relOf(id) !== undefined && relOf(id)! >= relationThreshold);
    if (related) {
      score++;
      reasons.push(e.met === true ? 'met_player' : typeof e.att === 'number' && e.att >= attitudeThreshold ? 'attitude' : 'relationship');
    }

    const grade: WakeGrade = score >= 3 ? 'high' : score === 2 ? 'medium' : 'low';
    return { entityId: id, grade, reasons };
  });

  return {
    worldGrade,
    primaryEventId: primary.id,
    wakes,
    worthWaking: wakes.some((w) => w.grade === 'high'),
  };
}

/** 把引擎 GET /state 的形状投影成唤醒评估输入（宿主 attributes.location 约定） */
export function wakeStateViewOf(s: {
  player?: { loc?: string };
  npcs?: Record<string, { att?: number; met?: boolean; attributes?: Record<string, unknown> }>;
  relations?: { source: string; target: string; type: string; value?: number }[];
}): WakeStateView {
  const entities: Record<string, WakeEntityView> = {};
  for (const [id, n] of Object.entries(s.npcs ?? {})) {
    const loc = n.attributes?.['location'] !== undefined ? String(n.attributes['location']) : undefined;
    entities[id] = {
      id,
      ...(loc !== undefined ? { location: loc } : {}),
      ...(typeof n.att === 'number' ? { att: n.att } : {}),
      ...(n.met === true ? { met: true } : {}),
    };
  }
  return {
    ...(s.player?.loc !== undefined ? { playerLoc: s.player.loc } : {}),
    entities,
    ...(s.relations?.length
      ? {
          relationValue: (a: string, b: string) => {
            let best: number | undefined;
            for (const r of s.relations ?? []) {
              const hit = (r.source === a && r.target === b) || (r.source === b && r.target === a);
              if (hit && typeof r.value === 'number') best = best === undefined ? r.value : Math.max(best, r.value);
            }
            return best;
          },
        }
      : {}),
  };
}

/** 引擎事实 → 唤醒评估事件面（位置归一化到统一字段） */
export function wakeEventsOf(events: (TriggerEventView & { id?: string; location?: string; target?: string; data?: Record<string, unknown> })[]): WakeEventView[] {
  return events.map((e) => ({
    ...(e.id !== undefined ? { id: e.id } : {}),
    type: e.type,
    ...(e.actor !== undefined ? { actor: e.actor } : {}),
    ...(e.target !== undefined ? { target: e.target } : {}),
    ...(e.location !== undefined ? { location: e.location } : {}),
    ...(e.witnesses !== undefined ? { witnesses: e.witnesses } : {}),
    ...(e.data !== undefined ? { data: e.data } : {}),
  }));
}

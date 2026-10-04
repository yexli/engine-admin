/* ============================================================
   信念系统（《Memory Engine 记忆系统设计方案》§24 / §25）
   —— Memory → Evidence → Belief Formation。
   铁律 §24：**信念可以变，原始记忆不因观点改变而被覆盖**。
   铁律 §25：同一主体可以同时持有互相冲突的记忆，不要简单覆盖——
      本模块把支持与反驳都留在 Belief 里，谁占上风由置信度体现，不由删除决定。
   边界（§46）：只做「同命题聚合」这一层，不做复杂心理模型、推断链与记忆重构。
   ============================================================ */
import cfg from '@/data/world/memory.json';
import { worldEventLog } from '@/events/EventStore';
import { memoriesOf } from '../MemoryStore';
import type { Belief, Memory, WorldState } from '@/types/world';

/**
 * 单条记忆的命题（主体|事件类型|客体）。
 * **优先读记忆自带的字段**——事件日志是不入档的环形缓冲，重启后必然查不到；
 * 早期版本只看事件日志，导致重启后的第一个日边界会把所有信念清空。
 * 回退分支只为兼容没有该字段的旧档。
 */
export function propositionOf(m: Memory): string | null {
  if (m.proposition) return m.proposition;
  if (!m.sourceEventId) return null;
  const e = worldEventLog.byId(m.sourceEventId);
  if (!e) return null;
  return [e.actor ?? '-', e.type, e.target ?? '-'].join('|');
}

/** §24 置信度聚合：取最可信的一条，其余同类记忆只做小幅加成（不叠加成「三人成虎」） */
function aggregate(list: Memory[]): number {
  const best = Math.max(...list.map((m) => m.confidence));
  const bonus = Math.min(0.15, 0.05 * (list.length - 1));
  return Math.min(1, best + bonus);
}

/** §23 的行动规则表（配置化；为空即「机制就位、内容待填」） */
const cfgBeliefActions = (cfg as unknown as { beliefActions?: { rules?: unknown[] } }).beliefActions ?? { rules: [] };

export function beliefsOf(ownerId: string, s: WorldState): Belief[] {
  return s.beliefs?.[ownerId] ?? [];
}

/** 命题拆解（主体|谓词|客体） */
export function partsOf(proposition: string): { subject: string; predicate: string; object: string } {
  const [subject = '-', predicate = '-', object = '-'] = proposition.split('|');
  return { subject, predicate, object };
}

/** beliefActions 规则表的一条（内容在 data/world/memory.json） */
export interface BeliefActionRule {
  match: { subject?: string; predicate?: string; object?: string; minConfidence?: number };
  action: string;
  params?: Record<string, unknown>;
  /** 只驱动一次（默认 true：同一条信念不该反复引发同一行动） */
  once?: boolean;
  /**
   * 卡 J2：行动的作用对象从哪取。缺省 'self'（相信者本人）。
   * 为什么需要它：命题的三段是「主体|谓词|客体」（如 player|crime_committed|otto），
   * 而大多动作的作用对象是**相信者自己**——「他相信玩家犯了罪」→ 该由他去冷淡玩家、
   * 去传这条闲话，而不是去动命题里那位受害者。把解析规则放进数据，就不必在代码里
   * 为每种动作硬编码一套取目标的逻辑。
   */
  targetFrom?: 'self' | 'subject' | 'object' | 'player';
}

export interface BeliefActionHit {
  ownerId: string;
  proposition: string;
  action: string;
  params: Record<string, unknown>;
  /** 卡 J2：按 rule.targetFrom 解析出的作用对象（'self' → ownerId） */
  target: string;
}

/**
 * 纯匹配（与配置解耦）：信念 × 规则表 → 该驱动的行动。
 * 拆出来是为了让「机制本身」能被合成规则验收——
 * 内容表留空时，否则这段逻辑永远没有测试碰得到。
 * 规则里的 `once`（默认开）表示同一条信念不重复引发同一行动。
 */
export function matchBeliefRules(ownerId: string, beliefs: Belief[], rules: BeliefActionRule[]): BeliefActionHit[] {
  const hits: BeliefActionHit[] = [];
  for (const b of beliefs) {
    for (const rule of rules) {
      const m = rule.match ?? {};
      if (m.subject && m.subject !== b.subject) continue;
      if (m.predicate && m.predicate !== b.predicate) continue;
      if (m.object && m.object !== b.object) continue;
      if (m.minConfidence !== undefined && b.confidence < m.minConfidence) continue;
      /* 已驱动过（成功或已判定不可满足）——两者都算「这条信念的事已经了结」，
         理由见 types/world.ts 的 failedAt 注释：不记账 = 每天重试一次。 */
      if (rule.once !== false && (b.actedAt !== undefined || b.failedAt !== undefined)) continue;
      const from = rule.targetFrom ?? 'self';
      const target =
        from === 'self' ? ownerId : from === 'player' ? 'player' : from === 'subject' ? b.subject : b.object;
      hits.push({ ownerId, proposition: b.proposition, action: rule.action, params: rule.params ?? {}, target });
    }
  }
  return hits;
}

export function beliefActionsFor(ownerId: string, s: WorldState): BeliefActionHit[] {
  return matchBeliefRules(ownerId, beliefsOf(ownerId, s), (cfgBeliefActions.rules ?? []) as BeliefActionRule[]);
}

/** 标记信念已被据此行动（写回 actedAt / actionKind） */
export function markBeliefActed(ownerId: string, proposition: string, action: string, s: WorldState, nowDay: number): void {
  const b = (s.beliefs?.[ownerId] ?? []).find((x) => x.proposition === proposition);
  if (!b) return;
  b.actedAt = nowDay;
  b.actionKind = action;
}

/** 标记信念被驱动过但没能落地（卡 J2）：与 actedAt 一样参与 once 判定 */
export function markBeliefFailed(ownerId: string, proposition: string, reason: string, s: WorldState, nowDay: number): void {
  const b = (s.beliefs?.[ownerId] ?? []).find((x) => x.proposition === proposition);
  if (!b) return;
  b.failedAt = nowDay;
  b.failedReason = reason;
}

/**
 * 从角色（或势力）的记忆重新推演信念。
 * 幂等：每次全量重建该主体的信念表，因此不会因为重复调用而累积。
 */
export function formBeliefs(ownerId: string, s: WorldState, nowDay: number): number {
  const mine = memoriesOf(ownerId, s).filter((m) => m.status === 'active' || m.status === 'archived');
  const byProp = new Map<string, Memory[]>();
  for (const m of mine) {
    const p = propositionOf(m);
    if (!p) continue;
    const arr = byProp.get(p);
    if (arr) arr.push(m);
    else byProp.set(p, [m]);
  }
  const out: Belief[] = [];
  /* 行动记账必须**继承**（审查 §信念 once）：actedAt / failedAt 记的是「这条事已经了结」，
     与命题此刻是否仍被记忆支撑无关。此前全量重建把它们丢掉，于是 once 判重永远不成立——
     同一条规则每天重新驱动一次（目击罪行的 NPC 每天再扣一次好感，约两周归零到敌对）。 */
  const prevByProp = new Map((s.beliefs?.[ownerId] ?? []).map((b) => [b.proposition, b]));
  for (const [proposition, list] of byProp) {
    const supporting = list.map((m) => m.id);
    const contradicting: string[] = []; // §25 的判定需要谓词级语义，当前留空（见文件头边界）
    const { subject, predicate, object } = partsOf(proposition);
    const prev = prevByProp.get(proposition);
    out.push({
      proposition,
      subject,
      predicate,
      object,
      ownerId,
      confidence: aggregate(list),
      supporting,
      contradicting,
      updatedAt: nowDay,
      ...(prev?.actedAt !== undefined ? { actedAt: prev.actedAt } : {}),
      ...(prev?.actionKind !== undefined ? { actionKind: prev.actionKind } : {}),
      ...(prev?.failedAt !== undefined ? { failedAt: prev.failedAt } : {}),
      ...(prev?.failedReason !== undefined ? { failedReason: prev.failedReason } : {}),
    });
  }
  if (!s.beliefs) s.beliefs = {};
  /* 兜底：旧档的记忆没有 proposition 字段、来源事件又已滚出缓冲时，本次判不出它们的命题。
     把这些命题的旧信念**留着**，而不是让一次重算把它们抹掉——信念的可重建性优先于表的新鲜度。
     上限防的是「记忆早已消失、信念却永久滞留」。 */
  const fresh = new Set(out.map((b) => b.proposition));
  const carried = (s.beliefs[ownerId] ?? []).filter((b) => !fresh.has(b.proposition)).slice(0, 40);
  s.beliefs[ownerId] = [...out, ...carried];
  return out.length;
}

export function beliefOf(ownerId: string, proposition: string, s: WorldState): Belief | undefined {
  return beliefsOf(ownerId, s).find((b) => b.proposition === proposition);
}

/** 该主体是否「相信」某命题（阈值可调；默认 0.5） */
export function believesIn(ownerId: string, proposition: string, s: WorldState, min = 0.5): boolean {
  const b = beliefOf(ownerId, proposition, s);
  return !!b && b.confidence >= min;
}

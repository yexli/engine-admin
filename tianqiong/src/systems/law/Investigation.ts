/* ============================================================
   调查与证据（《插件化世界模拟架构方案》§8 / §36）
   —— 感知层的下游：势力不会凭空知道罪行，只有**有人目击**才可能立案；
      立案后逐日取证推进，进度满则结案（通缉上升 + 势力敌意）。
   铁律 §26：证据只能来自感知表（谁真的看见了），不做无依据的定罪。
   铁律 §8：没人看见就没有案子——这正是信息不对称的玩法价值。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { rng } from '@/events/EventBus';
import { findFact, perception } from '@/events/Perception';
import { addRep, log } from '@/systems/character/Gains';
import { need } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import type { WorldEvent } from '@/events/EventSchema';
import type { CaseState, WorldState } from '@/types/world';

/** 结案所需进度 */
const CONCLUDE_AT = 100;
/** 每名证据每日贡献的进度 */
const EVIDENCE_WEIGHT = 8;

const factionName = (id: string): string => WB.factions[id] ?? id;

/** 立案门槛：至少一名目击者（§8 信息不对称——没人看见就没有案子） */
export function canFileCase(e: WorldEvent, s: WorldState = need()): boolean {
  return perception.knowers(e.id, s).length > 0;
}

/**
 * 立案。返回新案（未立案返回 null）。
 * 幂等：同一事件只立一次；同类型在办案件不重复立案。
 */
export function openCase(e: WorldEvent, filedBy = 'empire', s: WorldState = need()): CaseState | null {
  if (!s.cases) s.cases = [];
  const evidence = perception.knowers(e.id, s);
  if (!evidence.length) return null;
  if (s.cases.some((c) => c.id === 'case_' + e.id)) return null;
  if (s.cases.some((c) => c.status === 'open' && c.crime === e.type)) return null;
  const c: CaseState = {
    id: 'case_' + e.id,
    eventId: e.id,
    crime: e.type,
    subject: e.actor ?? 'player',
    filedBy: filedBy in s.rep ? filedBy : 'empire',
    day: e.day,
    progress: 0,
    evidence,
    status: 'open',
  };
  s.cases.push(c);
  log('（' + factionName(c.filedBy) + '的执事翻开一卷新案宗——' + e.type + '。）', 'sys', s);
  return c;
}

export function activeCases(s: WorldState = need()): CaseState[] {
  return (s.cases ?? []).filter((c) => c.status === 'open');
}

export function caseById(id: string, s: WorldState = need()): CaseState | undefined {
  return (s.cases ?? []).find((c) => c.id === id);
}

/**
 * 证据效力：亲眼所见算满，二手传闻打三折（§8）。
 * 少了这一层，传言链会凭空放大证据数、把小道消息变成铁证。
 */
function evidenceWeight(c: CaseState, s: WorldState): number {
  if (!c.eventId) return c.evidence.length; // 旧档兼容：无事件 id 时按人头计
  return c.evidence.reduce((sum, npc) => {
    const fact = findFact(npc, c.eventId, s);
    if (!fact) return sum + 0.5; // 记录已滚出感知表：算半个证人
    return sum + (fact.via === 'witness' ? 1 : 0.3) * fact.fidelity;
  }, 0);
}

/** 每日取证推进（time.newDay 调用）：证据越硬推进越快 */
export function investigationTick(s: WorldState): void {
  if (!s.cases?.length) return;
  for (const c of s.cases) {
    if (c.status !== 'open') continue;
    c.progress = Math.min(CONCLUDE_AT, c.progress + EVIDENCE_WEIGHT * evidenceWeight(c, s) + rng.R(0, 6));
    if (c.progress >= CONCLUDE_AT) concludeCase(c, s);
  }
}

/** 结案：证据确凿 → 通缉上升 + 立案势力敌意 */
function concludeCase(c: CaseState, s: WorldState): void {
  c.status = 'concluded';
  const lv = Math.max(1, Math.round(c.evidence.length / 2));
  mutate.playerNum('wanted', (v) => Math.min(5, v + lv));
  addRep(c.filedBy, -10);
  log('（' + factionName(c.filedBy) + '的案宗合上了：证据确凿，缉拿文书发往各城门。）', 'bad', s);
}

/** 供 UI / AI 读取的案件总览 */
export function caseView(s: WorldState = need()): { open: number; concluded: number; rows: CaseState[] } {
  const rows = s.cases ?? [];
  return {
    open: rows.filter((c) => c.status === 'open').length,
    concluded: rows.filter((c) => c.status === 'concluded').length,
    rows,
  };
}

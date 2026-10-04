/* ============================================================
   卡 D3 · 多维势力外交矩阵
   《项目方案》§13 关系不是单维度数字 / §31 多重声望。
   7 轴：attitude/trust/hostility/trade/military/religion/intelligence
   - 玩家对各势力：attitude 轴 = 旧 WorldState.rep[f]（向后兼容），其余 6 轴存 playerRep。
   - 势力↔势力：读 factionRel（运行时可变），缺省回落 factions.json.matrix 种子。
   纯 core：只读写 WorldState；判定与展示由此提供。
   ============================================================ */
import { WB } from '@/data/worldBook';
import seed from '@/data/world/factions.json';
import type { FactionRelation, PlayerRep, RepAxis, WorldState } from '@/types/world';
import { clamp } from '@/events/EventBus';
import { need } from '@/world/WorldState';

type Matrix = Record<string, Record<string, Partial<FactionRelation>>>;
const SEED_MATRIX = seed.matrix as unknown as Matrix;
const ZERO7: FactionRelation = {
  attitude: 0,
  trust: 0,
  hostility: 0,
  trade: 0,
  military: 0,
  religion: 0,
  intelligence: 0,
};
const PLAYER_AXES: RepAxis[] = ['trust', 'hostility', 'trade', 'military', 'religion', 'intelligence'];

/* ---------------- 神殿归属（卡 2026-09 · NPC 规模化：神殿拆五） ----------------
   为什么把归属放这里而不是散在各调用点：拆五之后，「圣辉城那座神殿算谁的」
   成为多条链路（祈祷 / 治疗 / 神选）共同的问题。散着写会出现「祈祷记生命殿、
   治疗记战争殿」这类同源不同账的漂移。 */
/** 圣辉城神殿区的主事殿：祈祷与治疗都记在它账上（神官艾德里安也归此殿）。 */
export const HOME_TEMPLE = 'temple_life' as const;
/** 万神殿五殿，顺序与 factions.json.groups.pantheon.members 一致。 */
export const PANTHEON_TEMPLES = [
  'temple_war',
  'temple_wisdom',
  'temple_life',
  'temple_death',
  'temple_chaos',
] as const;

/** 势力名称（沿用世界书 factions 表，缺名回落 id） */
export const factionName = (f: string) => (WB.factions as Record<string, string>)[f] || f;

/** 初始化玩家多维声望（hydrate/newState 调用；幂等，只补空缺） */
export function initPlayerRep(s: WorldState): void {
  s.playerRep = s.playerRep || {};
  for (const f of Object.keys(s.rep)) {
    if (!s.playerRep[f as keyof typeof s.playerRep]) {
      s.playerRep[f as keyof typeof s.playerRep] = { trust: 0, hostility: 0, trade: 0, military: 0, religion: 0, intelligence: 0 };
    }
  }
}

/** 读玩家对势力某轴声望（attitude 走旧 rep，其余走 playerRep，缺省 0） */
export function repAxis(f: string, axis: RepAxis, s: WorldState = need()): number {
  if (axis === 'attitude') return s.rep[f] || 0;
  return s.playerRep?.[f as keyof typeof s.playerRep]?.[axis] || 0;
}

/** 调整玩家对势力某轴声望（attitude 请走 gains.addRep；此处只管其余 6 轴） */
export function adjRepAxis(f: string, axis: RepAxis, n: number, s: WorldState = need()): number {
  if (axis === 'attitude') throw new Error('attitude 轴请走 gains.addRep（保持向后兼容单一写入口）');
  initPlayerRep(s);
  const pr = (s.playerRep as Record<string, PlayerRep>)[f];
  pr[axis] = clamp(pr[axis] + n, -100, 100);
  return pr[axis];
}

/** 势力↔势力外交关系（运行时 factionRel 覆盖种子；缺字段回落种子/零值） */
export function relBetween(a: string, b: string, s: WorldState = need()): FactionRelation {
  const base = { ...ZERO7, ...(SEED_MATRIX[a]?.[b] || {}) };
  const live = s.factionRel?.[a]?.[b];
  if (!live) return base;
  for (const k of Object.keys(base) as RepAxis[]) if (live[k] !== undefined) base[k] = live[k];
  return base;
}

/** 势力↔势力某轴读数 */
export function standingBetween(a: string, b: string, axis: RepAxis, s: WorldState = need()): number {
  return relBetween(a, b, s)[axis];
}

/** 调整势力↔势力外交某轴（惰性写入 factionRel，不动种子） */
export function adjFactionRel(a: string, b: string, axis: RepAxis, n: number, s: WorldState = need()): number {
  if (a === b) return 0;
  s.factionRel = s.factionRel || {};
  s.factionRel[a] = s.factionRel[a] || {};
  const cur = s.factionRel[a][b]?.[axis] ?? standingBetween(a, b, axis, s);
  const v = clamp(cur + n, -100, 100);
  s.factionRel[a][b] = { ...s.factionRel[a][b], [axis]: v };
  return v;
}

/** 关系标签（供 UI）：正→友好/合作，负→紧张/敌对，近零→中性 */
export function relWord(v: number): string {
  return v >= 45 ? '紧密' : v >= 15 ? '友好' : v > -15 ? '中性' : v > -45 ? '紧张' : '敌对';
}

/** 玩家对势力的 7 轴一览（attitude 取 rep），供面板渲染 */
export function playerStanding(f: string, s: WorldState = need()): FactionRelation {
  const out: Partial<FactionRelation> = { attitude: repAxis(f, 'attitude', s) };
  for (const ax of PLAYER_AXES) out[ax] = repAxis(f, ax, s);
  return { ...ZERO7, ...out };
}

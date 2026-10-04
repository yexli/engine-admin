/* ============================================================
   卡 I3 · 状态效果（纯函数层）
   —— 六种状态的数据在 src/data/world/tables.json.status（零逻辑），此处只做判定。
   —— 无 core 依赖：combat.ts 与 derived.ts 都可安全引用（避免 combat↔derived 环）。
   —— 状态只活在 CombatState / CombatFoe 上，战斗结束随 CB 一并丢弃，绝不落档。
   ============================================================ */
import tables from '@/data/world/tables.json';
import type { ElemKind, MonsterDef, StatusDef, StatusId, StatusInst } from '@/types/world';


const DEFS = (tables.status || {}) as unknown as Record<StatusId, StatusDef>;
const ELEM_MOD = (tables.elemMod || {}) as unknown as Record<string, Record<string, number>>;
const STATUS_IDS = Object.keys(DEFS) as StatusId[];

export const statusIds = (): StatusId[] => STATUS_IDS.slice();
export const statusDef = (id: StatusId): StatusDef | undefined => DEFS[id];
export const statusName = (id: StatusId): string => DEFS[id]?.name ?? id;

/** 命中/防御修正（按叠层累加；未定义状态忽略，不抛错） */
export function stMod(arr: StatusInst[] | undefined, k: 'hitMod' | 'acMod' | 'dmgMod'): number {
  let v = 0;
  for (const s of arr || []) {
    const d = DEFS[s.id];
    if (d && d[k]) v += d[k]! * Math.max(1, s.stack || 1);
  }
  return v;
}

/** 本回合持续伤害（DoT）总量 */
export function dotOf(arr: StatusInst[] | undefined): number {
  let v = 0;
  for (const s of arr || []) {
    const d = DEFS[s.id];
    if (d?.dot) v += (s.power || d.power || 0) * Math.max(1, s.stack || 1);
  }
  return v;
}

/** 是否被控（跳过本回合） */
export const hasSkip = (arr: StatusInst[] | undefined): boolean => (arr || []).some((s) => DEFS[s.id]?.skip);
export const hasStatus = (arr: StatusInst[] | undefined, id: StatusId): boolean => (arr || []).some((s) => s.id === id);

/**
 * 卡 N1 · 负面态判定（数据驱动，不写死名单）。
 * 为什么不留一张手写的「六种负面」清单：状态表是数据层，将来加一条新负面态时清单不会自己更新，
 * 而净化类道具要的是「此刻挂在我身上的坏东西」，不是某年某月的快照。
 * 判定取三条既有语义：持续伤害 / 跳过回合 / 任一修正为负。
 */
export const isNegativeStatus = (id: StatusId): boolean => {
  const d = DEFS[id];
  if (!d) return false;
  return !!d.dot || !!d.skip || (d.hitMod ?? 0) < 0 || (d.acMod ?? 0) < 0 || (d.dmgMod ?? 0) < 0;
};
export const negativeStatusIds = (): StatusId[] => STATUS_IDS.filter(isNegativeStatus);

/**
 * 施加状态：同 id 未满层则叠层并刷新时长；已满层只刷新时长。
 * 首领免疫集（immuneBoss）直接拒——防 BOSS 被控死（方案 gate 旋钮）。
 */
export function applyStatus(
  arr: StatusInst[],
  id: StatusId,
  dur: number,
  power: number,
  boss = false,
): { ok: boolean; stacked: boolean } {
  const d = DEFS[id];
  if (!d) return { ok: false, stacked: false };
  if (boss && d.immuneBoss) return { ok: false, stacked: false };
  const cap = Math.max(1, d.maxStack || 1);
  const cur = arr.find((s) => s.id === id);
  if (!cur) {
    arr.push({ id, dur: Math.max(1, Math.min(dur, d.dur || dur)), power: Math.max(0, power), stack: 1 });
    return { ok: true, stacked: false };
  }
  /* 时长同样夹取到状态表声明的上限：否则一次敌意施法就能把眩晕拖到 99 回合 */
  const capDur = Math.max(1, d.dur || dur);
  if (cur.stack < cap) {
    cur.stack++;
    cur.dur = Math.max(cur.dur, Math.min(dur, capDur));
    cur.power = Math.max(cur.power, power);
    return { ok: true, stacked: true };
  }
  cur.dur = Math.max(cur.dur, Math.min(dur, capDur));
  cur.power = Math.max(cur.power, power);
  return { ok: true, stacked: false };
}

/** 解除状态（净化类技能） */
export function cureStatus(arr: StatusInst[], ids: StatusId[]): number {
  let n = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (ids.includes(arr[i].id)) {
      arr.splice(i, 1);
      n++;
    }
  }
  return n;
}

/**
 * 只走时长：扣 1 并清过期。
 * 与 DoT 分开是刻意的——战斗中的顺序是「DoT → 敌方回合（读跳过/命中修正）→ 回合末递减」，
 * 若倒过来，dur=1 的眩晕会在生效前先过期（实测踩过）。
 */
export function decayStatus(arr: StatusInst[]): StatusId[] {
  const expired: StatusId[] = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    arr[i].dur--;
    if (arr[i].dur <= 0) {
      expired.push(arr[i].id);
      arr.splice(i, 1);
    }
  }
  return expired;
}

/** 回合结算（纯函数用法：DoT + 递减一步到位；战斗内请用 dotOf/decayStatus 分阶段） */
export function tickStatus(arr: StatusInst[]): { dmg: number; expired: StatusId[] } {
  return { dmg: dotOf(arr), expired: decayStatus(arr) };
}

/** 元素修正（按怪物族标记查表；未登记的族/元素返回 1） */
export function elemMult(m: Pick<MonsterDef, 'undead'>, elem?: ElemKind): number {
  if (!elem) return 1;
  const tag = m.undead ? 'undead' : '';
  if (!tag) return 1;
  return ELEM_MOD[tag]?.[elem] ?? 1;
}

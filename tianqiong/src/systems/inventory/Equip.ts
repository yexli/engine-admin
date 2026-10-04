/* ============================================================
   卡 I1 · 装备实例化（品质七档 / 词缀 / 专名 / 实例计价）
   —— 数据全部落在 src/data/world/affix.json（data 层零逻辑），core 只做判定。
   —— 数值出口唯一：derived.stat/AC/atkB 读 `instMods`，战斗伤害式读 `wornMods`。
   —— 旧档语义：无 uid 的槽位恒为 0 加成，AC/atkB/stat 与改动前逐位一致。
   ============================================================ */
import affix from '@/data/world/affix.json';
import econ from '@/data/world/economy.json';
import { WB } from '@/data/worldBook';
import type { BagSlot, ItemDef, StatName, WorldState } from '@/types/world';
import { rng } from '@/events/EventBus';
import { priceOf } from '@/systems/economy/Economy';
import { generateItem } from '@/systems/naming/Naming';
import { need } from '@/world/WorldState';

/* ---------------- 数据固化（as unknown as T 与项目既有 data 加载器同规） ---------------- */

export interface AffixEff {
  atk?: number;
  def?: number;
  stat?: Partial<Record<StatName, number>>;
  crit?: number; // 比例类：不被品质强度放大
  leech?: number; // 比例类
  elem?: number; // 附加元素伤害
  thorns?: number;
  ward?: number;
  haste?: number;
}
export interface AffixDef {
  id: string;
  name: string;
  kind: 'wpn' | 'arm' | 'both';
  tierMin: number;
  tierMax: number;
  weight: number;
  eff: AffixEff;
}
/** 实例加成聚合（全 0 = 旧档语义） */
export interface InstMods {
  atk: number;
  def: number;
  stat: Partial<Record<StatName, number>>;
  crit: number;
  leech: number;
  elem: number;
  thorns: number;
  ward: number;
  haste: number;
}
/** 可携带实例信息的槽位（背包槽 or 已装备实例） */
export interface InstSource {
  id?: string;
  uid?: string;
  q?: number;
  af?: string[];
}

const Q = affix.quality as unknown as { names: string[]; colors: string[]; base: number[]; shift: number[]; maxRoll: number };
const CAPS = affix.caps as unknown as { affix: number; scalePerQuality: number; pricePerAffix: number };
const CRIT = affix.crit as unknown as { base: number; max: number };
const AFFIXES = affix.affixes as unknown as AffixDef[];
const BY_ID = new Map(AFFIXES.map((a) => [a.id, a]));
const QUALITY_MULT = econ.qualityMult as unknown as Record<string, number>;

export const AFFIX_CAP = CAPS.affix;
export const CRIT_BASE = CRIT.base;
export const CRIT_MAX = CRIT.max;
export const affixById = (id: string): AffixDef | undefined => BY_ID.get(id);
export const qualityName = (q?: number): string => Q.names[q ?? 0] ?? Q.names[0];
export const qualityColor = (q?: number): string => Q.colors[q ?? 0] ?? Q.colors[0];
export const qualityMult = (q?: number): number => QUALITY_MULT[qualityName(q)] ?? 1;
/** 槽位是否为实例（有 uid 即实例；旧档槽位恒 false） */
export const isInstance = (x?: { uid?: string } | null): boolean => !!x?.uid;

/* ---------------- 品质掷档 ---------------- */

/** 品质权重：P[q] ∝ base[q] × (1 + (tier-1)×shift[q]) × (1 + luck×0.05) */
export function qualityWeights(tier = 1, luck = 0, allowGod = false): number[] {
  const t = Math.max(1, Math.min(5, Math.floor(tier) || 1));
  const maxQ = allowGod ? Q.base.length - 1 : Q.maxRoll;
  const lk = 1 + Math.max(0, luck) * 0.05;
  return Q.base.map((b, q) => {
    if (q > maxQ) return 0;
    const shift = Math.max(0, 1 + (t - 1) * (Q.shift[q] ?? 0));
    return Math.max(0, b * shift * lk);
  });
}

/** 按权重掷品质档（0–6；allowGod=false 时神器档权重为 0） */
export function rollQuality(tier = 1, luck = 0, allowGod = false): number {
  const w = qualityWeights(tier, luck, allowGod);
  let total = 0;
  for (const x of w) total += x;
  if (total <= 0) return 0;
  let x = rng.next() * total;
  for (let q = 0; q < w.length; q++) {
    x -= w[q];
    if (x < 0) return q;
  }
  return w.length - 1;
}

/** 词缀数 N = clamp(q-1, 0, cap) */
export const affixCount = (q: number): number => Math.max(0, Math.min(CAPS.affix, Math.floor(q || 0) - 1));
/** 词缀强度 = round(1 + 0.15×q) */
export const affixScale = (q: number): number => Math.max(1, Math.round(1 + CAPS.scalePerQuality * Math.max(0, q || 0)));

/* ---------------- 词缀抽取 ---------------- */

/** 可用词缀池：按 kind（wpn/arm/both）+ 装备 tier 区间过滤（affixPool 白名单优先） */
export function affixPoolOf(it: ItemDef, tier = 1): AffixDef[] {
  const kind = it.type === 'wpn' ? 'wpn' : 'arm';
  const white = it.affixPool && it.affixPool.length ? new Set(it.affixPool) : null;
  return AFFIXES.filter((a) => {
    if (white && !white.has(a.id)) return false;
    if (a.kind !== 'both' && a.kind !== kind) return false;
    return tier >= a.tierMin && tier <= a.tierMax;
  });
}

/** 抽 N 条不重复词缀（同池权重；池空则少抽，不伪造） */
export function rollAffixes(it: ItemDef, q: number, tier = 1): string[] {
  const n = affixCount(q);
  const out: string[] = [];
  if (!n) return out;
  const pool = affixPoolOf(it, tier);
  for (let i = 0; i < n && pool.length; i++) {
    let total = 0;
    for (const a of pool) total += a.weight;
    let x = rng.next() * total;
    let idx = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      x -= pool[j].weight;
      if (x < 0) {
        idx = j;
        break;
      }
    }
    out.push(pool[idx].id);
    pool.splice(idx, 1);
  }
  return out;
}

/* ---------------- 实例生成 / 存取 ---------------- */

/** 实例序号（存于 WorldState.isq，确定性：同档重放序号一致） */
export function nextUid(s: WorldState = need()): string {
  s.isq = (s.isq || 0) + 1;
  return 'e' + s.isq.toString(36);
}

export interface RollOpts {
  allowGod?: boolean; // 神器（q=6）仅由 I2 深渊级配方开放，常规掉落恒 false
}

/** 掷一件实例：品质 → 词缀 → uid（同 rng 注入下结果确定） */
export function rollInstance(baseId: string, tier = 1, luck = 0, opts: RollOpts = {}): BagSlot {
  const it = WB.items[baseId];
  const t = Math.max(1, Math.min(5, Math.floor(tier) || 1));
  const q = it ? rollQuality(t, luck, !!opts.allowGod) : 0;
  return { id: baseId, qty: 1, uid: nextUid(), q, af: it ? rollAffixes(it, q, t) : [] };
}

const fnv1a = (str: string): number => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/**
 * 传说以上专名：由 uid 确定性派生（不消耗全局 rng，同 uid 恒同名、关 AI 也成立）。
 *
 * 卡 G2：这一维**此前用错了维度**——调的是 generateName（人物命名），
 * 于是传说武器被叫作「莉拉」「灰羽」这种人名。§114「装备与道具命名」
 * （材质+武器名／特征+武器名／神名+权能+武器）才是装备这一维的出处。
 * 词表为空时 generateItem 自己返回空串，instName 会回落 base 名——与从前一致。
 */
export function instProperName(slot?: InstSource | null): string {
  const uid = slot?.uid || '';
  if (!uid) return '';
  const h = fnv1a(uid);
  let x = h;
  const next = () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
  return generateItem({ rng: next, tier: 'legend' });
}

/** 实例名：【品质】专名 · 词缀/词缀（无 uid 者回落 base 名，与改动前一致） */
export function instName(slot?: InstSource | null): string {
  const id = slot?.id || '';
  const it = WB.items[id];
  if (!it) return id;
  const q = Math.max(0, Math.floor(slot?.q || 0));
  const proper = q >= 4 ? instProperName(slot) : '';
  const names = (slot?.af || []).map((x) => BY_ID.get(x)?.name).filter(Boolean) as string[];
  const pre = q > 0 ? '【' + qualityName(q) + '】' : '';
  return pre + (proper || it.name) + (names.length ? ' · ' + names.join('/') : '');
}

/** 实例词缀说明行（UI tooltip 用纯文本，不产出 HTML） */
export function instAffixText(slot?: InstSource | null): string {
  const rows = (slot?.af || [])
    .map((id) => BY_ID.get(id))
    .filter(Boolean)
    .map((a) => {
      const e = (a as AffixDef).eff;
      const parts: string[] = [];
      if (e.atk) parts.push('攻击+' + e.atk * affixScale(slot?.q || 0));
      if (e.def) parts.push('防御+' + e.def * affixScale(slot?.q || 0));
      if (e.elem) parts.push('元素伤害+' + e.elem * affixScale(slot?.q || 0));
      if (e.thorns) parts.push('荆棘+' + e.thorns * affixScale(slot?.q || 0));
      if (e.ward) parts.push('格挡+' + e.ward * affixScale(slot?.q || 0));
      if (e.haste) parts.push('迅捷+' + e.haste * affixScale(slot?.q || 0));
      if (e.crit) parts.push('暴击+' + Math.round(e.crit * 100) + '%');
      if (e.leech) parts.push('吸血+' + Math.round(e.leech * 100) + '%');
      if (e.stat) for (const k of Object.keys(e.stat) as StatName[]) parts.push(k + '+' + (e.stat[k] || 0) * affixScale(slot?.q || 0));
      return (a as AffixDef).name + '（' + parts.join(' ') + '）';
    });
  return rows.join('\n');
}

/** 实例加成聚合（无 uid → 全 0） */
export function instMods(slot?: InstSource | null): InstMods {
  const m: InstMods = { atk: 0, def: 0, stat: {}, crit: 0, leech: 0, elem: 0, thorns: 0, ward: 0, haste: 0 };
  if (!slot || !slot.uid) return m;
  const it = slot.id ? WB.items[slot.id] : undefined;
  if (it?.stat) for (const k of Object.keys(it.stat) as StatName[]) m.stat[k] = it.stat[k] || 0;
  const sc = affixScale(slot.q || 0);
  for (const id of slot.af || []) {
    const a = BY_ID.get(id);
    if (!a) continue;
    const e = a.eff;
    if (e.atk) m.atk += e.atk * sc;
    if (e.def) m.def += e.def * sc;
    if (e.elem) m.elem += e.elem * sc;
    if (e.thorns) m.thorns += e.thorns * sc;
    if (e.ward) m.ward += e.ward * sc;
    if (e.haste) m.haste += e.haste * sc;
    if (e.crit) m.crit += e.crit; // 比例类不乘强度
    if (e.leech) m.leech += e.leech;
    if (e.stat) for (const k of Object.keys(e.stat) as StatName[]) m.stat[k] = (m.stat[k] || 0) + (e.stat[k] || 0) * sc;
  }
  return m;
}

const sumStat = (a: Partial<Record<StatName, number>>, b: Partial<Record<StatName, number>>): Partial<Record<StatName, number>> => {
  const out: Partial<Record<StatName, number>> = { ...a };
  for (const k of Object.keys(b) as StatName[]) out[k] = (out[k] || 0) + (b[k] || 0);
  return out;
};

/** 玩家全身实例加成（战斗/派生唯一读取口） */
export function wornMods(s: WorldState = need()): InstMods {
  const a = instMods(s.player.equip.wpnIns);
  const b = instMods(s.player.equip.armIns);
  return {
    atk: a.atk + b.atk,
    def: a.def + b.def,
    stat: sumStat(a.stat, b.stat),
    crit: a.crit + b.crit,
    leech: a.leech + b.leech,
    elem: a.elem + b.elem,
    thorns: a.thorns + b.thorns,
    ward: a.ward + b.ward,
    haste: a.haste + b.haste,
  };
}

/** 暴击率（唯一出口：基础 5% + 词缀，封顶 40% —— 防数值爆炸） */
export function critRate(s: WorldState = need()): number {
  return Math.min(CRIT.max, CRIT.base + wornMods(s).crit);
}

/** 实例价 = priceOf(base) × qualityMult[q] × (1 + 0.1×N) */
export function instPrice(slot: InstSource | null, s: WorldState = need()): number {
  const id = slot?.id || '';
  if (!WB.items[id]) return 0;
  const n = (slot?.af || []).length;
  const base = priceOf(id, s.player.loc, s);
  return Math.max(1, Math.round(base * qualityMult(slot?.q || 0) * (1 + CAPS.pricePerAffix * n)));
}

/** 入包：按 uid 去重；qty>1 的实例拆成多件（不并入同 id 堆叠行） */
export function addInstance(slot: BagSlot, s: WorldState = need()): BagSlot[] {
  if (!WB.items[slot.id]) return [];
  const out: BagSlot[] = [];
  const qty = Math.max(1, Math.floor(slot.qty) || 1);
  const af = slot.af ? [...slot.af] : [];
  for (let i = 0; i < qty; i++) {
    const inst: BagSlot = {
      id: slot.id,
      qty: 1,
      uid: i === 0 && slot.uid ? slot.uid : nextUid(s),
      q: Math.min(6, Math.max(0, Math.floor(slot.q || 0))), // 品质档越界一律夹取（防手改档/敌意命令写脏值）
      af: [...af],
    };
    if (s.player.bag.some((x) => x.uid === inst.uid)) continue; // 幂等
    s.player.bag.push(inst);
    out.push(inst);
  }
  return out;
}

/** 按 uid 精确取件（赠礼/出售/装备共用） */
export function removeInstance(uid: string, s: WorldState = need()): BagSlot | null {
  const i = s.player.bag.findIndex((x) => x.uid === uid);
  if (i < 0) return null;
  const slot = s.player.bag[i];
  s.player.bag.splice(i, 1);
  return slot;
}


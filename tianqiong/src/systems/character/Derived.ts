/* ============================================================
   派生数值（原型 §三：派生数值 —— 全部由 WorldState 纯函数导出）
   ============================================================ */
import { WB } from '@/data/worldBook';
import tablesRaw from '@/data/world/tables.json';
import type { StatName, WorldState } from '@/types/world';
import { instMods, wornMods } from '@/systems/inventory/Equip';
import { stMod } from '@/systems/character/Status';
import { axisAffinity } from '@/systems/character/Race';
import { core, need } from '@/world/WorldState';

/* 卡 E1b：分支机制数据（与 Combat 同源：直读数据文件，不经 WB 聚合） */
const CLS_MECH = (tablesRaw as unknown as { classMechanics?: Record<string, unknown> }).classMechanics ?? {};
const CLASSES = (tablesRaw as unknown as { classes?: Record<string, { path?: string[] }> }).classes ?? {};

/**
 * 卡 E1b · 分支是否生效（§32–§35「路线」的判据）。
 * 语义：本机制只对**走在同名职业线上**的角色生效——当前职业线（path[0]）就是该分支，
 * 或玩家正处于该分支本身。锁定分支经卡 D4 转职才可进入，所以转职前一律不生效，
 * 这正是"分支专属机制"与"通用被动"的分界。
 */
export function branchActive(branch: string, s: WorldState = need()): boolean {
  if (!branch) return false;
  const cls = s.player.cls;
  if (cls === branch) return true;
  const p = CLASSES[cls]?.path;
  return !!p && p[0] === branch;
}

/* 卡 I1：装备实例的属性加成（基础 stat + 词缀 stat；无 uid 恒 0 → 旧档逐位一致） */
function eqStat(n: StatName, s: WorldState): number {
  let v = 0;
  const pairs: ['wpn' | 'arm', WorldState['player']['equip']['wpnIns']][] = [
    ['wpn', s.player.equip.wpnIns],
    ['arm', s.player.equip.armIns],
  ];
  for (const [k, ins] of pairs) {
    const id = s.player.equip[k];
    const it = id ? WB.items[id] : undefined;
    if (it?.stat && it.stat[n]) v += it.stat[n] as number;
    const m = instMods(ins);
    if (m.stat[n]) v += m.stat[n] as number;
  }
  return v;
}

export const stat = (n: StatName, s: WorldState = need()) => (s.player.stats[n] || 10) + eqStat(n, s);
export const mod = (n: StatName, s: WorldState = need()) => Math.floor((stat(n, s) - 10) / 2);
/* 卡 R1：世界书 §28 力量双轴开始生效——肉体轴强壮的种族血更厚，灵魂轴强壮的种族法力更足。
   affinity 取自 §26 的效率表（同为该族所长），上限 1.25、下限 1，避免倍率把数值带飞。 */
/**
 * 卡 E1b · 灵魂负荷（§34 亡灵召唤）：驱使的亡灵越多，自身能承载的生命越少。
 * 负荷按「已掌握的亡灵系技能数 × 每单位占比」算，封顶 maxLoad——
 * 这是「召唤越多、自身越脆」这条设定的数值形态，而不是又一套召唤物管理。
 */
export function soulLoad(s: WorldState = need()): number {
  const sl = (CLS_MECH as unknown as { soulLoad?: { perSummon: number; maxLoad: number; branch?: string } }).soulLoad ?? {
    perSummon: 0.08,
    maxLoad: 0.3,
  };
  if (!branchActive(sl.branch ?? 'sm_undead', s)) return 1;
  const undeadSkills = ['soul_bind', 'undead_legion', 'curse_weak'].filter((id) => s.player.skills.includes(id)).length;
  if (!undeadSkills) return 1;
  return 1 - Math.min(sl.maxLoad, undeadSkills * sl.perSummon);
}

export const maxHp = (s: WorldState = need()) =>
  Math.round((20 + stat('体质', s) * 4 + s.player.level * 6) * axisAffinity(s.player.race, '肉体') * soulLoad(s));
export const maxMp = (s: WorldState = need()) =>
  Math.round((10 + stat('智力', s) * 3 + s.player.level * 3) * axisAffinity(s.player.race, '灵魂'));
export const raceName = (s: WorldState = need()) => WB.races[s.player.race].name;
export const clsName = (s: WorldState = need()) => WB.classes[s.player.cls].name;
/** 境界称号：优先走职业分支称号链（卡 A，§29–43），回落通用六阶表（卡 R2，§29） */
export const rankName = (s: WorldState = need()) => {
  const path = WB.classes[s.player.cls].path;
  return (path && path[s.player.level - 1]) || WB.ranks[s.player.level - 1]?.name || '神阶';
};

/**
 * 通用境界名（§29 六阶本名：信徒/见习/正式/主教/圣徒/神阶）。
 * 与 rankName 的分工：rankName 是「玩家此刻被怎么称呼」（职业链优先，如「剑士」），
 * rankTierName 是「他的境界落在哪一阶」——**规则判定一律用后者**。
 * 踩坑记录：学院入学检查原先拿 rankName 去比对通用境界表，有职业的玩家会被判「境界不足」。
 */
/** 境界名（按等级查通用六阶表）；寿命表（§80）也用它，避免 level→境界 的映射写第二遍 */
export const rankTierNameOf = (level: number): string => WB.ranks[level - 1]?.name ?? '神阶';
export const rankTierName = (s: WorldState = need()): string => rankTierNameOf(s.player.level);

/**
 * 境界细分（卡 R2 · §29 末两阶 / §30）：5 级 → 圣阶·中，6 级 → 圣阶·极（凡人极限）。
 * 中间等级无细分，返回空串——调用方直接拼即可，不必判空。
 */
export function rankSub(s: WorldState = need()): string {
  const map = WB.rankTiers?.levelMap;
  const id = map?.[String(s.player.level)];
  if (!id) return '';
  const pool = [...(WB.rankTiers?.[5] ?? []), ...(WB.rankTiers?.[6] ?? [])];
  return pool.find((x) => x.id === id)?.name ?? '';
}

/** 该境界分的传统别称（§30：剑圣级/武圣级/法圣级/匠圣级…）；无别称返回空数组 */
export function rankAliases(s: WorldState = need()): string[] {
  const sub = rankSub(s);
  return (sub && WB.rankAlias?.[sub]) || [];
}

/** 「称号 · 细分」的完整写法（空细分自动降级为纯称号） */
export const rankFull = (s: WorldState = need()): string => {
  const sub = rankSub(s);
  return rankName(s) + (sub ? '·' + sub : '');
};
export const mainStat = (s: WorldState = need()) => WB.classes[s.player.cls].main;

/** 防御等级（含战斗内奥术屏障 buff，原型 AC()） */
export const AC = (s: WorldState = need()) =>
  10 +
  mod('敏捷', s) +
  (s.player.equip.arm ? (WB.items[s.player.equip.arm].def || 0) + instMods(s.player.equip.armIns).def : 0) +
  /* 卡 I1：迅捷（闪避）/符文护壁词缀 —— 与技能 ward 同出口，无实例恒 0 */
  wornMods(s).haste +
  wornMods(s).ward +
  (core.CB && core.CB.ward ? 3 : 0) +
  /* 卡 I3：破甲/迟缓等状态降低防御（战斗外无状态，恒 0） */
  stMod(core.CB?.status, 'acMod');

/** 攻击加值（含祝福 buff 与武器加值，原型 atkB()） */
export const atkB = (s: WorldState = need()) =>
  2 +
  ((s.player.level / 2) | 0) +
  mod(mainStat(s), s) +
  (core.CB && core.CB.buff ? 2 : 0) +
  /* 卡 I3：冻结/迟缓降低命中（战斗外恒 0） */
  stMod(core.CB?.status, 'hitMod') +
  (s.player.equip.wpn ? (WB.items[s.player.equip.wpn].atk || 0) + instMods(s.player.equip.wpnIns).atk : 0);

/* 索引即等级（等级从 1 起，0 位是占位）。6 级是上限（hydrate 把 level 夹在 [1,6]），
   必须留一位，否则满级时读出 undefined——此前两个调用点各自打补丁绕开它（审查 §xpNeed）。 */
export const xpNeed = (s: WorldState = need()) => [0, 60, 150, 300, 500, 800, Number.POSITIVE_INFINITY][s.player.level];

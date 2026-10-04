/* ============================================================
   卡 R1 · 种族规则（世界书 §26 绑定类型与效率% / §27 聚居地 / §28 力量双轴）
   —— 「种族决定什么」此前只体现为六维 mods；本模块把 §26 的三条规则接上引擎：
     · bind/exclusive：软绑定=倾向，强绑定=专属（专属线其他种族不可选）
     · eff：各职业系的**经验效率**（精灵学法系快、兽人学法师慢）
     · axis：灵魂/肉体双轴（§28）——法师/召唤/辅助走灵魂，物理/生产走肉体
   铁律：本模块是纯查询（只读 WB + WorldState），不改状态；倍率一律能回落 1。
   ============================================================ */
/* 刻意不 import WorldState/need：本模块是**纯查询**，调用方把 raceId/clsId 传进来即可。
   （character 目录与 world 的 WorldState 之间有既有的环根，少一条边就少一份维护负担。） */
import { WB } from '@/data/worldBook';

/** 取某个种族定义（未知种族回落 human，保证永不抛错）。导出仅为自检用例使用。 */
export const raceOf = (raceId: string) => WB.races[raceId] ?? WB.races.human;

/** 玩家所属职业系（lineage，如「物理」「法师」「召唤」「辅助」「生产」） */
export function lineageOf(clsId: string): string {
  return WB.classes[clsId]?.lineage ?? '';
}

/**
 * 种族对该职业系的效率倍率（§26）。缺省 1。
 * 用于经验获取——「同一个法术，精灵比兽人学得快」这类差异终于有实际后果。
 */
export function raceEff(raceId: string, lineage: string): number {
  const eff = raceOf(raceId).eff;
  if (!eff || !lineage) return 1;
  const v = eff[lineage];
  return typeof v === 'number' && v > 0 ? v : 1;
}

/**
 * 该种族能否选这条职业线（世界书 §26「专属」）。
 *
 * 语义是**独占**而不是白名单：`exclusive[]` 记的是「某族独有的职业」，
 * 于是判据反着写才对——
 *   · 该线出现在**别人的** exclusive 里 → 本族不可走（矮人的生产三线、精灵的巫女、巨人的重装）；
 *   · 该线不在任何人的 exclusive 里 → 人人可走。
 *
 * 踩坑记录：第一版写成「本族有 exclusive 名单时只许名单内的线」，结果矮人只剩三条生产
 * 可玩、人类反倒能走矮人专属线——两个方向同时错。专属是**排他**，不是白名单。
 */
export function raceAllowsClass(raceId: string, clsId: string): boolean {
  for (const r of Object.values(WB.races)) {
    const ex = r.exclusive;
    if (ex && ex.length && ex.includes(clsId)) return r === raceOf(raceId);
  }
  return true;
}

/** 该职业线是否被某个种族独占（供 UI 标注「此路为 X 族专有」） */
export function exclusiveOwner(clsId: string): string | null {
  for (const [k, r] of Object.entries(WB.races)) {
    const ex = r.exclusive;
    if (ex && ex.length && ex.includes(clsId)) return k;
  }
  return null;
}

/** 职业线的力量轴（§28 双轴）：灵魂（法/召唤/辅助）或肉体（物理/生产） */
const SOUL_LINES = ['法师', '召唤', '辅助'];
export function axisOfClass(clsId: string): '灵魂' | '肉体' {
  const def = WB.classes[clsId];
  if (def?.axis) return def.axis;
  return SOUL_LINES.includes(lineageOf(clsId)) ? '灵魂' : '肉体';
}

/** 轴向亲和度（0–2）：≥1 表示该种族在此轴上更强壮。供 HP/MP 派生与未来的战斗系数共用。 */
export function axisAffinity(raceId: string, axis: '灵魂' | '肉体'): number {
  const eff = raceOf(raceId).eff;
  if (!eff) return 1;
  let best = 1;
  for (const [line, v] of Object.entries(eff)) {
    if (typeof v !== 'number') continue;
    const lineAxis = SOUL_LINES.includes(line) ? '灵魂' : '肉体';
    if (lineAxis === axis) best = Math.max(best, v);
  }
  return best;
}

/** 种族 × 职业的可读摘要（供创角页与角色面板直出，不参与判定） */
export function raceAffinityNote(raceId: string, clsId: string): string {
  const r = raceOf(raceId);
  const eff = raceEff(raceId, lineageOf(clsId));
  const tag = eff > 1 ? '亲和 ×' + eff : eff < 1 ? '生疏 ×' + eff : '中性';
  return r.name + '·' + tag + (r.affinityNote ? '（' + r.affinityNote + '）' : '');
}

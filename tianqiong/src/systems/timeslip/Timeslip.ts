/* ============================================================
   卡 N3 · 小世界与时间流速（世界书 §7/§80/§89）
     加速型 1:5 修炼地 / 减速型 5:1 流放地 / 变异型 / 静止型；境界寿命表；流放刑期换算。
   —— 裁决 D1 = 1:5：故 §89「外界 100 年」≈ 狱内 20 年（旧版 1:7 的 14 年随 D1 作废）。
   ============================================================ */
import raw from '@/data/world/timeslip.json';
import type { WorldState } from '@/types/world';
import { toast } from '@/events/EventBus';
import { gainExp, log } from '@/systems/character/Gains';
import { confirmSheet } from '@/systems/character/Sheet';
import { need } from '@/world/WorldState';
import { advance, CHEN_PER_DAY, sceneTime } from '@/world/WorldClock';
import { lifeStatus } from '@/systems/timeslip/Lifespan';
import { rankTierNameOf } from '@/systems/character/Derived';
import { addHistory, worldEventLog } from '@/events/EventStore';
import { WB } from '@/data/worldBook';

interface SlipType { id: string; name: string; ratio: string; innerPerOuter: number; relation: string; note: string }
interface LifespanRow { rank: string; min: number; max: number }
const CFG = raw as unknown as {
  types: SlipType[];
  lifespan: LifespanRow[];
  timeMagic: Record<string, string>;
  exile: { outerYearsPerInnerYear: number; example: { outer: number; inner: number } };
};

export const slipTypes = (): SlipType[] => CFG.types ?? [];
export const lifespanTable = (): LifespanRow[] => CFG.lifespan ?? [];
export const timeMagicRules = (): Record<string, string> => CFG.timeMagic ?? {};
export const slipById = (id: string): SlipType | undefined => slipTypes().find((t) => t.id === id);

/** 外界经过 N 日，小世界内过了多少日（静止型恒 0） */
export function innerDays(slipId: string, outerDays: number): number {
  const t = slipById(slipId);
  if (!t) return outerDays;
  return Math.round(outerDays * t.innerPerOuter * 100) / 100;
}

/** 小世界内过 N 日，外界过了多少日（流放刑期按外界计，用这个换算） */
export function outerDays(slipId: string, days: number): number {
  const t = slipById(slipId);
  if (!t || t.innerPerOuter <= 0) return days;
  return Math.round((days / t.innerPerOuter) * 100) / 100;
}

/** §89 流放刑期换算：外界刑期 → 狱内实际渡过的年数 */
export function exileInnerYears(outerYears: number): number {
  return Math.round((outerYears / (CFG.exile?.outerYearsPerInnerYear ?? 5)) * 100) / 100;
}

/**
 * 某境界的寿命区间（§80）。
 * level ≤ 0 时取玩家当前境界；境界名经 Derived.rankTierNameOf 的唯一映射取，
 * 本模块不再自己写一遍 level→境界（原先那串三元判断与 R2 的境界表是两份真相）。
 * 「信徒」在世界书的寿命表里没有单列——凡人基准就是见习那一档，故回落首档。
 */
export function lifespanOf(level: number, s: WorldState = need()): LifespanRow {
  const rows = lifespanTable();
  const lv = level > 0 ? level : s.player.level;
  const rankName = rankTierNameOf(lv);
  return rows.find((r) => r.rank.startsWith(rankName)) ?? rows[0] ?? { rank: '见习', min: 70, max: 100 };
}

/**
 * 进小世界修炼：外界耗 outerDays 日，内部经历 innerDays 日，按「修炼 1 日 ≈ 经验」折算。
 * 不做全自动成长——只给经验与叙事，突破仍要靠玩家自己走既有路径。
 */
export function enterSlip(slipId: string, outerDays: number, s: WorldState = need()): { ok: boolean; why: string; exp: number } {
  const t = slipById(slipId);
  if (!t) return { ok: false, why: '没有这种小世界', exp: 0 };
  if (t.innerPerOuter === 0) {
    toast('静止型小世界内时间不流动——进去只是被封存。', 'bad');
    return { ok: false, why: '时间不流动', exp: 0 };
  }
  const inner = innerDays(slipId, outerDays);
  const exp = Math.max(1, Math.round(inner * 2));
  /* 卡 L1：外界时间必须**真的走**。此前这里算完经验却不推进时间——
     「进小世界闭关百年」在世界上没有留下任何痕迹：寿命不减、季节不换、他人停在原地。
     §80 的「内成长 100 年 = 外成长 20 年」（D1 = 1:5）本就是以外界时间计价的一次交换。 */
  advance(outerDays * CHEN_PER_DAY);
  log('你踏入' + t.name + '的门槛——外界 ' + outerDays + ' 日，此处过了 ' + inner + ' 日。', 'nar', s);
  addHistory('入小世界修炼', t.name + ' · 内外 ' + outerDays + ':' + inner + ' 日', 3);
  return { ok: true, why: '', exp };
}

/* ============================================================
   卡 K3-UI · 时之缝隙面板
   —— 小世界此前只能被 effects 调用（enter_timeslip），玩家在界面上看不见它。
   面板把"内外换算"与"这场闭关要花掉自己多少年"摆在一起——
   代价那一半是卡 L1 的寿数接上来之后才真正存在的。
   ============================================================ */

/** 入小世界闭关：耗外界天数、换内部修炼时长。经验在此入账（effects 路由也会走这条） */
export function timeslipEnter(slipId: string, outerDays = 30): boolean {
  const s = need();
  /* 出关结算卡的口径在**进门之前**采：境界/经验/日期/世界史条数，出关后对差值（UX-003） */
  const lv0 = s.player.level;
  const exp0 = s.player.exp;
  const day0 = sceneTime(s).day;
  const evts0 = worldEventLog.size();
  const r = enterSlip(slipId, outerDays, s);
  if (!r.ok) return false;
  if (r.exp > 0) gainExp(r.exp);
  /* 出关结算卡（UX-003 · 2026-09-29 实测）：此前面板一关世界直接跳 30 天——
     16 条事件、境界 Lv1→4，玩家毫无过场与总结，像被偷走了半个月。 */
  const t = slipById(slipId);
  const now = need();
  const tNow = sceneTime(now);
  const lines: string[] = [];
  lines.push(
    '闭关时长：外界 ' + outerDays + ' 日 · 小世界内 ' + innerDays(slipId, outerDays) + ' 日（第 ' + day0 + ' 日 → 第 ' + tNow.day + ' 日）',
  );
  const lvNow = now.player.level;
  /* 境界名走职业链（剑士/剑师/剑圣…），与升级 toast 同一口径；
     rankTierNameOf 是通用六阶表，规则判定用，出关卡上写给玩家看的得是称呼。 */
  const path = WB.classes[now.player.cls].path;
  const rankAt = (lv: number) => (path && path[lv - 1]) || rankTierNameOf(lv);
  lines.push(
    lvNow > lv0
      ? '境界：' + rankAt(lv0) + ' → <b style="color:var(--gold2)">' + rankAt(lvNow) + '</b>（Lv.' + lvNow + '）'
      : '境界：' + rankAt(lvNow) + '（未突破）',
  );
  lines.push('修为：经验 +' + (now.player.exp - exp0) + '（' + exp0 + ' → ' + now.player.exp + '）');
  const evts = worldEventLog.size() - evts0;
  lines.push('世间变化：你闭关的这些天，外面发生了 <b>' + evts + '</b> 件被载入史册的事——纪闻与世相都已改写。');
  confirmSheet('出关 · ' + (t?.name ?? '小世界'), lines.join('<br>'), [{ l: '（回到世间）', a: 'close' }]);
  return true;
}

export function timeslipMenu(): void {
  const s = need();
  const v = slipView();
  const st = lifeStatus(s);
  const body =
    '时之缝隙里外流速不同：加速型内 5 日 = 外 1 日（修炼地），减速型反过来（流放地），静止型进去只是被封存。' +
    '<br>闭关耗的是**外面**的年岁——你在里面多挣的日子，外面一样要老。<br>' +
    '<br>你现下 ' +
    Math.floor(st.age) +
    ' 岁（' +
    st.rank +
    '，寿数 ' +
    st.min +
    '–' +
    st.max +
    ' 年，余 ' +
    Math.round(st.remain * 10) / 10 +
    ' 年）' +
    '<br><br>' +
    Object.values(v.timeMagic).join('<br>');
  const btns: { l: string; a: string; id?: string }[] = v.types
    .filter((t) => t.innerPerOuter > 0)
    .map((t) => ({
      l: t.name + '（' + t.ratio + '）· 闭关 30 日 = 内 ' + innerDays(t.id, 30) + ' 日',
      a: 'tl_enter',
      id: t.id,
    }));
  btns.push({ l: '（退开）', a: 'close' });
  confirmSheet('时之缝隙 · 内外之别', body, btns);
}

export interface SlipView { types: SlipType[]; lifespan: LifespanRow[]; timeMagic: Record<string, string>; exileExample: { outer: number; inner: number } }
export function slipView(): SlipView {
  return {
    types: slipTypes(),
    lifespan: lifespanTable(),
    timeMagic: timeMagicRules(),
    exileExample: { outer: CFG.exile?.example?.outer ?? 100, inner: exileInnerYears(CFG.exile?.example?.outer ?? 100) },
  };
}

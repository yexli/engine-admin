/* ============================================================
   卡 I6 · 头衔 · 声名
   —— 条件表在 src/data/world/titles.json（零逻辑），本模块只做判定与出口。
   —— 铁律：称号只能由 core 依据 WorldState 既有字段授予；玩家/AI 都不能"授予称号"，
      地图与对话只读。世界记得：隐藏（suppress）只影响称呼与世界反应，历史照留。
   ============================================================ */
import titlesJson from '@/data/world/titles.json';
import { toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { sceneTime } from '@/world/WorldClock';
import { codexStats } from '@/systems/codex/Codex';
import { craftLv } from '@/systems/inventory/Craft';
import type { WorldState } from '@/types/world';
import { log } from '@/systems/character/Gains';
import { repAxis } from '@/systems/faction/Factions';
import { need } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { addHistory } from '@/events/EventStore';

export type TitleCondKind =
  | 'kills'
  | 'flag'
  | 'level'
  | 'rep'
  | 'axis'
  | 'craftLv'
  | 'codexCount'
  | 'dungeonBest'
  | 'abyss'
  | 'wanted'
  | 'crime'
  | 'exiled'
  | 'gold'
  | 'academy'
  | 'theoselect_champion';

export interface TitleCond {
  kind: TitleCondKind;
  key?: string;
  faction?: string;
  axis?: 'trust' | 'hostility' | 'trade' | 'military' | 'religion' | 'intelligence';
  min?: number;
}
export interface TitleDef {
  id: string;
  name: string;
  tier: number;
  negative: boolean;
  cond: TitleCond;
  desc: string;
  react: string;
}

const DEFS = titlesJson.titles as unknown as TitleDef[];
const BY_ID = new Map(DEFS.map((t) => [t.id, t]));
const SUPPRESS_COST = titlesJson.suppressCost as number;

export const titleDefs = (): TitleDef[] => DEFS.slice();
export const titleById = (id: string): TitleDef | undefined => BY_ID.get(id);
export const suppressCost = (): number => SUPPRESS_COST;

/* ---------------- 条件判定（纯函数：只读 WorldState） ---------------- */

export function condMet(c: TitleCond, s: WorldState = need()): boolean {
  const min = c.min ?? 1;
  switch (c.kind) {
    case 'kills':
      return (s.killed[c.key || ''] || 0) >= min;
    case 'flag':
      return !!s.player.flags[c.key || ''];
    case 'level':
      return s.player.level >= min;
    case 'rep':
      return (s.rep[c.faction || ''] || 0) >= min;
    case 'axis':
      return !!c.faction && !!c.axis && repAxis(c.faction, c.axis, s) >= min;
    case 'craftLv':
      return craftLv(c.key || 'forge', s) >= min;
    case 'codexCount':
      return codexStats(s).unlocked >= min;
    case 'dungeonBest':
      return (s.dungeon?.best || 0) >= min;
    case 'abyss':
      return ((s.abyss?.[(c.key || 'sealed') as 'leak' | 'sealed']) || 0) >= min;
    case 'wanted':
      return s.player.wanted >= min;
    case 'crime':
      return (s.legal?.charges || []).includes(c.key || '');
    case 'exiled':
      return !!s.legal?.exiledTo;
    case 'gold':
      return s.player.gold >= min;
    case 'academy':
      return ((c.key === 'graduated' ? s.academy?.graduated?.length : s.academy?.completed.length) || 0) >= min;
    case 'theoselect_champion':
      return s.theoselect?.champion === 'player';
    default:
      return false;
  }
}

/* ---------------- 授予 / 隐藏 ---------------- */

/**
 * 评估并授予（挂 newDay 与关键事件后；幂等：同称号只记一次历史）。
 * 返回本次新授予的称号 id 列表。
 */
export function evalTitles(s: WorldState = need()): string[] {
  if (!Array.isArray(s.titles)) s.titles = [];
  const got: string[] = [];
  for (const t of DEFS) {
    if (s.titles.includes(t.id)) continue;
    if (!condMet(t.cond, s)) continue;
    s.titles.push(t.id);
    got.push(t.id);
    toast((t.negative ? '⚑ ' : '✦ ') + '获得称号：' + t.name, t.negative ? 'bad' : 'gain');
    log('（世人开始这样称呼你：' + t.name + '——' + t.desc + '）', t.negative ? 'bad' : 'gain', s);
    addHistory('获得称号：' + t.name, t.desc, t.negative ? -2 : 2);
    /* §22/§34：称号是世人给你的评价，属跨系统事实（势力 / 委托 / 对话都可能引用） */
    worldBus.emit(
      makeEvent({
        type: 'title_granted',
        day: sceneTime(s).day,
        tick: s.t,
        actor: 'player',
        target: t.id,
        cause: t.name,
        data: { title: t.id, negative: !!t.negative },
      }),
    );
  }
  return got;
}

/** 已获得的称号定义（含被隐藏者；UI 自行过滤） */
export const titlesOf = (s: WorldState = need()): TitleDef[] =>
  (s.titles || []).map((id) => BY_ID.get(id)).filter(Boolean) as TitleDef[];

/** 对外可见的称号（隐藏的负面称号不出现在称呼与反应里） */
export const visibleTitles = (s: WorldState = need()): TitleDef[] => {
  const hidden = s.titleHidden || [];
  return titlesOf(s).filter((t) => !hidden.includes(t.id));
};

/** 主称号 = 最高 tier 中最近获得的一个（平手取后得） */
export function primaryTitle(s: WorldState = need()): TitleDef | null {
  const list = visibleTitles(s);
  if (!list.length) return null;
  const order = s.titles || [];
  let best: TitleDef | null = null;
  let bestAt = -1;
  for (const t of list) {
    const at = order.indexOf(t.id);
    if (!best || t.tier > best.tier || (t.tier === best.tier && at > bestAt)) {
      best = t;
      bestAt = at;
    }
  }
  return best;
}

/** 称号评分（正向 − 负面，未隐藏时计入） */
export function titleScore(s: WorldState = need()): number {
  return visibleTitles(s).reduce((a, t) => a + (t.negative ? -t.tier : t.tier), 0);
}

/**
 * 花代价隐藏负面称号：只影响称呼与世界反应，**历史不抹**（世界记得）。
 * 只能隐藏负面称号（正面称号没有隐藏的理由）。
 */
export function suppressTitle(id: string, s: WorldState = need()): boolean {
  const t = BY_ID.get(id);
  if (!t || !t.negative) {
    toast('这个称号没有必要藏起来。', 'bad');
    return false;
  }
  if (!(s.titles || []).includes(id)) return false;
  if (!Array.isArray(s.titleHidden)) s.titleHidden = [];
  if (s.titleHidden.includes(id)) return false;
  if (s.player.gold < SUPPRESS_COST) {
    toast('打点关系要 ' + SUPPRESS_COST + ' 铜，你拿不出来。', 'bad');
    return false;
  }
  mutate.playerGold(-SUPPRESS_COST);
  s.titleHidden.push(id);
  log('你花了一笔钱，让人把「' + t.name + '」从告示与话头里悄悄抹去——但你自己知道它还在。', 'sys', s);
  addHistory('隐藏称号：' + t.name, '花' + SUPPRESS_COST + '铜打点', 1);
  return true;
}

/* ---------------- 出口（世界回应） ---------------- */

/** 名望折让：主称号 tier ≥ 3 时买价 ×0.97（卖价不变，防刷） */
export function fameDiscount(s: WorldState = need()): number {
  const p = primaryTitle(s);
  return p && p.tier >= 3 ? 0.97 : 1;
}

/**
 * 军团长特权：盘查概率 ×0.5。
 * **注意（与卡 I4 的合并口径）**：I4 的"军职档（military ≥ 70）"已把 ×0.5 接进
 * `diplomacy.guardChance`；本称号的授予条件正是 military ≥ 70，两者同指一件事。
 * 因此本函数**只作 UI/测试的只读判定**，不得再乘一次——叠乘会变成 ×0.25。
 */
export function marshalGuardMul(s: WorldState = need()): number {
  const has = visibleTitles(s).some((t) => t.id === 'ti_field_marshal');
  return has ? 0.5 : 1;
}

/** 称呼：问候与 UI 用（无称号返回空串） */
export function titleWord(s: WorldState = need()): string {
  const p = primaryTitle(s);
  if (!p) return '';
  const n = visibleTitles(s).length;
  return p.name + (n > 1 ? ' 等 ' + n + ' 项' : '');
}

/* ---------------- UI 契约 ---------------- */

export interface TitleRow {
  id: string;
  name: string;
  tier: number;
  negative: boolean;
  desc: string;
  react: string;
  got: boolean;
  hidden: boolean;
}
export interface TitleView {
  rows: TitleRow[];
  primary: string;
  score: number;
  hiddenCount: number;
}

export function titleView(s: WorldState = need()): TitleView {
  const got = s.titles || [];
  const hidden = s.titleHidden || [];
  return {
    rows: DEFS.map((t) => ({
      id: t.id,
      name: t.name,
      tier: t.tier,
      negative: t.negative,
      desc: t.desc,
      react: t.react,
      got: got.includes(t.id),
      hidden: hidden.includes(t.id),
    })).sort((a, b) => Number(b.got) - Number(a.got) || b.tier - a.tier),
    primary: titleWord(s),
    score: titleScore(s),
    hiddenCount: hidden.length,
  };
}

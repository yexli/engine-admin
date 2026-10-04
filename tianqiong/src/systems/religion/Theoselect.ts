/* ============================================================
   卡 H5 · 百年神选事件链（lore §4 canon：周期 100 年 / 每殿 3 名 /
   海选（每殿 100 人）→ 预选（每殿 10 人）→ 正赛（每殿 3 名候补）→ 神战定座次）
   - 612 年首届；预选与正赛可移于星枢五塔·星斗台跨大陆举办，众生以星符观战
   - 依赖：H4 地下城（正赛走深层战绩）/ H1 星斗台（跨大陆观战）/ D3 势力声望 / D4 事件引擎
   - 打分全走 core（worldState），名次确定性；关 AI 走 seed，不留占位符
   - 神战终局 → 候补神（神界第 5 级），交 H6 deity.ascendCandidate 收口
   铁律：AI 只润色文本，名次与奖励的后果一律在 core。
   ============================================================ */
import raw from '@/data/world/theoselect.json';
import { WB } from '@/data/worldBook';
import type { FactionId, TheoselectCandidate, TheoselectState, WorldState } from '@/types/world';
import { rng, toast } from '@/events/EventBus';
import { generateName } from '@/systems/naming/Naming';
import { eventMeta, fireEvent } from '@/events/EventProcessor';
import { addItem, addRep, gainGold, log } from '@/systems/character/Gains';
import { confirmSheet } from '@/systems/character/Sheet';
import { need, sync } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { CHEN_PER_DAY, sceneTime } from '@/world/WorldClock';
import { lifespanRange } from '@/systems/timeslip/Lifespan';
import { addHistory } from '@/events/EventStore';

interface TempleDef { id: string; name: string; deity: string; faction: string; path: string[] }
interface StageDef {
  /** 可展示地点名（F-29：loc 是 geo/塔 id，直出会给玩家看到内部代号） */
  locName?: string;
  id: string; quota: number; fieldSize: number; duration: number;
  mode: 'threshold' | 'rank' | 'final'; cut?: number; desc: string; loc: string; task: string;
}
interface TheoselectCfg {
  version: number; loreRefs: string[]; canon: string; cycle: number; currentCycle: number; startDay: number;
  modelNote: string;
  temples: TempleDef[];
  stages: StageDef[];
  rewards: Record<string, { label: string; lifespan: number }>;
  enroll: { minLevel: number; minFavor: number; costGold: number; windowStages: string[] };
  score: { base: number; perDungeonFloor: number; perRep: number; perFavor: number; perTrialFloor: number; luckMax: number };
  chain: { announceEvent: string; stageEndEvent: string; finalEvent: string };
  spectate: { costStarcoin: number; repGain: number; arenaWinsNeeded: number };
  fallbackUnlockDay: number;
}
const CFG = raw as unknown as TheoselectCfg;

export const THEOSELECT = CFG;
export const PLAYER_ID = 'player';

/* ---------------- 取用 ---------------- */

export const templeOf = (id: string): TempleDef | undefined => CFG.temples.find((t) => t.id === id);
export const stageOf = (id: string): StageDef | undefined => CFG.stages.find((s) => s.id === id);
export const stageNames = (): string[] => CFG.stages.map((s) => s.id);
const stageIdx = (id: string) => Math.max(0, CFG.stages.findIndex((s) => s.id === id));
const ticks = (days: number) => (days < 0 ? Number.POSITIVE_INFINITY : days * CHEN_PER_DAY);

/** 该神殿对应的神明偏好（H6 deity 域；H6 未落地时读缺省 0，不硬依赖） */
export const templeFavor = (templeId: string, s: WorldState): number => {
  const tp = templeOf(templeId);
  if (!tp) return 0;
  return s.favor?.[tp.deity as keyof typeof s.favor]?.favor ?? 0;
};

/* ---------------- 状态 ---------------- */

export function ensureTheoselect(s: WorldState): TheoselectState {
  if (!s.theoselect) s.theoselect = { enrolled: false, stage: CFG.stages[0].id, score: 0 };
  const t = s.theoselect;
  if (!t.cycle) t.cycle = CFG.currentCycle;
  if (!t.stage || !stageOf(t.stage)) t.stage = CFG.stages[0].id;
  if (!t.candidates) t.candidates = seedField(s);
  if (t.stageEndsAt === undefined) t.stageEndsAt = ticks(stageOf(t.stage)!.duration);
  return t;
}

/**
 * 具名候选池（「你知道名字的那些人」的抽样）。
 * 名义人数见 stage.fieldSize（canon 数值）；抽样是为了性能与可读性，不影响名次判定语义。
 * 名字来源：世界书现有 NPC 名册（canon 专名）+ 命名生成器补位。
 */
function seedField(s: WorldState): TheoselectCandidate[] {
  const roster = Object.keys(WB.npcs);
  const out: TheoselectCandidate[] = [];
  const temples = CFG.temples;
  /* 轮转分配：同一 NPC 只入一殿，避免同名跨殿重复 */
  for (let i = 0; i < roster.length; i++) {
    const tp = temples[i % temples.length];
    out.push({ npcId: roster[i], temple: tp.id, score: rivalScore() });
  }
  for (const e of extraRivals(roster.length)) out.push(e);
  void s;
  return out;
}

/* —— 卡 H3 调用点：名册不足时用命名生成器补位（规律进词库，不让模型现编） —— */
const RIVAL_RACES = ['human', 'elf', 'dwarf', 'orc', 'gnome', 'vampire', 'elemental', 'avariel', 'giant', 'demon'];
const EXTRA_RIVALS = 10;
/** 补位候选的展示名（世界书 NPC 直接查表；生成名走 extraRivalNames） */
const extraRivalNames: Record<string, string> = {};

function extraRivals(offset: number): TheoselectCandidate[] {
  const out: TheoselectCandidate[] = [];
  for (let i = 0; i < EXTRA_RIVALS; i++) {
    const id = 'rival_' + (i + 1);
    /* 一两个传说名点缀，其余普通档——避免评分盘上全是稀有名（§H3 稀有度权重） */
    const tier = i === 0 ? 'legend' : i < 3 ? 'rare' : 'common';
    extraRivalNames[id] = generateName(RIVAL_RACES[i % RIVAL_RACES.length], { tier });
    out.push({ npcId: id, temple: CFG.temples[(offset + i) % CFG.temples.length].id, score: rivalScore() });
  }
  return out;
}
export const rivalName = (id: string): string =>
  id === PLAYER_ID ? '（你）' : WB.npcs[id]?.name ?? extraRivalNames[id] ?? id;

const rivalScore = () => Math.round((CFG.score.base + rng.R(6, 62)) * 10) / 10;

/* ---------------- 报名 ---------------- */

export function enrollBlock(templeId: string, s: WorldState = need()): string {
  const t = ensureTheoselect(s);
  const tp = templeOf(templeId);
  if (!tp) return '没有这座神殿。';
  if (!s.player.flags.theoselect_open) return '本届神选尚未开启。';
  if (t.enrolled && !t.disqualified) return '你已在' + (templeOf(t.temple || '')?.name ?? '某殿') + '的候选名册上。';
  if (t.disqualified) return '本届你已出局——须沉淀至下一届（百年后）方可再战。';
  if (!CFG.enroll.windowStages.includes(t.stage)) return '本届报名期已过（当前：' + t.stage + '）。';
  if (s.player.level < CFG.enroll.minLevel) return '境界不足：至少需 Lv.' + CFG.enroll.minLevel + '。';
  const fv = templeFavor(templeId, s);
  if (fv < CFG.enroll.minFavor) return tp.name + '的香火不足（需神明偏好 ' + CFG.enroll.minFavor + '，你 ' + Math.round(fv) + '）。';
  if (s.player.gold < CFG.enroll.costGold) return '报名与资质测试需 ' + CFG.enroll.costGold + ' 金币。';
  return '';
}

export function enroll(templeId: string): boolean {
  const s = need();
  const t = ensureTheoselect(s);
  const why = enrollBlock(templeId, s);
  if (why) {
    toast(why, 'bad');
    return false;
  }
  const tp = templeOf(templeId)!;
  t.enrolled = true;
  t.temple = templeId;
  t.disqualified = false;
  t.score = evaluate(s);
  t.enrolledDay = sceneTime(s).day;
  t.stage = t.stage || CFG.stages[0].id;
  gainGold(-CFG.enroll.costGold);
  if (!s.theoselect!.candidates!.some((c) => c.npcId === PLAYER_ID))
    s.theoselect!.candidates!.push({ npcId: PLAYER_ID, temple: templeId, score: t.score });
  log('你在' + tp.name + '的坛前按下手印——香火的气味混着旧羊皮纸的味道。名册上多了一个名字。', 'nar');
  log('（本届神选：' + CFG.currentCycle + ' 年首届。当前阶段：' + t.stage + '。众生可以星符观战。）', 'sys');
  addHistory('报名百年神选', tp.name + ' · 第 ' + CFG.currentCycle + ' 届', 3);
  sync();
  return true;
}

/* ---------------- 评分与名次 ---------------- */

/** 玩家评分：地下城最深 + 势力声望 + 神明偏好 + 星塔试炼 + 运气（全在 core，确定性随 seed） */
export function evaluate(s: WorldState = need()): number {
  const luck = rng.R(0, CFG.score.luckMax); // 先抽运气：避免后续懒初始化（候选池播种）扰动随机序列
  const t = ensureTheoselect(s);
  const tp = templeOf(t.temple || CFG.temples[0].id) ?? CFG.temples[0];
  const sc = CFG.score;
  let v = sc.base;
  v += (s.dungeon?.best || 0) * sc.perDungeonFloor;
  v += (s.rep[tp.faction] || 0) * sc.perRep;
  v += templeFavor(tp.id, s) * sc.perFavor;
  v += (s.net?.trialBest || 0) * sc.perTrialFloor;
  v += luck;
  return Math.round(v * 10) / 10;
}

/** 评分盘（含玩家，若仍在册）：按分数降序，同分按 npcId 稳定排序（确定性） */
export function standings(s: WorldState = need()): TheoselectCandidate[] {
  const t = ensureTheoselect(s);
  const list = (t.candidates || []).map((c) => (c.npcId === PLAYER_ID ? { ...c, score: t.score } : c));
  return list.slice().sort((a, b) => b.score - a.score || (a.npcId < b.npcId ? -1 : 1));
}

export const playerRank = (s: WorldState = need()): number | undefined => {
  const t = ensureTheoselect(s);
  if (!t.enrolled || t.disqualified) return t.rank;
  const i = standings(s).findIndex((c) => c.npcId === PLAYER_ID);
  return i < 0 ? undefined : i + 1;
};

/* ---------------- 阶段推进 ---------------- */

/** 每日 tick（time.newDay 挂）：开启本届 → 按刻推进阶段（幂等） */
export function theoselectTick(s: WorldState): void {
  ensureTheoselect(s);
  const day = sceneTime(s).day;
  /* 保底开启：首届第 1 日；若玩家一直没触发，第 180 日强制开启（风险项 §8 的兜底） */
  if (!s.player.flags.theoselect_open && (day >= CFG.startDay || day >= CFG.fallbackUnlockDay)) {
    mutate.playerFlag('theoselect_open');
    fire(CFG.chain.announceEvent, s);
    log('告示栏换上了新的羊皮纸：第 ' + CFG.currentCycle + ' 届百年神选开启。五座神殿同时设坛——这一次，星斗台会为全大陆亮起。', 'sys');
  }
  if (!s.player.flags.theoselect_open) return;
  stageAdvance(s);
}

/** 阶段推进（幂等：同刻只结算一次） */
export function stageAdvance(s: WorldState = need()): boolean {
  const t = ensureTheoselect(s);
  if (t.stage === '候补') return false;
  if (s.t < (t.stageEndsAt ?? Number.POSITIVE_INFINITY)) return false;
  if (t.advancedAt === s.t) return false;
  t.advancedAt = s.t;
  const cur = stageOf(t.stage)!;

  /* 结算：门槛制（海选）按分数线，名次制（预选/正赛/神战）按名次 */
  if (t.enrolled && !t.disqualified) {
    if (cur.mode === 'threshold') {
      if (t.score < (cur.cut ?? 0)) {
        t.disqualified = true;
        log('你的名字没有出现在' + cur.id + '的合格名册上——分数差了一线。按规矩，须沉淀至下一届方可再战。', 'bad');
        addHistory('百年神选落选', cur.id + ' 分数线 ' + cur.cut + ' · 你 ' + t.score, 3);
      }
    } else {
      const r = playerRank(s) ?? 999;
      if (r > cur.quota) {
        t.disqualified = true;
        log(cur.id + '结束：你止步第 ' + r + ' 名（取前 ' + cur.quota + '）。神殿的人把名册收走了。', 'bad');
        addHistory('百年神选止步', cur.id + ' 第 ' + r + ' 名', 3);
      }
    }
  }

  /* 候选池淘汰：保留「本阶段名义规模」的前若干名（不多于下一阶段所需，不少于下一阶段名额） */
  const next = CFG.stages[stageIdx(t.stage) + 1];
  if (t.disqualified) t.candidates = t.candidates!.filter((c) => c.npcId !== PLAYER_ID);
  const survive = Math.max(next.quota, Math.min(cur.quota, t.candidates!.length));
  t.candidates = standings(s).slice(0, survive);

  t.stage = next.id;
  t.stageEndsAt = s.t + ticks(next.duration); // duration = -1 → Infinity（候补阶段无期限）
  log('【百年神选 · ' + next.id + '】' + next.desc, 'nar');
  fire(CFG.chain.stageEndEvent, s);

  if (next.mode === 'final') finishFinal(s);
  sync();
  return true;
}

/** 神战终局：定座次 → 前三名受封候补神 → 奖励与历史（幂等） */
function finishFinal(s: WorldState): void {
  const t = ensureTheoselect(s);
  const board = standings(s);
  t.champion = board[0]?.npcId;
  if (t.enrolled && !t.disqualified) {
    const r = board.findIndex((c) => c.npcId === PLAYER_ID) + 1;
    const rank = r > 0 ? r : undefined;
    t.rank = rank;
    const rw = rewardFor(rank);
    if (rw && rank !== undefined) {
      /* 卡 L1：寿元真的落袋（此前这句赏赐只是日志里的一个字——没有任何数值承接它） */
      mutate.playerLifeBonus(rw.lifespan);
      log('座次定下：你列第 ' + rank + ' 名——' + rw.label + '。神界的名册上添了一行字，记的是你的名字（寿元 +' + rw.lifespan + ' 年，寿数上限延至 ' + lifespanRange(s).max + ' 年）。', 'gain');
      if (rank <= 3) mutate.playerFlag('theoselect_candidate_god');
      if (rank === 1) mutate.playerFlag('theoselect_champion');
      addHistory('百年神选定座次', '第 ' + rank + ' 名 · ' + rw.label, 5);
      /* 神殿拆五后不再有「圣辉神殿」这唯一承接方。神选由万神殿主持，五殿同沾；
         殿名从世界书势力表里取前缀（而非硬编码列表）——将来加第六座殿，这里自动跟上。 */
      for (const t of Object.keys(WB.factions).filter((k) => k.startsWith('temple_'))) {
        addRep(t as FactionId, rank <= 3 ? 4 : 2);
      }
      addItem('star_shard', 1);
    }
  } else {
    const champ = board[0];
    log('神战落幕。' + (champ ? rivalName(champ.npcId) + ' ' + '立于星斗台心，受封候补神。' : '本届无人受封。'), 'nar');
    addHistory('百年神选定座次', (champ ? rivalName(champ.npcId) : '无人') + ' 受封候补神', 4);
  }
  if (t.champion) ascendCandidate(t.champion);
  fire(CFG.chain.finalEvent, s);
  t.stageEndsAt = Number.POSITIVE_INFINITY;
}

export function rewardFor(rank?: number): { label: string; lifespan: number } | undefined {
  if (!rank) return undefined;
  if (rank === 1) return CFG.rewards.rank1;
  if (rank <= 3) return CFG.rewards.rank2_3;
  if (rank <= 8) return CFG.rewards.rank4_8;
  if (rank <= 16) return CFG.rewards.rank9_16;
  if (rank <= 50) return CFG.rewards.rank17_50;
  if (rank <= 100) return CFG.rewards.rank51_100;
  return undefined;
}

/** 神战终局 → 候补神（神界第 5 级，lore §3）。卡 H6 deity 模块的注入位（缺省不崩）。 */
type AscendHook = (npcId: string) => boolean;
let ascendHook: AscendHook | null = null;
export function setAscendHook(fn: AscendHook) {
  ascendHook = fn;
}
/* 写入路径收编后不再需要世界状态：这个函数只写 flag（或转交 H6 的钩子） */
function ascendCandidate(npcId: string): void {
  if (!ascendHook) {
    /* H6 未就位时的保底：只写 flag/历史，不臆造神职数据 */
    mutate.playerFlag('theoselect_ascended');
    return;
  }
  try {
    ascendHook(npcId);
  } catch {
    mutate.playerFlag('theoselect_ascended');
  }
}

/** D4 事件引擎触发位（事件缺失时静默，不崩） */
function fire(eventId: string, s: WorldState): void {
  const ev = eventMeta(eventId);
  if (ev) fireEvent(ev, s);
}

/* ---------------- 跨大陆观战（星枢五塔 · 星斗台） ---------------- */

/**
 * 以星符观战（§4：预选与正赛移于星枢五塔·星斗台跨大陆举办，众生以星符观战）。
 * 需要入网（H1 starNet）；花星币；得见闻与声望。
 */
export function spectate(): boolean {
  const s = need();
  const t = ensureTheoselect(s);
  if (!s.net?.online) {
    toast('须先入星枢之网，方能以星符观战。', 'bad');
    return false;
  }
  const cost = CFG.spectate.costStarcoin;
  if (s.net.starcoin < cost) {
    toast('星币不足（观战需 ' + cost + '）。', 'bad');
    return false;
  }
  if (!s.player.flags.theoselect_open) {
    toast('本届神选尚未开启。', 'bad');
    return false;
  }
  s.net.starcoin -= cost;
  const board = standings(s).slice(0, 10);
  const lines = board.map((c, i) => i + 1 + '. ' + rivalName(c.npcId) + '（' + (templeOf(c.temple)?.name ?? c.temple) + '）' + c.score);
  log('你在星斗台的观战席上凝出投影。' + t.stage + '的评分盘悬在台心：<br>' + lines.join('<br>'), 'ai');
  addRep('guild', CFG.spectate.repGain);
  addHistory('星符观战百年神选', t.stage + ' · 前十名见闻', 1);
  sync();
  return true;
}

/* ---------------- 表现层 ---------------- */

export interface TheoselectView {
  open: boolean;
  cycle: number;
  stage: string;
  stageDesc: string;
  stageTask: string;
  stageLoc: string;
  /** 地点的人类可读名；数据缺失时回落 loc 原文 */
  stageLocName: string;
  quota: number;
  daysLeft: number; // -1 = 不定（候补阶段）
  enrolled: boolean;
  temple: string;
  templeName: string;
  score: number;
  rank: number | null;
  disqualified: boolean;
  champion: string;
  top: { rank: number; name: string; temple: string; score: number; you: boolean }[];
  rewards: { label: string; lifespan: number } | null;
}

export function theoselectView(s: WorldState = need()): TheoselectView {
  const t = ensureTheoselect(s);
  const st = stageOf(t.stage) ?? CFG.stages[0];
  const rk = playerRank(s) ?? null;
  const board = standings(s).slice(0, 10).map((c, i) => ({
    rank: i + 1,
    name: rivalName(c.npcId),
    temple: templeOf(c.temple)?.name ?? c.temple,
    score: c.score,
    you: c.npcId === PLAYER_ID,
  }));
  return {
    open: !!s.player.flags.theoselect_open,
    cycle: t.cycle ?? CFG.currentCycle,
    stage: t.stage,
    stageDesc: st.desc,
    stageTask: st.task,
    stageLoc: st.loc,
    stageLocName: st.locName || st.loc,
    quota: st.quota,
    daysLeft: Number.isFinite(t.stageEndsAt ?? Number.POSITIVE_INFINITY)
      ? Math.max(0, Math.ceil(((t.stageEndsAt ?? 0) - s.t) / CHEN_PER_DAY))
      : -1,
    enrolled: !!t.enrolled && !t.disqualified,
    temple: t.temple ?? '',
    templeName: t.temple ? templeOf(t.temple)?.name ?? t.temple : '未报名',
    score: t.score,
    rank: rk,
    disqualified: !!t.disqualified,
    champion: t.champion ? rivalName(t.champion) : '',
    top: board,
    rewards: rewardFor(rk ?? undefined) ?? null,
  };
}

/** 神选菜单（复用 ConfirmSheet，零新增弹层协议） */
export function theoselectMenu(): void {
  const s = need();
  ensureTheoselect(s);
  const v = theoselectView(s);
  if (!v.open) {
    confirmSheet('百年神选', '第 ' + v.cycle + ' 届尚未开启。星枢的告示栏还空着——时候到了，五座神殿会同时设坛。', [
      { l: '（再等等）', a: 'close' },
    ]);
    return;
  }
  const head =
    '第 ' + v.cycle + ' 届 · 当前阶段 <b>' + v.stage + '</b>（取前 ' + v.quota + '）' +
    (v.daysLeft >= 0 ? '　·　余 ' + v.daysLeft + ' 日' : '　·　已定局') +
    '<br>' + v.stageDesc + '<br><span style="opacity:.7">' + v.stageTask + '</span>';
  const me = v.enrolled
    ? '<br><br>你的名册：' + v.templeName + '　评分 ' + v.score + (v.rank ? '　当前第 ' + v.rank + ' 名' : '')
    : v.disqualified
      ? '<br><br><span style="color:var(--crimson)">本届你已出局——须沉淀至下一届方可再战。</span>'
      : '<br><br>你尚未报名。报名需 Lv.' + CFG.enroll.minLevel + '、该殿神明偏好 ' + CFG.enroll.minFavor + '、' + CFG.enroll.costGold + ' 金币。';
  const board = '<br><br><b>评分盘 · 前十</b><br>' + v.top.map((x) => x.rank + '. ' + x.name + (x.you ? '（你）' : '') + '　' + x.temple + '　' + x.score).join('<br>');
  const btns: { l: string; a: string; id?: string }[] = [];
  if (!v.enrolled && !v.disqualified && (v.stage === '海选' || v.stage === '预选')) {
    for (const tp of CFG.temples) btns.push({ l: '报名 · ' + tp.name, a: 'ts_enroll', id: tp.id });
  }
  btns.push({ l: '以星符观战（' + CFG.spectate.costStarcoin + ' 星币）', a: 'ts_spectate' });
  btns.push({ l: '（返回）', a: 'close' });
  confirmSheet('百年神选 · ' + v.stage, head + me + board, btns);
}

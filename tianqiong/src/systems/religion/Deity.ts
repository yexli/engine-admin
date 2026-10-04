/* ============================================================
   卡 H6 · 神明系统（lore s2 六大神系 / s3 神界职位层级 / s4 百年神选 /
   s12 神系态度 / s37 信仰职业 / s43 终极技能 / s103 神殿培养）
   - pray：每日限次（pray.dailyCap），favor 累积 → 信仰阶位自动晋阶（s37 四级路线）
   - divineIntervene：favor ≥ needFavor → 神迹；叙事走 D4 事件引擎 seed 直出（关 AI 成立）
   - ascendCandidate：H5 神战终局调用，晋升候补神（s4 新神晋升路径起点）；幂等 + 防御
   铁律：一切状态改写只在本文件内完成；神名/阶位/阈值一律读 data/world/deities.json，
   本文件不硬编码任何神名；AI 不参与本模块（文本全部来自数据层 seed）。
   ============================================================ */
import rawAcademy from '@/data/world/academy.json';
import raw from '@/data/world/deities.json';
import { WB } from '@/data/worldBook';
import type { DeityFavor, DeityId, FactionId, Weather, WorldState } from '@/types/world';
import { rng, toast } from '@/events/EventBus';
import { maxHp, maxMp } from '@/systems/character/Derived';
import { fireEvent, type EventDef } from '@/events/EventProcessor';
import { addItem, addRep, gainExp, gainGold, log } from '@/systems/character/Gains';
import { confirmSheet } from '@/systems/character/Sheet';
import { core, need, sync } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { advance, dayOfTick } from '@/world/WorldClock';
import { addHistory } from '@/events/EventStore';

/* ---------------- 数据契约（deities.json / academy.json.templeSchools） ---------------- */

export interface FaithTier {
  tier: number;
  needFavor: number;
  templeGrade: string;
  duty: string;
}
export interface RankDetail {
  tier: number;
  name: string;
  headcount: string;
  duty: string;
  source: string;
}
export interface InterveneEffect {
  name: string;
  text: string;
  exp?: number;
  gold?: [number, number];
  item?: string;
  healFull?: boolean;
  soulCrystal?: number;
  weatherPick?: string[];
  flag?: string;
  rep?: Record<string, number>;
}
interface DeityCfg {
  pantheon: Record<DeityId, string>;
  pantheonTitle: Record<DeityId, string>;
  temple: Record<DeityId, string>;
  gender: Record<DeityId, string>;
  branches: Record<DeityId, string>;
  ranks: string[];
  rankDetail: RankDetail[];
  promotionPath: { from: string; to: string; need: string }[];
  faithTiers: FaithTier[];
  faithClasses: Record<DeityId, string[]>;
  noFaithRank: string;
  faithUltimate: Partial<Record<DeityId, { name: string; ability: string; effect: string }>>;
  domains: Record<DeityId, string[]>;
  attitudes: { common: string; byDeity: Record<DeityId, string> };
  pray: {
    dailyCap: number;
    favorMin: number;
    favorMax: number;
    favorCap: number;
    costTicks: number;
    templeRepGain: number;
    seeds: string[];
    prayLines: Record<DeityId, string>;
  };
  intervene: { needFavor: number; costFavor: number; cooldownDays: number; effects: Partial<Record<DeityId, InterveneEffect>> };
  ascension: { rank: string; rankIndex: number; needStage: string; history: string; seeds: string[]; tale: string };
  favorMax: number;
  favorMin: number;
}
interface TempleSchool {
  temple: string;
  deity: string;
  direction: string;
  years: string;
  entry: string;
}

const CFG = raw as unknown as DeityCfg;
const TEMPLE_SCHOOLS = (rawAcademy as unknown as { templeSchools: TempleSchool[] }).templeSchools || [];

/** DeityFavor 的神迹冷却（types/world.ts 未定义该字段，见交付报告「需要的字段」）。
 *  以局部可选字段兜住：写入后随存档持久化；旧档无该键即视为无冷却。 */
type FavorEx = DeityFavor; // lastMiracleDay 已提升进 canonical 类型（types/world.ts），不再局部扩展

export const DEITY_IDS: DeityId[] = ['war', 'wisdom', 'life', 'death', 'chaos', 'dragon'];

export const isDeityId = (v: string): v is DeityId => (DEITY_IDS as string[]).includes(v);
export const deityName = (id: DeityId): string => CFG.pantheon[id] || id;
export const deityTitle = (id: DeityId): string => CFG.pantheonTitle[id] || '';
export const deityTemple = (id: DeityId): string => CFG.temple[id] || '';

/** 主神 → 其神殿势力。龙神（守界者）不在万神殿议事之内，故刻意没有对应殿——
    向它祈祷照常有偏好与阶位，只是没有哪座殿需要记你的名字。
    用局部表而非 import 势力模块：这里只要几个字符串常量，不值得新增一条跨系统边。 */
const DEITY_FACTION: Partial<Record<DeityId, FactionId>> = {
  war: 'temple_war',
  wisdom: 'temple_wisdom',
  life: 'temple_life',
  death: 'temple_death',
  chaos: 'temple_chaos',
};
export const deityDomains = (id: DeityId): string[] => CFG.domains[id] || [];
export const faithClassesOf = (id: DeityId): string[] => (Array.isArray(CFG.faithClasses[id]) ? CFG.faithClasses[id] : []);

/* ---------------- 状态兜底（旧档可读；hydrate 之外再做一道运行时兜底） ---------------- */

const dayOf = (s: WorldState) => dayOfTick(s.t);

export function ensureFavor(s: WorldState): Partial<Record<DeityId, DeityFavor>> {
  if (!s.favor) s.favor = {};
  for (const id of DEITY_IDS) {
    const f = s.favor[id] as FavorEx | undefined;
    if (!f) {
      s.favor[id] = { favor: 0, rank: rankFor(id, 0) };
      continue;
    }
    if (typeof f.favor !== 'number' || Number.isNaN(f.favor)) f.favor = 0;
    f.favor = Math.max(CFG.favorMin, Math.min(CFG.favorMax, f.favor));
    if (typeof f.rank !== 'string' || !f.rank) f.rank = rankFor(id, f.favor);
  }
  if (!s.favorDay || typeof s.favorDay.n !== 'number' || typeof s.favorDay.day !== 'number') {
    s.favorDay = { day: dayOf(s), n: 0 };
  }
  return s.favor;
}

/** 当日祈祷计数（跨日自动归零；只在 pray 内推进） */
function prayUsed(s: WorldState): number {
  const fd = s.favorDay;
  return fd && fd.day === dayOf(s) ? fd.n : 0;
}

function prayLeft(s: WorldState): number {
  return Math.max(0, CFG.pray.dailyCap - prayUsed(s));
}

/* ---------------- 信仰阶位（s37 四级路线 × favor 阈值） ---------------- */

function tierIndex(favor: number): number {
  const t = CFG.faithTiers;
  let idx = 0;
  for (let i = 0; i < t.length; i++) if (favor >= t[i].needFavor) idx = i;
  return idx;
}

function rankFor(id: DeityId, favor: number): string {
  const cls = faithClassesOf(id);
  if (!cls.length) return CFG.noFaithRank; // 龙神殿：canon 无信仰职业路线（s37）
  return cls[Math.min(cls.length - 1, tierIndex(favor))];
}

function tierFor(id: DeityId, favor: number): FaithTier {
  const i = faithClassesOf(id).length ? tierIndex(favor) : 0;
  return CFG.faithTiers[Math.min(CFG.faithTiers.length - 1, i)];
}

function nextRankNeed(id: DeityId, favor: number): { rank: string; at: number } | null {
  const cls = faithClassesOf(id);
  if (!cls.length) return null;
  const i = tierIndex(favor);
  if (i >= cls.length - 1 || i >= CFG.faithTiers.length - 1) return null;
  return { rank: cls[i + 1], at: CFG.faithTiers[i + 1].needFavor };
}

export function favorOf(deityId: DeityId, s: WorldState = need()): number {
  const f = ensureFavor(s)[deityId];
  return f ? f.favor : 0;
}

export function deityRank(deityId: DeityId, s: WorldState = need()): string {
  const f = ensureFavor(s)[deityId] as FavorEx | undefined;
  if (!f) return rankFor(deityId, 0);
  const want = rankFor(deityId, f.favor);
  if (f.rank !== want) f.rank = want; // 阶位随 favor 自动晋阶（幂等）
  return f.rank;
}

/* ---------------- 祈祷（s103：信仰入门 → 神术修炼 → 神官晋升） ---------------- */

export function pray(deityId: DeityId): boolean {
  const s = core.S;
  if (!s) return false;
  if (!isDeityId(deityId)) {
    toast('神名有误——万神殿没有这一位。', 'bad');
    return false;
  }
  const fav = ensureFavor(s)[deityId] as FavorEx;
  const day = dayOf(s);
  const fd = s.favorDay!;
  if (fd.day !== day) {
    fd.day = day;
    fd.n = 0;
  }
  if (fd.n >= CFG.pray.dailyCap) {
    toast('今日祈祷已满 ' + CFG.pray.dailyCap + ' 次——神明不喜絮叨。', 'bad');
    return false;
  }
  fd.n++;
  advance(CFG.pray.costTicks);
  const gain = rng.R(CFG.pray.favorMin, CFG.pray.favorMax);
  const before = rankFor(deityId, fav.favor);
  fav.favor = Math.min(CFG.pray.favorCap, fav.favor + gain);
  fav.lastPrayDay = day;
  fav.rank = rankFor(deityId, fav.favor);
  log(rng.pick(CFG.pray.seeds) + ' ' + (CFG.pray.prayLines[deityId] || ''), 'sys', s);
  const tf = DEITY_FACTION[deityId];
  if (tf && CFG.pray.templeRepGain) addRep(tf, CFG.pray.templeRepGain);
  toast('✦ ' + deityName(deityId) + ' 偏好 +' + gain + '（' + fav.favor + '/' + CFG.pray.favorCap + '）', 'gain');
  if (fav.rank !== before) {
    log('你与' + deityName(deityId) + '之间的联系深了一层——' + deityTemple(deityId) + '的执事记下了你的名字（' + fav.rank + '）。', 'gain', s);
    toast('信仰阶位提升：' + fav.rank, 'gain');
  }
  sync();
  return true;
}

/* ---------------- 神迹（s43 终极技能 · 叙事走 D4 事件引擎） ---------------- */

export function divineIntervene(deityId: DeityId): boolean {
  const s = core.S;
  if (!s) return false;
  if (!isDeityId(deityId)) {
    toast('神名有误——万神殿没有这一位。', 'bad');
    return false;
  }
  const eff = CFG.intervene.effects[deityId];
  if (!eff) {
    toast('这一位不降神迹。', 'bad');
    return false;
  }
  const fav = ensureFavor(s)[deityId] as FavorEx;
  if (fav.favor < CFG.intervene.needFavor) {
    toast(
      deityName(deityId) + '尚未垂听——偏好 ' + fav.favor + ' / ' + CFG.intervene.needFavor + '（多去' + deityTemple(deityId) + '祈祷）',
      'bad',
    );
    return false;
  }
  const day = dayOf(s);
  const left = fav.lastMiracleDay === undefined ? 0 : CFG.intervene.cooldownDays - (day - fav.lastMiracleDay);
  if (left > 0) {
    toast('神迹不可频求——' + deityName(deityId) + '还需 ' + left + ' 日才会再次垂目。', 'bad');
    return false;
  }
  fav.favor = Math.max(0, fav.favor - CFG.intervene.costFavor);
  fav.intervened = (fav.intervened || 0) + 1;
  fav.lastMiracleDay = day;
  fav.rank = rankFor(deityId, fav.favor);
  // 神迹叙事经 D4：簿记 + seed 直出（关 AI 成立）；id 带次数 → 每次神迹各自留档且不互相幂等
  const ev: EventDef = {
    id: 'divine_' + deityId + '_' + fav.intervened,
    name: eff.name,
    trigger: {},
    seed: eff.text,
    loreRef: 'lore s2/s37/s43',
    effects: {
      ...(eff.rep ? { rep: eff.rep } : {}),
      ...(eff.flag ? { flags: { [eff.flag]: true } } : {}),
      toast: { text: '✦ 神迹 · ' + eff.name, cls: 'gold' },
      history: { result: eff.name, imp: 4 },
    },
  };
  fireEvent(ev, s);
  if (eff.healFull) {
    mutate.playerHp(maxHp(s));
    mutate.playerMp(maxMp(s));
  }
  if (eff.gold) gainGold(rng.R(eff.gold[0], eff.gold[1]));
  if (eff.item) addItem(eff.item);
  if (eff.soulCrystal) {
    mutate.playerWallet('soulCrystal', eff.soulCrystal);
    toast('◈ 灵魂结晶 +' + eff.soulCrystal, 'gold');
  }
  if (eff.exp) gainExp(eff.exp);
  if (eff.weatherPick && eff.weatherPick.length) mutate.weather(rng.pick(eff.weatherPick) as Weather);
  sync();
  return true;
}

/* ---------------- 候补神晋升（s4 · 供卡 H5 神战终局调用） ---------------- */

/** 晋升幂等台账键（WorldState 无 ascended 字段，见交付报告「需要的字段」） */
const ASCEND_KEY = (npcId: string) => 'ascend_' + npcId;

/**
 * 晋升候补神（s4：每神殿每百年 3 名候补，神战定座次后入册）。
 * 幂等：同一 npcId 重复调用不再产生任何副作用，仍返回 true（该员已在册）。
 * 防御：core.S 未初始化 / npcId 非法 / H5 未落地（theoselect 缺失）/ NPC 不在世界书 → 均不抛错。
 */
export function ascendCandidate(npcId: string): boolean {
  const s = core.S;
  if (!s || typeof npcId !== 'string' || !npcId.trim()) return false;
  if (s.player.flags[ASCEND_KEY(npcId)]) return true; // 已在册（幂等）
  mutate.playerFlag(ASCEND_KEY(npcId));
  ensureFavor(s);
  const rank = CFG.ranks[CFG.ascension.rankIndex] || CFG.ascension.rank;
  // 卡 H5 联动（H5 未落地时 theoselect 可能缺失或字段不全 → 全部可选链，不抛错）
  const th = s.theoselect;
  if (th) {
    if (th.stage === CFG.ascension.needStage) th.stage = rank; // 神战 → 候补
    if (!th.champion) th.champion = npcId;
  }
  const nm = npcId === 'player' ? s.player.name : WB.npcs[npcId]?.name || npcId; // 百年神选夺魁者是玩家本人
  log(rng.pick(CFG.ascension.seeds) + ' ' + nm + CFG.ascension.tale, 'sys', s);
  addHistory(CFG.ascension.history, nm + '·' + rank + '级', 5);
  toast('✦ ' + nm + ' 晋升' + rank, 'gain');
  sync();
  return true;
}

/* ---------------- 演出菜单（复用 ConfirmSheet，零新增 React 组件） ---------------- */

/** 单神详情菜单（engine 路由：de_show+id / de_pray+id / de_intervene+id / de_menu） */
export function deityDetail(deityId: DeityId): void {
  const s = need();
  if (!isDeityId(deityId)) {
    toast('神名有误——万神殿没有这一位。', 'bad');
    return;
  }
  const f = ensureFavor(s)[deityId] as FavorEx;
  const left = prayLeft(s);
  const cls = faithClassesOf(deityId);
  const ult = CFG.faithUltimate[deityId];
  const t = tierFor(deityId, f.favor);
  const canMiracle = f.favor >= CFG.intervene.needFavor;
  const body =
    '神号：' + deityTitle(deityId) + '　·　' + deityTemple(deityId) + '（' + (CFG.gender[deityId] || '—') + '）<br>' +
    '分殿：' + (CFG.branches[deityId] || '—') + '<br>' +
    '神职领域：' + deityDomains(deityId).join('／') + '<br>' +
    '信仰阶位：' + rankFor(deityId, f.favor) + (cls.length ? '（' + cls.join(' → ') + '）' : '（' + CFG.noFaithRank + '）') + '<br>' +
    '殿堂职名：' + t.templeGrade + '　·　' + t.duty + '<br>' +
    '偏好：' + f.favor + ' / ' + CFG.pray.favorCap + '　·　已降神迹：' + (f.intervened || 0) + ' 次<br>' +
    (ult ? '终极：' + ult.name + '（' + ult.ability + '·' + ult.effect + '）<br>' : '') +
    '神系态度：' + (CFG.attitudes.byDeity[deityId] || '');
  confirmSheet('万神殿 · ' + deityName(deityId), body, [
    { l: '祈祷（今日余 ' + left + ' 次）', a: 'de_pray', id: deityId, dg: left <= 0 },
    { l: '祈求神迹（需偏好 ' + CFG.intervene.needFavor + '，耗 ' + CFG.intervene.costFavor + '）', a: 'de_intervene', id: deityId, dg: !canMiracle },
    { l: '（回到万神殿）', a: 'de_menu' },
    { l: '（退开）', a: 'close' },
  ]);
}

/** 万神殿总菜单（engine 路由 de_menu） */
export function deityMenu(): void {
  const s = need();
  ensureFavor(s);
  const rows = DEITY_IDS.map((id) => {
    const f = ensureFavor(s)[id] as FavorEx;
    const next = nextRankNeed(id, f.favor);
    return (
      '【' + deityTitle(id) + '·' + deityName(id) + '】偏好 ' + f.favor + '　' + rankFor(id, f.favor) +
      (next ? '（下一阶 ' + next.rank + '：' + next.at + '）' : '')
    );
  });
  confirmSheet(
    '万神殿 · 六大神系',
    '今日祈祷：' + prayUsed(s) + ' / ' + CFG.pray.dailyCap + '<br>' + CFG.attitudes.common + '<br>' + rows.join('<br>'),
    [...DEITY_IDS.map((id) => ({ l: deityName(id) + '·' + deityTitle(id), a: 'de_show', id })), { l: '（退开）', a: 'close' }],
  );
}

/* ---------------- 纯数据视图（供 UI 面板渲染；只读） ---------------- */

export interface DeityRow {
  id: DeityId;
  name: string;
  title: string;
  temple: string;
  gender: string;
  branches: string;
  domains: string[];
  attitude: string;
  favor: number;
  rank: string;
  templeGrade: string;
  duty: string;
  nextRank: string | null;
  nextAt: number | null;
  faithClasses: string[];
  faithDisabled: boolean;
  ultimate: { name: string; ability: string; effect: string } | null;
  templeSchool: { direction: string; years: string; entry: string } | null;
  intervened: number;
  needFavor: number;
  costFavor: number;
  cooldownLeft: number;
  canIntervene: boolean;
  lastPrayDay: number | null;
}

export interface DeityView {
  day: number;
  dailyCap: number;
  prayUsed: number;
  prayLeft: number;
  favorMin: number;
  favorMax: number;
  favorCap: number;
  ranks: string[];
  rankDetail: RankDetail[];
  promotionPath: { from: string; to: string; need: string }[];
  attitudesCommon: string;
  noFaithNote: string;
  rows: DeityRow[];
}

export function deityView(s: WorldState = need()): DeityView {
  ensureFavor(s);
  const used = prayUsed(s);
  const day = dayOf(s);
  return {
    day,
    dailyCap: CFG.pray.dailyCap,
    prayUsed: used,
    prayLeft: Math.max(0, CFG.pray.dailyCap - used),
    favorMin: CFG.pray.favorMin,
    favorMax: CFG.pray.favorMax,
    favorCap: CFG.pray.favorCap,
    ranks: CFG.ranks,
    rankDetail: CFG.rankDetail,
    promotionPath: CFG.promotionPath,
    attitudesCommon: CFG.attitudes.common,
    noFaithNote: CFG.noFaithRank,
    rows: DEITY_IDS.map((id) => {
      const f = ensureFavor(s)[id] as FavorEx;
      const cls = faithClassesOf(id);
      const next = nextRankNeed(id, f.favor);
      const t = tierFor(id, f.favor);
      const ts = TEMPLE_SCHOOLS.find((x) => x.deity === id) || null;
      const left = f.lastMiracleDay === undefined ? 0 : Math.max(0, CFG.intervene.cooldownDays - (day - f.lastMiracleDay));
      return {
        id,
        name: deityName(id),
        title: deityTitle(id),
        temple: deityTemple(id),
        gender: CFG.gender[id] || '',
        branches: CFG.branches[id] || '',
        domains: deityDomains(id),
        attitude: CFG.attitudes.byDeity[id] || '',
        favor: f.favor,
        rank: rankFor(id, f.favor),
        templeGrade: t.templeGrade,
        duty: t.duty,
        nextRank: next ? next.rank : null,
        nextAt: next ? next.at : null,
        faithClasses: cls,
        faithDisabled: cls.length === 0,
        ultimate: CFG.faithUltimate[id] || null,
        templeSchool: ts ? { direction: ts.direction, years: ts.years, entry: ts.entry } : null,
        intervened: f.intervened || 0,
        needFavor: CFG.intervene.needFavor,
        costFavor: CFG.intervene.costFavor,
        cooldownLeft: left,
        canIntervene: f.favor >= CFG.intervene.needFavor && left === 0,
        lastPrayDay: typeof f.lastPrayDay === 'number' ? f.lastPrayDay : null,
      };
    }),
  };
}

/** 天界职位层级（s3）只读表 */
export function divineRanks(): RankDetail[] {
  return CFG.rankDetail;
}

/** 当前祈祷状态（纯读，供菜单/面板显示） */
export function favorDayState(s: WorldState = need()): { day: number; used: number; left: number; cap: number } {
  return { day: dayOf(s), used: prayUsed(s), left: prayLeft(s), cap: CFG.pray.dailyCap };
}

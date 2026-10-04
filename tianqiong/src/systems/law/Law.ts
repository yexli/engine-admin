/* ============================================================
   法律系统（卡 D5 升级：罪名 S/A/B/C/D 分级 + 司法审判流程 + 城法差异）
   《项目方案》§30。旧 wantedLv/arrest/payFine 语义保留（core.test 依赖）；
   arrest 若在押案底则转 data-driven 审判 trial()。法外之地不追究。
   ============================================================ */
import law from '@/data/world/law.json';
import { regionOf } from '@/data/regions';
import { WB } from '@/data/worldBook';
import type { CrimeGrade } from '@/types/world';
import { rng, toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { militaryLeniency } from '@/systems/faction/Diplomacy';
import { adjRepAxis } from '@/systems/faction/Factions';
import { addRep, gainGold } from '@/systems/character/Gains';
import { log } from '@/systems/character/Gains';
import { need } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { formatMoney } from '@/systems/economy/Money';
import { CHEN_PER_DAY, sceneTime, tillMorning } from '@/world/WorldClock';
import { addHistory } from '@/events/EventStore';

interface CrimeDef {
  name: string;
  grade: CrimeGrade;
  wantedAdd: number;
  fineBase: number;
  jailDays?: number;
  exileTo?: string;
}
const CRIMES = law.crimes as unknown as Record<string, CrimeDef>;
const GRADE_PENALTY = Object.fromEntries(Object.entries(law.grades).map(([k, v]) => [k, (v as { penalty: string }).penalty]));
const ORDER: CrimeGrade[] = law.order as CrimeGrade[]; // ['S','A','B','C','D']
const JURIS = law.jurisdictions as unknown as Record<string, 'strict' | 'lawless'>;

/* —— 世界书 §90/§89（卡 T3）——
   通缉档位与赎罪门槛都取自 law.json。档位刻意**不**改 wanted 的既有量纲
   （1/2/3 累进，上限 3）：wanted 在存档、盘查概率、星枢禁入、称号条件里都被当
   "等级"用，改量纲会连带漂移这些语义。改为把 1/2/3 映射到六档中的橙/红/黑，
   白名＝无通缉、黄名＝有案底但未决，神罚档供 S 级罪预留。 */
const TIERS = (law.wantedTiers ?? []) as unknown as {
  id: string; name: string; color: string; bounty: [number, number]; note: string;
}[];
const ATONE = (law.atonement ?? {}) as unknown as Record<string, { min: number; max: number; needTemple?: boolean } | null>;

const legalOf = () => {
  const s = need();
  if (!s.legal) s.legal = { charges: [] };
  return s.legal;
};

/** 该地点是否法外（不追究），缺省按 strict 处理 */
export const isLawless = (loc: string) => (JURIS[loc] || 'strict') === 'lawless';

/* —— 卡 D5 演出：只读罪名/等级元数据访问（供 UI 渲染判决书，不改状态） —— */
export const crimeName = (id: string) => CRIMES[id]?.name ?? id;
export const crimeGrade = (id: string): CrimeGrade | undefined => CRIMES[id]?.grade;
export const gradeLabel = (g: CrimeGrade) => (law.grades as Record<string, { label: string }>)[g]?.label ?? g;
export const penaltyLabel = (g: CrimeGrade) => (law.penalties as Record<string, string>)[GRADE_PENALTY[g]] ?? '';

/** 立案：记入案底 + 累加通缉（法外之地不立案）。内部复用 wantedLv 保旧语义。 */
export function commitCrime(crimeId: string, atLoc?: string): boolean {
  const s = need();
  const c = CRIMES[crimeId];
  if (!c) return false;
  if (atLoc && isLawless(atLoc)) {
    log('这里没有官府——你的所作所为无人追究，但也没人会替你说话。', 'bad', s);
    return false;
  }
  legalOf().charges.push(crimeId);
  /* 卡 R4 · §87：立案轻重随**所在地的执法严格度**浮动——
     中央大陆（5 星）×1.4、地下深渊（1 星）×0.2。这是「换个地方犯法后果不同」
     这句设定唯一该落地的地方：它只影响立案当下那一次，不改变通缉累进的语义。 */
  const cont = WB.locations[atLoc ?? s.player.loc]?.continent ?? '';
  const add = cont ? wantedAddAt(c.wantedAdd, cont) : c.wantedAdd;
  wantedLv(add, c.name);
  adjRepAxis('empire', 'hostility', add * 8, s); // 卡 F：犯罪累积帝国敌意（越高越易被盘查/追捕）
  /* §22/§34：立案即世界事实。罪行本身多半是隐蔽的（显眼度见 Perception 表），
     因此目击名单由感知层判定——无人目击的罪行只有玩家自己知道。 */
  worldBus.emit(
    makeEvent({
      type: 'crime_committed',
      day: sceneTime(s).day,
      tick: s.t,
      actor: 'player',
      target: crimeId,
      location: atLoc ?? s.player.loc,
      cause: c.name,
      data: { crime: crimeId, wantedAdd: add, continent: cont || undefined },
    }),
  );
  return true;
}

/** 取案底中最高等级罪名（S>A>B>C>D） */
export function topCharge(s = need()): { id: string; def: CrimeDef } | null {
  const legal = s.legal;
  if (!legal || !legal.charges.length) return null;
  let best: { id: string; def: CrimeDef } | null = null;
  for (const id of legal.charges) {
    const def = CRIMES[id];
    if (!def) continue;
    if (!best || ORDER.indexOf(def.grade) < ORDER.indexOf(best.def.grade)) best = { id, def };
  }
  return best;
}

/** 审判：按最高罪名等级执行处罚（罚金 / 赎罪 / 监禁 / 流放 / 处决） */
export function trial(s = need()): string {
  const top = topCharge(s);
  if (!top) {
    arrestLegacy();
    return 'fine';
  }
  const penalty = GRADE_PENALTY[top.def.grade];
  const legal = legalOf();
  /* 地区规整：判决署名取当前所在地，而不是写死「圣辉城」——
     新增一座有司法的城市时，这里的文案自动跟上。 */
  toast('⚖ ' + (regionOf(s.player.loc) || '当地') + '判决 · ' + top.def.name + '（' + gradeLabel(top.def.grade) + '）→ ' + penaltyLabel(top.def.grade), 'bad');
  if (penalty === 'death') {
    legal.executed = true;
    mutate.playerSet('wanted', 0);
    log('灭世之罪，无可赦免——行刑台上的圣钟长鸣。你的故事在此定格。', 'bad', s);
    addHistory('处决：' + top.def.name, '极刑', 5);
    return 'death';
  }
  // 卡 F：军功者可罚金代刑（军事维度 ≥30 → 监禁/流放降为罚金）
  let effPenalty = penalty;
  if ((penalty === 'jail' || penalty === 'exile') && militaryLeniency(s)) {
    effPenalty = 'fine';
    log('你身上的军功被呈到了案头——法官冷哼一声，改判罚金，免了牢狱与流放。', 'gain', s);
    addHistory('军功从轻：' + top.def.name, '以罚金代刑', 3);
  }
  // 罚金（C 级以上附加当众赎罪的氛围）
  const fine = Math.min(s.player.gold, top.def.fineBase);
  gainGold(-fine);
  mutate.playerSet('wanted', 0);
  mutate.playerNum('crimes', (n) => n + 1);
  if (effPenalty === 'jail' && top.def.jailDays) {
    legal.jailedUntil = s.t + top.def.jailDays * CHEN_PER_DAY;
    mutate.playerLoc('gate');
    addRep('empire', -5);
    log(`审判：${top.def.name}（重罪）。你被判监禁 ${top.def.jailDays} 日，并处罚金 ${formatMoney(fine)}。`, 'bad', s);
    addHistory('监禁：' + top.def.name, `${top.def.jailDays}日·罚金${formatMoney(fine)}`, 4);
    return 'jail';
  }
  if (effPenalty === 'exile') {
    const to = top.def.exileTo || 'wild';
    legal.exiledTo = to;
    mutate.playerLoc(to);
    addRep('empire', -12);
    log(`审判：${top.def.name}（极恶罪）。你被${formatMoney(fine)}罚金后逐出圣辉城，流放${to === 'wild' ? '西方荒野' : to}。`, 'bad', s);
    addHistory('流放：' + top.def.name, '驱逐出境', 5);
    return 'exile';
  }
  // fine / fine_atone
  tillMorning();
  mutate.playerLoc('gate');
  addRep('empire', -5);
  const tone = penalty === 'fine_atone' ? '并在广场当众赎罪' : '';
  log(`你在拘留室蹲了一夜，课以 ${formatMoney(fine)} 罚金${tone}。雷诺队长警告：“再犯就不是罚钱了事。”`, 'bad', s);
  addHistory('审判：' + top.def.name, '罚金' + formatMoney(fine), 3);
  return 'fine';
}

/* ============================================================
   卡 R4 · 法律全量（世界书 §87–§93）
   —— 三件事：① 七大陆严格度影响「立案轻重」；② 白盟约决定跨大陆能不能引渡；
   ③ 七铁律与冒险者特权有了判定载体。判定全在本模块，数据全在 law.json / continents.json。
   ============================================================ */

const WP = (law as unknown as {
  whitePact?: { members: string[]; nonMembers: string[]; minGrade: string };
  ironLaws?: { no: number; text: string; grade: CrimeGrade; crime: string; scope: string }[];
  adventurer?: { rights: { id: string; text: string }[]; limits: { id: string; text: string; penalty: string }[] };
}).whitePact;
const IRON = (law as unknown as { ironLaws?: { no: number; text: string; grade: CrimeGrade; crime: string; scope: string }[] }).ironLaws ?? [];

/** 七大陆法律严格度（§87；未登记的大陆按 3 星中性处理，缺数据不惩罚玩家也不放水） */
export function lawStrictness(continent: string): number {
  const c = WB.continents.items[continent] as unknown as { lawStrict?: number } | undefined;
  return c?.lawStrict ?? 3;
}

/**
 * 该地盘查/追诉的强度倍率：严格度 5 星 → ×1.4，1 星 → ×0.2。
 * 用法与「换个地方犯法后果不同」这句设定对齐；只在**立案那一刻**算一次，
 * 不改变后续通缉累进的语义（避免同一个数字在不同阶段有不同含义）。
 */
export function lawPressure(continent: string): number {
  return 0.2 + lawStrictness(continent) * 0.24;
}

/** 玩家当前所在地的追诉强度 */
export function currentPressure(s = need()): number {
  const cont = WB.locations[s.player.loc]?.continent ?? '';
  return cont ? lawPressure(cont) : 1;
}

/** 按追诉强度折算通缉增量（至少 1，且不超过原始值——弱执法地区只是"追得松"，不是"无罪"） */
export function wantedAddAt(base: number, continent: string): number {
  return Math.max(1, Math.min(base, Math.round(base * lawPressure(continent))));
}

/** 白盟约签约方（§90）：只有签约方之间才谈得上引渡 */
export function isPactMember(continent: string): boolean {
  if (!WP) return false;
  return WP.members.includes(continent);
}

/**
 * 跨大陆引渡判定（§90 白盟约）。
 * 三个条件同时成立才引渡：两地都是签约方、罪名等级够（B 级及以上）、确有通缉在身。
 */
export function canExtradite(fromContinent: string, toContinent: string, topGrade?: CrimeGrade, s = need()): { ok: boolean; why: string } {
  if (!WP) return { ok: false, why: '七大陆之间没有司法协议' };
  if (s.player.wanted <= 0) return { ok: false, why: '你身上没有未决的通缉' };
  if (!isPactMember(fromContinent)) return { ok: false, why: fromContinent + '未签白盟约——实际无法引渡' };
  if (!isPactMember(toContinent)) return { ok: false, why: toContinent + '未签白盟约——实际无法引渡' };
  const order = WP.minGrade as CrimeGrade;
  if (topGrade && ORDER.indexOf(topGrade) > ORDER.indexOf(order)) {
    return { ok: false, why: gradeLabel(topGrade) + '不足引渡门槛（需 ' + gradeLabel(order) + ' 及以上）' };
  }
  return { ok: true, why: '' };
}

/** 七大铁律（§93）：罪名 → 触犯了哪几条铁律（供判决书与叙事引用） */
export function ironLawsOf(crimeId: string): { no: number; text: string; grade: CrimeGrade; scope: string }[] {
  return IRON.filter((x) => x.crime === crimeId);
}

/** 全部铁律（只读，供面板展示） */
export const ironLaws = (): typeof IRON => IRON.slice();

/* ---------------- 冒险者特权（§91） ---------------- */

export type CrimeContext = 'quest' | 'self_defense' | 'bounty';

/**
 * 冒险者特权豁免：公会任务期间伤人 / 被魔物攻击反击 / 悬赏任务所得，均不违法。
 * 刻意**只豁免轻中罪**（D/C）——任务身份不是免死金牌，重罪照究（§91 的限制面）。
 */
export function adventurerExempt(crimeId: string, ctx?: CrimeContext): { exempt: boolean; why: string } {
  if (!ctx) return { exempt: false, why: '' };
  const g = CRIMES[crimeId]?.grade;
  if (!g) return { exempt: false, why: '' };
  const light = ORDER.indexOf(g) >= ORDER.indexOf('C'); // C/D 级
  if (!light) return { exempt: false, why: '重罪不因任务身份豁免' };
  const name = ctx === 'quest' ? '公会任务豁免' : ctx === 'self_defense' ? '紧急避险' : '悬赏归属';
  return { exempt: true, why: name + '：此行径不计入案底' };
}

/* ---------------- 通缉档位 · 赏金 · 赎罪门槛（卡 T3） ---------------- */

/** 通缉档（六档之一）。wanted=0 白名；1/2/3 → 橙/红/黑；更高值封顶神罚。 */
export function wantedTier(s = need()) {
  const w = Math.max(0, s.player.wanted | 0);
  const idx = Math.min(TIERS.length - 1, w === 0 ? 0 : w + 1);
  return TIERS[idx] ?? { id: 'white', name: '白名', color: '#e8e8e8', bounty: [0, 0] as [number, number], note: '守法' };
}

/** 通缉档的显示名（供 UI / 文案；缺数据时回落旧样式"等级 N"） */
export const wantedName = (s = need()): string => (TIERS.length ? wantedTier(s).name : '等级 ' + s.player.wanted);

/**
 * 赏金令金额（**金币**，按 §90 档位区间取材）。
 * tierMin/tierMax 为 0（白/黄名）时按旧口径 300×wanted 兜底——一个没有档位区间的
 * 通缉犯也该有价码，否则赏金猎人系统会凭空少一类人。
 */
export function bountyOf(s = need()): number {
  const t = wantedTier(s);
  const [lo, hi] = t.bounty ?? [0, 0];
  if (hi > 0) return lo === hi ? lo : lo + ((rng.R(0, hi - lo) as number) | 0);
  return 300 * s.player.wanted;
}

/**
 * 销案（赎罪/缴罚）金额，**铜**。§89 的赎罪标准以金币计，这里按 1 金币 = 10000 铜换算；
 * 无档位数据时回落旧口径 300×wanted（旧档与数据缺失都不至于算不出价）。
 */
export function payableFine(s = need()): number {
  const top = topCharge(s);
  if (top) {
    const a = ATONE[top.def.grade];
    if (a && a.min > 0) return a.min * 10000;
  }
  return 300 * s.player.wanted;
}

/** 该罪名能否以赎罪金销案（§89：S 级不接受赎罪） */
export function atonementAllowed(crimeId: string): boolean {
  const def = CRIMES[crimeId];
  if (!def) return true;
  return ATONE[def.grade] != null;
}

/** 通缉升级并记录案底（原型 wantedLv） */
export function wantedLv(n: number, why: string) {
  const s = need();
  mutate.playerNum('wanted', (v) => Math.min(3, v + n));
  mutate.playerNum('crimes', (v) => v + n);
  toast('⚑ 你被通缉（等级 ' + s.player.wanted + '）：' + why, 'bad');
  addHistory('犯罪：' + why, '通缉等级 ' + s.player.wanted, 2);
}

/** 逮捕：有案底 → 审判；无案底（旧路径）→ 原罚金拘留逻辑（core.test 依赖） */
export function arrest(): string {
  const s = need();
  if (s.legal && s.legal.charges.length) {
    const r = trial(s);
    s.legal.charges = []; // 审判后清空待结案底
    return r;
  }
  arrestLegacy();
  return 'fine';
}

function arrestLegacy() {
  const s = need();
  mutate.playerSet('wanted', 0);
  mutate.playerNum('crimes', (n) => n + 1); // 被捕另记一案底（core.test 断言，非重复计数 bug）
  const fine = Math.min(s.player.gold, 300 * s.player.crimes);
  mutate.playerGold(-fine);
  tillMorning();
  mutate.playerLoc('gate');
  log('你在拘留室蹲了一夜，还被课了 ' + formatMoney(fine) + '罚金。雷诺队长放你出来时警告：“再犯就不是罚钱了事。”', 'bad');
  addRep('empire', -5);
  addHistory('玩家被捕', '罚金' + formatMoney(fine) + '·拘留一日', 2);
}

/** 是否仍在服刑（供行动受限判定） */
export const isJailed = (s = need()) => !!s.legal?.jailedUntil && s.t < s.legal.jailedUntil;

/** 刑满释放（推进到释放刻） */
export function releaseIfNeeded(s = need()): boolean {
  if (s.legal?.jailedUntil && s.t >= s.legal.jailedUntil) {
    s.legal.jailedUntil = undefined;
    log('刑期届满，你被放出拘留室。', 'sys', s);
    return true;
  }
  return false;
}

/** 缴罚金销案（雷诺对话 / 城门行动共用；原型经 gainGold 走账目通知） */
export function payFine(): boolean {
  const s = need();
  const cost = payableFine(s);
  if (s.player.gold < cost) return false;
  gainGold(-cost);
  mutate.playerSet('wanted', 0);
  if (s.legal) s.legal.charges = []; // 缴清销案：清空待结案底
  log('你缴清罚金，通缉撤销。', 'gain');
  return true;
}


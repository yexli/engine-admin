/* ============================================================
   卡 H3 · 命名生成器（core 判定层）
   —— 词根表 / 命名公式 / 稀有度权重 / 避雷词 全部落在
      src/data/naming/{lexicon,rules,blocklist}.json（data 层零逻辑）。
   —— 分层：core 只依赖 @/data/* 与 ./bus，不碰 UI/store/DOM。
   —— 确定性：随机一律走统一 rng（可 seed），函数亦接受 opts.rng 注入。
   —— 兜底：未知种族回落人类公式；生成结果永不命中 blocklist。
   ============================================================ */
import blocklist from '@/data/naming/blocklist.json';
import lexicon from '@/data/naming/lexicon.json';
import rules from '@/data/naming/rules.json';
import { LORE, PERSON_LORE, type LoreCard } from '@/data/lore';
import { rng } from '@/events/EventBus';

/* ---------------- 类型 ---------------- */

/** lexicon 的六张词根表（族 key 与 tables.json.races 完全一致） */
export type NamingTable = 'male' | 'female' | 'clan' | 'epithet' | 'prefix' | 'suffix';
/** 稀有度：普通 70% / 稀有 25% / 传说 5% */
export type NamingTier = 'common' | 'rare' | 'legend';
export type NamingGender = 'male' | 'female';
/** 可注入随机源（签名与 rng.next 一致，便于测试复现） */
export type RngLike = () => number;

export interface NameOpts {
  gender?: NamingGender;
  tier?: NamingTier;
  rng?: RngLike;
}
export interface BatchOpts extends NameOpts {
  /** 单批去重上限尝试次数（默认 count × rules.limits.batchAttemptFactor） */
  maxAttempts?: number;
}

export type NamingLexicon = Record<string, Record<NamingTable, string[]>>;
export interface RaceRule {
  styleNote: string;
  formula: string;
  slots: Record<string, NamingTable[]>;
  patterns: string[];
  tierPatterns: Record<NamingTier, string[]>;
  gender: { optional: boolean; male: NamingGender; female: NamingGender };
  style: { charset: string; sample: string };
}
export interface NamingRules {
  tiers: Record<NamingTier, number>;
  fallbackRace: string;
  /** 中文族名 → lexicon key（与 tables.json.races[*].name 对齐，如 人类 → human） */
  alias: Record<string, string>;
  limits: { minLen: number; maxLen: number; nameAttempts: number; batchAttemptFactor: number };
  lore: { separators: string[]; quotes: string[][]; minLen: number; maxLen: number; fallbackRace: string };
  races: Record<string, RaceRule>;
}
export interface NamingBlocklist {
  meta?: { note?: string };
  /** 脏话 / 敏感词 / 政治雷区（子串命中即拒） */
  words: string[];
  /** 已用 canonical 专名（整名命中即拒，防重复） */
  reserved: string[];
  /** canonical 词根（子串命中即拒，防撞神名/地名） */
  reservedRoots: string[];
  /** 地名（nameFromLore 不取用地名作人名） */
  places: string[];
}

/* ---------------- 只读加载器（as unknown as T 固化类型） ---------------- */

export const NAMING_LEXICON = lexicon as unknown as NamingLexicon;
export const NAMING_RULES = rules as unknown as NamingRules;
export const NAMING_BLOCKLIST = blocklist as unknown as NamingBlocklist;

const TIERS: NamingTier[] = ['common', 'rare', 'legend'];
const CJK_RE = /[\u4e00-\u9fa5]/;
/* 卡 G1：槽位名允许驼峰（{secretTrait} / {relicEra}），故字符集含大写——
   原正则只认全小写，驼峰占位符会被整段跳过、原样留在成品名里。 */
const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g;
/** 同上，但**不带 g**——带 g 的正则做 test() 会留 lastIndex，跨次调用结果不定 */
const hasSlot = (x: string): boolean => /\{[A-Za-z]+\}/.test(x);
const FALLBACK_RACE = NAMING_RULES.fallbackRace || 'human';
const ALIAS: Record<string, string> = NAMING_RULES.alias ?? {};
const LIMITS = NAMING_RULES.limits;
const RESERVED = new Set(NAMING_BLOCKLIST.reserved);
const PLACES = new Set(NAMING_BLOCKLIST.places);

/** 每族合法字符集（词根字符 ∪ 公式字面量字符；单字表上也用于风格校验） */
const CHARSETS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(NAMING_RULES.races).map(([race, r]) => [race, new Set(r.style.charset)]),
);

/* ---------------- 基础 ---------------- */

/** 全部可命名种族（13，次序与 tables.json.races 一致） */
/**
 * 有词表的**种族**键（卡 G1 后 lexicon 还装了地区/组织/装备等六维词表，
 * 那些表没有「male/female」这一对槽位——用结构判定把种族与其它维度分开，
 * 免得 namingRaces() 把 'place' 也当成一个种族报出去）。
 */
export function namingRaces(): string[] {
  return Object.keys(NAMING_LEXICON).filter((k) => {
    const t = TABLES[k];
    return !!t && Array.isArray(t.male) && Array.isArray(t.female);
  });
}

/** 种族是否有词根表（未知种族不抛错，交由调用方回落） */
export function isNamingRace(race: string): boolean {
  return Object.prototype.hasOwnProperty.call(NAMING_LEXICON, race);
}

/** 族名 → key：支持 lexicon key、中文族名（人类/精灵…）与大小写混写；未知返回 null */
function aliasToKey(race: string): string | null {
  const r = (race ?? '').trim();
  if (isNamingRace(r)) return r;
  const k = Object.prototype.hasOwnProperty.call(ALIAS, r) ? ALIAS[r] : r.toLowerCase();
  return isNamingRace(k) ? k : null;
}

/** 族名归一（供调用方复用）：未知种族回落人类 */
export function resolveRace(race: string): string {
  return aliasToKey(race) ?? FALLBACK_RACE;
}

/** 取族规则：未知种族回落人类（优雅兜底，绝不抛错） */
export function raceRuleOf(race: string): { key: string; rule: RaceRule } {
  const key = resolveRace(race);
  return { key, rule: NAMING_RULES.races[key] ?? Object.values(NAMING_RULES.races)[0] };
}

/** 有界取样：rng 返回越界 / NaN 也不崩 */
function pick<T>(arr: T[], next: RngLike): T {
  const v = next();
  const i = Number.isFinite(v) ? Math.min(arr.length - 1, Math.max(0, Math.floor(v * arr.length))) : 0;
  return arr[i];
}

/** 稀有度掷点：按 rules.tiers 权重返回档位（普通 70% / 稀有 25% / 传说 5%） */
export function rollTier(next: RngLike): NamingTier {
  const v = next();
  const x = Number.isFinite(v) ? Math.min(1 - 1e-9, Math.max(0, v)) : 0;
  let acc = 0;
  for (const tier of TIERS) {
    acc += NAMING_RULES.tiers[tier] ?? 0;
    if (x < acc) return tier;
  }
  return 'common';
}

/** 单槽位取值：多表槽（given）按性别选表，单表槽直接取词根 */
function slotValue(race: string, slot: string, gender: NamingGender, next: RngLike): string {
  const rule = NAMING_RULES.races[race];
  const tables = rule.slots[slot] ?? [slot as NamingTable];
  const name = tables.length > 1 ? (tables.includes(gender) ? gender : tables[0]) : tables[0];
  const arr = NAMING_LEXICON[race]?.[name];
  return arr && arr.length ? pick(arr, next) : slot;
}

function fill(race: string, pattern: string, gender: NamingGender, next: RngLike): string {
  return pattern.replace(PLACEHOLDER_RE, (_m, slot: string) => slotValue(race, slot, gender, next));
}

/* ---------------- blocklist ---------------- */

/** 命中避雷词库 / canonical 专名 → true（子串 + 整名双规则） */
export function isBlocked(name: string): boolean {
  const n = (name ?? '').trim();
  if (!n) return true;
  /* F-28：canonical 专名 124 条里 119 条是单段名（莉安、戈林、布伦丹…），
     而 11 个族的公式必带间隔号——等值判定永远命中不了，保护形同虚设。
     统一按子串拦截（与 reservedRoots 同规则），并保持整名命中的短路。 */
  if (RESERVED.has(n)) return true;
  for (const r of RESERVED) if (n.includes(r)) return true;
  for (const w of NAMING_BLOCKLIST.words) if (n.includes(w)) return true;
  for (const r of NAMING_BLOCKLIST.reservedRoots) if (n.includes(r)) return true;
  return false;
}

/** 名字是否通过校验：非空 / 非纯符号 / 长度合规 / 不撞 blocklist / 合规族字符集 */
export function validateName(name: string, race: string): boolean {
  const n = (name ?? '').trim();
  if (!n) return false;
  if (!CJK_RE.test(n)) return false; // 纯符号 / 纯拉丁 → 拒
  if (n.length < LIMITS.minLen || n.length > LIMITS.maxLen) return false;
  if (isBlocked(n)) return false;
  const key = aliasToKey(race);
  const charset = key ? CHARSETS[key] : undefined; // 未知种族跳过字符集校验
  if (charset) for (const ch of n) if (!charset.has(ch)) return false; // 跨族风格串味 → 拒
  return true;
}

/* ---------------- 生成 ---------------- */

/**
 * 生成一个名字。
 * @param race 十三族 key（未知种族优雅回落人类公式，不抛错）
 * @param opts gender 指定性别 / tier 指定稀有度 / rng 注入随机源（可复现）
 */
export function generateName(race: string, opts: NameOpts = {}): string {
  const { key, rule } = raceRuleOf(race);
  const next = opts.rng ?? rng.next;
  const tier = opts.tier ?? rollTier(next);
  const gender: NamingGender = opts.gender ?? (rule.gender.optional ? (next() < 0.5 ? 'female' : 'male') : rule.gender.male);
  const patterns = rule.tierPatterns[tier]?.length ? rule.tierPatterns[tier] : rule.patterns;
  for (let i = 0; i < LIMITS.nameAttempts; i++) {
    const name = fill(key, pick(patterns, next), gender, next);
    if (!isBlocked(name)) return name; // 避雷 + 防撞 canonical 专名
  }
  return fallbackName(key, gender);
}

/** 极少数全命中时：按公式线性扫词根表，取第一个不撞避雷的（保证总能出名字） */
function fallbackName(race: string, gender: NamingGender): string {
  const rule = NAMING_RULES.races[race];
  const givens = [...NAMING_LEXICON[race][gender], ...NAMING_LEXICON[race].male, ...NAMING_LEXICON[race].female];
  for (const pattern of [rule.formula, ...rule.patterns]) {
    const fixed = pattern.replace(PLACEHOLDER_RE, (_m, slot: string) => {
      const tables = rule.slots[slot] ?? [slot as NamingTable];
      return NAMING_LEXICON[race][tables[0]][0];
    });
    if (!isBlocked(fixed)) return fixed;
    for (const given of givens) {
      const cand = pattern.replace(PLACEHOLDER_RE, (_m, slot: string) => {
        if (slot === 'given') return given;
        const tables = rule.slots[slot] ?? [slot as NamingTable];
        return NAMING_LEXICON[race][tables[0]][0];
      });
      if (!isBlocked(cand)) return cand;
    }
  }
  return NAMING_LEXICON[race].male[0];
}

/**
 * 批量生成（同批内去重 + 覆盖 reserved canonical 专名）。
 * 词根空间被 opts.tier 限死时可能少于 count（不伪造、不抛错）。
 */
export function batchGenerate(race: string, count: number, opts: BatchOpts = {}): string[] {
  const n = Math.max(0, Math.floor(count) || 0);
  const out: string[] = [];
  if (!n) return out;
  const next = opts.rng ?? rng.next;
  const attempts = Math.max(n * (LIMITS.batchAttemptFactor || 40), opts.maxAttempts ?? 0);
  const seen = new Set<string>();
  for (let i = 0; i < attempts && out.length < n; i++) {
    const name = generateName(race, { ...opts, rng: next });
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/* ---------------- lore canon 取名 ---------------- */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 canon 正文里抽取候选专名：先取分隔符（·/・）后的名字，再取引号内名字 */
function extractNames(text: string): string[] {
  const cfg = NAMING_RULES.lore;
  const out: string[] = [];
  const push = (raw: string) => {
    const t = (raw ?? '').trim();
    if (t.length >= cfg.minLen && t.length <= cfg.maxLen && !out.includes(t)) out.push(t);
  };
  const cjk = `[\\u4e00-\\u9fa5]{${cfg.minLen},${cfg.maxLen}}`;
  if (cfg.separators.length) {
    const re = new RegExp(`[${escapeRe(cfg.separators.join(''))}]\\s*(${cjk})`, 'g');
    for (const m of text.matchAll(re)) push(m[1]);
  }
  for (const pair of cfg.quotes) {
    const [open, close] = pair;
    if (!open || !close) continue;
    const re = new RegExp(`${escapeRe(open)}(${cjk})${escapeRe(close)}`, 'g');
    for (const m of text.matchAll(re)) push(m[1]);
  }
  return out;
}

function findCard(loreId: string): LoreCard | undefined {
  const id = (loreId ?? '').trim();
  if (!id) return undefined;
  return LORE.find((c) => c.id === id) ?? PERSON_LORE.find((c) => c.id === id);
}

/**
 * 从 lore.json canon 提取已有专名（如 s2 → 「阿尔卡斯」；人物卡 → 其 canon 名）。
 * 非人物 canon 会过滤掉地名；提取不到时回落 generateName（关 AI 也成立）。
 */
export function nameFromLore(loreId: string): string {
  const card = findCard(loreId);
  if (card) {
    if (card.kind === 'person' && card.name) return card.name;
    const text = [card.canon, card.seed].filter(Boolean).join('\n');
    for (const cand of extractNames(text)) {
      if (PLACES.has(cand)) continue; // 地名不作人名
      if (RESERVED.has(cand) || NAMING_BLOCKLIST.reservedRoots.includes(cand)) return cand;
    }
  }
  return generateName(NAMING_RULES.lore.fallbackRace || FALLBACK_RACE);
}

/* ============================================================
   卡 G1 · 命名六维（世界书 §106/§107/§114/§115/§116/§117）
   —— 人物名之外的五类命名此前没有生成器（地区/组织/装备/魔物/层名/技能遗迹），
   本段把它们接上同一套机制：公式 + 词根 + 避雷。
   加一类命名 = rules.json.dimensions 加一条 + lexicon.json 加一组词，代码零改动。
   ============================================================ */

type DimKey = 'place' | 'org' | 'item' | 'monster' | 'floor' | 'skill';
interface DimRule {
  formula: string;
  patterns: string[];
  tierPatterns: Record<string, string[]>;
  lex?: string[];
}
const DIMS: Record<DimKey, DimRule> = (NAMING_RULES as unknown as { dimensions: Record<DimKey, DimRule> }).dimensions;
/** 全词表（槽位查找用）：lexicon 是 { 表名: { 槽位: 词[] } } */
const TABLES = NAMING_LEXICON as unknown as Record<string, Record<string, unknown>>;

/** 该槽位在本维度下的词表（先查维度指定的表，再退回「槽位名同名表」）；
 *  带 context 时支持「context+槽位名」二级查表（技能名按职业系取词根就用这条）。 */
function slotTable(dim: DimKey, slot: string, context?: string): string[] | undefined {
  const probe = context ? context.replace(/·/g, '') : '';
  for (const t of DIMS[dim].lex ?? []) {
    if (probe) {
      const byCtx = TABLES[t]?.[probe] as Record<string, unknown> | undefined;
      const v = byCtx?.[slot];
      if (Array.isArray(v) && v.length) return v as string[];
      /* 二级表（如 skill.byLineage.<系>.<槽>）：本维度的词按"系"分组时走这条 */
      const by2 = TABLES[t]?.byLineage as Record<string, Record<string, unknown>> | undefined;
      const v2 = by2?.[probe]?.[slot];
      if (Array.isArray(v2) && v2.length) return v2 as string[];
    }
    const v = TABLES[t]?.[slot];
    if (Array.isArray(v) && v.length) return v as string[];
    /* 驼峰槽位的二级查表：{secretTrait} → TABLES[t].secret.trait、{relicEra} → .relic.era。
       这样公式里可以用语义化长名，而不必把词表拆成十几个扁平表。 */

  }
  const own = TABLES[slot];
  if (Array.isArray(own) && own.length) return own as string[];
  return undefined;
}

export interface DimOpts {
  /** 指定稀有度档（缺省按 tiers 概率掷） */
  tier?: NamingTier;
  rng?: RngLike;
  /** 附带条件（如魔物按大陆加前缀、层名按层数取主题段） */
  context?: string;
  level?: number;
}

/** 按槽位填充模板（与人物名的 fill 同构；未登记槽位原样保留，便于一眼看出缺词表） */
function fillDim(dim: DimKey, pattern: string, next: RngLike, context?: string): string {
  return pattern.replace(PLACEHOLDER_RE, (_m, slot: string) => {
    /* 层维度自己解决 {name}：从该层段主题里取一个层名（§116「层数 · 主题区域」） */
    if (slot === 'name') {
      const bands = (TABLES.floor?.bands as { words: string[] }[] | undefined) ?? [];
      const all = bands.flatMap((b) => b.words);
      return all.length ? pick(all, next) : '无名之地';
    }
    /* 驼峰槽位走二级查表：{secretTrait} → skill.secret.trait、{relicEra} → skill.relic.era。
       第二段首字母小写（Trait → trait）。 */
    const camel = /^([a-z]+)([A-Z][a-z]*)$/.exec(slot);
    if (camel) {
      const groupName = camel[1];
      const leafName = camel[2].toLowerCase();
      for (const host of [TABLES[dim], ...(DIMS[dim].lex ?? []).map((t) => TABLES[t])]) {
        /* 卡 G2：先认**平铺键**——词表里写的是 deityName，不是 deity.name。
           此前只查嵌套，于是 {deityName} 填不上、原样吐给玩家
           （「【神器】{deityName}之庇护·长枪」）。两种写法都认，不必为一个槽位改整张词表。 */
        const flat = host?.[slot] as unknown;
        if (Array.isArray(flat) && flat.length) return pick(flat as string[], next);
        const g = host?.[groupName] as Record<string, unknown> | undefined;
        const leaf = g?.[leafName];
        if (Array.isArray(leaf) && leaf.length) return pick(leaf as string[], next);
      }
      return '{' + slot + '}';
    }
    const words = slotTable(dim, slot, context);
    if (!words) return '{' + slot + '}';
    return pick(words, next);
  });
}

/** 六维通用生成：掷档 → 填模板 → 避雷校验（与人物名同一道防线） */
export function generateDimension(dim: DimKey, opts: DimOpts = {}): string {
  const rule = DIMS[dim];
  if (!rule) return '';
  const next = opts.rng ?? rng.next;
  /* 技能维度必须有「系」才能取词根（§117 按职业系命名）：
     没指定就随机挑一个——总比把 {mod}{noun} 原样吐出去强。 */
  if (dim === 'skill' && !opts.context) {
    const lines = Object.keys((TABLES.skill?.byLineage ?? {}) as Record<string, unknown>);
    if (lines.length) opts = { ...opts, context: pick(lines, next) };
  }
  const tier = opts.tier ?? rollTier(next);
  const patterns = rule.tierPatterns?.[tier]?.length ? rule.tierPatterns[tier] : rule.patterns;
  /* 卡 G2：填不满的模板**不能吐给玩家**——接进生产时捞出过带 {deityName} 的半成品。
     与避雷校验并列再加一道：残留占位符的候选直接作废、换个模板重试。
     开发期"原样保留便于一眼看出缺词表"的意图，改由 cardG1 的断言承担。 */
  for (let i = 0; i < LIMITS.nameAttempts; i++) {
    const out = fillDim(dim, pick(patterns, next), next, opts.context);
    if (!isBlocked(out) && !hasSlot(out)) return out;
  }
  /* 连兜底公式都填不满时，把残留的槽位抹掉——宁可名字短一点，也不给玩家看花括弧 */
  return fillDim(dim, rule.formula, next, opts.context).replace(PLACEHOLDER_RE, '');
}

/** 地区名（§106：大陆/城市/城镇/特殊地点） */
export const generatePlace = (opts: DimOpts = {}): string => generateDimension('place', opts);

/** 组织名（§107：政权/神殿/商业/地下/探索 + 分殿格式） */
export const generateOrg = (opts: DimOpts = {}): string => generateDimension('org', opts);

/** 装备与道具（§114：材质+武器名 / 特征+武器名 / 神名+权能+武器） */
export const generateItem = (opts: DimOpts = {}): string => generateDimension('item', opts);

/**
 * 魔物名（§115：按等级段取不同公式，另可按大陆加前缀）。
 * 等级→段位：1-10 普通 / 11-30 精英 / 31-50 首领 / 51-80 灾难 / 81-100 神级。
 */
export function generateMonster(opts: DimOpts = {}): string {
  const lvl = opts.level ?? 1;
  const tier: NamingTier = lvl >= 81 ? 'legend' : lvl >= 51 ? 'legend' : lvl >= 31 ? 'rare' : lvl >= 11 ? 'rare' : 'common';
  const name = generateDimension('monster', { ...opts, tier });
  const pre = opts.context ? (TABLES.monster?.continentPrefix as Record<string, string>)?.[opts.context] : undefined;
  return pre ? pre + name : name;
}

/** 地下城层名（§116：按层数落在 10 段主题里取词） */
export function generateFloor(level: number, opts: DimOpts = {}): string {
  const bands = (TABLES.floor?.bands as { range: [number, number]; theme: string; words: string[] }[]) ?? [];
  const band = bands.find((b) => level >= b.range[0] && level <= b.range[1]) ?? bands[bands.length - 1];
  if (!band) return '第 ' + level + ' 层';
  const next = opts.rng ?? rng.next;
  return '第 ' + level + ' 层 · ' + pick(band.words, next);
}

/** 技能名与遗迹名（§117：技能按职业系；遗迹/秘境/试炼各有公式） */
export function generateSkillOrRelic(lineage: string, opts: DimOpts = {}): string {
  const next = opts.rng ?? rng.next;
  const by = (TABLES.skill?.byLineage as Record<string, { mod: string[]; noun: string[] }>)?.[lineage];
  if (by && by.mod.length && by.noun.length) return pick(by.mod, next) + pick(by.noun, next);
  return generateDimension('skill', opts);
}

/** 六维总览（供审计与面板显示"这套命名覆盖了哪几类"） */
export const namingDimensions = (): DimKey[] => Object.keys(DIMS) as DimKey[];

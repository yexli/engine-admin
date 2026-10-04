/* ============================================================
   卡 I5 · 文献图鉴（星枢藏书）
   —— 把 lore.json(121) + lore-person.json(109) 从"只喂 AI 的上下文"变成
      "玩家读得到、且能反向驱动玩法"的可收集物。
   —— 三条解锁途径：观察/搜索命中关键词 · 文献残卷（tome_*）· 与 NPC 深谈。
   —— 咬合：unlocked 是 I2 配方 needCodex 的门；分类与文案全部来自 data 层。
   ============================================================ */
import { LORE, PERSON_LORE, type LoreCard } from '@/data/lore';
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { toast } from '@/events/EventBus';
import { log, removeItem } from '@/systems/character/Gains';
import { studyTome } from '@/systems/character/Learn';
import { openSheet } from '@/systems/character/Sheet';
import { need } from '@/world/WorldState';
import { dayOfTick } from '@/world/WorldClock';
import { addHistory } from '@/events/EventStore';

/** 分类轴（UI tab 顺序即此序） */
export const CODEX_CATS = ['位面', '历史', '势力', '地理', '星渊', '技艺', '人物', '典籍'];
/** 分类规则：按序命中（数据无 cat 字段，规则即 canon 主题的词面映射，零逻辑判定） */
const CAT_RULES: [string, RegExp][] = [
  ['星渊', /星渊|星枢|星海|魔气|虚空|深渊|封印|神罚/],
  ['位面', /位面|天界|神界|人间|魔界|世界|创世|法则|元素|成神|神职/],
  ['技艺', /职业|技能|魔法|锻造|炼金|铭刻|装备|道具|命名|学院|终极|技艺|生产|信仰职业|分支/],
  ['势力', /帝国|神殿|公会|议会|势力|家族|组织|法律|军|王朝|政治|贵族|神殿派|皇权/],
  ['地理', /大陆|地理|地标|城|区域|路线|气候|季节|地形|村镇|海域|浮岛/],
  ['历史', /历法|纪元|时间|节日|庆典|纪年|年代|史/],
];
/** 观察解锁：每地点每日上限（方案 gate 旋钮：1–5） */
export const OBS_CAP = 2;

/* ---------------- 只读 ---------------- */

/** 全量藏书（person 走懒加载：未载入时只统计 setting，UI 打开时通常已就位） */
export const allLore = (): LoreCard[] => [...LORE, ...PERSON_LORE];
export const loreById = (id: string): LoreCard | undefined => allLore().find((c) => c.id === id);

export function catOf(c: LoreCard): string {
  if (c.kind === 'person') return '人物';
  for (const [cat, re] of CAT_RULES) if (re.test(c.topic)) return cat;
  return '典籍';
}

function ensureCodex(s: WorldState): NonNullable<WorldState['codex']> {
  if (!s.codex) s.codex = { unlocked: [], found: {} };
  if (!Array.isArray(s.codex.unlocked)) s.codex.unlocked = [];
  if (!s.codex.found) s.codex.found = {};
  return s.codex;
}

export const codexUnlocked = (id: string, s: WorldState = need()): boolean => (s.codex?.unlocked || []).includes(id);

/** 关键词反查（core 自持，不依赖 ai 层——分层方向 core ← ai 不可逆） */
export function matchByText(text: string, limit = 5): LoreCard[] {
  const hay = (text || '').trim();
  if (!hay) return [];
  return allLore()
    .map((c) => ({ c, s: (c.keywords || []).reduce((a, kw) => (kw && hay.includes(kw) ? a + (kw.length >= 2 ? 2 : 1) : a), 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.c.num - b.c.num)
    .slice(0, limit)
    .map((x) => x.c);
}

export interface CodexStat {
  total: number;
  unlocked: number;
  pct: number;
}
export function codexStats(s: WorldState = need()): CodexStat {
  const total = allLore().length;
  const unlocked = (s.codex?.unlocked || []).filter((id) => !!loreById(id)).length;
  return { total, unlocked, pct: total ? unlocked / total : 0 };
}

/** 文献掉落权重（方案：<30% ×0.6，>80% ×1.5，其余 ×1——近满时保底加速） */
export function tomeWeight(s: WorldState = need()): number {
  const st = codexStats(s);
  if (st.pct < 0.3) return 0.6;
  if (st.pct > 0.8) return 1.5;
  return 1;
}

/* ---------------- 写入口（唯一） ---------------- */

/** 解锁（幂等：同 id 不重复发奖、不重复记历史） */
export function tryUnlock(loreId: string, how: string, s: WorldState = need()): boolean {
  const c = loreById(loreId);
  if (!c) return false;
  const cx = ensureCodex(s);
  if (cx.unlocked.includes(loreId)) return false;
  cx.unlocked.push(loreId);
  cx.found[loreId] = (cx.found[loreId] || 0) + 1;
  toast('✦ 图鉴解锁：' + c.name, 'gain');
  log('（星枢藏书新增一页：《' + c.name + '》——' + how + '）', 'gain', s);
  addHistory('图鉴解锁：' + c.name, how, 1);
  return true;
}

/** 观察/搜索：命中关键词即解锁；每地点每日限 OBS_CAP 条（防一站刷满） */
export function observeUnlock(text: string, loc: string, s: WorldState = need()): number {
  const cx = ensureCodex(s);
  const day = dayOfTick(s.t) - 1;
  if (!cx.obsDay || cx.obsDay.day !== day || cx.obsDay.loc !== loc) cx.obsDay = { day, loc, n: 0 };
  if (cx.obsDay.n >= OBS_CAP) return 0;
  let n = 0;
  for (const c of matchByText(text, 4)) {
    if (cx.obsDay.n >= OBS_CAP) break;
    if (cx.unlocked.includes(c.id)) continue;
    if (tryUnlock(c.id, '观察所得', s)) {
      cx.obsDay.n++;
      n++;
    }
  }
  return n;
}

/** 与 NPC 深谈：解锁其人物条目（幂等；未相识/无对应 canon 则静默返回 false） */
export function deepTalkUnlock(npcId: string, s: WorldState = need()): boolean {
  const n = WB.npcs[npcId];
  if (!n) return false;
  const hit = PERSON_LORE.find((c) => c.name === n.name) || PERSON_LORE.find((c) => (c.keywords || []).includes(n.name));
  if (!hit) return false;
  return tryUnlock(hit.id, '与' + n.name + '深谈所得', s);
}

/** 研读文献残卷：解锁该类目下序号最小的一条未读（确定性，不掷随机） */
export function readTome(iid: string, s: WorldState = need()): boolean {
  const it = WB.items[iid];
  if (!it?.codexCat) return false;
  const cx = ensureCodex(s);
  const pool = allLore()
    .filter((c) => catOf(c) === it.codexCat && !cx.unlocked.includes(c.id))
    .sort((a, b) => a.num - b.num);
  if (!pool.length) {
    toast('这一册你已经读尽了。', 'bad');
    return false;
  }
  const pickLore = pool[0];
  /* 卡 R3 · 技能书通道（世界书 §44「补充方式」）：五本残卷除解锁图鉴外，同时是技能书。
     授技放在 removeItem 之前——消耗品一旦离包，背包查询就落空了。 */
  const taught = studyTome(iid, s);
  removeItem(iid, 1);
  log('你翻开《' + it.name + '》，读到一页关于「' + pickLore.name + '」的文字。' + (taught ? '读至末页，某一式在你手里合上了。' : ''), 'nar', s);
  return tryUnlock(pickLore.id, '研读' + it.name, s);
}

/* ---------------- UI 契约（纯数据，React 不摸 core.S） ---------------- */

export interface CodexRow {
  id: string;
  num: number;
  name: string;
  topic: string;
  cat: string;
  unlocked: boolean;
  text: string; // 已解锁=正文；未解锁=空
  hint: string; // 未解锁=关键词线索
}
export interface CodexView {
  total: number;
  unlocked: number;
  pct: number;
  cats: { id: string; have: number; total: number }[];
  rows: CodexRow[];
}

export function codexView(cat = '', s: WorldState = need()): CodexView {
  const cx = ensureCodex(s);
  const all = allLore();
  const cats = CODEX_CATS.map((id) => {
    const list = all.filter((c) => catOf(c) === id);
    return { id, have: list.filter((c) => cx.unlocked.includes(c.id)).length, total: list.length };
  }).filter((x) => x.total > 0);
  const rows: CodexRow[] = all
    .filter((c) => !cat || catOf(c) === cat)
    .map((c) => {
      const on = cx.unlocked.includes(c.id);
      return {
        id: c.id,
        num: c.num,
        name: c.name,
        topic: c.topic,
        cat: catOf(c),
        unlocked: on,
        text: on ? c.canon || c.seed || '（残卷，字迹已不可辨）' : '',
        hint: (c.keywords || []).slice(0, 4).join('、') || '尚无线索',
      };
    })
    .sort((a, b) => a.num - b.num);
  const st = codexStats(s);
  return { total: st.total, unlocked: st.unlocked, pct: st.pct, cats, rows };
}

/** 打开图鉴浮层（UI 只提交命令，浮层内容由本模块的视图函数产出） */
export function codexMenu(cat = ''): void {
  openSheet({ kind: 'codex', cat });
}

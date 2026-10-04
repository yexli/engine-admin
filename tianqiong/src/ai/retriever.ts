/* ============================================================
   lore 检索层（AI 层 · 纯函数 · 只读）
   「叙事→AI」的取词器：按当前场景/在场 NPC/玩家输入命中文档化 canon，
   组装成有预算的上下文喂给 LLM（AI 须与之一致、只产文本、不改状态）。
   铁律：不引入 core/UI；结果确定性（无 rng、无副作用）。
   ============================================================ */
import { LORE, PERSON_LORE, type LoreCard } from '@/data/lore';

export interface LoreQuery {
  area?: string;
  locName?: string;
  npcNames?: string[];
  text?: string;
}
export interface LoreOpts {
  max?: number;
}

/** 关键词命中打分：命中越多越相关；≥2 字关键词权重更高 */
function score(c: LoreCard, hay: string): number {
  let s = 0;
  for (const kw of c.keywords) {
    if (kw && hay.includes(kw)) s += kw.length >= 2 ? 2 : 1;
  }
  return s;
}

/** 返回与查询最相关的 lore 卡（去重、稳定排序、按 max 截断）。 */
export function matchLore(q: LoreQuery, opts: LoreOpts = {}): LoreCard[] {
  const max = opts.max ?? 5;
  const hay = [q.area, q.locName, ...(q.npcNames || []), q.text].filter(Boolean).join(' ');
  if (!hay) return [];
  return [...LORE, ...PERSON_LORE]
    .map((c) => ({ c, s: score(c, hay) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.c.kind.localeCompare(b.c.kind) || a.c.num - b.c.num)
    .slice(0, max)
    .map((x) => x.c);
}

/** 一行式「主题：seed」，用于 rule-sim 上下文分层展示。 */
export function loreLines(cards: LoreCard[]): string[] {
  return cards.map((c) => c.name + '：' + c.seed);
}

/* ============================================================
   卡 R7 · 常驻准则层（constant 卡的**唯一**消费者）
   —— 37 张 constant 卡此前在代码里零消费：matchLore 是「地点/NPC 驱动」的关键词
   打分，背景规则类卡（§118–121 NPC 准则、§105 命名原则、§76 历法）永远匹配不上，
   等于整本规则书对 AI 从未可见。本层把它们作为**永远在场**的上下文注入。
   数据源用 seed（设计如此：seed = 一句事实级兜底），不塞 canon 长文——
   长文只留给「按场景检索」那条路，避免常驻层撑爆 prompt 预算。
   ============================================================ */

/** 常驻优先级：数小者先注入。只列「对引擎行为最关键」的条目，其余按 num 兜底排序。 */
const CONST_PRIORITY: Record<number, number> = {
  121: 0, 120: 1, 119: 2, 118: 3, // NPC 行为准则（独立性红线）
  105: 4, // 命名总原则
  76: 5, // 历法（时间口径）
  58: 6, 59: 7, // 货币
  29: 8, 30: 9, 31: 10, 44: 11, // 境界 / 分支 / 技能学习
  45: 12, 46: 13, 47: 14, // 地下城层级 / 魔物来源 / 魔物等级
  9: 15, 10: 16, 11: 17, 12: 18, 13: 19, // 星枢
  54: 20, 53: 21, // 道具等级 / 材料
  85: 22, 81: 23, // 传送阵 / 交通
  5: 24, 26: 25, 28: 26, // 大陆 / 十三族 / 力量双轴
  1: 27, 2: 28, 3: 29, 4: 30, 6: 31, 7: 32, 8: 33, // 位面 / 天界 / 神职 / 神选 / 魔界 / 小世界 / 神罚
  14: 34, 99: 35, 77: 36, // 势力分类 / 培养路径 / 纪元
};

/** 常驻卡（按优先级 → num 稳定排序；不改动原数组）。 */
export function canonicalCards(): LoreCard[] {
  return LORE.filter((c) => c.constant === true)
    .slice()
    .sort((a, b) => (CONST_PRIORITY[a.num] ?? 900 + a.num) - (CONST_PRIORITY[b.num] ?? 900 + b.num));
}

export interface PersistentCanon {
  /** 一行式「名称：seed」清单（供 rule-sim 上下文分层直出） */
  lines: string[];
  /** 拼好的块（供 LLM prompt 注入；空串 = 无可注入内容） */
  text: string;
  /** 实际注入几条（预算截断后的数量） */
  used: number;
}

/**
 * 生成常驻准则块。**预算独立**：不吃场景检索的 max/字符额度，
 * 否则「这一场景的 5 条设定」和「全书的规则」会互相挤占。
 */
export function persistentCanon(chars = 900): PersistentCanon {
  const out: string[] = [];
  let n = 0;
  for (const c of canonicalCards()) {
    const line = c.name + '：' + c.seed;
    if (n + line.length > chars) {
      /* 兜底：若连「优先级最高的一张」都放不下，硬塞它的前一段——
         否则预算一旦被调小（或某天 seed 变长），常驻层会**静默变空**，
         而「静默失效」比「截断内容」难查一百倍。 */
      if (!out.length && chars > 8) out.push(line.slice(0, chars - 2) + '…');
      break;
    }
    n += line.length;
    out.push(line);
  }
  const text = out.map((l) => '· ' + l).join(String.fromCharCode(10));
  return { lines: out, text: out.length ? text : '', used: out.length };
}

/** 组装给 LLM 的紧凑 canon 块（预算内），超出即截断。 */
export function loreCanonBlock(cards: LoreCard[], chars = 240): string {
  const out: string[] = [];
  let n = 0;
  for (const c of cards) {
    const line = '· ' + c.name + '：' + c.seed;
    if (n + line.length > chars) break;
    n += line.length;
    out.push(line);
  }
  return out.join('\n');
}

/* ============================================================
   关键词检索（《Memory Engine 记忆系统设计方案》§15）
   —— 中文没有词边界，用「整串命中 + 字符二元组重合率」做近似：
      既能让「王都」命中「三年前玩家在王都救过我」，
      也不会因为分词器缺失而漏召回。
   ============================================================ */

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** 关键词得分 0..1 */
export function keywordScore(content: string, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const text = content.toLowerCase();
  if (text.includes(needle)) return 1;
  /* 长查询才做二元组匹配：单字查询用二元组没有意义（长度不足） */
  if (needle.length < 2) return 0;
  const grams = bigrams(needle);
  let hit = 0;
  for (const g of grams) if (text.includes(g)) hit++;
  return hit / grams.length;
}

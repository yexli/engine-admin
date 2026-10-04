/* ============================================================
   向量相似度（《Memory Engine 记忆系统设计方案》§15/§16）
   —— 独立成模块：它是向量层的基础度量，被 VectorStore 使用；
      若留在 EmbeddingCache 里就会形成 EmbeddingCache → VectorStore → EmbeddingCache 的环。
   ============================================================ */

/** 余弦相似度（负相关截断为 0：方向相反的语义不该被当成「不相关」之外的信号） */
export function cosine(a: number[], b: number[]): number {
  /* 维度必须相等（审查 §向量空间）：此前取 Math.min 做前缀点积，两套不同维度的嵌入
     会算出一个落在 0..1 的「看起来合理」的相似度。入口处已按模型丢弃异空间向量，
     这里守住最后一道——宁可判 0（不相关），也不要一个可比较的假分数。 */
  if (a.length !== b.length || !a.length) return 0;
  const n = a.length;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? Math.max(0, dot / d) : 0;
}

/* ============================================================
   确定性采样（《NPC 规模化与事件通道方案》改进版 §11 / Phase 2）
   —— 把「按概率抽样」从随机流里摘出来：
     旧做法是 rng.chance(p)，问题有三：消耗主随机流（NPC 越多消耗越快）、
     依赖遍历顺序、且**改变 NPC 数量会改变其他系统的随机结果**。
     改用 hash(worldSeed + eventId + npcId + purpose) 后：
     零消耗、与顺序无关、可复现、不随规模漂移。
   ============================================================ */

/** FNV-1a 的 32 位变体：同一个串总是同一个无符号整数（跨平台稳定，不用 Math.random）
 *  导出给存储层复用：分片存档的「同代指纹」也是同一类需求（内容 → 稳定整数）。 */
export function hash32(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 把 32 位无符号整数映到 [0,1)：用作概率比较的左值 */
const unit = (h: number): number => h / 4294967296;

/**
 * 采样结果注入（**仅供测试**，与 rng.inject 同构）。
 * 确定性采样不给测试留后门的话，测试只能「依赖恰好命中」或「改断言」——
 * 前者会随实现漂移变成假绿，后者丢掉契约。返回还原函数。
 */
let _override: ((value: number) => boolean) | null = null;

export function injectSampling(fn: ((value: number) => boolean) | null): () => void {
  const prev = _override;
  _override = fn;
  return () => {
    _override = prev;
  };
}

/**
 * 要不要命中？
 * parts 的顺序即语义：同一组输入永远得到同一结论，与调用次数、遍历顺序、
 * 以及世界里有多少 NPC 都无关。
 * purpose 是刻意的第四个维度——同一事件对同一 NPC 的「目击」与「传闻扩散」
 * 必须是两次独立判定，否则两者会永远同真同假。
 */
export function sampleHit(worldSeed: number, eventId: string, npcId: string, purpose: string, probability: number): boolean {
  /* 参数错误要响亮：NaN 会落进 `v < NaN` 恒假，变成静默的「永不命中」（审查 I9）。
     概率来自显眼度表（常量），真出现非有限数说明调用方传错了。 */
  if (!Number.isFinite(probability)) {
    throw new Error('sampleHit 的概率必须是有限数，收到：' + String(probability));
  }
  /* JSON 编码而非裸 | 拼接：含分隔符的 id 不会与他人撞串（审查 I9） */
  const v = unit(hash32(JSON.stringify([worldSeed, eventId, npcId, purpose])));
  /* 注入点在边界短路**之前**：否则 injectSampling(() => false) 对「必中」的概率无效，
     测试没法构造「所有人都没察觉」（审查 I9）。 */
  if (_override) return _override(v);
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  return v < probability;
}

/** 供测试与调试：取出某次采样的原始 [0,1) 值 */
export function sampleValue(worldSeed: number, eventId: string, npcId: string, purpose: string): number {
  return unit(hash32(JSON.stringify([worldSeed, eventId, npcId, purpose])));
}

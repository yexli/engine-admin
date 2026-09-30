/* ============================================================
   可注入随机源（自宿主 EventBus 原样抽出，零行为偏差）
   默认 Math.random；测试可注入种子。一切随机必须经 rng，
   保证「同种子同世界同结果」可复现。
   ============================================================ */

let _next: () => number = Math.random;

export const rng = {
  /** 覆盖随机源（返回还原函数） */
  inject(fn: () => number) {
    const old = _next;
    _next = fn;
    return () => {
      _next = old;
    };
  },
  /** 线性同余种子源 */
  seed(s: number) {
    let x = s >>> 0;
    return rng.inject(() => {
      x = (x * 1664525 + 1013904223) >>> 0;
      return x / 4294967296;
    });
  },
  next: () => _next(),
  /** 1..n 整数 */
  d: (n: number) => 1 + Math.floor(_next() * n),
  /** a..b 闭区间整数 */
  R: (a: number, b: number) => a + Math.floor(_next() * (b - a + 1)),
  /**
   * 从数组里随机取一个。空数组是**调用方的错误**：当场抛，把现场留在调用点。
   * 可能为空的数组请用 pickOr 显式给兜底值。
   */
  pick<T>(a: readonly T[]): T {
    if (!a || !a.length) throw new Error('rng.pick 需要一个非空数组（可能为空的池子请用 rng.pickOr）');
    return a[Math.floor(_next() * a.length)];
  },
  /** 可能为空的池子：取不到就用兜底值，不抛 */
  pickOr<T>(a: readonly T[] | undefined | null, fallback: T): T {
    if (!a || !a.length) return fallback;
    return a[Math.floor(_next() * a.length)];
  },
  chance: (p: number) => _next() < p,
};

/** 数值夹取 */
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/* ============================================================
   货币（卡 B · §58 金属货币 100 进制）
   内部一律以「铜币」为最小基数单整数记账（不改 gold 语义），
   仅在展示层把整数降位成 铜/银/金/白金币。规则零依赖、纯函数。
   换算：1 白金币 = 100 金币 = 10000 银币 = 1000000 铜币
   ============================================================ */

export type MoneyUnit = 'copper' | 'silver' | 'gold' | 'plat';
export interface MoneyParts {
  plat: number;
  gold: number;
  silver: number;
  copper: number;
}

const DENOMS: [MoneyUnit, string, number][] = [
  ['plat', '白金币', 1000000],
  ['gold', '金币', 10000],
  ['silver', '银币', 100],
  ['copper', '铜币', 1],
];

/** 降位分解（自大到小，各档取余），供图标组件渲染。 */
export function moneyParts(copper: number): MoneyParts {
  let n = Math.max(0, Math.floor(copper));
  const out: MoneyParts = { plat: 0, gold: 0, silver: 0, copper: 0 };
  for (const [key, , val] of DENOMS) {
    const q = Math.floor(n / val);
    out[key] = q;
    n -= q * val;
  }
  return out;
}

/** 文本降级展示（toast/日志/存档导出用）：满单位「8 银币 28 铜币」，至少显示铜币。 */
export function formatMoney(copper: number): string {
  const p = moneyParts(copper);
  if (p.plat + p.gold + p.silver + p.copper === 0) return '0 铜币';
  const bits: string[] = [];
  for (const [key, label] of DENOMS) if (p[key] > 0) bits.push(p[key] + ' ' + label);
  return bits.join(' ');
}

/** 二级货币计数；0 则空串。 */
export function formatWallet(crystal: number, label: string): string {
  return crystal > 0 ? crystal + ' ' + label : '';
}

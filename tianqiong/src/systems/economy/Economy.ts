/* ============================================================
   卡 D6 · NPC 经济行为 + 动态物价
   《项目方案》§28 经济系统 / §29 NPC 经济行为（"商人不是无限金币 NPC"）
   - 物价 = 基准价 × 品类指数(受世界事件驱动) × 地区修正 × 品质倍率
   - 商店收购本金有限：玩家卖出从 vendor 钱袋扣，钱不够即拒收/减价
   - 每日向基准均值回归（econRevert），使事件造成的涨价会随时间回落
   纯 core：读 data，写 WorldState。
   ============================================================ */
import { WB } from '@/data/worldBook';
import econ from '@/data/world/economy.json';
import type { WorldState } from '@/types/world';
import { clamp } from '@/events/EventBus';
import { need } from '@/world/WorldState';

const ITEM_INDEX = econ.itemIndex as unknown as Record<string, string>;
const INDEX_DEFAULT = econ.indexDefault as unknown as Record<string, number>;
const REGION = econ.region as unknown as Record<string, number>;
const QUALITY = econ.qualityMult as unknown as Record<string, number>;
const REVERSION = econ.reversion as number;
const VENDOR_SEED = econ.vendors as unknown as Record<string, { coin: number; income: number }>;

/** 初始化商店收购本金（newState/hydrate 调用；幂等） */
export function initVendors(s: WorldState): void {
  if (s.vendors) return;
  s.vendors = {};
  for (const shopId in VENDOR_SEED) s.vendors[shopId] = VENDOR_SEED[shopId].coin;
}

/** 商品 → 品类索引键（价格指数按品类波动；订阅侧据此做供需反应） */
export const indexKeyOf = (iid: string): string | undefined => ITEM_INDEX[iid];

/** 综合买价（铜）：基准 × 品类指数 × 地区修正 × 品质倍率 */
export function priceOf(iid: string, loc: string, s: WorldState = need()): number {
  const it = WB.items[iid];
  if (!it) return 0;
  const idx = ITEM_INDEX[iid];
  const idxMult = idx ? s.econ[idx] ?? INDEX_DEFAULT[idx] ?? 1 : 1;
  const regMult = REGION[loc] ?? 1;
  const qMult = it.quality ? QUALITY[it.quality] ?? 1 : 1;
  return Math.max(1, Math.round(it.price * idxMult * regMult * qMult));
}

/** 每日向基准均值回归（事件涨价随时间回落）；由 time.newDay 调用 */
export function econRevert(s: WorldState = need()): void {
  for (const k in INDEX_DEFAULT) {
    const base = INDEX_DEFAULT[k];
    const cur = s.econ[k] ?? base;
    s.econ[k] = Math.round((cur + (base - cur) * REVERSION) * 100) / 100;
  }
}

/** vendor 当前钱袋（铜） */
export const vendorCoin = (shopId: string, s: WorldState = need()): number => s.vendors?.[shopId] ?? 0;

/** 玩家卖出：vendor 付钱（钱袋扣减）；钱不够返回 false */
export function vendorPays(shopId: string, amount: number, s: WorldState = need()): boolean {
  initVendors(s);
  const coin = s.vendors![shopId] ?? 0;
  if (coin < amount) return false;
  s.vendors![shopId] = coin - amount;
  return true;
}

/** 玩家买入：货款进 vendor 钱袋（商人赚到了钱 → 收购力增长） */
export function vendorEarns(shopId: string, amount: number, s: WorldState = need()): void {
  initVendors(s);
  s.vendors![shopId] = clamp((s.vendors![shopId] ?? 0) + amount, 0, 1_000_000);
}

/** 每日收入补给（商人营生）；由 time.newDay 调用 */
export function vendorIncome(s: WorldState = need()): void {
  initVendors(s);
  for (const shopId in VENDOR_SEED) {
    s.vendors![shopId] = clamp((s.vendors![shopId] ?? 0) + VENDOR_SEED[shopId].income, 0, 1_000_000);
  }
}

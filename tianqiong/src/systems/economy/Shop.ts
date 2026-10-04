/* ============================================================
   商店与经济（原型 §商店：openShop/buy/sell —— 药价随世界事件浮动）
   ============================================================ */
import { WB } from '@/data/worldBook';
import type { ItemDef, WorldState } from '@/types/world';
import { bus, toast, worldBus } from '@/events/EventBus';
import { makeEvent } from '@/events/EventSchema';
import { sceneTime } from '@/world/WorldClock';
import { tradeBuyMod, tradeSellMod } from '@/systems/faction/Diplomacy';
import { adjRepAxis } from '@/systems/faction/Factions';
import { grudgeOf } from '@/systems/relationship/Bond';
import { addItem, gainGold, itemCount, log, removeItem } from '@/systems/character/Gains';
import { instName, instPrice, removeInstance } from '@/systems/inventory/Equip';
import { fameDiscount } from '@/systems/reputation/Title';
import { priceOf, vendorEarns, vendorPays } from '@/systems/economy/Economy';
import { core, need, save, sync } from '@/world/WorldState';
import { formatMoney } from '@/systems/economy/Money';
import { addHistory } from '@/events/EventStore';

/** §12/§34：大额交易门槛（铜）。低于此数只算局部账目，不上世界总线。 */
const TRADE_ALERT = 1000;

/** 大额交易是跨系统事实——商会 / 势力 / 治安都可能响应（§12 Level 2） */
function traceTrade(s: WorldState, kind: 'buy' | 'sell', item: string, amount: number): void {
  if (amount < TRADE_ALERT) return;
  worldBus.emit(
    makeEvent({
      type: 'large_trade',
      day: sceneTime(s).day,
      tick: s.t,
      actor: 'player',
      target: item,
      location: s.player.loc,
      cause: kind === 'buy' ? '大额购入' : '大额售出',
      data: { kind, item, amount },
    }),
  );
}

export interface ShopRow {
  iid: string;
  price: number;
  base: number;
  item: ItemDef;
  affordable: boolean;
}
export interface SellRow {
  iid: string;
  qty: number;
  price: number;
  item: ItemDef;
  /* —— 卡 I1：实例装备回收行（uid 存在即为实例；name=实例名，q=品质档供 UI 着色） —— */
  uid?: string;
  name?: string;
  q?: number;
}

/** 买入价（卡 D6 动态定价 × 卡 F 通商折扣 × 卡 11 仇怨加价：店主记你的仇，价加 25%） */
export function buyPrice(shopId: string, iid: string): number {
  const s = need();
  const sh = WB.shops[shopId];
  const f = sh?.faction;
  let p = priceOf(iid, s.player.loc, s);
  if (f) p = Math.max(1, Math.round(p * tradeBuyMod(f, s)));
  const v = sh?.vendor;
  if (v && grudgeOf(v, s)) p = Math.max(1, Math.round(p * 1.25));
  /* 卡 I6：名望折让（主称号 tier ≥ 3 → ×0.97；卖价不变，防刷） */
  return Math.max(1, Math.round(p * fameDiscount(s)));
}

export function shopRows(shopId: string): ShopRow[] {
  const s = need();
  const sh = WB.shops[shopId];
  const stock = [...sh.stock];
  // 卡 F 下游：满足同盟旗标才上架的独家货（如暗影自己人 → 虚空精华）
  if (sh.allyStock && s.player.flags[sh.allyStock.needFlag]) stock.push(...sh.allyStock.items);
  return stock.map((iid) => {
    const p = buyPrice(shopId, iid);
    return { iid, price: p, base: WB.items[iid].price, item: WB.items[iid], affordable: s.player.gold >= p };
  });
}

/** 收购行：背包中可卖素材（卡 F：通商越深，收购价越高） */
export function sellRows(shopId: string): SellRow[] {
  const s = need();
  const sh = WB.shops[shopId];
  const mod = sh.faction ? tradeSellMod(sh.faction, s) : 1;
  const rows: SellRow[] = s.player.bag
    .filter((x) => !x.uid && WB.items[x.id].type === 'mat' && WB.items[x.id].price > 0)
    .map((x) => ({
      iid: x.id,
      qty: x.qty,
      price: Math.max(1, Math.floor(WB.items[x.id].price * sh.sell * mod)),
      item: WB.items[x.id],
    }));
  /* 卡 I1：实例装备可按「实例价」回收；无 uid 的普通装备维持不收的既有契约（回归护栏） */
  for (const x of s.player.bag) {
    if (!x.uid) continue;
    const it = WB.items[x.id];
    if (!it || (it.type !== 'wpn' && it.type !== 'arm')) continue;
    rows.push({
      iid: x.id,
      qty: 1,
      uid: x.uid,
      name: instName(x),
      q: x.q || 0,
      price: Math.max(1, Math.floor(instPrice(x, s) * sh.sell * mod)),
      item: it,
    });
  }
  return rows;
}

export function openShop(shopId: string) {
  core.curShop = shopId;
  bus.emit({ type: 'sheet', desc: { kind: 'shop', shopId } });
}

/** 购买。第二参数为兼容既有调用保留，但**不再采信**——价格与上架状态一律由 core 重算。 */
export function buy(iid: string, _p?: number) {
  const s = need();
  const shop = core.curShop || 'grocer';
  const sh = WB.shops[shop];
  const item = WB.items[iid];
  if (!sh || !item) {
    toast('没有这件货。', 'bad');
    return;
  }
  /* F-10：不在架上（含未满足 allyStock.needFlag 的独家货）一律拒绝 */
  const row = shopRows(shop).find((x) => x.iid === iid);
  if (!row) {
    toast('「' + item.name + '」不在' + sh.name + '的货架上。', 'bad');
    return;
  }
  /* 卡 11：店主与你结下深仇（sev3）→ 拒售 */
  const v = sh.vendor;
  if (v) {
    const g = grudgeOf(v, s);
    if (g && g.sev >= 3) {
      toast('✖ ' + WB.npcs[v].name + '认出了你——「本店不欢迎你。」', 'bad');
      return;
    }
  }
  const p = row.price;
  if (s.player.gold < p) {
    toast('钱不够（需 ' + formatMoney(p) + '）。', 'bad');
    return;
  }
  gainGold(-p);
  addItem(iid);
  vendorEarns(shop, p, s); // 商人赚到钱，收购力增长
  const f = sh.faction;
  if (f) adjRepAxis(f, 'trade', 2, s); // 卡 F：交易累积通商
  if (item.illegal) {
    addHistory('购入违禁品', item.name, 1);
    log('交易无声完成。你把 ' + item.name + ' 藏进行囊最深处。', 'sys');
  }
  traceTrade(s, 'buy', iid, p);
  openShop(shop);
  save();
  sync();
}

export function sell(iid: string, uid?: string) {
  const s = need();
  const shop = core.curShop || 'grocer';
  const sh = WB.shops[shop];
  const it = WB.items[iid];
  /* 卡 I1：实例装备按 uid 精确回收（价 = 实例价 × 商店收购率 × 通商修正） */
  if (uid) {
    const slot = s.player.bag.find((x) => x.uid === uid && x.id === iid);
    if (!sh || !it || !slot) {
      toast('这件东西商家不收。', 'bad');
      return;
    }
    const umod = sh.faction ? tradeSellMod(sh.faction, s) : 1;
    const up = Math.max(1, Math.floor(instPrice(slot, s) * sh.sell * umod));
    if (!vendorPays(shop, up, s)) {
      toast(sh.name + '的钱袋不够了，暂时收不了这件货。', 'bad');
      return;
    }
    removeInstance(uid, s);
    gainGold(up);
    if (sh.faction) adjRepAxis(sh.faction, 'trade', 1, s);
    log('你以 ' + formatMoney(up) + '卖出' + instName(slot) + '。', 'sys');
    traceTrade(s, 'sell', iid, up);
    openShop(shop);
    save();
    sync();
    return;
  }
  /* F-10：只收可售素材（type='mat' 且价 > 0），商店必须存在——不信任调用方给的 id */
  if (!sh || !it || it.type !== 'mat' || it.price <= 0) {
    toast('这件东西商家不收。', 'bad');
    return;
  }
  /* 事务顺序（审查 §交易）：先确认**货真的在行囊里**，再扣商人的钱袋。
     原实现先 vendorPays（钱已扣）再 removeItem，而 removeItem 在货不在时返回 false——
     那一刻商人的钱单向蒸发、玩家也没拿到钱。uid 分支的顺序本来就是对的，这里与它对齐。 */
  if (itemCount(iid, s) <= 0) {
    toast('行囊里已经没有这件货了。', 'bad');
    return;
  }
  const mod = sh.faction ? tradeSellMod(sh.faction, s) : 1;
  const p = Math.max(1, Math.floor(it.price * sh.sell * mod));
  if (!vendorPays(shop, p, s)) {
    // 商人钱袋不足：拒收（"商人不是无限金币 NPC"）
    toast(sh.name + '的钱袋不够了，暂时收不了这件货。', 'bad');
    return;
  }
  if (removeItem(iid)) {
    gainGold(p);
    if (sh.faction) adjRepAxis(sh.faction, 'trade', 1, s); // 卡 F：卖出也累积通商
    log('你以 ' + formatMoney(p) + '卖出 ' + it.name + '。', 'sys');
    traceTrade(s, 'sell', iid, p);
  }
  openShop(shop);
  save();
  sync();
}

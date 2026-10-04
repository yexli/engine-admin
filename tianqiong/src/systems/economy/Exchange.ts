/* ============================================================
   卡 N1 · 星枢兑换所
   ------------------------------------------------------------
   世界书 §10 的原话是「星币 / 星晶只进不出，不可兑现实铜」。那条规则要防的是
   「在网内刷币、就地变现」——本模块**不改网内**：StarNet.cashOut 依旧拒绝。
   地面上另开一扇窗：每个大陆一家兑换所，落在该大陆的枢纽。

   三个刻意的设计：
   1. **一大陆一家**。兑换所跟着大陆走（大陆在本作里是机制实体），
      于是「把网里的钱落地」变成一件要跑路的事，而不是任何一座城都有的窗口。
      这也是 1:1 汇率之下唯一的摩擦：钱不缩水，但要跑腿。
   2. **1 星币 = 1 银币 = 100 铜**（YG 裁决）。买卖同价，与网内寄售的定价
      （starhub.consignPerCopper = 100）严格一致——星币不是第二套货币，
      它就是银币在网内的形态。
      **这条裁决放开了原先的价差防线**：寄售的折算率是市价的 100%，
      而商店回收只有 40–55%，于是「入网寄售」会比「就地卖店」更划算。
      这是设计后果不是缺陷——想要星枢网值得跑一趟，这就是代价；
      若要收窄，该动的是 starhub 的 consignPerCopper，而不是这里的牌价。
   3. **星晶按 §11 既有汇率**（1 星晶 = 30 星币），只走「星晶 → 星币」这一向，
      与网内那条一致，不多开一条口子。

   为什么不做自由数量输入：兑换是低频动作，三档（全兑 / 100 / 星晶全兑）
   覆盖了全部意图，而输入框会把一次点击变成一次填表。
   ============================================================ */
import exch from '@/data/world/exchange.json';
import type { NetState, WorldState } from '@/types/world';
import { WB } from '@/data/worldBook';
import { toast } from '@/events/EventBus';
import { gainGold, log } from '@/systems/character/Gains';
import { formatMoney } from '@/systems/economy/Money';
import { confirmSheet } from '@/systems/character/Sheet';
import { need, sync } from '@/world/WorldState';

export interface ExchangeHouse {
  id: string;
  loc: string;
  continent: string;
  name: string;
  keeper: string;
  flavor: string;
}
interface Rates {
  starcoinSell: number;
  starcoinBuy: number;
  crystalToStarcoin: number;
}

const HOUSES = exch.houses as unknown as ExchangeHouse[];
const RATES = exch.rates as unknown as Rates;

/** 全部兑换所（七大陆各一家；数据完整性用例逐条核过） */
export const exchangeHouses = (): ExchangeHouse[] => HOUSES.slice();
/** 所在地的兑换所（没有就是不在这块大陆的枢纽上） */
export const houseAt = (loc: string): ExchangeHouse | undefined => HOUSES.find((h) => h.loc === loc);
/** 当前地点的兑换所 */
export const houseHere = (s: WorldState = need()): ExchangeHouse | undefined => houseAt(s.player.loc);
/** 牌价（卖出 / 买入 / 星晶兑星币） */
export const exchangeRates = (): Rates => ({ ...RATES });

/**
 * 网内账户（缺省建一个空的）。
 * 判定的口径是「有没有星币/星晶」，不是「有没有进过网」——
 * 出网之后 online 归 false，但账户要留着，否则这扇窗就无从兑换。
 */
function netOf(s: WorldState): NetState {
  if (!s.net) s.net = { online: false, starcoin: 0, starcrystal: 0, consign: [], duels: { won: 0, lost: 0 } };
  return s.net;
}

export interface ExchangeView {
  house: ExchangeHouse;
  locName: string;
  starcoin: number;
  starcrystal: number;
  gold: number;
  /** 把手上星币全卖掉能到手多少铜 */
  sellQuote: number;
  /** 买 100 星币要付多少铜 */
  buyCost: number;
}

export function exchangeView(house: ExchangeHouse, s: WorldState = need()): ExchangeView {
  const n = netOf(s);
  return {
    house,
    locName: WB.locations[house.loc]?.name ?? house.loc,
    starcoin: n.starcoin,
    starcrystal: n.starcrystal,
    gold: s.player.gold,
    sellQuote: Math.floor(n.starcoin * RATES.starcoinSell),
    buyCost: 100 * RATES.starcoinBuy,
  };
}

/** 兑换所菜单（行动坞入口）。顺手把「这里能不能兑」讲清楚，不留一个点了没反应的按钮。 */
export function exchangeMenu(): void {
  const s = need();
  const house = houseHere(s);
  if (!house) {
    toast('这一带没有星枢兑换所——七大陆各有且只有一家，都在枢纽上。', 'bad');
    return;
  }
  const v = exchangeView(house, s);
  const lines = [
    house.flavor,
    '',
    '牌价：1 星币 ⇄ ' + RATES.starcoinSell + ' / ' + RATES.starcoinBuy + ' 铜　·　1 星晶 → ' + RATES.crystalToStarcoin + ' 星币',
    '你持有：星币 ' + v.starcoin + '　星晶 ' + v.starcrystal + '　钱袋 ' + formatMoney(v.gold),
  ];
  const btns: { l: string; a: string; dg?: boolean }[] = [];
  if (v.starcoin > 0) btns.push({ l: '兑出全部星币（' + v.starcoin + ' → ' + formatMoney(v.sellQuote) + '）', a: 'exchange_sell' });
  if (v.starcrystal > 0) btns.push({ l: '星晶兑星币（' + v.starcrystal + ' → ' + v.starcrystal * RATES.crystalToStarcoin + ' 星币）', a: 'exchange_crystal' });
  if (v.gold >= v.buyCost) btns.push({ l: '买入 100 星币（付 ' + formatMoney(v.buyCost) + '）', a: 'exchange_buy' });
  btns.push({ l: '先不动', a: 'close' });
  if (btns.length === 1) {
    /* 既没钱又没币：给一句实话，而不是三个全灰的按钮 */
    toast('你还没有可以兑换的星币——星币要在星枢网里挣。', 'bad');
    return;
  }
  confirmSheet(house.name + ' · ' + v.locName, lines.join('<br>'), btns);
}

/** 兑出全部星币：网内所得落成铜。 */
export function sellStarcoin(s: WorldState = need()): boolean {
  const house = houseHere(s);
  if (!house) return false;
  const n = netOf(s);
  if (n.starcoin <= 0) {
    toast('没有星币可兑。', 'bad');
    return false;
  }
  const gain = Math.floor(n.starcoin * RATES.starcoinSell);
  const sold = n.starcoin;
  n.starcoin = 0;
  gainGold(gain);
  log('账房把 ' + sold + ' 枚星币倒进一只布袋，摇了摇——它听起来比看着轻。你入账 ' + formatMoney(gain) + '。', 'gain', s);
  sync();
  return true;
}

/** 买入星币：现实的钱换网内的币，价差十倍。 */
export function buyStarcoin(s: WorldState = need(), n = 100): boolean {
  const house = houseHere(s);
  if (!house) return false;
  const cost = n * RATES.starcoinBuy;
  if (s.player.gold < cost) {
    toast('铜钱不足（需 ' + formatMoney(cost) + '）。', 'bad');
    return false;
  }
  gainGold(-cost);
  netOf(s).starcoin += n;
  log('你把 ' + formatMoney(cost) + ' 推过柜台，换回 ' + n + ' 枚星币。账房没抬头：「网里的钱网里花，别指望它变多。」', 'nar', s);
  sync();
  return true;
}

/** 星晶 → 星币（§11 既有那一向，网内与地面同价）。 */
export function sellCrystal(s: WorldState = need()): boolean {
  const house = houseHere(s);
  if (!house) return false;
  const n = netOf(s);
  if (n.starcrystal <= 0) {
    toast('没有星晶可兑。', 'bad');
    return false;
  }
  const gain = n.starcrystal * RATES.crystalToStarcoin;
  const sold = n.starcrystal;
  n.starcrystal = 0;
  n.starcoin += gain;
  log(sold + ' 枚星晶在柜台上化成 ' + gain + ' 枚星币。账房说：「晶是给人看的，币才是给人花的。」', 'gain', s);
  sync();
  return true;
}

/* 卡 G3 反向审计：这个模块只留真实消费者。
   exchangeHouses / exchangeRates 留给数据完整性用例（一大陆一家、价差十倍），
   其余曾一度导出的便捷口子（exchangeHere / exchangeViewHere / exchangeReady）
   没有任何调用方——它们是「以后再接 UI 时会用到」的想象，已删除。 */

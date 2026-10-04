/* 星枢塔/规则/汇率 加载器（内容权威层 · 零逻辑）——规则判定在 core/starNet.ts */
import starhub from './world/starhub.json';

export interface StarTower {
  id: string;
  name: string;
  /** 所在 geo 地点（世界书 §9：一塔一城） */
  loc: string;
  /** 所在城市与大陆（展示用，判定走 loc） */
  city?: string;
  continent?: string;
  func: 'market' | 'duel' | 'insight' | 'trial' | 'arena' | 'council' | 'abyss';
  status: 'open' | 'planned' | 'locked';
  desc: string;
}
export interface NetRules {
  exitLockDays: number;
  banWantedMin: number;
  banFlags: string[];
  buyNoCashOut: boolean;
  onlineNoLifespanDrain: boolean;
}
export interface StarHub {
  towers: StarTower[];
  net_rules: NetRules;
  rates: { crystalToCoin: number; consignPerCopper: number; note: string };
  duel: { dc: number; winStarcrystal: number; costTicks: number };
  /* —— 卡 H1 · 七塔完全体规则（卡 0 数据驱动原则：加规则不改代码）—— */
  insight: { costTicks: number; nightmareChance: number; breakthroughAt: number; breakthroughExp: number };
  trial: { maxFloor: number; baseDc: number; dcPerFloor: number; starcrystalEvery: number; fallTicks: number; climbTicks: number };
  arena: { stakes: number[]; baseDc: number; dcPerStake: number };
  council: { decreeCost: number; talkTicks: number };
}

export const STARHUB = starhub as unknown as StarHub;

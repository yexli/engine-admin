/* ============================================================
   卡 H4 · 地下城 100 层数据加载器（内容权威层 · 零逻辑）
   —— 规则判定在 core/dungeon.ts；本文件只做 JSON → 类型固化。
   数据由 scripts/gen-dungeon.mjs 模板化生成（浅 20 手工 / 中 30 / 深 30 / 最深 19 / 深渊 1）。
   依据：《项目方案》§26 地下城 · §45 分层 · §46 魔物来源 · §62 冒险经济
   ============================================================ */
import raw from './world/dungeon.json';
import type { StatName } from '@/types/world';

/** 地下城陷阱（非魔物危害：走 check 判定，不产战斗） */
export interface DungeonTrap {
  id: string;
  name: string;
  stat: StatName;
  dcMod: number;
  dmgPct: number;
  seed: string;
  /**
   * 卡 N1 · 应对标签：玩家行囊里持有对应 utility 工具时，这道陷阱的 DC 下降。
   *
   * 为什么对应关系写在陷阱侧而不是道具侧写死「能防哪些陷阱」：同一条陷阱本来就有多种化解方式
   * （落石既能靠照明提前看见，也能靠绳索把自己固定住），写在这里才是单一真源；
   * 道具侧只需要声明「我是什么工具」，不必知道这世界有几种陷阱。
   */
  tags?: string[];
}
export interface DungeonBoss {
  mid: string; // 魔物 id（WB.monsters）
  name: string;
  /* F-41：层数化强度覆盖——只借魔物的形象/掉落，血量与 AC 随层数单调递增 */
  hp?: number;
  ac?: number;
  reward: { gold: [number, number]; item?: string };
}
export interface DungeonFloor {
  id: number; // 1–100
  name: string;
  theme: string; // themes 的 key
  monsters: string[]; // 魔物 id 池
  traps: string[]; // 陷阱 id 池
  loot: string[]; // 物品 id 池
  boss?: DungeonBoss;
  loreRef?: string; // 单向引用 lore 条目 id（§7.3 单一真源）
  seed: string; // 关 AI 兜底文本（不得含未替换槽位）
}
export interface DungeonTheme {
  id: string;
  name: string;
  range: [number, number];
  dcBase: number;
  tier: number; // 1–5 物价/掉落档
  corruption: 0 | 1; // 深层魔气侵蚀标记
  monsters: string[];
  traps: string[];
  loot: string[];
  desc: string;
}
export interface DungeonEntry {
  id: string;
  locId: string; // geo.json 地点 id（星渊入口在深井城的星枢六塔，卡 C2）
  name: string;
  startFloor: number; // 从第几层开始下潜
  unlockFloor: number; // 需要已抵达该层（best >= unlockFloor-1）才开启
  require?: string; // 形如 'flag.leak_3'
  desc: string;
}
export interface DungeonRules {
  retreatTicks: number;
  corruptionFrom: number;
  corruptionHpPct: number;
  corruptionFlag: string;
  bossEvery: number;
  encounter: { monster: number; trap: number; loot: number; npc: number; none: number };
  firstClear: { gold: [number, number]; exp: number };
  lootGold: Record<string, [number, number]>;
  abyssFloor: number;
  abyssChainFlag: string;
}
export interface DungeonData {
  version: number;
  loreRefs: string[];
  themes: Record<string, DungeonTheme>;
  traps: DungeonTrap[];
  floors: DungeonFloor[];
  entries: DungeonEntry[];
  rules: DungeonRules;
}

export const DUNGEON = raw as unknown as DungeonData;
export const MAX_FLOOR = 100;

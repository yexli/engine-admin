/* ============================================================
   实体 id → 玩家可读名（纯数据 · 零逻辑）
   ------------------------------------------------------------
   世界史 / 纪闻 / 赠礼偏好这些玩家可见的界面上，此前的渲染直接
   落出了内部 id（「player → brendan @market」「据说喜欢：pelt、gem」）。
   翻译收敛在这里：查得到就给中文名，查不到**原样返回**（不隐藏、
   不猜测）——漏登一条的表现是"显示英文"，而不是"显示错名字"。
   ============================================================ */
import { WB } from './worldBook';
import law from './world/law.json';

/** 罪名表（law.json crimes）：世界史里罪行会出现在 target 位（player → threat） */
const CRIMES = (law as { crimes: Record<string, { name: string }> }).crimes;

/**
 * id → 中文名。优先级：玩家 > NPC 名册 > 地点 > 罪名 > 原样。
 * playerName 由调用方给（面板侧取存档里的玩家名），缺省「玩家」。
 */
export function entityName(id: string, playerName = '玩家'): string {
  if (!id) return '';
  if (id === 'player') return playerName;
  return WB.npcs[id]?.name ?? WB.locations[id]?.name ?? CRIMES[id]?.name ?? id;
}

/** 地点 id → 中文名（WorldEvent 的 location 字段：plaza/market/tavern…） */
export function locLabel(id: string | undefined): string {
  if (!id) return '';
  return WB.locations[id]?.name ?? id;
}

/* —— 卡 11 · 赠礼偏好标签（items.json giftTag 值域，NPC likes 对齐）—— */
export const GIFT_TAG_LABELS: Record<string, string> = {
  food: '吃食',
  herb: '药草',
  trinket: '小饰件',
  relic: '古物',
  pelt: '毛皮',
  gem: '宝石',
  rare: '稀罕物',
};

/** giftTag → 中文；未登记的标签原样返回 */
export function giftTagLabel(tag: string): string {
  return GIFT_TAG_LABELS[tag] ?? tag;
}

/* —— 经济品类（economy.json itemIndex 的值域）—— */
export const CATE_LABELS: Record<string, string> = {
  food: '食粮',
  herb: '药材',
  forge: '铁器',
  book: '书卷',
  holy: '圣物',
  black: '黑市货',
};

/** 品类 id → 中文；未登记原样返回 */
export function cateLabel(k: string): string {
  return CATE_LABELS[k] ?? k;
}

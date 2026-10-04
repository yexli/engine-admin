/* ============================================================
   世界书加载器（内容权威层）
   JSON 是机器读取的事实源（《开发技术栈.md》§10），
   本模块只做：导入 → 类型固化 → 聚合导出 WB。
   禁止在此写任何游戏规则逻辑。
   ============================================================ */
import type {
  ClassDef,
  FactionId,
  ItemDef,
  LocationDef,
  MonsterDef,
  NpcDef,
  QuestDef,
  RaceDef,
  RankTiers,
  ShopDef,
  SkillDef,
  StatName,
  Weather,
  WorldBook,
} from '@/types/world';
import tables from './world/tables.json';
/* 卡 N1 · 道具扩展分表：200 件新道具走独立文件，不让 tables.json 继续膨胀。
   聚合顺序刻意是「tables 在前、扩展在后」——Object.keys(WB.items)[0] 被多处测试当基准取用，
   既有 49 件的相对次序必须逐位不动。 */
import itemsExt from './world/items.json';
/** 分表类型固化：JSON 模块只能推断出宽化的字面量类型，与 tables 的固化同规（加载器职责，非规则层） */
const ITEMS_EXT = itemsExt.items as unknown as Record<string, ItemDef>;
import continents from './world/continents.json';
import geo from './world/geo.json';
import people from './world/people.json';
import { NPC_ARCHIVE } from './npc';

export const WB: WorldBook = {
  months: tables.months,
  shichen: tables.shichen,
  periodOf: tables.periodOf,
  races: tables.races as unknown as Record<string, RaceDef>,
  classes: tables.classes as unknown as Record<string, ClassDef>,
  skills: tables.skills as unknown as Record<string, SkillDef>,
  items: { ...(tables.items as unknown as Record<string, ItemDef>), ...ITEMS_EXT },
  monsters: tables.monsters as unknown as Record<string, MonsterDef>,
  locations: geo.locations as unknown as Record<string, LocationDef>,
  travel: geo.travel as unknown as Record<string, Record<string, number>>,
  /* NPC 花名册 = 街头 15 人（people.json）+ 档案 109 人（data/npc 的文件夹树）。
     顺序刻意是「街头在前、档案在后」：Object.keys(WB.npcs) 是婚配候选、神选名册与
     位置索引重建的遍历基准，把档案人物append在后面，既有 15 人的相对次序不动。 */
  npcs: { ...(people.npcs as unknown as Record<string, NpcDef>), ...NPC_ARCHIVE },
  shops: people.shops as unknown as Record<string, ShopDef>,
  quests: people.quests as unknown as Record<string, QuestDef>,
  factions: tables.factions as unknown as Record<FactionId, string>,
  ranks: tables.ranks,
  /* 卡 R2：细分与别称都是可选数据（缺省时 rankSub 回落空串，不影响既有显示） */
  rankTiers: (tables as unknown as { rankTiers?: RankTiers }).rankTiers,
  rankAlias: (tables as unknown as { rankAlias?: Record<string, string[]> }).rankAlias,
  weatherText: tables.weatherText as unknown as Record<Weather, string[]>,
  /* 卡 J5 · 大陆定义：地图分组顺序与解锁条件都在数据里，
     UI 与引擎共用这一个来源（此前顺序硬编码在 MapPanel 的 CONTINENT_ORDER 里）。 */
  continents: continents as unknown as WorldBook['continents'],
  /* 卡 S1：地标与六星险区（世界书 §73/§75）——地图与旅行面板直读 */
  landmarks: (geo as unknown as { landmarks?: unknown[] }).landmarks as WorldBook['landmarks'],
  dangerZones: (geo as unknown as { dangerZones?: unknown[] }).dangerZones as WorldBook['dangerZones'],
};

/** 属性六维（展示顺序与原型一致） */
export const STAT_NAMES: StatName[] = ['力量', '体质', '敏捷', '智力', '感知', '魅力'];
/* F-40：MAP_SECTIONS 已删除——零引用，且只覆盖 11 个地点（geo 实为 17 个），
   留着会让后来者以为它是地图分组的权威来源。 */


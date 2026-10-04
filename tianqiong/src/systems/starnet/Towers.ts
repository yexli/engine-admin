/* ============================================================
   卡 C2 · 星枢塔的地理归属（世界书 §9「七塔架构」）
   一塔一城：一塔圣辉城 / 二塔翠风港 / 三塔金砂城 / 四塔霜锚堡 /
   五塔血吼城 / 六塔深井城 / 七塔天穹之城。
   —— 本模块只做「哪座塔在哪、你够不够得着」的地理判定，**不依赖星枢网运行时**。
   之所以独立成文件：StarNet 已经 import 了 dungeon/Abyss（魔气分级），
   若 Abyss 反过来 import StarNet 就成了真循环。塔的地理是纯数据+纯函数，
   放在这里两边共用，环自然解开。
   ============================================================ */
import { STARHUB, type StarTower } from '@/data/starhub';
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { need } from '@/world/WorldState';

type LocMeta = { area?: string; continent?: string };
const locMeta = (loc: string): LocMeta => ((WB.locations as Record<string, LocMeta>)[loc] ?? {}) as LocMeta;

/** 某座 geo 地点上的星枢塔（一塔一城） */
export const towerOf = (loc: string): StarTower | undefined => STARHUB.towers.find((t) => t.loc === loc);

/**
 * 你此刻所栖之塔。地点本身立着塔就直接用它；没有塔的地点（圣辉城的酒馆/集市/神殿、
 * 城外旷野、地下洞窟）回落到**同城**（geo.area）再**同大陆**（geo.continent）的塔——
 * 一塔一城的空间关系由地理数据决定，而不是另写一张对应表。
 * 圣辉城只有一塔，于是中央大陆诸地共栖一塔。
 */
export function towerHere(s: WorldState = need()): StarTower | undefined {
  const direct = towerOf(s.player.loc);
  if (direct) return direct;
  const L = locMeta(s.player.loc);
  const sameArea = STARHUB.towers.find((t) => !!L.area && locMeta(t.loc).area === L.area);
  if (sameArea) return sameArea;
  return STARHUB.towers.find((t) => !!L.continent && locMeta(t.loc).continent === L.continent);
}

/** 投影所栖之塔：本体定神何处，投影就落在该处之塔；实在无塔可依时归主塔（一塔） */
export const netTower = (s: WorldState = need()): StarTower | undefined =>
  towerHere(s) ?? STARHUB.towers.find((t) => t.id === 'star1');

/**
 * 现实侧门禁：人不在这座塔的城里就够不着它。
 * 下潜星渊、踏入星渊之门——凡要动到塔的**实体**的事，都走此判。
 */
export function towerLocalGate(func: StarTower['func'], s: WorldState = need()): string | null {
  const tower = STARHUB.towers.find((t) => t.func === func);
  if (!tower) return null;
  if (towerHere(s)?.id === tower.id) return null;
  return tower.name + '在' + (tower.city ?? '') + '（' + (tower.continent ?? '') + '）——你须亲身前往。';
}

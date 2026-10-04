/* ============================================================
   卡 F1 · 魔物图鉴（世界书 §46–§52）
   §46 五类来源 / §47 六档等级与推荐层数 / §48–§51 速查 / §52 食物链。
   —— 本模块只做**查询**：数据全在 data/world/tables.json，零硬编码。
   之所以单独成文件：地下城要按层段配怪、图鉴要给人看、
   生态链要能被叙事引用，三处都需要同一份查表；写在 Dungeon.ts 里会让那文件更肿。
   ============================================================ */
import tablesRaw from '@/data/world/tables.json';
import { WB } from '@/data/worldBook';
import { confirmSheet } from '@/systems/character/Sheet';

/** §46 来源分类 */
export interface MonsterSourceRow {
  name: string;
  def: string;
  typical: string[];
}
/** §47 等级对应 */
export interface MonsterTierRow {
  tier: number;
  name: string;
  rank: string;
  floors: string;
  floorFrom: number;
  floorTo: number;
  /** 仅在「每 N 层一次的节主房间」出现的档位（楼层主） */
  every?: number;
}
/** §52 食物链的一层 */
export interface EcoLevel {
  level: string;
  label: string;
  tier: string;
  members: string[];
  mids: string[];
}

const TABLES = tablesRaw as unknown as {
  monsterSources?: Record<string, MonsterSourceRow>;
  monsterTiers?: Record<string, MonsterTierRow>;
  monsterEcology?: { chain: EcoLevel[] };
};

/** 数据表里的 "_comment" 之类的下划线键不进查询结果 */
function rows<T>(o: Record<string, T> | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(o ?? {})) if (!k.startsWith('_')) out[k] = v;
  return out;
}

export const monsterSources = (): Record<string, MonsterSourceRow> => rows(TABLES.monsterSources);
export const monsterTiers = (): Record<string, MonsterTierRow> => rows(TABLES.monsterTiers);
export const monsterEcologyChain = (): EcoLevel[] => (TABLES.monsterEcology?.chain ?? []).slice();


export const monsterSource = (id: string): MonsterSourceRow | undefined => {
  const src = WB.monsters[id]?.source;
  return src ? monsterSources()[src] : undefined;
};
export const monsterTier = (id: string): MonsterTierRow | undefined => {
  const t = WB.monsters[id]?.tier;
  return t ? monsterTiers()[t] : undefined;
};

/** 全部魔物 id（按表内顺序） */
export const allMonsters = (): string[] => Object.keys(WB.monsters);

/** 某一来源下的魔物（§46） */
export const monstersBySource = (srcId: string): string[] => allMonsters().filter((m) => WB.monsters[m].source === srcId);

/** 某一档位的魔物（§47） */
export const monstersOfTier = (tierId: string): string[] => allMonsters().filter((m) => WB.monsters[m].tier === tierId);

/**
 * §47「推荐探索层数」反查：第 N 层应该碰上哪些档的魔物。
 * 楼层主（floorLord）带 every，只在每 N 层的节主房间出现——所以它与常规档**同时**成立，
 * 不是"或"的关系：第 10 层既是 6-20 的精英层，也是第 10 层的节主房间。
 * floor=0 表示地表。
 */
export function tiersForFloor(floor: number): MonsterTierRow[] {
  const out: MonsterTierRow[] = [];
  for (const t of Object.values(monsterTiers())) {
    if (t.every) {
      if (floor > 0 && floor % t.every === 0) out.push(t);
    } else if (floor >= t.floorFrom && floor <= t.floorTo) out.push(t);
  }
  return out;
}

/** 该层段推荐的魔物 id（按档位取，供配怪与提示） */
export function monstersForFloor(floor: number): string[] {
  const ids = new Set<string>();
  for (const [tid, t] of Object.entries(monsterTiers())) {
    const hit = t.every ? floor > 0 && floor % t.every === 0 : floor >= t.floorFrom && floor <= t.floorTo;
    if (hit) for (const m of monstersOfTier(tid)) ids.add(m);
  }
  return [...ids];
}

/** 图鉴条目（UI 与测试共用；纯数据，无副作用） */
export interface BestiaryRow {
  id: string;
  name: string;
  tier: string;
  tierName: string;
  rank: string;
  range: string;
  source: string;
  sourceName: string;
  loot: string[];
}

export function bestiary(): BestiaryRow[] {
  return allMonsters().map((id) => {
    const m = WB.monsters[id];
    const t = monsterTier(id);
    const s = monsterSource(id);
    return {
      id,
      name: m.name,
      tier: m.tier ?? '',
      tierName: t?.name ?? '',
      rank: t?.rank ?? '',
      range: m.tierRange ?? t?.floors ?? '',
      source: m.source ?? '',
      sourceName: s?.name ?? '',
      loot: (m.loot ?? []).map(([iid]) => WB.items[iid]?.name ?? iid),
    };
  });
}

/** 魔物图鉴面板（SysPanel 入口）：五类来源 × 各自的档位与层段 */
export function bestiaryPanel() {
  const groups = Object.entries(monsterSources()).map(([id, src]) => {
    const list = monstersBySource(id).map((m) => {
      const t = monsterTier(m);
      const range = WB.monsters[m].tierRange ?? t?.floors ?? '';
      return WB.monsters[m].name + '（' + (t?.name ?? '—') + '·' + range + '）';
    });
    return '<b>' + src.name + '</b>　' + src.def + '<br>' + (list.join('、') || '（尚未实体化）');
  });
  const chain = monsterEcologyChain()
    .map((c) => c.level + '：' + c.label + '——' + c.members.join('、'))
    .join('<br>');
  confirmSheet(
    '魔物图鉴 · 来源与生态',
    groups.join('<br><br>') + '<br><br><b>食物链</b>（§52）<br>' + chain,
    [{ l: '（合上）', a: 'close' }],
  );
}

/* ============================================================
   卡 F1 · 魔物图鉴（世界书 §46–§52）
   §46 五类来源 / §47 六档等级与推荐层数 / §48–§51 速查 / §52 食物链。
   本卡的护栏有三条：① 世界书点名的魔物与材料一个都不能少；
   ② 档位与强度单调（数据加东西时不许出现"普通比精英还强"）；
   ③ 深层不留地表生物（配怪时不许拿兔子凑数）。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { DUNGEON } from '@/data/dungeon';
import { WB } from '@/data/worldBook';
import { core } from '@/world/WorldState';
import { bus, rng, scheduler } from '@/events/EventBus';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { newGame } from '@/world/WorldRuntime';
import {
  allMonsters,
  bestiary,
  bestiaryPanel,
  monsterEcologyChain,
  monsterSource,
  monsterSources,
  monsterTier,
  monsterTiers,
  monstersBySource,
  monstersForFloor,
  monstersOfTier,
  tiersForFloor,
} from '@/systems/dungeon/Monsters';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(41);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: 'F1', race: 'human', cls: 'warrior' });
});

/* 世界书 §48–§51 逐条点名的魔物（13 条） */
const NAMED_MONSTERS = ['融合兽', '魔像', '古代守卫', '合成龙', '史莱姆', '哥布林', '地底巨虫', '水晶蜘蛛', '亡灵骑士', '怨灵术士', '深渊恶魔', '虚空行者', '魔界领主'];
/* 世界书 §48–§51 逐条点名的掉落材料（12 条） */
const NAMED_MATERIALS = ['融合核心', '魔像核心', '古代能量核心', '合成龙鳞', '史莱姆液', '巨虫皮', '水晶丝', '怨灵核心', '恶魔核心', '虚空碎片', '领主核心', '楼层核心'];
/* 地表生物：不该出现在深层 */
const SURFACE_ONLY = ['rabbit', 'wolf', 'bandit'];

const itemNames = () => new Set(Object.values(WB.items).map((i) => i.name));
const monsterNames = () => Object.values(WB.monsters).map((m) => m.name);

describe('卡 F1 · §46 五类来源', () => {
  it('五类齐备，每类都有定义与典型代表', () => {
    const srcs = monsterSources();
    expect(Object.keys(srcs).sort()).toEqual(['ancient', 'fallen', 'invader', 'mutant', 'native']);
    for (const [id, s] of Object.entries(srcs)) {
      expect(s.name, id).toBeTruthy();
      expect(s.def, id).toBeTruthy();
      expect(s.typical.length, id).toBeGreaterThan(0);
    }
  });

  it('世界节点名的五类归属逐条对上（古代造物/原生物种/堕落探险者/魔界入侵者/变异体）', () => {
    expect(monsterSources().ancient.name).toBe('古代造物');
    expect(monsterSources().native.name).toBe('地下原生物种');
    expect(monsterSources().fallen.name).toBe('堕落探险者');
    expect(monsterSources().invader.name).toBe('魔界入侵者');
    expect(monsterSources().mutant.name).toBe('变异体');
  });

  it('魔物用到的 source 全在表内，且每类都至少落着一个实体', () => {
    const ids = new Set(Object.keys(monsterSources()));
    for (const m of allMonsters()) {
      const s = WB.monsters[m].source;
      if (s) expect(ids.has(s), m + ' 的来源 ' + s).toBe(true);
    }
    for (const id of ids) expect(monstersBySource(id).length, id).toBeGreaterThan(0);
  });

  it('地表野兽与网内投影不硬塞来源——世界书的五类专指地下城魔物', () => {
    for (const m of SURFACE_ONLY) expect(WB.monsters[m].source, m).toBeUndefined();
    expect(WB.monsters.phantom.source).toBeUndefined();
  });
});

describe('卡 F1 · §47 六档等级与推荐层数', () => {
  it('六档齐备，档位号递增', () => {
    const tiers = monsterTiers();
    expect(Object.keys(tiers)).toEqual(['beast', 'common', 'elite', 'areaBoss', 'floorLord', 'guardian']);
    const nums = Object.values(tiers).map((t) => t.tier);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('档位名与境界对应对上世界书的表', () => {
    const t = monsterTiers();
    expect([t.beast.name, t.beast.rank, t.beast.floors]).toEqual(['无害野兽', '信徒级', '地表']);
    expect([t.common.name, t.common.rank, t.common.floors]).toEqual(['普通魔物', '见习级', '1-5 层']);
    expect([t.elite.name, t.elite.rank, t.elite.floors]).toEqual(['精英魔物', '正式级', '6-20 层']);
    expect([t.areaBoss.name, t.areaBoss.rank, t.areaBoss.floors]).toEqual(['区域BOSS', '主教级', '21-40 层']);
    expect(t.guardian.name).toBe('地下城守卫');
    expect(t.guardian.rank).toBe('神阶级');
    expect(t.floorLord.every, '楼层主是「每 N 层」的节主房间，不是某一段').toBe(10);
  });

  it('每个魔物都有档位，且档位 id 都在表内', () => {
    const ids = new Set(Object.keys(monsterTiers()));
    for (const m of allMonsters()) {
      const t = WB.monsters[m].tier;
      expect(t, m + ' 缺 tier').toBeTruthy();
      expect(ids.has(t!), m + ' 的档位 ' + t).toBe(true);
    }
  });

  it('推荐层数反查：地表只出无害野兽，第 10 层同时是精英层与节主房间', () => {
    expect(tiersForFloor(0).map((t) => t.name)).toEqual(['无害野兽']);
    const l10 = tiersForFloor(10).map((t) => t.name);
    expect(l10).toContain('精英魔物');
    expect(l10, '第 10 层是节主房间').toContain('楼层主（节主）');
    expect(tiersForFloor(11).map((t) => t.name)).toEqual(['精英魔物']);
    expect(tiersForFloor(80).map((t) => t.name)).toContain('地下城守卫');
    expect(monstersForFloor(0).length).toBeGreaterThan(0);
  });
});

describe('卡 F1 · §48–§51 速查：点名的魔物与材料一个都不能少', () => {
  it('13 条点名魔物全部实体化，名字逐条对得上', () => {
    const names = monsterNames();
    for (const n of NAMED_MONSTERS) {
      expect(names.some((x) => x.includes(n)), '缺魔物「' + n + '」').toBe(true);
    }
  });

  it('12 条点名材料全部实体化（魔物掉落不能指向不存在的东西）', () => {
    const names = itemNames();
    for (const n of NAMED_MATERIALS) expect(names.has(n), '缺材料「' + n + '」').toBe(true);
  });

  it('每个魔物的掉落都指向真实物品，且概率在 (0,1]', () => {
    for (const m of allMonsters()) {
      for (const [iid, p] of WB.monsters[m].loot) {
        expect(WB.items[iid], m + ' 掉落 ' + iid).toBeTruthy();
        expect(p, m + ' 掉落 ' + iid).toBeGreaterThan(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it('每种来源的代表魔物都有自己的材料出口（不是只会掉铜板的靶子）', () => {
    for (const src of ['ancient', 'native', 'fallen', 'invader']) {
      const withLoot = monstersBySource(src).filter((m) => WB.monsters[m].loot.length > 0);
      expect(withLoot.length, src + ' 下没有一个带掉落的魔物').toBeGreaterThan(0);
    }
  });
});

describe('卡 F1 · §52 食物链', () => {
  it('六层齐备，顺序取自原文（顶层→基础）', () => {
    const chain = monsterEcologyChain();
    expect(chain.length).toBe(6);
    expect(chain.map((c) => c.level)).toEqual(['顶层', '高层', '中层', '基层', '底层', '基础']);
    expect(chain[0].members).toContain('魔界大君');
    expect(chain[5].members).toContain('真菌');
  });

  it('链上每层都落着实体，且 mids 全部指向真实存在的魔物', () => {
    const ids = new Set(allMonsters());
    for (const c of monsterEcologyChain()) {
      expect(c.mids.length, c.label).toBeGreaterThan(0);
      for (const m of c.mids) expect(ids.has(m), c.label + ' 的 ' + m).toBe(true);
    }
  });
});

describe('卡 F1 · 平衡护栏（加数据时不许越线）', () => {
  it('档位与强度单调：档位越高，平均血量越高', () => {
    const avgHp = (tid: string) => {
      const list = monstersOfTier(tid).map((m) => WB.monsters[m].hp);
      return list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);
    };
    const order = ['beast', 'common', 'elite', 'areaBoss', 'floorLord', 'guardian'];
    for (let i = 1; i < order.length; i++) {
      expect(avgHp(order[i]), order[i - 1] + ' → ' + order[i]).toBeGreaterThan(avgHp(order[i - 1]));
    }
  });

  it('深层不留地表生物：81 层以上不该出现兔子、狼与荒野劫掠者', () => {
    for (const f of DUNGEON.floors) {
      if (f.id < 81) continue;
      for (const m of f.monsters) expect(SURFACE_ONLY.includes(m), 'L' + f.id + ' 混进了 ' + m).toBe(false);
    }
  });

  it('层池里的魔物全部存在于魔物表（配怪指向空 id 会让战斗当场崩）', () => {
    for (const f of DUNGEON.floors) {
      expect(f.monsters.length, 'L' + f.id).toBeGreaterThan(0);
      for (const m of f.monsters) expect(WB.monsters[m], 'L' + f.id + ' 的 ' + m).toBeTruthy();
      for (const x of f.loot) expect(WB.items[x], 'L' + f.id + ' 掉落 ' + x).toBeTruthy();
    }
  });

  it('楼层主掉落楼层核心（§50）：BOSS 层必有，普通层不必有', () => {
    for (const f of DUNGEON.floors) {
      if (f.boss) expect(f.loot, 'L' + f.id).toContain('floor_core');
    }
    expect(DUNGEON.floors.filter((f) => f.boss).length).toBe(10);
  });
});

describe('卡 F1 · 图鉴视图与面板', () => {
  it('bestiary 逐条给出档位/境界/层段/来源，且与数据同源', () => {
    const rows = bestiary();
    expect(rows.length).toBe(allMonsters().length);
    const golem = rows.find((r) => r.id === 'golem')!;
    expect(golem.name).toBe('魔像');
    expect(golem.tierName).toBe('普通魔物');
    expect(golem.sourceName).toBe('古代造物');
    expect(golem.range).toContain('见习级');
    expect(golem.loot).toContain('魔像核心');
  });

  it('档位查询与来源查询互为印证', () => {
    expect(monstersOfTier('guardian')).toEqual(['demon_lord']);
    expect(monsterTier('demon_lord')?.rank).toBe('神阶级');
    expect(monsterSource('demon_lord')?.name).toBe('魔界入侵者');
    expect(monsterSource('rabbit')).toBeUndefined();
    expect(monstersBySource('mutant').length).toBeGreaterThanOrEqual(2);
  });

  it('bestiaryPanel 能开（图鉴不是只给测试用的 API）', () => {
    expect(() => bestiaryPanel()).not.toThrow();
  });
});

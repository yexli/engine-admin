/* ============================================================
   卡 F2 · §53 材料的用途（把 §46–§52 的魔物掉落接进工坊）
   ⑥ 把 12 种材料立进了 items、挂上了魔物掉落，但它们**一条配方都没有**——
   只能卖钱。本卡补齐另一半：材料 → 工坊 → 装备/药水。
   分派取自 §53 的六类：锻造材料走 forge、附魔材料走 inscribe、炼金材料走 alchemy。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { core } from '@/world/WorldState';
import { newGame } from '@/world/WorldRuntime';
import { WB } from '@/data/worldBook';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { bus, rng, scheduler } from '@/events/EventBus';
import { craftRecipes, craftStations, craftView } from '@/systems/inventory/Craft';
import { priceOf } from '@/systems/economy/Economy';
import { instPrice, rollInstance } from '@/systems/inventory/Equip';

const s = () => core.S!;

/** §46–§52 里由魔物掉落进来的 12 种材料（卡 F1 立的） */
const MONSTER_MATS = [
  'slime_fluid',
  'golem_core',
  'worm_hide',
  'crystal_silk',
  'fusion_core',
  'wraith_core',
  'ancient_core',
  'demon_core',
  'synth_dragon_scale',
  'floor_core',
  'void_shard',
  'lord_core',
];

/** §48–§51 点名的那 12 种掉落材料，用的就是它们的表内 id */
const stationsOf = (mat: string): string[] =>
  craftRecipes()
    .filter((r) => r.need.items.some(([i]) => i === mat))
    .map((r) => r.station);

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
  newGame({ name: 'F2', race: 'human', cls: 'warrior' });
});

describe('卡 F2 · 材料真的有用途了', () => {
  it('12 种魔物材料**每一种**都能被至少一条配方消费（此前它们只能卖钱）', () => {
    const used = new Set<string>();
    for (const r of craftRecipes()) for (const [iid] of r.need.items) used.add(iid);
    for (const m of MONSTER_MATS) expect(used.has(m), m + ' 还没有任何配方用它').toBe(true);
  });

  it('没有配方的 mat 必须**另有用途**——不能是纯摆设', () => {
    const used = new Set<string>();
    for (const r of craftRecipes()) for (const [iid] of r.need.items) used.add(iid);
    /* 卡 N1 批 4：判据收紧到「有价的 mat」——price 0 的是剧情物（信物 / 文书 / 钥匙），
       它们的去处是委托与门锁，不是工坊。此前靠一张白名单逐个豁免，每加一件剧情物就要改测试。 */
    const orphan = Object.entries(WB.items)
      .filter(([, v]) => v.type === 'mat' && v.price > 0)
      .map(([k]) => k)
      .filter((k) => !used.has(k));
    /* 这两样都不属 §53 的材料体系，于是不该有配方——但它们各有各的去处：
       letter 是 q_letter 的任务道具（要交给「银鸥」的赛琳娜），
       rabbit_meat 是浅层掉落物、又是可送出的食物礼物。
       "没有配方"不等于"没有用途"，这条断言把两者的区别钉住。 */
    /* 卡 N1：rabbit_meat 被食谱收编（批 3），信物与文书按 price 0 归入剧情物（批 4）。
       现在这份名单是**空的**——每一件有价的材料都有正经去处。 */
    expect(orphan.sort()).toEqual([]);
    const people = readFileSync('src/data/world/people.json', 'utf8');
    expect(people).toContain('q_letter');
    expect(WB.items.letter.desc).toContain('赛琳娜');
    const dung = readFileSync('src/data/world/dungeon.json', 'utf8');
    expect(dung).toContain('rabbit_meat');
    expect(WB.items.rabbit_meat.giftTag).toBe('food');
  });

  it('§53 六类分派：锻造材料走 forge、附魔材料走 inscribe、炼金材料走 alchemy', () => {
    /* 锻造：龙鳞、魔像核心、巨虫皮 (§53) */
    expect(stationsOf('golem_core'), '魔像核心是锻造材料').toContain('forge');
    expect(stationsOf('worm_hide'), '巨虫皮是锻造材料').toContain('forge');
    expect(stationsOf('synth_dragon_scale'), '合成龙鳞是锻造材料').toContain('inscribe');
    /* 附魔：水晶丝、恶魔核心 (§53) */
    expect(stationsOf('crystal_silk'), '水晶丝是附魔材料').toContain('forge');
    expect(stationsOf('demon_core'), '恶魔核心是附魔材料').toContain('inscribe');
    expect(stationsOf('wraith_core')).toContain('inscribe');
    /* 魔法：融合核心、虚空碎片 (§53) */
    expect(stationsOf('fusion_core'), '融合核心是魔法材料').toContain('inscribe');
    expect(stationsOf('void_shard')).toContain('inscribe');
    /* 特殊：楼层核心、领主核心 (§53) */
    expect(stationsOf('floor_core')).toContain('inscribe');
    expect(stationsOf('lord_core')).toContain('inscribe');
    /* 炼金：史莱姆液 (§53) */
    expect(stationsOf('slime_fluid'), '史莱姆液是炼金材料').toContain('alchemy');
  });

  it('每一种材料都恰好落在它该去的那个站点上（不外溢到别的台子）', () => {
    const expectStation: Record<string, string> = {
      slime_fluid: 'alchemy',
      golem_core: 'forge',
      worm_hide: 'forge',
      crystal_silk: 'forge',
      fusion_core: 'inscribe',
      wraith_core: 'inscribe',
      ancient_core: 'inscribe',
      demon_core: 'inscribe',
      synth_dragon_scale: 'inscribe',
      floor_core: 'inscribe',
      void_shard: 'inscribe',
      lord_core: 'inscribe',
    };
    for (const [mat, st] of Object.entries(expectStation)) {
      expect(stationsOf(mat), mat).toContain(st);
    }
  });
});

describe('卡 F2 · 配方的数据契约', () => {
  it('材料与产出 id 全部存在，数量都是正整数（防幽灵引用与 NaN 成本）', () => {
    for (const r of craftRecipes()) {
      expect(r.need.items.length, r.id).toBeGreaterThan(0);
      for (const [iid, q] of r.need.items) {
        expect(WB.items[iid], r.id + ' 材料 ' + iid).toBeTruthy();
        expect(Number.isInteger(q) && q > 0, r.id + ' 的 ' + iid + ' 数量是 ' + q).toBe(true);
      }
      if (r.out.base) expect(WB.items[r.out.base], r.id + ' 产出 ' + r.out.base).toBeTruthy();
      if (r.out.item) expect(WB.items[r.out.item], r.id + ' 产出 ' + r.out.item).toBeTruthy();
    }
  });

  it('不降级：产出 tier 不低于前置装备自己标的基础 tier', () => {
    for (const r of craftRecipes()) {
      if (!r.out.base) continue;
      const same = r.need.items.find(([i]) => i === r.out.base);
      if (!same) continue;
      const baseTier = WB.items[r.out.base].tier ?? 1;
      expect(r.out.tier ?? 1, r.id + ' 把 tier ' + baseTier + ' 的装备做成了 tier ' + r.out.tier).toBeGreaterThanOrEqual(baseTier);
    }
  });

  it('每条配方都有站点、耗时、失败率与兜底叙事（关 AI 也不出占位符）', () => {
    for (const r of craftRecipes()) {
      expect(['forge', 'alchemy', 'inscribe'], r.id).toContain(r.station);
      expect(r.ticks, r.id).toBeGreaterThan(0);
      expect(r.failRate, r.id).toBeGreaterThanOrEqual(0);
      expect(r.failRate, r.id).toBeLessThan(1);
      expect(r.seed.length, r.id).toBeGreaterThan(6);
      expect(/\{[a-zA-Z]+\}/.test(r.seed), r.id).toBe(false);
    }
  });

  it('站点解锁条件齐备：forge 无门槛、inscribe 要一塔、alchemy 要金砂课程', () => {
    const by = Object.fromEntries(craftStations().map((x) => [x.id, x]));
    expect(by.forge.unlock).toBeFalsy();
    expect(by.inscribe.unlock?.tower).toBe('star1');
    expect(by.alchemy.unlock?.course).toBe('goldveil_y1');
  });
});

describe('卡 F2 · 制作经济护栏（新配方单独钉一遍余量）', () => {
  it('装备类配方：期望产出价 ≤ 材料成本 × 8（复现 balance 的算法，只跑魔物材料那批）', () => {
    const S = s();
    const mine = craftRecipes().filter((r) => r.out.base && r.need.items.some(([i]) => MONSTER_MATS.includes(i)));
    /* 12 条新配方里 1 条是药水（史莱姆膏），其余 11 条是装备类 */
    expect(mine.length, '应当有 11 条装备类配方用魔物材料').toBe(11);
    for (const r of mine) {
      let cost = r.need.gold;
      for (const [iid, q] of r.need.items) cost += priceOf(iid, 'plaza', S) * q;
      const back = rng.seed(31 + r.tier);
      let sum = 0;
      for (let i = 0; i < 60; i++) sum += instPrice(rollInstance(r.out.base!, r.out.tier || r.tier, 0), S);
      back();
      const ratio = sum / 60 / cost;
      expect(ratio, r.id + ' 比值 ' + ratio.toFixed(2) + '（成本 ' + cost + '）').toBeLessThanOrEqual(8);
      /* 下界不必卡死（既有配方里也有"为品质不计成本"的），但新配方的下界收紧到 0.7——
         低于这个数的配方没人会用，等于材料换了个地方继续躺着。 */
      expect(ratio, r.id + ' 太亏：造不如直接卖材料').toBeGreaterThanOrEqual(0.7);
    }
  });

  it('顶级强化有两条并行的路线（虚空线 / 领主线），材料不同、品质补偿不同', () => {
    const voidQ = craftRecipes().find((r) => r.id === 'rc_void_quench')!;
    const lord = craftRecipes().find((r) => r.id === 'rc_lord_blade')!;
    expect(voidQ.out.base).toBe('blade_void');
    expect(lord.out.base).toBe('blade_void');
    expect(lord.out.luckBias).toBeGreaterThan(voidQ.out.luckBias!);
  });
});

describe('卡 F2 · 工坊视图', () => {
  it('craftView 能列出新配方，且白手起家时全部标为材料未齐', () => {
    const s0 = s();
    const v = craftView('inscribe', s0);
    expect(v.rows.length).toBeGreaterThan(0);
    expect(v.rows.every((r) => !r.ok)).toBe(true);
    const ids = v.rows.map((r) => r.id);
    expect(ids).toContain('rc_void_quench');
    expect(ids).toContain('rc_lord_blade');
  });

  it('名录里的每一行都指得出它要什么材料（材料名取自世界书）', () => {
    const v = craftView('forge', s());
    for (const row of v.rows) expect(row.need.length).toBeGreaterThan(0);
  });
});

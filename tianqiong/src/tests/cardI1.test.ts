/* ============================================================
   卡 I1 单测 · 装备实例化（七档品质 / 词缀 / 实例计价 / 旧档回归）
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { AC, atkB, bus, combat, core, importState, rng, scheduler } from '@/world';
import {
  AFFIX_CAP,
  CRIT_MAX,
  addInstance,
  affixById,
  affixCount,
  affixPoolOf,
  critRate,
  instAffixText,
  instName,
  instPrice,
  qualityWeights,
  removeInstance,
  rollInstance,
  wornMods,
} from '@/systems/inventory/Equip';
import { newGame } from '@/world/WorldRuntime';
import { addItem, itemCount, removeItem } from '@/systems/character/Gains';
import { openShop, sell, sellRows } from '@/systems/economy/Shop';
import { WB } from '@/data/worldBook';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  core.curShop = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(23);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '铁匠', race: 'human', cls: 'warrior' });
});

const S = () => core.S!;

describe('卡 I1 · 旧档回归护栏（无 uid → 数值与改动前逐位一致）', () => {
  it('无实例装备时 AC/atkB 与基线完全相同（穿戴/卸下不产生偏差）', () => {
    const s = S();
    const ac0 = AC(s);
    const atk0 = atkB(s);
    combat.equipItem('sword_iron'); // 旧路径：无 uid
    /* 以公式复算，确认实例通道恒为 0 加成 */
    const base = 2 + ((s.player.level / 2) | 0) + Math.floor((s.player.stats[WB.classes[s.player.cls].main] - 10) / 2);
    expect(atkB(s)).toBe(base + (WB.items.sword_iron.atk || 0));
    expect(wornMods(s).atk).toBe(0);
    expect(wornMods(s).def).toBe(0);
    combat.equipItem('cloth');
    expect(AC(s)).toBe(10 + Math.floor((s.player.stats['敏捷'] - 10) / 2) + (WB.items.cloth.def || 0));
    expect(atkB(s)).toBeGreaterThanOrEqual(atk0 - 10);
    expect(ac0).toBeGreaterThan(0);
  });

  it('极简旧档（{id,qty} 背包 + 无 isq/无实例字段）可导入且不崩', () => {
    const oldSave = {
      ver: 1,
      player: {
        name: '旧人',
        race: 'human',
        cls: 'warrior',
        loc: 'plaza',
        level: 1,
        exp: 0,
        gold: 300,
        hp: 30,
        mp: 10,
        stats: { 力量: 12, 体质: 11, 敏捷: 10, 智力: 10, 感知: 10, 魅力: 10 },
        bag: [{ id: 'sword_iron', qty: 1 }],
        skills: ['heavy_slash'],
        equip: { wpn: 'sword_iron', arm: null },
        quests: {},
        wanted: 0,
        crimes: 0,
        flags: {},
      },
      rep: {},
      log: [],
    };
    expect(importState(JSON.stringify(oldSave))).toBe(true);
    const s = S();
    expect(s.isq).toBe(0); // hydrate 兜底
    expect(s.player.equip.wpnIns).toBeUndefined();
    expect(atkB(s)).toBe(2 + 0 + 1 + (WB.items.sword_iron.atk || 0)); // 逐位一致
    expect(AC(s)).toBe(10 + 0);
  });
});

describe('卡 I1 · 品质掷档与词缀', () => {
  it('同种子同结果（确定性）', () => {
    const a = (() => {
      const off = rng.seed(7);
      const x = rollInstance('sword_iron', 3, 2);
      off();
      return x;
    })();
    const b = (() => {
      const off = rng.seed(7);
      const x = rollInstance('sword_iron', 3, 2);
      off();
      return x;
    })();
    expect(a.q).toBe(b.q);
    expect(a.af).toEqual(b.af);
  });

  it('神器（q=6）权重为 0：常规掉落掷不出神器', () => {
    expect(qualityWeights(5, 10, false)[6]).toBe(0);
    expect(qualityWeights(5, 10, true)[6]).toBeGreaterThan(0);
    const off = rng.seed(99);
    for (let i = 0; i < 200; i++) expect(rollInstance('sword_iron', 5, 10).q).toBeLessThan(6);
    off();
  });

  it('词缀数 = clamp(q-1,0,cap)：q=6 必带 3 条', () => {
    expect(affixCount(0)).toBe(0);
    expect(affixCount(1)).toBe(0);
    expect(affixCount(2)).toBe(1);
    expect(affixCount(6)).toBe(AFFIX_CAP);
    const q6 = rollInstance('sword_iron', 5, 0, { allowGod: true });
    expect(q6.q).toBeGreaterThanOrEqual(0);
    const slot = { id: 'sword_iron', qty: 1, uid: 'eZZ', q: 6, af: ['af_sharp', 'af_bear', 'af_flame'] };
    expect(instName(slot).startsWith('【神器】')).toBe(true);
    expect(instAffixText(slot)).toContain('锋锐');
  });

  it('词缀池按 tier 过滤：tier=1 不掉星锻（tierMin=4）', () => {
    const t1 = affixPoolOf(WB.items.sword_iron, 1).map((a) => a.id);
    const t5 = affixPoolOf(WB.items.sword_iron, 5).map((a) => a.id);
    expect(t1).not.toContain('af_starforged');
    expect(t5).toContain('af_starforged');
    expect(t1).not.toContain('af_stout'); // arm 系词缀不进武器池
    const armorPool = affixPoolOf(WB.items.armor_chain, 3).map((a) => a.id);
    expect(armorPool).toContain('af_stout');
    expect(armorPool).not.toContain('af_sharp');
    expect(affixById('af_sharp')?.name).toBe('锋锐');
  });

  it('实例价随品质/词缀单调上升', () => {
    const mk = (q: number, n: number) => ({ id: 'sword_iron', qty: 1, uid: 'e' + q + n, q, af: ['af_sharp', 'af_bear', 'af_flame'].slice(0, n) });
    const p0 = instPrice(mk(0, 0), S());
    const p3 = instPrice(mk(3, 0), S());
    const p5 = instPrice(mk(5, 2), S());
    expect(p0).toBeGreaterThan(0);
    expect(p3).toBeGreaterThan(p0);
    expect(p5).toBeGreaterThan(p3);
  });

  it('instName 由 uid 确定性派生专名（同 uid 恒同名）', () => {
    const a = { id: 'sword_iron', qty: 1, uid: 'e7', q: 4, af: ['af_flame'] };
    expect(instName(a)).toBe(instName({ ...a }));
    expect(instName(a)).toContain('【传说】');
    expect(instName(a)).toContain('烈焰');
    expect(instName({ id: 'sword_iron' })).toBe('铁剑'); // 旧档语义（无 uid → 回落 base 名）
  });
});

describe('卡 I1 · 实例与堆叠隔离', () => {
  it('addItem 不并入实例槽，removeItem 只动普通堆叠行', () => {
    const s = S();
    addInstance({ id: 'sword_iron', qty: 1, uid: 'eA', q: 3, af: [] });
    addItem('sword_iron', 1);
    expect(s.player.bag.length).toBe(2); // 实例一行 + 普通一行
    removeItem('sword_iron'); // 只删普通件（默认 q=1 → 普通行清零移除）
    expect(s.player.bag.length).toBe(1);
    expect(s.player.bag[0].uid).toBe('eA');
    expect(itemCount('sword_iron', s)).toBe(1);
    /* 反向：先删实例槽不会误删普通件 */
    addItem('knife_hunt', 1);
    addInstance({ id: 'knife_hunt', qty: 1, uid: 'eK', q: 2, af: [] });
    expect(s.player.bag.filter((x) => x.id === 'knife_hunt').length).toBe(2);
    removeInstance('eK', s);
    expect(s.player.bag.some((x) => x.id === 'knife_hunt' && !x.uid)).toBe(true);
  });

  it('addInstance 幂等（同 uid 不重复入包）且 qty>1 拆成多件', () => {
    const s = S();
    addInstance({ id: 'knife_hunt', qty: 1, uid: 'eB', q: 2, af: [] });
    addInstance({ id: 'knife_hunt', qty: 1, uid: 'eB', q: 2, af: [] });
    expect(s.player.bag.filter((x) => x.uid === 'eB').length).toBe(1);
    const made = addInstance({ id: 'knife_hunt', qty: 3, q: 1, af: ['af_sharp'] });
    expect(made.length).toBe(3);
    expect(new Set(made.map((m) => m.uid)).size).toBe(3);
  });

  it('按 uid 精确取件：removeInstance 只摘指定实例', () => {
    const s = S();
    addInstance({ id: 'sword_iron', qty: 1, uid: 'eC', q: 1, af: [] });
    addInstance({ id: 'sword_iron', qty: 1, uid: 'eD', q: 4, af: [] });
    const got = removeInstance('eD', s);
    expect(got?.uid).toBe('eD');
    expect(s.player.bag.map((x) => x.uid)).toEqual(['eC']);
    expect(removeInstance('nope', s)).toBeNull();
  });
});

describe('卡 I1 · 穿戴与数值出口', () => {
  it('穿戴实例后 atk 提升，卸下时实例原样回包（不重掷）', () => {
    const s = S();
    addInstance({ id: 'sword_iron', qty: 1, uid: 'eE', q: 5, af: ['af_heavy', 'af_bear', 'af_flame'] });
    const before = atkB(s);
    combat.equipItem('sword_iron', 'eE');
    expect(s.player.equip.wpn).toBe('sword_iron');
    expect(s.player.equip.wpnIns?.uid).toBe('eE');
    expect(atkB(s)).toBeGreaterThan(before);
    expect(s.player.bag.some((x) => x.uid === 'eE')).toBe(false); // 已从背包下架
    combat.equipItem('knife_hunt'); // 换上普通猎刀
    const back = s.player.bag.find((x) => x.uid === 'eE');
    expect(back?.q).toBe(5);
    expect(back?.af).toEqual(['af_heavy', 'af_bear', 'af_flame']);
    expect(s.player.equip.wpnIns).toBeUndefined(); // 普通件不残留实例加成
    expect(wornMods(s).atk).toBe(0);
  });

  it('暴击率 = 5% + 词缀，封顶 40%（数值爆炸护栏）', () => {
    const s = S();
    expect(critRate(s)).toBeCloseTo(0.05, 5);
    addInstance({ id: 'sword_iron', qty: 1, uid: 'eF', q: 6, af: ['af_duelist', 'af_bloodlust', 'af_serrated'] });
    combat.equipItem('sword_iron', 'eF');
    expect(critRate(s)).toBeLessThanOrEqual(CRIT_MAX);
    expect(critRate(s)).toBeGreaterThan(0.05);
  });

  it('装备实例的属性词缀经 derived.stat 出口（无后门）', () => {
    const s = S();
    const zhi0 = s.player.stats['智力'];
    addInstance({ id: 'armor_chain', qty: 1, uid: 'eG', q: 5, af: ['af_runed'] });
    combat.equipItem('armor_chain', 'eG'); // 覆盖粗布衣
    const ins = s.player.equip.armIns!;
    expect(ins.uid).toBe('eG');
    expect(s.player.stats['智力']).toBe(zhi0); // 基础属性表不被直写
    expect(wornMods(s).stat['智力']).toBeGreaterThan(0);
  });
});

describe('卡 I1 · 商店与校验', () => {
  it('实例装备可按实例价回收；无 uid 的装备仍拒收（F-10 契约不破）', () => {
    const s = S();
    s.player.gold = 0;
    openShop('grocer');
    s.player.bag = [{ id: 'sword_iron', qty: 1 }];
    const g0 = s.player.gold;
    sell('sword_iron'); // 无 uid → 原路径拒收
    expect(s.player.gold).toBe(g0);
    expect(s.player.bag.length).toBe(1);
    /* 实例行：出现在收购列表且可卖 */
    addInstance({ id: 'sword_iron', qty: 1, uid: 'eH', q: 4, af: ['af_heavy'] });
    const rows = sellRows('grocer');
    const row = rows.find((r) => r.uid === 'eH');
    expect(row).toBeTruthy();
    expect(row!.price).toBeGreaterThan(WB.items.sword_iron.price);
    sell('sword_iron', 'eH');
    expect(s.player.gold).toBeGreaterThan(0);
    expect(s.player.bag.some((x) => x.uid === 'eH')).toBe(false);
  });

  it('存档校验：品质越界/未知词缀/实例 qty≠1 被拒，旧档 {id,qty} 放行', () => {
    const mk = (slot: unknown) => ({
      ver: 1,
      player: {
        name: '试',
        race: 'human',
        cls: 'warrior',
        loc: 'plaza',
        level: 1,
        exp: 0,
        gold: 1,
        stats: { 力量: 10, 体质: 10, 敏捷: 10, 智力: 10, 感知: 10, 魅力: 10 },
        bag: [slot],
        skills: [],
        equip: { wpn: null, arm: null },
        quests: {},
        flags: {},
        wanted: 0,
      },
    });
    expect(importState(JSON.stringify(mk({ id: 'sword_iron', qty: 1 })))).toBe(true);
    expect(importState(JSON.stringify(mk({ id: 'sword_iron', qty: 1, uid: 'eX', q: 9 })))).toBe(false);
    expect(importState(JSON.stringify(mk({ id: 'sword_iron', qty: 1, uid: 'eX', q: 2, af: ['af_nope'] })))).toBe(false);
    expect(importState(JSON.stringify(mk({ id: 'sword_iron', qty: 3, uid: 'eX', q: 2 })))).toBe(false);
    expect(importState(JSON.stringify(mk({ id: 'sword_iron', qty: 1, uid: 'eX', q: 2, af: ['af_sharp'] })))).toBe(true);
  });
});

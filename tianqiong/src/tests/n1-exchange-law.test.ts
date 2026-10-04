/* ============================================================
   卡 N1 · 星枢兑换所 与 违禁品
   ------------------------------------------------------------
   两条线都建立在既有机制上，而不是另起炉灶：
     · 兑换所接的是 §10/§11 的币制（网内依旧不许变现，地面另开一扇窗）
     · 违禁品接的是 law.json 的 smuggling 罪名与大陆治安档（lawStrictness）
   因此这里要钉的不是"新功能能跑"，而是**它们没有把原来的边界撞坏**：
   价差必须堵死往返套利、起获必须真的立案、空手过城门不该被拦。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler } from '@/world';
import { newGame } from '@/world/WorldRuntime';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { MemorySaveRepository } from '@/repo';
import { addItem } from '@/systems/character/Gains';
import { topCharge } from '@/systems/law/Law';
import { contrabandChance, contrabandOf, contrabandStop } from '@/actions/ActionExecutor';
import { buyStarcoin, exchangeHouses, exchangeRates, exchangeView, houseAt, sellCrystal, sellStarcoin } from '@/systems/economy/Exchange';
import { abilitiesOf } from '@/data/regions';
import { WB } from '@/data/worldBook';
import starhubRaw from '@/data/world/starhub.json';
import type { NetState } from '@/types/world';

const net = (starcoin = 0, starcrystal = 0): NetState => ({
  online: false,
  starcoin,
  starcrystal,
  consign: [],
  duels: { won: 0, lost: 0 },
});

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(21);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '兑换', race: 'human', cls: 'warrior' });
});

describe('卡 N1 · 星枢兑换所', () => {
  it('七大陆各一家，落在真实枢纽上，且地点能力与数据一致', () => {
    const houses = exchangeHouses();
    expect(houses.length, '七个可玩大陆应当各有一家').toBe(7);
    const continents = new Set(houses.map((h) => h.continent));
    expect(continents.size, '同一块大陆开了两家').toBe(houses.length);
    for (const h of houses) {
      expect(WB.locations[h.loc], h.id + ' 的地点不存在').toBeTruthy();
      expect(abilitiesOf(h.loc), h.loc + ' 没有 exchange 能力，按钮就不会出现').toContain('exchange');
      expect(h.name.length, h.id).toBeGreaterThan(2);
    }
  });

  it('1 星币 = 1 银币 = 100 铜：买卖同价，且与网内寄售的折算率同源', () => {
    const r = exchangeRates();
    expect(r.starcoinSell, 'YG 裁决：星币按银币 1:1').toBe(100);
    expect(r.starcoinBuy, '买卖同价——星币不是第二套货币').toBe(r.starcoinSell);
    expect(r.crystalToStarcoin, '星晶汇率沿用 §11').toBe(30);
    /* 两处折算若不一致，玩家当场就能算出差价并来回搬运。钉死它们同源。 */
    const consign = (starhubRaw as unknown as { rates: { consignPerCopper: number } }).rates.consignPerCopper;
    expect(r.starcoinSell, '与 starhub.consignPerCopper 漂移了').toBe(consign);
  });

  it('站在兑换所里才能兑：离开枢纽就是一句明确的拒绝', () => {
    const s = core.S!;
    s.player.loc = 'plaza';
    s.net = net(100);
    expect(houseAt('plaza')).toBeFalsy();
    expect(sellStarcoin(s), '不在兑换所却兑成功了').toBe(false);
    expect(s.net.starcoin, '失败的兑换不该动星币').toBe(100);
  });

  it('兑出星币：星币归零、铜钱按牌价到账（1:1 之下 1 星币就是 1 银币）', () => {
    const s = core.S!;
    s.player.loc = 'gate';
    s.net = net(200);
    const gold0 = s.player.gold;
    expect(sellStarcoin(s)).toBe(true);
    expect(s.net.starcoin).toBe(0);
    expect(s.player.gold).toBe(gold0 + 200 * 100);
  });

  it('买入星币：扣铜、入账，钱不够时拒绝且不动账', () => {
    const s = core.S!;
    s.player.loc = 'gate';
    s.net = net(0);
    const cost = 100 * exchangeRates().starcoinBuy;
    s.player.gold = cost;
    expect(buyStarcoin(s)).toBe(true);
    expect(s.net.starcoin).toBe(100);
    expect(s.player.gold).toBe(0);
    expect(buyStarcoin(s), '钱不够却买成了').toBe(false);
    expect(s.net.starcoin, '失败的买入不该入账').toBe(100);
  });

  it('星晶兑星币：按 §11 的 1:30，且不落成铜（那一步是另一档）', () => {
    const s = core.S!;
    s.player.loc = 'goldveil';
    s.net = net(0, 2);
    const gold0 = s.player.gold;
    expect(sellCrystal(s)).toBe(true);
    expect(s.net.starcrystal).toBe(0);
    expect(s.net.starcoin).toBe(60);
    expect(s.player.gold, '星晶不该直接变铜').toBe(gold0);
  });

  it('视图给出可读的牌价与报价（UI 与测试共用同一份口径）', () => {
    const s = core.S!;
    s.player.loc = 'windport';
    s.net = net(45, 1);
    const v = exchangeView(exchangeHouses().find((h) => h.loc === 'windport')!, s);
    expect(v.starcoin).toBe(45);
    expect(v.sellQuote).toBe(45 * exchangeRates().starcoinSell);
    expect(v.buyCost).toBe(100 * exchangeRates().starcoinBuy);
    expect(v.locName.length).toBeGreaterThan(1);
  });
});

describe('卡 N1 · 违禁品', () => {
  it('只把 illegal 标记的东西算作禁货', () => {
    const s = core.S!;
    addItem('bread');
    addItem('dagger_black');
    addItem('dust_dream');
    expect(contrabandOf(s).sort()).toEqual(['dagger_black', 'dust_dream']);
  });

  it('空手过城门不会被拦：概率为 0', () => {
    expect(contrabandChance(core.S!)).toBe(0);
  });

  it('治安越严越容易露：中央（5 档）高于深渊（1 档），且永远留一线运气', () => {
    const s = core.S!;
    addItem('dagger_black');
    s.player.loc = 'gate';
    const strict = contrabandChance(s);
    s.player.loc = 'deepwell';
    const loose = contrabandChance(s);
    expect(strict).toBeGreaterThan(loose);
    expect(loose).toBeGreaterThan(0);
    addItem('dust_dream');
    addItem('void_essence');
    addItem('dagger_black');
    expect(contrabandChance(s), '概率封顶，否则带着禁货过城门成了必然的墙').toBeLessThanOrEqual(0.85);
  });

  it('盘查失败：禁货全部起获，并立下「倒卖禁货」（B 级）', () => {
    const s = core.S!;
    addItem('dagger_black');
    addItem('dust_dream');
    rng.inject(() => 0); // d20 = 1，必败
    contrabandStop();
    expect(contrabandOf(s), '东西没被起获').toEqual([]);
    expect(topCharge(s)?.id, '没有立案，违禁品就只是"贵一点的货"').toBe('smuggling');
  });

  it('藏住了：东西还在，也不留案底', () => {
    const s = core.S!;
    addItem('dagger_black');
    rng.inject(() => 0.999); // d20 = 20，必过
    contrabandStop();
    expect(contrabandOf(s).length, '成功了却把东西搜走了').toBe(1);
    expect(topCharge(s), '成功了却留了案底').toBeNull();
  });
});

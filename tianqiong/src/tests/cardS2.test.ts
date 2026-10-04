/* ============================================================
   卡 S2 · 交通体系（世界书 §81 速度等级 / §83 城内交通 / §85 传送阵）
   数据在 T4 就建好（travelModes/portals/cityTransit），本用例验证判定层。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { core, newState } from '@/world/WorldState';
import { bus, rng, scheduler } from '@/events/EventBus';
import {
  canTeleport,
  cityTransit,
  cityTransitCost,
  daysByMode,
  portalBannedItem,
  portalCarryBan,
  portalCost,
  portalLimits,
  portalTiers,
  travelModes,
} from '@/systems/travel/Travel';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  rng.seed(31);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  core.S = newState({ name: 'S2', race: 'human', cls: 'warrior' });
});

describe('卡 S2 · 交通方式与速度等级（§81）', () => {
  it('五档方式齐备：步行 / 骑乘 / 精良坐骑 / 飞行器 / 传送阵', () => {
    const m = travelModes().map((x) => x.id);
    for (const id of ['walk', 'ride', 'steed', 'airship', 'portal']) expect(m, id).toContain(id);
  });

  it('速度等级单调：步行最慢，飞行器最快', () => {
    const by = Object.fromEntries(travelModes().map((x) => [x.id, x.speed]));
    expect(by.walk).toBeLessThan(by.ride);
    expect(by.ride).toBeLessThan(by.steed);
    expect(by.steed).toBeLessThan(by.airship);
  });

  it('同一条路走法不同天数不同：飞行器远快于步行', () => {
    expect(daysByMode(10, 'airship')).toBeLessThan(daysByMode(10, 'walk'));
    expect(daysByMode(10, 'walk')).toBeGreaterThanOrEqual(1);
  });

  it('传送类不按速度折算天数（即时），返回原值由费用另计', () => {
    expect(daysByMode(10, 'portal')).toBe(10);
  });
});

describe('卡 S2 · 传送阵（§85）', () => {
  it('四类传送阵齐备（城内/短距/长距/次元门），费用递增', () => {
    const t = portalTiers();
    expect(t.map((x) => x.id)).toEqual(['city', 'short', 'long', 'gate']);
    expect(portalCost('city')).toBeLessThan(portalCost('short'));
    expect(portalCost('short')).toBeLessThan(portalCost('long'));
    expect(portalCost('long')).toBeLessThan(portalCost('gate'));
  });

  it('费用按人头叠加：启动费只收一次，每多一人只加人头费', () => {
    const one = portalCost('long', 1);
    const two = portalCost('long', 2);
    const three = portalCost('long', 3);
    expect(two).toBeGreaterThan(one);
    /* 增量必须恒定（线性），而不是每加一人都重收一次启动费 */
    expect(two - one).toBe(three - two);
    expect(three - one).toBe((two - one) * 2);
  });

  it('载员上限与禁传清单来自数据（§85：100 人 / 禁魔·诅咒·神器）', () => {
    const l = portalLimits();
    expect(l.maxLoad).toBe(100);
    expect(l.banRules.length).toBeGreaterThanOrEqual(3);
    expect(l.network.continental).toBe(7);
  });

  it('禁传判定：神器/违禁品被识别，普通货放行', () => {
    expect(portalBannedItem('blade_void')).toBe('神器'); // tier 5
    expect(portalBannedItem('dagger_black')).toBe('被诅咒物品'); // illegal
    expect(portalBannedItem('bread')).toBeNull();
  });

  it('随身带神器时整条链路被拒，且指出是哪一件', () => {
    const s = core.S!;
    s.player.gold = 99999999;
    s.player.bag.push({ id: 'blade_void', qty: 1 });
    const c = canTeleport('gate', 'frosthold', s);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/神器/);
    expect(portalCarryBan(s)?.item).toBe('虚空噬刃');
  });

  it('卸下禁传物后同一趟可走，但费用不足时仍拒', () => {
    const s = core.S!;
    s.player.gold = 99999999;
    expect(canTeleport('long', 'frosthold', s).ok).toBe(true);
    s.player.gold = 0;
    const c = canTeleport('long', 'frosthold', s);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/传送费/);
  });

  it('载员超限被拒（100 人以上）', () => {
    const s = core.S!;
    s.player.gold = 99999999;
    const c = canTeleport('long', 'frosthold', s, 101);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/载员/);
  });
});

describe('卡 S2 · 城内交通与网络规模（§83/§85）', () => {
  it('城内四种走法价目齐备，步行免费', () => {
    expect(cityTransitCost('walk')).toBe(0);
    expect(cityTransitCost('carriage')).toBeGreaterThan(0);
    expect(cityTransitCost('portalPoint')).toBeGreaterThan(0);
    expect(cityTransitCost('mount')).toBeGreaterThan(0);
    expect(cityTransit()).toBeTruthy();
  });

  it('传送阵网络规模与 §85 一致（7 跨大陆 / 35 长距 / 200+ 城内）', () => {
    const n = portalLimits().network;
    expect(n.continental).toBe(7);
    expect(n.longRange).toBe(35);
    expect(n.cityShort).toBeGreaterThanOrEqual(200);
  });
});

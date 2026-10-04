/* ============================================================
   卡 D6 · NPC 经济行为 + 动态物价
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler, newGame } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { WB } from '@/data/worldBook';
import { econRevert, initVendors, priceOf, vendorCoin, vendorEarns, vendorPays } from '@/systems/economy/Economy';

beforeEach(() => {
  core.S = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  const r = rng.seed(3);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return r;
});
const start = () => newGame({ name: 'D6', race: 'human', cls: 'warrior' });

describe('卡 D6 · 动态定价', () => {
  it('品类指数拉动价格：herb=1 → 基准；herb=2 → 约翻倍（广场地区修正 1）', () => {
    start();
    const s = core.S!;
    const iid = 'herb_paste';
    s.player.loc = 'plaza';
    s.econ.herb = 1;
    const p1 = priceOf(iid, 'plaza', s);
    s.econ.herb = 2;
    const p2 = priceOf(iid, 'plaza', s);
    expect(p2).toBeCloseTo(p1 * 2, 0);
    expect(p1).toBe(WB.items[iid].price); // 广场修正=1，指数=1 → 基准价
  });
  it('地区修正：洞窟深处贵于广场（荒野/矿洞补给溢价）', () => {
    start();
    const s = core.S!;
    s.econ.herb = 1;
    const city = priceOf('herb_paste', 'plaza', s);
    const deep = priceOf('herb_paste', 'cave3', s);
    expect(deep).toBeGreaterThan(city);
  });
  it('econRevert 把涨价拉回基准（不越过基准）', () => {
    start();
    const s = core.S!;
    s.econ.herb = 2;
    econRevert(s);
    expect(s.econ.herb).toBeLessThan(2);
    expect(s.econ.herb).toBeGreaterThan(1);
    for (let i = 0; i < 40; i++) econRevert(s);
    expect(s.econ.herb).toBeCloseTo(1, 1); // 多日后基本回落
  });
});

describe('卡 D6 · 商人有限钱袋（"不是无限金币 NPC"）', () => {
  it('initVendors 从种子建本金、幂等', () => {
    start();
    const s = core.S!;
    expect(s.vendors!.iron).toBeGreaterThan(0);
    const before = s.vendors!.iron;
    initVendors(s);
    expect(s.vendors!.iron).toBe(before); // 不重复初始化
  });
  it('vendorPays 钱够则扣减、不够则拒付；vendorEarns 回补', () => {
    start();
    const s = core.S!;
    const c0 = vendorCoin('iron', s);
    expect(vendorPays('iron', 100, s)).toBe(true);
    expect(vendorCoin('iron', s)).toBe(c0 - 100);
    vendorEarns('iron', 40, s);
    expect(vendorCoin('iron', s)).toBe(c0 - 60);
    expect(vendorPays('iron', c0 + 1, s)).toBe(false); // 超支拒付
  });
});

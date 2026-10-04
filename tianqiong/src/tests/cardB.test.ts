/* 卡 B 回归：货币降位格式化（满单位） + 旧存档 hydrate 补二级钱包（旧档可读） */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, importState, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { formatMoney, formatWallet, moneyParts } from '@/systems/economy/Money';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  const restore = rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return restore;
});

describe('卡B · formatMoney（铜基数 100 进制降位，满单位）', () => {
  it.each([
    [0, '0 铜币'],
    [99, '99 铜币'],
    [100, '1 银币'],
    [600, '6 银币'],
    [10050, '1 金币 50 铜币'],
    [2500000, '2 白金币 50 金币'],
  ])('%i → %s', (n, out) => expect(formatMoney(n)).toBe(out));
  it('负值兜底为 0 铜币', () => expect(formatMoney(-5)).toBe('0 铜币'));
  it('moneyParts 逐位分解', () => {
    expect(moneyParts(10050)).toEqual({ plat: 0, gold: 1, silver: 0, copper: 50 });
  });
  it('formatWallet 0 不显示', () => {
    expect(formatWallet(0, ' · 魔晶')).toBe('');
    expect(formatWallet(3, ' · 魔晶')).toBe('3  · 魔晶');
  });
});

describe('卡B · 旧存档 hydrate（§4 保持旧档可读）', () => {
  it('缺 wallet/net 的 ver1 旧档导入后自动补默认，不崩', () => {
    const oldSave = { ver: 1, player: { name: 'X', gold: 500 }, rep: {}, log: [] };
    expect(importState(JSON.stringify(oldSave))).toBe(true);
    const s = core.S!;
    expect(s.player.wallet).toEqual({ magicCrystal: 0, soulCrystal: 0 });
    expect(s.player.gold).toBe(500); // 单整数基数不变
    expect(s.net).toBeDefined();
  });
});

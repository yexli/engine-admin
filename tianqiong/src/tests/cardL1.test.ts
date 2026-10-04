/* ============================================================
   卡 L1 · 寿命（世界书 §80「时间与寿命」）
   §80 的表早在 K3 就进了 timeslip.json，但那时**年龄根本不存在**——
   表只有测试在调。本卡把它接上真实年龄，于是四件事成立：
   ① 年龄随外界时间走；② 境界抬升真的延寿；③ 百年神选的「寿元 +N 年」有地方落；
   ④ §10「网中历时不耗寿」有地方扣。
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { core } from '@/world/WorldState';
import { newGame } from '@/world/WorldRuntime';
import { advance, TICKS_PER_YEAR } from '@/world/WorldClock';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { bus, rng, scheduler, worldBus } from '@/events/EventBus';
import { lifespanOf, lifespanTable, exileInnerYears, innerDays } from '@/systems/timeslip/Timeslip';
import { ageOf, agingTick, lifeLine, lifespanRange, lifeStatus } from '@/systems/timeslip/Lifespan';
import { enterNet, exitNet } from '@/systems/starnet/StarNet';

const s = () => core.S!;

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  worldBus.reset();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(41);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: 'L1', race: 'human', cls: 'warrior' });
});

describe('卡 L1 · §80 寿命表（与境界同轴）', () => {
  it('五档与世界书逐条对上', () => {
    const t = lifespanTable();
    expect(t.map((r) => r.rank)).toEqual(['见习', '正式', '主教', '圣徒（圣阶）', '神阶']);
    expect([t[0].min, t[0].max]).toEqual([70, 100]);
    expect([t[1].min, t[1].max]).toEqual([100, 150]);
    expect([t[2].min, t[2].max]).toEqual([150, 300]);
    expect([t[3].min, t[3].max]).toEqual([300, 500]);
    expect(t[4].min).toBe(500);
  });

  it('境界抬升延长寿数：Lv.1 见习、Lv.3 正式、Lv.6 神阶', () => {
    expect(lifespanOf(1, s()).rank).toBe('见习');
    expect(lifespanOf(3, s()).rank).toBe('正式');
    expect(lifespanOf(6, s()).rank).toBe('神阶');
  });

  it('「信徒」在世界书的表里没有单列——回落凡人基准（见习档），不臆造新档', () => {
    s().player.level = 1;
    expect(lifespanOf(0, s()).rank).toBe('见习');
  });

  it('境界名走 R2 的唯一映射：本模块不再自己写一遍 level→境界', () => {
    s().player.level = 5;
    expect(lifespanOf(0, s()).rank).toMatch(/圣徒/);
    s().player.level = 4;
    expect(lifespanOf(0, s()).rank).toBe('主教');
  });
});

describe('卡 L1 · 年龄是真的会走的', () => {
  it('创角 16 岁（年龄是派生量：存出生刻，不存年龄）', () => {
    expect(s().player.birthTick).toBeDefined();
    expect(ageOf(s())).toBeCloseTo(16, 2);
  });

  it('过一年长一岁', () => {
    const a0 = ageOf(s());
    advance(TICKS_PER_YEAR);
    expect(ageOf(s())).toBeCloseTo(a0 + 1, 2);
  });

  /* 注：不测「推进十年」——advance 每 48 刻触发一次 newDay，十年是 3600 次日结算，
     单测跑不动（实测 42 秒）。年龄与时长的线性关系改由出生刻那条直接覆盖。 */
  it('年龄来自时间而不是字段：把出生刻往前挪，年龄立刻变大', () => {
    s().player.birthTick = s().t - 40 * TICKS_PER_YEAR;
    expect(ageOf(s())).toBeCloseTo(40, 2);
  });
});

describe('卡 L1 · §10「网中历时不耗寿」', () => {
  it('网中待三十日再出网，岁数不动', () => {
    const a0 = ageOf(s());
    expect(enterNet()).toBe(true);
    advance(48 * 30);
    exitNet();
    expect(ageOf(s())).toBeCloseTo(a0, 2);
    expect(s().player.netAgedTicks, '出网时要结清网中时长').toBeGreaterThan(0);
  });

  it('网中时长被精确扣掉：出网后外界再走一日，只长一日', () => {
    const a0 = ageOf(s());
    enterNet();
    advance(48 * 10);
    exitNet();
    advance(48 * 10);
    /* 世界时间走了 20 日，其中 10 日在网中 → 年龄只长 10 日 */
    expect(ageOf(s())).toBeCloseTo(a0 + 10 / 360, 3);
  });

  it('从未入网时 netAgedTicks 为 0', () => {
    expect(s().player.netAgedTicks).toBe(0);
    advance(48 * 5);
    expect(ageOf(s())).toBeCloseTo(16 + 5 / 360, 3);
  });
});

describe('卡 L1 · §80 小世界闭关以年岁计价', () => {
  it('闭关外界一年 → 年龄长一岁（此前 enterSlip 根本不推进时间）', () => {
    const a0 = ageOf(s());
    const r = innerDays('fast', 360);
    expect(r).toBe(1800);
    /* 直接调 enterSlip 会走 advance —— 用同一个入口验证 */
    return import('@/systems/timeslip/Timeslip').then(({ enterSlip }) => {
      const out = enterSlip('fast', 360, s());
      expect(out.ok).toBe(true);
      expect(ageOf(s())).toBeCloseTo(a0 + 1, 2);
    });
  });

  it('内成长 100 年 = 外成长 20 年（D1 = 1:5，§89 的旧版 1:7 已作废）', () => {
    expect(innerDays('fast', 100)).toBe(500);
    expect(exileInnerYears(100)).toBe(20);
  });

  it('静止型小世界：时间不流动，等于被封存', () => {
    expect(innerDays('still', 365)).toBe(0);
  });
});

describe('卡 L1 · 寿元加成（百年神选的「寿元 +N 年」）', () => {
  it('lifeBonus 直接抬升上限与下限', () => {
    const before = lifespanRange(s());
    s().player.lifeBonus = 800;
    const after = lifespanRange(s());
    expect(after.max).toBe(before.max + 800);
    expect(after.min).toBe(before.min + 800);
    expect(after.bonus).toBe(800);
  });

  it('神阶的「部分永生」不设硬顶：表上给的是 9999 年', () => {
    s().player.level = 6;
    expect(lifespanRange(s()).max).toBeGreaterThan(5000);
  });
});

describe('卡 L1 · 寿数阶段与寿尽', () => {
  it('阶段随占比推进：青年 → 盛年 → 暮年 → 寿数已尽', () => {
    s().player.birthTick = s().t; // 0 岁
    expect(lifeStatus(s()).stage).toBe('young');
    s().player.birthTick = s().t - 60 * TICKS_PER_YEAR; // 60/100
    expect(lifeStatus(s()).stage).toBe('prime');
    s().player.birthTick = s().t - 90 * TICKS_PER_YEAR; // 90/100
    expect(lifeStatus(s()).stage).toBe('old');
    s().player.birthTick = s().t - 120 * TICKS_PER_YEAR;
    expect(lifeStatus(s()).stage).toBe('exhausted');
  });

  it('寿尽时置事实并只上报一次（幂等）', () => {
    s().player.birthTick = s().t - 120 * TICKS_PER_YEAR;
    const seen: string[] = [];
    worldBus.on('life_exhausted', () => seen.push('x'), 'test-l1');
    agingTick(s());
    expect(s().player.flags.life_exhausted).toBe(true);
    agingTick(s());
    agingTick(s());
    expect(seen, '寿尽不是每天播一次的广告').toEqual(['x']);
  });

  it('未寿尽时不置 flag，也不上报', () => {
    const seen: string[] = [];
    worldBus.on('life_exhausted', () => seen.push('x'), 'test-l1');
    agingTick(s());
    expect(s().player.flags.life_exhausted).toBeFalsy();
    expect(seen).toEqual([]);
  });

  it('寿元赏赐能把已寿尽的人拉回来（赏赐要在寿尽之前领）', () => {
    s().player.birthTick = s().t - 120 * TICKS_PER_YEAR;
    expect(lifeStatus(s()).stage).toBe('exhausted');
    s().player.lifeBonus = 800; // 神选第一名
    expect(lifeStatus(s()).stage).not.toBe('exhausted');
  });
});

describe('卡 L1 · 面板行', () => {
  it('lifeLine 同时给出岁数、境界、阶段、寿数与剩余', () => {
    const line = lifeLine(s());
    expect(line).toContain('16 岁');
    expect(line).toContain('见习');
    expect(line).toContain('青年');
    expect(line).toContain('70–100');
    expect(line).toContain('余');
  });

  it('领了寿元的面板行会写明含赏赐', () => {
    s().player.lifeBonus = 800;
    expect(lifeLine(s())).toContain('寿元 +800');
  });
});

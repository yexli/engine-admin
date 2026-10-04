/* ============================================================
   卡 E4 · 历法节日与周期事件（世界书 §6/§37）
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler, newGame } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { ALL_EVENTS, directorTick, evalTrigger, fireEvent } from '@/events/EventProcessor';

beforeEach(() => {
  core.S = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  const r = rng.seed(17);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return r;
});
const start = () => newGame({ name: 'E4', race: 'human', cls: 'warrior' });

describe('卡 E4 · 历法触发', () => {
  it('timeline 节日已并入事件池（卡 T4 后为 15 条节日 + 4 条周期事件）', () => {
    /* 卡 T4：节日表按世界书 §78 全量重铺，旧的 fest_bloom（2/15）被
       「春耕祭 fest_spring_plow（2/15）」接管；元日祭是新的 1/1 条目。 */
    expect(ALL_EVENTS.some((e) => e.id === 'fest_newyear' && e.recurring)).toBe(true);
    expect(ALL_EVENTS.some((e) => e.id === 'fest_spring_plow')).toBe(true);
    expect(ALL_EVENTS.filter((e) => (e.tags || []).includes('festival')).length).toBe(15);
    expect(ALL_EVENTS.filter((e) => (e.tags || []).includes('period')).length).toBe(4);
  });
  it('month/date 精确命中：新芽月(0)1 日命中元日祭，错位月日不命中', () => {
    start();
    const s = core.S!;
    s.t = 0; // 绝对日 1 → 月 index 0、月内日 1
    expect(evalTrigger({ month: 0, date: 1 }, s)).toBe(true);
    expect(evalTrigger({ month: 0, date: 2 }, s)).toBe(false);
    expect(evalTrigger({ month: 1, date: 1 }, s)).toBe(false);
  });
  it('卡 T4 新增触发字段：everyDays 日节律 / months 季节窗口 / year 纪年', () => {
    start();
    const s = core.S!;
    s.t = 10 * 48; // 绝对日 11
    expect(evalTrigger({ everyDays: 10, everyOffset: 1 }, s)).toBe(true); // 第 11 日 = 周一日
    expect(evalTrigger({ everyDays: 10, everyOffset: 2 }, s)).toBe(false);
    expect(evalTrigger({ months: [0, 1] }, s)).toBe(true); // 1 月落在窗口内
    expect(evalTrigger({ months: [6, 7] }, s)).toBe(false); // 台风季不在窗口内
    expect(evalTrigger({ year: 612 }, s)).toBe(true);
    expect(evalTrigger({ year: 613 }, s)).toBe(false);
  });
});

describe('卡 E4 · 周期事件可复现', () => {
  it('同一日不重复触发；下一周期（隔一年）可再触发', () => {
    start();
    const s = core.S!;
    const fest = ALL_EVENTS.find((e) => e.id === 'fest_newyear')!;
    s.t = 0; // 绝对日 1 = 新芽月 1 日
    expect(fireEvent(fest, s)).toBe(true);
    expect(fireEvent(fest, s)).toBe(false); // 同日幂等
    s.t = 360 * 48; // 来年同月同日（12 月 ×30 日 = 360 日一年）
    expect(fireEvent(fest, s)).toBe(true); // 周期再现
  });
  it('directorTick 在节日当天自动播报元日祭（recurring 实例 id 带日后缀）', () => {
    start();
    const s = core.S!;
    s.t = 0; // 新芽月 1 日 = 元日祭
    directorTick(s);
    expect(s.events.some((e) => e.id === 'fest_newyear:' + 1)).toBe(true);
    expect(s.rep.temple_life).toBeGreaterThanOrEqual(3);
  });
});

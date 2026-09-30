/* 世界时钟：推进 / 日边界 / 时辰边界 / 效果衰减 / 计划事件 / 睡到天亮 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeEvent, registerEventTables, resetEventSeq } from '../src/events/EventSchema';
import { worldBus } from '../src/events/WorldEventBus';
import { createBaseState } from '../src/state/WorldState';
import { createWorldClock, dayOfTick, periodSeg, shichenOf } from '../src/time/WorldClock';
import type { EngineWorldState } from '../src/types';

function harness() {
  const s: EngineWorldState = createBaseState();
  const seen: string[] = [];
  const stop = worldBus.on('*', (e) => seen.push(e.type));
  const clock = createWorldClock<EngineWorldState>({
    need: () => s,
    labels: {
      months: ['新芽', '盛夏', '枯叶', '凛冬', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'],
      shichen: ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'],
      periodOf: ['晨', '昼', '夜', '晨', '晨', '晨', '昼', '昼', '昼', '夜', '夜', '夜'],
      baseYear: 612,
    },
  });
  return { s, seen, stop, clock };
}

beforeEach(() => {
  worldBus.reset();
  resetEventSeq();
  /* 天穹同款分级：节律事件是 critical（时钟大量发布它们） */
  registerEventTables({ hour_advanced: 0, new_day: 2 }, { hour_advanced: 'critical', new_day: 'critical' });
});

describe('时间换算', () => {
  it('shichenOf / dayOfTick / periodSeg 与天穹口径一致', () => {
    expect(shichenOf(0)).toBe(0);
    expect(shichenOf(4)).toBe(1);
    expect(shichenOf(47)).toBe(11);
    expect(dayOfTick(0)).toBe(1);
    expect(dayOfTick(47)).toBe(1);
    expect(dayOfTick(48)).toBe(2);
    /* 晨 2–5 / 昼 6–8 / 余下归暮夜（与天穹 periodSeg 同一切点） */
    expect(Array.from({ length: 12 }, (_, h) => periodSeg(h))).toEqual([2, 2, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2]);
  });
});

describe('推进循环', () => {
  it('advance 推进刻数；跨时辰发布 hour_advanced', () => {
    const h = harness();
    h.clock.advance(5);
    expect(h.s.t).toBe(21); // 16 + 5
    expect(h.seen).toEqual(['hour_advanced']);
  });

  it('日边界发布 new_day 并结算到期计划事件（先开 tick 再发）', () => {
    const h = harness();
    const late = makeEvent({ type: 'caravan_arrives', day: 1 });
    worldBus.schedule(late, 1); // 发布日 + 1 → 第 2 天到期
    h.s.t = 47;
    h.clock.advance(1);
    expect(h.s.t).toBe(48);
    expect(h.seen).toContain('new_day');
    expect(h.seen).toContain('caravan_arrives');
  });

  it('时辰边界先广播事实、后调用注入钩子（顺序契约）', () => {
    const s = createBaseState();
    const order: string[] = [];
    worldBus.on('hour_advanced', () => order.push('broadcast'));
    const clock = createWorldClock<EngineWorldState>({
      need: () => s,
      onHourTick: () => order.push('hook'),
    });
    clock.advance(4);
    expect(order).toEqual(['broadcast', 'hook']);
  });

  it('衰减：带 left 的状态效果逐刻递减，到期移除；缺 left 的永久保留', () => {
    const h = harness();
    h.s.player.effects = [
      { id: 'poi', left: 2 },
      { id: 'bless' },
    ];
    h.s.npcs['npc_a'] = { att: 0, mem: [], met: false, effects: [{ id: 'slow', left: 1 }] };
    h.clock.advance(2);
    expect(h.s.player.effects!.map((e) => e.id)).toEqual(['bless']);
    expect(h.s.npcs['npc_a'].effects).toEqual([]);
  });

  it('tillMorning：推到下一个卯时；已在窗口内也至少推进 1 刻（防零成本刷休息）', () => {
    const h = harness();
    h.s.t = 40; // 亥时
    h.clock.tillMorning();
    expect(shichenOf(h.s.t)).toBe(3);

    h.s.t = 12; // 卯时（3*4=12）
    const t0 = h.s.t;
    h.clock.tillMorning();
    expect(h.s.t).toBe(t0 + 1);
  });
});

describe('历法标签', () => {
  it('sceneTime：月名 / 日期 / 时辰名 / 纪年，12 月一轮回', () => {
    const h = harness();
    h.s.t = 48 * 400; // 第 401 天 → 绝对月 13 → 折回月 1
    const t = h.clock.sceneTime();
    expect(t.month).toBe('盛夏'); // (400/30)%12 = 13%12 = 1 → 标签表索引 1
    expect(t.year).toBe(613); // 612 + floor(400/360)
    expect(t.day).toBe(401);
    expect(h.clock.timeStr()).not.toContain('undefined');
    expect(h.clock.seasonName()).toMatch(/^[春夏秋冬]$/);
  });
});

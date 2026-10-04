/* ============================================================
   卡 J1 · 世界档案（《后续开发方案-阶段J》）
   —— 门面层证据：world.query.get_world_log / trace_event 真的能把
      「这一局实际发生的因果」交到表现层手里。

   为什么单独立卡：阶段 J 审计实测，worldEventLog 的四方法（recent /
   byId / chain / dump）+ 因果实现 + 双介质落盘全部就位，但在 src/ui/**
   下消费点为 0 —— 玩家能看到的「因果」是 NewsPanel 读 events.json 里
   剧本 trigger.afterEvent 的**静态依赖名**，不是运行时链路。
   本文件钉的是数据出口的契约与边界；组件渲染由真机脚本覆盖。

   注意：走动（dispatch travel）**不产生**世界事件——ActionExecutor.go()
   只写叙事日志与状态，事实是由系统在真正发生后果时才发布的。
   所以本文件的样本事实用 makeEvent 直接发布，而不是伪造一次假走动。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler, world } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { worldBus } from '@/events/EventBus';
import { makeEvent, resetEventSeq } from '@/events/EventSchema';
import { worldEventLog } from '@/events/EventStore';
import { plugins } from '@/plugins/PluginRegistry';
import { bootstrapWorld } from '@/plugins/bootstrap';

const start = () => newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });

/** 清空世界史并重置本 tick 配额：先 beginTick 再 clear，避免重投的旧事件混进来 */
const freshLog = () => {
  worldBus.beginTick();
  worldEventLog.clear();
};

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  worldBus.reset();
  plugins.clear();
  worldEventLog.clear();
  resetEventSeq();
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  /* 与生产同一条装配路径——世界史靠 bootstrapWorld 挂上总线，测试不手工预置 */
  bootstrapWorld({ reasoner: ruleReasoner });
});

describe('卡 J1 · 世界档案的因果出口', () => {
  it('事实发布后能被门面读到（装配链是通的）', () => {
    start();
    freshLog();
    const ev = makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'otto' });
    worldBus.emit(ev);
    const log = world.query.get_world_log(50);
    /* 一条事实会引发衍生事实（目击者反应等），所以刻意**不**假设「缓冲里只有一条」。
       真正的不变量是：同一个 id 在缓冲里只记一次（§30 记账幂等）。 */
    const mine = log.filter((e) => e.id === ev.id);
    expect(mine.length, '同 id 只该记一次').toBe(1);
    expect(mine[0].type).toBe('crime_committed');
    expect(mine[0].actor).toBe('player');
    expect(mine[0].target).toBe('otto');
    expect(log.length, '门面确实交出了事实').toBeGreaterThanOrEqual(1);
  });

  it('因果链沿 parentId 向上追溯——这是静态剧本给不了的东西', () => {
    start();
    freshLog();
    const parent = makeEvent({ type: 'crime_committed', day: 3, level: 2, actor: 'player', target: 'otto' });
    worldBus.emit(parent);
    const child = makeEvent({ type: 'reputation_changed', day: 3, level: 2, actor: 'otto', target: 'player', parentId: parent.id });
    worldBus.emit(child);

    const chain = world.query.trace_event(child.id);
    expect(chain.map((e) => e.id)).toEqual([child.id, parent.id]);
    expect(chain.map((e) => e.type)).toEqual(['reputation_changed', 'crime_committed']);
    /* 链首是被查的那条、链尾是根源——顺序是契约，UI 的「↑ 向上追溯」按此渲染 */
    expect(chain[chain.length - 1].parentId).toBeUndefined();
  });

  it('缓冲里没有的 id 返回空数组（不伪造链路）', () => {
    start();
    freshLog();
    expect(world.query.trace_event('evt_not_in_buffer')).toEqual([]);
  });

  it('深度上限生效：超长链不会无限回溯', () => {
    start();
    freshLog();
    let prev = makeEvent({ type: 'new_day', day: 1, level: 2 });
    worldBus.emit(prev);
    for (let i = 0; i < 5; i++) {
      const e = makeEvent({ type: 'reputation_changed', day: 1, level: 2, parentId: prev.id });
      worldBus.emit(e);
      prev = e;
    }
    expect(world.query.trace_event(prev.id, 3).length, '深度 3 就只给 3 条，哪怕真实链更长').toBe(3);
    expect(world.query.trace_event(prev.id, 99).length, '链只有 6 条，要 99 也只给 6 条').toBe(6);
  });

  it('世界史只收 L1 以上：内部账目（L0）不进档案', () => {
    start();
    freshLog();
    worldBus.emit(makeEvent({ type: 'damage_applied', day: 1, level: 0 }));
    worldBus.emit(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player' }));
    const types = world.query.get_world_log(20).map((e) => e.type);
    expect(types).toContain('crime_committed');
    expect(types, 'L0 是内部账目，进了档案会淹没因果链').not.toContain('damage_applied');
  });

  it('每条链都落地在真实存在的根上，不悬空', () => {
    start();
    freshLog();
    /* 三条彼此独立的链：A→B, C→D→E, F（单点） */
    const a = makeEvent({ type: 'crime_committed', day: 2, level: 2, actor: 'player' });
    worldBus.emit(a);
    const b = makeEvent({ type: 'reputation_changed', day: 2, level: 2, parentId: a.id });
    worldBus.emit(b);
    const c = makeEvent({ type: 'city_at_war', day: 3, level: 3, actor: 'empire' });
    worldBus.emit(c);
    const d = makeEvent({ type: 'faction_conflict', day: 3, level: 3, parentId: c.id });
    worldBus.emit(d);
    const e = makeEvent({ type: 'reputation_changed', day: 3, level: 2, parentId: d.id });
    worldBus.emit(e);

    for (const leaf of [b, e]) {
      const chain = world.query.trace_event(leaf.id);
      expect(chain[0].id, '链首必须是被查的那条').toBe(leaf.id);
      expect(chain[chain.length - 1].parentId, '链尾必须是根').toBeUndefined();
      expect(chain.length, '链上每一跳都必须真实存在').toBe(leaf === b ? 2 : 3);
    }
  });

  it('get_world_log(n) 只给最近 n 条，且保持缓冲原始时序', () => {
    start();
    freshLog();
    for (let i = 0; i < 6; i++) worldBus.emit(makeEvent({ type: 'reputation_changed', day: i + 1, level: 2 }));
    const all = world.query.get_world_log(99);
    expect(all.length).toBe(6);
    const tail = world.query.get_world_log(3);
    expect(tail.length).toBe(3);
    expect(tail.map((e) => e.id)).toEqual(all.slice(-3).map((e) => e.id));
    expect(tail.map((e) => e.day), '时序原样交出，倒序由 UI 决定').toEqual([4, 5, 6]);
  });
});

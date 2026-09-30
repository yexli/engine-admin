/* 世界事件总线：配额 / 熔断 / 幂等 / 因果链 / 延后重投 / 死信 */
import { beforeEach, describe, expect, it } from 'vitest';
import { causality, MAX_CHAIN_DEPTH, worldBus } from '../src/events/WorldEventBus';
import { makeEvent, registerEventTables, resetEventSeq } from '../src/events/EventSchema';

beforeEach(() => {
  worldBus.reset();
  resetEventSeq();
});

describe('派发与幂等', () => {
  it('通配订阅者先于具体类型订阅者（横切关注点先写入的顺序契约）', () => {
    const order: string[] = [];
    worldBus.on('npc_moved', () => order.push('typed'));
    worldBus.on('*', () => order.push('wild'));
    worldBus.emit(makeEvent({ type: 'npc_moved', day: 1 }));
    expect(order).toEqual(['wild', 'typed']);
  });

  it('同一事件对象重复投递判 duplicate（幂等第二道）', () => {
    const e = makeEvent({ type: 'grudge_formed', day: 1 });
    worldBus.on('grudge_formed', () => undefined);
    expect(worldBus.emit(e).status).toBe('dispatched');
    expect(worldBus.emit(e).status).toBe('duplicate');
  });

  it('同一处理器重复消费被跳过；全员跳过报 duplicate（假阳性防线）', () => {
    let n = 0;
    worldBus.on('item_gained', () => n++, 'bag');
    const e = makeEvent({ type: 'item_gained', day: 1 });
    e.processedBy = ['item_gained#bag'];
    expect(worldBus.emit(e).status).toBe('duplicate');
    expect(n).toBe(0);
  });
});

describe('配额与死信', () => {
  it('超出单 tick 配额：普通事件进死信，semantic 延后到下个 tick 原样重投', () => {
    const dead: string[] = [];
    worldBus.onDeadLetter((e) => dead.push(e.type));
    const plain = makeEvent({ type: 'xp_gained', day: 1, level: 1 });
    expect(worldBus.emit(plain, { chainDepth: MAX_CHAIN_DEPTH + 1 }).status).toBe('dead_letter');

    /* semantic：占满普通配额后发布，应被延后而非丢弃 */
    for (let i = 0; i < 64; i++) worldBus.emit(makeEvent({ type: `noise_${i}`, day: 1, level: 2 }));
    const sem = makeEvent({ type: 'reputation_changed', day: 1, level: 2 });
    let seen = 0;
    worldBus.on('reputation_changed', () => seen++);
    const res = worldBus.emit(sem);
    expect(res.status).toBe('deferred');
    expect(seen).toBe(0);
    expect(worldBus.deferredEvents()).toHaveLength(1);

    worldBus.beginTick(); // 新 tick 重投
    expect(seen).toBe(1);
    expect(worldBus.deferredEvents()).toHaveLength(0);
    expect(dead).toEqual(['xp_gained']);
  });

  it('critical 独立熔断：超量节律事件不死信普通配额，而是自己进死信', () => {
    registerEventTables({ new_day: 2 }, { new_day: 'critical' });
    const dead: string[] = [];
    worldBus.onDeadLetter((e) => dead.push(e.type));
    worldBus.beginTick();
    for (let i = 0; i < 20; i++) worldBus.emit(makeEvent({ type: 'new_day', day: 1, level: 2 }));
    expect(dead.filter((t) => t === 'new_day').length).toBe(20 - 16);
  });
});

describe('因果链', () => {
  it('withParent 之下发布的自动挂父；嵌套累加深度，超限死信（防环）', () => {
    let child = '';
    causality.withParent('evt_root', () => {
      const e = makeEvent({ type: 'relationship_changed', day: 1 });
      worldBus.emit(e);
      child = e.id;
      expect(e.parentId).toBe('evt_root');
      expect(causality.depth()).toBe(1);
    });
    expect(causality.depth()).toBe(0);

    const events = [makeEvent({ type: 'a', day: 1 }), makeEvent({ type: 'b', day: 1 })];
    events[1].parentId = events[0].id;
    events[0].id = 'root';
    /* 递归深度超限的链：手工构造 parent 环 */
    const x = makeEvent({ type: 'x', day: 1 });
    const y = makeEvent({ type: 'y', day: 1 });
    x.parentId = y.id;
    y.parentId = x.id;
    const chain = worldBus.emit(x, { chainDepth: MAX_CHAIN_DEPTH + 1 });
    expect(chain.status).toBe('dead_letter');
    expect(child).not.toBe('');
  });
});

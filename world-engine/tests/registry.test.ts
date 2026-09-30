/* ============================================================
   V0.9 · World Registry 与多世界隔离不变量（W9.2/W9.3，方案 §42）
   —— 本文件是 V0.9 的存在证明：同进程两个世界，事件/事件 id 序号
   互不可见（DR-001 兑现）。rng/scheduler 为进程级共享设施（DR-001
   语义：执行基础设施，非世界状态），不在隔离断言之列。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import {
  createWorld,
  createWorldRegistry,
  WorldRegistryError,
  worldBus,
  makeEvent,
} from '../src/index';

describe('W9.2 · 双世界隔离不变量（DR-001 兑现）', () => {
  it('事件互不可见：A 的事实不进 B 的世界环，反之亦然', () => {
    const registry = createWorldRegistry();
    const a = registry.create({ worldId: 'alpha' });
    const b = registry.create({ worldId: 'beta' });

    a.executeCommand({ type: 'move', targetId: 'forest' });
    b.executeCommand({ type: 'move', targetId: 'market' });

    const aTypes = a.getEvents(50).map((e) => `${e.type}@${e.id}`);
    const bTypes = b.getEvents(50).map((e) => `${e.type}@${e.id}`);
    expect(aTypes.some((t) => t.includes('player_moved'))).toBe(true);
    expect(bTypes.some((t) => t.includes('player_moved'))).toBe(true);
    /* 隔离核心断言：环内没有任何**同一条**事实（对象同一性）；事件 id 分域生成，
       两世界的首事件都叫 evt_1_1——域限定语义，不是碰撞 */
    expect(a.getEvents().every((e) => !b.getEvents().includes(e))).toBe(true);
    expect(a.getEvents().at(-1)!.id).toBe('evt_1_1');
    expect(b.getEvents().at(-1)!.id).toBe('evt_1_1');
  });

  it('事件 id 序号分域：A/B 各自从 evt_1_1 起算，互不推进', () => {
    const registry = createWorldRegistry();
    const a = registry.create({ worldId: 'a' });
    const b = registry.create({ worldId: 'b' });
    a.emitEvent({ type: 'a_fact' });
    expect(a.getEvents()[0].id).toBe('evt_1_1');
    expect(b.emitEvent({ type: 'b_fact' }).id).toBe('evt_1_1'); // b 的序号未被 a 推动
    b.emitEvent({ type: 'b_fact_2' });
    expect(b.getEvents()[0].id).toBe('evt_1_2');
    expect(a.getEvents()[0].id).toBe('evt_1_1'); // a 不受影响
  });

  it('总线互不可见：A 的订阅者收不到 B 的事实', () => {
    const registry = createWorldRegistry();
    const a = registry.create({ worldId: 'a' });
    const b = registry.create({ worldId: 'b' });
    const aSeen: string[] = [];
    const bSeen: string[] = [];
    a.bus.on('marker_event', (e) => aSeen.push(e.id));
    b.bus.on('marker_event', (e) => bSeen.push(e.id));

    a.bus.emit(makeEvent({ type: 'marker_event', day: 1 }));
    expect(aSeen).toHaveLength(1);
    expect(bSeen).toHaveLength(0);
    b.bus.emit(makeEvent({ type: 'marker_event', day: 1 }));
    expect(bSeen).toHaveLength(1);
    expect(aSeen).toHaveLength(1);
  });

  it('全局缺省作用域与隔离世界互不串扰（既有宿主零改动的保护断言）', () => {
    const registry = createWorldRegistry();
    const isolated = registry.create({ worldId: 'iso' });
    const globalSeen: string[] = [];
    const stop = worldBus.on('*', (e) => globalSeen.push(e.id));

    isolated.executeCommand({ type: 'move', targetId: 'forest' });
    expect(globalSeen).toEqual([]); // 隔离世界的事实不进全局总线

    createWorld({ worldId: 'legacy' }).executeCommand({ type: 'move', targetId: 'plaza2' });
    expect(globalSeen.length).toBeGreaterThan(0); // 缺省作用域世界照常进全局总线
    stop();
  });
});

describe('W9.3 · WorldRegistry', () => {
  it('create/get/list/close；worldId 必填唯一', () => {
    const registry = createWorldRegistry();
    expect(registry.list()).toHaveLength(0);
    expect(() => registry.create({ worldId: '' })).toThrow(WorldRegistryError);
    const a = registry.create({ worldId: 'a' });
    expect(() => registry.create({ worldId: 'a' })).toThrow(WorldRegistryError);
    expect(registry.get('a')).toBe(a);
    expect(registry.list()).toHaveLength(1);
    expect(registry.close('a')).toBe(true);
    expect(registry.get('a')).toBeNull();
    expect(registry.close('a')).toBe(false);
  });

  it('隔离作用域强制：注册表创建的世界永不落在全局总线上', () => {
    const registry = createWorldRegistry();
    const w = registry.create({ worldId: 'forced' });
    const seen: string[] = [];
    const stop = worldBus.on('*', (e) => seen.push(e.id));
    w.executeCommand({ type: 'move', targetId: 'forest' });
    expect(seen).toEqual([]);
    stop();
  });
});

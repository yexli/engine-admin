/* 状态容器：唯一入口 / 节流落盘 / 分片往返 / 事件序号随档走 */
import { beforeEach, describe, expect, it } from 'vitest';
import { scheduler } from '../src/scheduler';
import { resetEventSeq, setEventSeq } from '../src/events/EventSchema';
import { createBaseState, createWorldContainer, SAVE_THROTTLE_MS } from '../src/state/WorldState';
import { splitShards, mergeShards, isShardedMain } from '../src/state/Shards';
import { InMemoryWorldStorage, type SavePort } from '../src/state/storage';
import type { EngineWorldState } from '../src/types';

beforeEach(() => {
  resetEventSeq();
});

describe('WorldState 容器', () => {
  it('need：未开局抛错，开局后返回同一状态', () => {
    const c = createWorldContainer<EngineWorldState>();
    expect(() => c.need()).toThrow(/尚未初始化/);
    const s = createBaseState({ worldId: 'w1' });
    c.core.S = s;
    expect(c.need()).toBe(s);
  });

  it('无介质时 save 静默跳过（与宿主既有行为一致）', () => {
    const c = createWorldContainer<EngineWorldState>();
    c.core.S = createBaseState();
    expect(() => c.save()).not.toThrow();
    expect(() => c.sync()).not.toThrow();
  });

  it('save 落盘前把事件序号写进状态（序号随档走）', () => {
    const store = new InMemoryWorldStorage<EngineWorldState>();
    const c = createWorldContainer<EngineWorldState>({ getSavePort: () => store });
    c.core.S = createBaseState();
    setEventSeq(7);
    c.save();
    expect(store.load()!.evtSeq).toBe(7);
  });

  it('节流：changed 立即发，落盘窗口内只写一次', async () => {
    const store = new InMemoryWorldStorage<EngineWorldState>();
    let changed = 0;
    const c = createWorldContainer<EngineWorldState>({
      getSavePort: () => store,
      onChanged: () => changed++,
    });
    c.core.S = createBaseState();
    let saves = 0;
    store.save = () => {
      saves++;
    };
    /* 真实定时器验尾节流 */
    c.sync();
    c.sync();
    c.sync();
    expect(changed).toBe(3); // changed 不被节流
    expect(saves).toBe(0); // 窗口内还没写
    await new Promise((r) => setTimeout(r, SAVE_THROTTLE_MS + 120));
    expect(saves).toBe(1); // 合并为一次
  });

  it('同步调度器注入时 sync 立即落盘（测试桩行为等价）', () => {
    const restore = scheduler.inject((_ms, fn) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    try {
      const store = new InMemoryWorldStorage<EngineWorldState>();
      const c = createWorldContainer<EngineWorldState>({ getSavePort: () => store });
      c.core.S = createBaseState();
      c.sync();
      expect(store.load()).not.toBeNull();
    } finally {
      restore();
    }
  });

  it('分片介质优走分片通道；不支持分片的介质整档落盘', () => {
    let shardWrites = 0;
    let wholeWrites = 0;
    const shardPort: SavePort<EngineWorldState> = {
      load: () => null,
      save: () => {
        wholeWrites++;
      },
      clear: () => undefined,
      saveShards: () => {
        shardWrites++;
      },
    };
    const plainPort: SavePort<EngineWorldState> = {
      load: () => null,
      save: () => {
        wholeWrites++;
      },
      clear: () => undefined,
    };
    const fields = [['npcs', () => ({})], ['cases', () => []]] as const;
    const c1 = createWorldContainer<EngineWorldState>({ getSavePort: () => shardPort, shardFields: fields });
    c1.core.S = createBaseState();
    c1.save();
    expect(shardWrites).toBe(1);
    expect(wholeWrites).toBe(0);

    const c2 = createWorldContainer<EngineWorldState>({ getSavePort: () => plainPort, shardFields: fields });
    c2.core.S = createBaseState();
    c2.save();
    expect(wholeWrites).toBe(1);
  });

  it('宿主可注入自己的容器对象（额外槽位保留，如战斗态）', () => {
    const holder = { S: null as EngineWorldState | null, CB: null as unknown };
    const c = createWorldContainer<EngineWorldState>({ holder });
    c.core.S = createBaseState();
    expect(holder.S).not.toBeNull();
    expect(c.core).toBe(holder);
    holder.CB = { round: 1 };
    expect((c.core as typeof holder).CB).toEqual({ round: 1 });
  });

  it('世界史随 SavePort 往返（§43：世界事实可持久化追溯）', () => {
    const store = new InMemoryWorldStorage<EngineWorldState>();
    /* 无世界史时读回 null（介质未写过 ≠ 空数组：宿主据此区分「没写过」与「写空」） */
    expect(store.loadWorldLog()).toBeNull();
    store.saveWorldLog([{ id: 'evt_1_1', type: 'world_opened' }]);
    expect(store.loadWorldLog()).toEqual([{ id: 'evt_1_1', type: 'world_opened' }]);
    /* 重写覆盖旧批；clear 连世界史一起清（世界重置不留幽灵账） */
    store.saveWorldLog([]);
    expect(store.loadWorldLog()).toBeNull();
    store.saveWorldLog([{ id: 'evt_1_2', type: 'npc_moved' }]);
    store.clear();
    expect(store.load()).toBeNull();
    expect(store.loadWorldLog()).toBeNull();
  });
});

describe('存档分片', () => {
  const fields = [
    ['npcs', () => ({})],
    ['memories', () => ({})],
    ['cases', () => []],
  ] as const;

  it('拆掉增长表后主档不再含它们；拼回时缺片补空', () => {
    const s = createBaseState();
    (s as unknown as Record<string, unknown>).memories = { npc_1: [{ x: 1 }] };
    s.npcs['npc_1'] = { att: 5, mem: [], met: true };
    (s as unknown as Record<string, unknown>).cases = [{ id: 'c1' }];

    const shards = splitShards(s, fields);
    expect('npcs' in (shards.main as Record<string, unknown>)).toBe(false);
    expect(shards.npcs).toEqual({ npc_1: { att: 5, mem: [], met: true } });
    expect(shards.cases).toEqual([{ id: 'c1' }]);

    const merged = mergeShards<EngineWorldState>({ main: shards.main }, fields);
    expect(merged.npcs).toEqual({}); // 缺片归零，不报废
    expect((merged as unknown as Record<string, unknown>).cases).toEqual([]);
  });

  it('拼回完整分片 = 原状态（浅拷贝语义）', () => {
    const s = createBaseState();
    s.npcs['a'] = { att: 1, mem: [], met: false };
    (s as unknown as Record<string, unknown>).memories = { a: [] };
    (s as unknown as Record<string, unknown>).cases = [{ id: 'c0' }];
    const merged = mergeShards<EngineWorldState>(splitShards(s, fields), fields);
    expect(merged).toEqual(s);
  });

  it('isShardedMain：旧整档（含 npcs）判假，新主档（无 npcs）判真', () => {
    expect(isShardedMain(createBaseState())).toBe(false);
    expect(isShardedMain(splitShards(createBaseState(), fields).main)).toBe(true);
    expect(isShardedMain(null)).toBe(false);
  });
});

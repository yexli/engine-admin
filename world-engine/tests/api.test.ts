/* World API 门面：createWorld 最小 API + 存档往返 + 游戏规则注册 */
import { beforeEach, describe, expect, it } from 'vitest';
import { worldBus } from '../src/events/WorldEventBus';
import { resetEventSeq } from '../src/events/EventSchema';
import { createWorld } from '../src/api/WorldAPI';
import { InMemoryWorldStorage } from '../src/state/storage';
import type { EngineWorldState, WorldRule } from '../src';

beforeEach(() => {
  worldBus.reset();
  resetEventSeq();
});

describe('createWorld（§63 最小 API）', () => {
  it('创建世界 → 读状态 → 执行命令 → 读事件', () => {
    const world = createWorld({ worldId: 'demo' });
    expect(world.worldId).toBe('demo');
    expect(world.getState()?.worldId).toBe('demo');

    const r = world.executeCommand({ type: 'move', actorId: 'player', targetId: 'forest' });
    expect(r.ok).toBe(true);
    expect(world.query.get_location()).toBe('forest');

    const events = world.getEvents();
    expect(events[0].type).toBe('player_moved');
    expect(events[0].actor).toBe('player');
  });

  it('查询面：时间 / 天气 / 实体 / 见闻', () => {
    const world = createWorld({ worldId: 'demo', playerName: '云生' });
    world.executeCommand({ type: 'spawn_entity', payload: { id: 'lita', name: '莉安', kind: 'npc' } });
    world.mutate.pushLog('你抵达中央广场。');

    expect(world.query.get_player()?.name).toBe('云生');
    expect(world.query.get_entities()).toEqual(['lita']);
    expect(world.query.get_entity('lita')?.met).toBe(false);
    expect(world.query.get_time()?.tick).toBe(16);
    expect(world.query.get_weather()).toBe('晴');
    expect(world.query.get_log().length).toBe(1);
  });

  it('推进时间 → 状态前进 + 事件入环', () => {
    const world = createWorld({ worldId: 'demo' });
    const t0 = world.getState()!.t;
    world.advanceTime(10);
    expect(world.getState()!.t).toBe(t0 + 10);
    expect(world.getEvents().some((e) => e.type === 'time_advanced')).toBe(true);
  });

  it('游戏注册自己的规则：拒绝引擎不认识的行为而不改引擎', () => {
    const world = createWorld<EngineWorldState>({ worldId: 'demo' });
    world.registerRule({
      name: 'PrayRule',
      for: 'pray',
      apply(ctx) {
        ctx.mutate.rep('temple', 5);
        ctx.emit({ type: 'prayer_answered', actor: ctx.command.actorId });
      },
    } as WorldRule<EngineWorldState>);
    /* 声望键由游戏数据声明（引擎 rep 原语只增量已知键——与天穹同语义） */
    world.getState()!.rep['temple'] = 0;
    const r = world.executeCommand({ type: 'pray' });
    expect(r.ok).toBe(true);
    expect(world.getState()!.rep['temple']).toBe(5);
    expect(world.getEvents()[0].type).toBe('prayer_answered');
  });

  it('setSavePort + 内存介质：命令链后的状态可读回', () => {
    const store = new InMemoryWorldStorage<EngineWorldState>();
    const world = createWorld<EngineWorldState>({ worldId: 'w-001', savePort: store });
    world.executeCommand({ type: 'move', targetId: 'market' });
    world.container.save();

    const loaded = store.load();
    expect(loaded?.worldId).toBe('w-001');
    expect(loaded?.player.loc).toBe('market');
  });

  it('emitEvent：系统级事实进总线与事件环，day/tick 自动补全', () => {
    const world = createWorld({ worldId: 'demo' });
    const e = world.emitEvent({ type: 'world_opened' });
    expect(e.day).toBe(1);
    expect(e.tick).toBe(16);
    expect(world.getEvents()[0].type).toBe('world_opened');
  });

  it('emitEvent：事件环单次记账（总线订阅已入环，门面不直推——M4.3 缺陷回归）', () => {
    const world = createWorld({ worldId: 'demo' });
    const e = world.emitEvent({ type: 'world_opened' });
    const count = world.getEvents().filter((x) => x.id === e.id).length;
    expect(count).toBe(1);
  });
});

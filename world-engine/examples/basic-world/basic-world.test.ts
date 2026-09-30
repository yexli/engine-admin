/* ============================================================
   Basic World · 最小可运行世界（方案 §36 的验收场景）
   ------------------------------------------------------------
   创建世界 → 创建玩家 / NPC / 地点 → 推进时间 → 移动玩家 →
   修改 NPC 状态 → 产生事件 → 读取世界状态 → 存档读回。
   World Engine 脱离天穹独立完成这一整圈——这是本阶段的存在证明。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { createWorld } from '../../src/api/WorldAPI';
import { InMemoryWorldStorage } from '../../src/state/storage';
import { worldBus } from '../../src/events/WorldEventBus';
import { resetEventSeq } from '../../src/events/EventSchema';
import { rng } from '../../src/rng';
import type { EngineWorldState } from '../../src';

beforeEach(() => {
  worldBus.reset();
  resetEventSeq();
  rng.seed(42);
});

describe('basic-world · 一日巡礼', () => {
  it('创建世界 → 玩家进入森林 → 时间推进 → NPC 状态 → 事件 → 读档', () => {
    /* 1. 创建世界（地点表归游戏：引擎只需要字符串 id） */
    const store = new InMemoryWorldStorage<EngineWorldState>();
    const world = createWorld<EngineWorldState>({
      worldId: 'basic-001',
      playerName: '云生',
      startLoc: 'plaza',
      savePort: store,
    });

    /* 2. 创建 NPC（地点是纯字符串：'plaza' / 'forest'） */
    expect(world.executeCommand({ type: 'spawn_entity', payload: { id: 'lita', name: '莉安', kind: 'npc' } }).ok).toBe(true);
    expect(world.query.get_entities()).toEqual(['lita']);

    /* 3. 玩家移动 → PlayerMoved */
    const moved = world.executeCommand({ type: 'move', actorId: 'player', targetId: 'forest' });
    expect(moved.ok).toBe(true);
    expect(world.query.get_location()).toBe('forest');
    expect(world.getEvents()[0].type).toBe('player_moved');

    /* 4. 时间推进 → TimeAdvanced（逐刻的衰减 / 边界事件由时钟发布） */
    const t0 = world.getState()!.t;
    expect(world.advanceTime(8).ok).toBe(true);
    expect(world.getState()!.t).toBe(t0 + 8);
    expect(world.getEvents().some((e) => e.type === 'time_advanced')).toBe(true);

    /* 5. 修改 NPC 状态 → NPCAttitudeShift */
    world.executeCommand({ type: 'set_attitude', targetId: 'lita', amount: 20 });
    expect(world.query.get_entity('lita')?.att).toBe(20);
    expect(world.getEvents()[0].type).toBe('npc_attitude_shift');

    /* 6. 世界状态可读 */
    const s = world.getState()!;
    expect(s.player.name).toBe('云生');
    expect(s.player.loc).toBe('forest');
    expect(s.t).toBe(t0 + 8);
    expect(s.npcs['lita'].att).toBe(20);

    /* 7. 存档 → 读回 */
    world.container.save();
    const loaded = store.load()!;
    expect(loaded.worldId).toBe('basic-001');
    expect(loaded.player.loc).toBe('forest');
    expect(loaded.npcs['lita'].att).toBe(20);
    expect(loaded.evtSeq).toBeGreaterThan(0);
  });

  it('不配任何模型、不装任何 UI，同一份引擎照常运行', () => {
    /* 引擎核心零 AI / 零 UI 依赖：createWorld 之后直接跑命令链就是证明 */
    const world = createWorld({ worldId: 'bare' });
    const r = world.executeCommand({ type: 'move', targetId: 'docks' });
    expect(r.ok).toBe(true);
    expect(world.query.get_time()).not.toBeNull();
  });
});

/* ============================================================
   W8.4b · 铁与沙 × world-memory：§16 数据流闭环
   ------------------------------------------------------------
   世界事实流 → MemoryEngine 摄取（感知边界）→ 检索喂 AI →
   AI 的建议落成 Command → 世界状态改变。
   记忆引擎全程只读事实流，对世界的影响只经命令链——§16 铁律。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { createWorld, InMemoryWorldStorage } from '../../src/index';
import { worldBus } from '../../src/events/WorldEventBus';
import { resetEventSeq } from '../../src/events/EventSchema';
import { rng } from '../../src/rng';
import { MemoryEngine, InMemoryMemoryStorage } from '../../memory/src/index';
import type { EngineWorldState } from '../../src/index';

beforeEach(() => {
  worldBus.reset();
  resetEventSeq();
  rng.seed(7);
});

describe('second-game × world-memory · 记忆闭环', () => {
  it('事实流 → 摄取 → 检索喂 AI → Command → 世界状态（§16 闭环）', async () => {
    const game = createWorld<EngineWorldState>({
      worldId: 'iron-and-sand-mem',
      playerName: '灰烬',
      startLoc: 'caravanserai',
      savePort: new InMemoryWorldStorage<EngineWorldState>(),
    });
    game.executeCommand({ type: 'spawn_entity', payload: { id: 'guard', name: '守卫老哈', kind: 'npc' } });

    /* 记忆引擎挂到世界事实流上（宿主桥接：worldBus → ingest，只读方向） */
    const memory = new MemoryEngine({ save: new InMemoryMemoryStorage() });
    worldBus.on('*', (e) => {
      memory.ingestFact(e); // WorldEvent 结构化满足 WorldFact
    });

    /* 世界里发生一起盗窃（守卫在场目击） */
    game.emitEvent({
      type: 'item_stolen',
      actor: 'petty_thief',
      target: 'guard',
      location: 'caravanserai',
      witnesses: ['guard'],
      data: { importance: 0.8 },
    });
    expect(memory.stats().total).toBe(1); // 守卫记住了这件事

    /* 宿主 AI 检索守卫的记忆 → 生成建议 → 落成 Command（§45：AI 不直改状态） */
    const recalls = await memory.recall('guard', 'theft 被偷', { day: 1 });
    expect(recalls.length).toBe(1);
    const suggestion = `目击盗窃：${recalls[0].text}`;
    expect(suggestion).toContain('petty_thief');

    const cmd = game.executeCommand({ type: 'set_attitude', targetId: 'guard', amount: -15 });
    expect(cmd.ok).toBe(true);
    expect(game.query.get_entity('guard')!.att).toBe(-15); // 唯一写入口是命令链
  });

  it('时间推移 → 记忆衰减 → 检索弱化（遗忘可观测，世界不受影响）', async () => {
    const game = createWorld<EngineWorldState>({ worldId: 'iron-and-sand-mem2' });
    const memory = new MemoryEngine({
      save: new InMemoryMemoryStorage(),
      config: { decayPerDay: 0.6, forgetBelow: 0.5 },
    });
    worldBus.on('*', (e) => memory.ingestFact(e));
    game.emitEvent({ type: 'item_stolen', actor: 'rat', location: 'docks', witnesses: ['dockwatch'], data: { importance: 0 } });

    game.advanceTime(96); // 两个世界日过去（48 刻/日）
    const day = game.query.get_time()!.day;
    memory.tickDay(day - 1); // 基线 tick（首个 tick 只记水位不衰减）
    memory.tickDay(day); // 过去 1 日：0.9 无关，witness 1.0 - 0.6 = 0.4 < 0.5 → 遗忘

    expect((await memory.recall('dockwatch', 'item_stolen')).length).toBe(0); // 已淡忘
    expect(game.query.get_location()).toBe('plaza'); // 记忆系统没有碰世界一根手指
  });
});

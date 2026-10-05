/* P3 卡片7：个体 tick 焦点分域锁 + 有界并发——同 NPC 串行、不同 NPC 并行 */
import { describe, expect, it } from 'vitest';
import { createEvolutionJournal } from '../src/evolution/journal.ts';
import { createEvolutionRuntime } from '../src/evolution/runtime.ts';
import { FULL_CORE_POLICY, type WakePlan } from '../src/index.ts';
import type { EngineClient } from '../src/types.ts';

function wakeFor(entityId: string): WakePlan {
  return {
    worldGrade: 'high',
    primaryEventId: 'evt_x',
    wakes: [{ entityId, grade: 'high', reasons: ['involved'] }],
    worthWaking: true,
  };
}

const STATE = {
  t: 48,
  weather: 'clear',
  player: { name: '旅人', loc: 'tavern', bag: [] },
  npcs: Object.fromEntries(['a', 'b', 'c'].map((id) => [id, { att: 0, met: true, type: 'npc', attributes: { location: 'tavern' } }])),
  relations: [],
};

function fakeEngine(): EngineClient {
  return {
    async getEvents() {
      return { ok: true as const, events: [{ id: 'evt_x', type: 'entity_updated', day: 1, actor: 'player' }] };
    },
    async getState() {
      return { ok: true as const, state: STATE };
    },
    async executeCommand(_worldId: string) {
      return { ok: true as const, result: { ok: true, events: ['evt_ok'] } };
    },
  } as unknown as EngineClient;
}

function slowDriver(ms: number, counter: { running: number; max: number }) {
  return {
    name: 'slow-driver',
    async propose(context: import("../src/evolution/types.ts").EvolutionContext) {
      counter.running++;
      counter.max = Math.max(counter.max, counter.running);
      await new Promise((r) => setTimeout(r, ms));
      counter.running--;
      return {
        id: `prop_${context.worldId}_${context.builtAt}`,
        worldId: context.worldId,
        reason: 'ok',
        observations: [],
        changes: [],
        source: { type: 'ai' as const, model: 'slow' },
      };
    },
  };
}

describe('个体 tick 并发（P3 卡片7）', () => {
  it('不同 NPC 的 tick 互不阻塞（3 个 120ms tick 并行总耗时 < 300ms）', async () => {
    const counter = { running: 0, max: 0 };
    const rt = createEvolutionRuntime(
      { engine: fakeEngine(), policy: FULL_CORE_POLICY, cooldownMs: 0, driver: slowDriver(120, counter) },
      createEvolutionJournal(),
    );
    const t0 = Date.now();
    await Promise.all(['a', 'b', 'c'].map((npc) => rt.tick('w1', 'auto', { wakePlan: wakeFor(npc) })));
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(300); /* 串行应 >360ms */
    expect(counter.max).toBeGreaterThan(1); /* 有并行证据 */
  });

  it('同一 NPC 的并发 tick 仍串行（焦点锁）', async () => {
    const counter = { running: 0, max: 0 };
    const rt = createEvolutionRuntime(
      { engine: fakeEngine(), policy: FULL_CORE_POLICY, cooldownMs: 0, driver: slowDriver(80, counter) },
      createEvolutionJournal(),
    );
    await Promise.all([1, 2].map(() => rt.tick('w1', 'admin', { wakePlan: wakeFor('a') })));
    expect(counter.max).toBe(1); /* 同焦点从不重叠 */
  });
});

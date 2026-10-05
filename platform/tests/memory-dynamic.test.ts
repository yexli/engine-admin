/* P2 卡片5：MemoryRuntime 动态纳管/移除世界——运行中生效，无需重启平台 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryRuntime } from '../src/memory/runtime.ts';
import { createWorldMemoryService } from '../src/memory/service.ts';
import type { EngineClient } from '../src/types.ts';

interface FakeWorld {
  events: { id: string; type: string; day: number; actor?: string }[];
  state: { t?: number; player?: { loc?: string }; npcs?: Record<string, unknown>; seed?: number };
}

/** runtime 只消费 getEvents / getState 两个方法——最小假引擎 */
function fakeEngine(worlds: Map<string, FakeWorld>): EngineClient {
  return {
    async getEvents(worldId: string) {
      const w = worlds.get(worldId);
      if (!w) return { ok: false as const, status: 404, error: 'no such world' };
      return { ok: true as const, events: w.events };
    },
    async getState(worldId: string) {
      const w = worlds.get(worldId);
      if (!w) return { ok: false as const, status: 404, error: 'no such world' };
      return { ok: true as const, state: w.state };
    },
  } as unknown as EngineClient;
}

function mkWorld(id: string, eventCount = 1): [string, FakeWorld] {
  return [
    id,
    {
      events: Array.from({ length: eventCount }, (_, i) => ({ id: `${id}_evt_${i}`, type: 'entity_updated', day: 1, actor: 'player' })),
      state: { t: 48, player: { loc: 'village' }, npcs: {}, seed: 7 },
    },
  ];
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'memory-dynamic-'));
}

describe('MemoryRuntime 动态纳管（P2 卡片5）', () => {
  it('addWorld 后新世界被摄取守护（pollOnce 立即生效）', async () => {
    const dir = tmpDir();
    const worlds = new Map([mkWorld('w1', 0), mkWorld('w2', 2)]);
    const service = createWorldMemoryService({ dir: join(dir, 'memory') });
    const rt = createMemoryRuntime({ engine: fakeEngine(worlds), service, worlds: ['w1'] });
    rt.addWorld('w2');
    await rt.pollOnce();
    const st = rt.status().worlds.find((w) => w.worldId === 'w2');
    expect(st?.polls).toBe(1);
    expect(st?.ingestedTotal).toBeGreaterThan(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it('addWorld 幂等（重复添加不重建状态）', () => {
    const dir = tmpDir();
    const worlds = new Map([mkWorld('w1', 0)]);
    const service = createWorldMemoryService({ dir: join(dir, 'memory') });
    const rt = createMemoryRuntime({ engine: fakeEngine(worlds), service, worlds: ['w1'] });
    rt.addWorld('w1');
    rt.addWorld('w1');
    expect(rt.status().worlds).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it('removeWorld 后不再摄取（轮询遍历不含该世界）', async () => {
    const dir = tmpDir();
    const worlds = new Map([mkWorld('w1', 0), mkWorld('w2', 1)]);
    const service = createWorldMemoryService({ dir: join(dir, 'memory') });
    const rt = createMemoryRuntime({ engine: fakeEngine(worlds), service, worlds: ['w1', 'w2'] });
    await rt.pollOnce();
    const before = rt.status().worlds.find((w) => w.worldId === 'w2')!.polls;
    rt.removeWorld('w2');
    await rt.pollOnce();
    expect(rt.status().worlds.some((w) => w.worldId === 'w2')).toBe(false);
    /* w2 的 polls 计数随状态一起移除——世界不再被遍历 */
    expect(before).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it('removeWorld 不影响已有记忆数据（service 数据保留）', async () => {
    const dir = tmpDir();
    const worlds = new Map([mkWorld('w1', 1)]);
    const service = createWorldMemoryService({ dir: join(dir, 'memory') });
    const rt = createMemoryRuntime({ engine: fakeEngine(worlds), service, worlds: ['w1'] });
    await rt.pollOnce();
    console.log('[dbg] status:', JSON.stringify(rt.status()));
    console.log('[dbg] stats:', JSON.stringify(service.stats('w1')));
    expect(service.stats('w1')?.entries ?? 0).toBeGreaterThan(0);
    rt.removeWorld('w1');
    expect(service.stats('w1')?.entries ?? 0).toBeGreaterThan(0); /* 记忆仍在 */
    await expect(service.recallFor('w1', 'player', 'entity_updated')).resolves.toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
  });
});

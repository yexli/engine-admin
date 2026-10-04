/* ============================================================
   Runtime 分层测试（V2.4-03 · 方案 §七）
   ------------------------------------------------------------
   方案核心要求：**AI 不在线 → World 仍然可以运行**；依赖 AI 的行为
   在 AI unavailable 时 WAIT/DEFER，不能伪造 World Fact。

   World Runtime（时间/事件/调度/实体/规则/变更/触发/持久化）与
   AI Runtime（上下文/推理/提案/叙事/记忆检索/模型调用）分层验证：

     ① AI 完全不在线（驱动恒抛 model_unavailable）：
        玩家命令 / 日程对齐 / 记忆摄取 全部照跑（确定性面零 AI）；
        触发 tick → run = deferred（DEFER 语义，世界零影响）。
     ② 语义区分：model_unavailable → deferred；invalid_proposal → failed
        （AI 出错 ≠ 不可用）。
     ③ 模型恢复后 → 重试成功（DEFER 不阻塞恢复）。
     ④ AI 不伪造事实：deferred/failed 的 run 零事件落地。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import {
  NPC_EVOLUTION_POLICY,
  EvolutionDriverError,
  createEngineClient,
  createEvolutionJournal,
  createEvolutionRuntime,
  createMemoryRuntime,
  createScheduleRuntime,
  createScheduleStore,
  createTriggerRuntime,
  createWorldMemoryService,
  type EvolutionDriver,
  type EvolutionRuntime,
  type MemoryRuntime,
  type ScheduleRuntime,
  type TriggerRuntime,
} from '../src/index.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
let trigger: TriggerRuntime;
let schedule: ScheduleRuntime;
let memory: MemoryRuntime;
let evolution: EvolutionRuntime;
const WORLD = 'w-layer';

/** 可切换 AI 可用性：down = 恒抛 model_unavailable；up = 正常零提案 */
const ai = {
  available: false,
  calls: 0,
  driver: {
    name: 'layered-ai',
    async propose(context): Promise<import('../src/index.ts').EvolutionProposal> {
      if (!ai.available) throw new EvolutionDriverError('模型 API 不可达', 'model_unavailable');
      ai.calls++;
      return {
        id: `prop_${Date.now()}`,
        worldId: context.worldId,
        reason: 'AI 在线：无事发生',
        observations: [],
        changes: [],
        source: { type: 'ai' as const, model: 'layered-ai' },
      };
    },
  } as import('../src/index.ts').EvolutionDriver,
};

async function move(to: string): Promise<void> {
  const r = await engine.executeCommand(WORLD, { type: 'move', targetId: to });
  if (!r.ok || !r.result.ok) throw new Error(`move 被拒：${r.ok ? r.result.reason : r.error}`);
}

beforeAll(async () => {
  const registry = createWorldRegistry();
  const w = registry.create({
    worldId: WORLD,
    playerName: '旅人',
    startLoc: 'village',
    weather: 'clear',
    isolated: true,
    savePort: new InMemoryWorldStorage(),
    definition: {
      locations: [
        { id: 'village', attributes: { desc: '村庄' } },
        { id: 'tavern', attributes: { desc: '酒馆' } },
      ],
      relations: [{ source: 'milu', target: 'player', type: 'noticed', value: 20 }],
    },
  });
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } },
    { type: 'update_attribute', targetId: 'milu', payload: { key: 'goal', value: '经营酒馆' } },
  ]) {
    const r = w.executeCommand(c);
    if (!r.ok) throw new Error(`种子被拒：${JSON.stringify(r)}`);
  }
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });

  evolution = createEvolutionRuntime(
    { engine, driver: ai.driver, policy: NPC_EVOLUTION_POLICY, cooldownMs: 0 },
    createEvolutionJournal(),
  );
  trigger = createTriggerRuntime({ engine, evolution, worlds: [WORLD], log: () => {} });
  const store = createScheduleStore();
  store.set(WORLD, { milu: [{ from: 0, to: 16, location: 'village' }, { from: 16, to: 48, location: 'tavern' }] });
  schedule = createScheduleRuntime({ engine, store, worlds: [WORLD], log: () => {} });
  const memoryService = createWorldMemoryService();
  memory = createMemoryRuntime({ engine, service: memoryService, worlds: [WORLD], log: () => {} });
});

afterAll(async () => {
  await engineServer?.close();
});

describe('V2.4-03 分层验证：AI 完全不在线 → World 仍然运行', () => {
  it('确定性面全绿：玩家命令 / 日程对齐 / 记忆摄取（全部零 AI）', async () => {
    await move('tavern');
    await Promise.all([trigger.pollOnce(), schedule.pollOnce(), memory.pollOnce()]);
    /* 日程对齐（确定性）：tickOfDay=16 → 米露应在酒馆（种子即在此，对齐幂等） */
    const s = await engine.getState(WORLD);
    if (!s.ok) throw new Error(s.error);
    const st = s.state as { npcs: Record<string, { attributes?: Record<string, unknown> }> };
    expect(st.npcs.milu.attributes?.['location']).toBe('tavern');
    /* 记忆摄取（确定性）：种子与移动事实已入记忆 */
    const mem = memory.status().worlds[0]!;
    expect(mem.ingestedTotal).toBeGreaterThan(0);
    /* 玩家命令照常 */
    const r = await engine.executeCommand(WORLD, { type: 'update_attribute', targetId: 'player', payload: { key: 'money', value: 50 } });
    expect(r.ok && r.result.ok).toBe(true);
  });

  it('触发 tick → DEFER（deferred，不是 failed、不是伪造）', async () => {
    await move('village'); /* 玩家移动 → High → 唤醒 milu（有关系边）→ tick */
    await trigger.pollOnce();
    const run = evolution.runs(WORLD, 1)[0]!;
    expect(run.status).toBe('deferred'); /* 方案 §七 DEFER 语义 */
    expect(run.error).toContain('model_unavailable');
    expect(run.eventIds).toHaveLength(0); /* 不伪造世界事实 */
    const st = trigger.status().worlds[0]!;
    expect(st.ticksFired).toBeGreaterThanOrEqual(1);
  });

  it('语义区分：AI 出错（invalid_proposal）→ failed，不是 deferred', async () => {
    const journal = createEvolutionJournal();
    const badDriver: EvolutionDriver = {
      name: 'bad-json',
      async propose() {
        throw new EvolutionDriverError('提案不是 JSON', 'invalid_proposal');
      },
    };
    const bad = createEvolutionRuntime(
      { engine, driver: badDriver, policy: NPC_EVOLUTION_POLICY, cooldownMs: 0 },
      journal,
    );
    const run = await bad.tick(WORLD, 'admin');
    expect(run.status).toBe('failed'); /* AI 出错 ≠ 不可用 */
    expect(run.error).toContain('invalid_proposal');
  });

  it('模型恢复 → 重试成功（DEFER 不阻塞恢复；世界全程未被伪造）', async () => {
    ai.available = true;
    const runsBefore = evolution.runs(WORLD, 200).length;
    await move('tavern');
    await trigger.pollOnce();
    const runsAfter = evolution.runs(WORLD, 200);
    expect(runsAfter.length).toBe(runsBefore + 1);
    const latest = runsAfter[0]!;
    expect(latest.status).toBe('completed');
    expect(latest.eventIds).toHaveLength(0); /* 空提案：AI 判断无事发生（诚实） */
    /* AI 从未伪造事实：全程 AI 零事件落地 */
    for (const r of runsAfter) expect(r.eventIds.length).toBe(0);
  });
});

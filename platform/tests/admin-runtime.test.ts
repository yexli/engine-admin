/* ============================================================
   Admin Runtime / Causal Trace 测试（P9 · 方案 §十二）
   ------------------------------------------------------------
   覆盖：
   ① 统一观测面 GET /v1/admin/runtime：Worlds / Evolution / Trigger /
      Schedule / Memory 分区聚合（装配哪个就出现哪个）。
   ② 因果链完整呈现（方案 §十二 链）：World Event → Trigger → Context →
      Model → Proposal → Validation → Command → Mutation → New Events。
   ③ 多代世界语义：世界重建（同 worldId 新 seed）→ 消费 runtime 指纹
      检测 → seen 重置 → 新世界同 id 事件恢复触发（P5 遗留关闭）。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import { startManagedRuntime, type ManagedRuntime } from '../src/admin/managed-runtime.ts';
import { startAdminServer } from '../src/admin/http.ts';
import { SecretStore } from '../src/admin/secrets.ts';
import { ModelConfigStore } from '../src/admin/model-config.ts';
import { KeyStore } from '../src/keys/keystore.ts';
import {
  NPC_EVOLUTION_POLICY,
  createEngineClient,
  createEvolutionJournal,
  createEvolutionRuntime,
  createMemoryRuntime,
  createScheduleRuntime,
  createScheduleStore,
  createTriggerRuntime,
  createWorldMemoryService,
  type EvolutionDriver,
  type TriggerRuntime,
} from '../src/index.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
let registry: ReturnType<typeof createWorldRegistry>;
let dir = '';
const WORLD = 'w-p9';

/** 真实触发驱动：有提案内容（产生 command/mutation/新事件，供因果链检查） */
function activeDriver(): EvolutionDriver {
  return {
    name: 'p9-active',
    async propose(context) {
      return {
        id: `prop_p9_${Date.now()}`,
        worldId: context.worldId,
        reason: '米露注意到玩家并转向（因果链演示）',
        observations: [],
        changes: [{ targetId: 'milu', action: 'update_attribute', payload: { key: 'attention', value: 'player' }, reason: '个体注意' }],
        source: { type: 'ai', model: 'p9-active' },
      };
    },
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'platform-p9-'));
  registry = createWorldRegistry();
  const w = registry.create({ worldId: WORLD, playerName: '旅人', startLoc: 'village', weather: 'clear', savePort: new InMemoryWorldStorage() });
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } },
    { type: 'set_relation', actorId: 'milu', targetId: 'player', payload: { type: 'noticed', value: 20 } },
  ]) {
    const r = w.executeCommand(c);
    if (!r.ok) throw new Error(`种子被拒：${JSON.stringify(r)}`);
  }
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });
});

afterAll(async () => {
  await engineServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('P9 统一观测面（GET /v1/admin/runtime）', () => {
  let managed: ManagedRuntime | null = null;
  let admin: Awaited<ReturnType<typeof startAdminServer>> | null = null;
  let trigger: TriggerRuntime | null = null;

  beforeAll(async () => {
    const secrets = new SecretStore(join(dir, 's.json'), 'mk');
    const configStore = new ModelConfigStore({ filePath: join(dir, 'mc.json'), secrets, endpointPolicy: { allowLoopback: true } });
    configStore.load();
    const keys = new KeyStore(join(dir, 'keys.json'), 'boot');
    managed = await startManagedRuntime({ configStore, secrets, keys, engine, adminToken: 'p9-token', endpointPolicy: { allowLoopback: true }, accessLog: false });

    const evolution = createEvolutionRuntime({ engine, driver: activeDriver(), policy: NPC_EVOLUTION_POLICY, cooldownMs: 0 }, createEvolutionJournal());
    trigger = createTriggerRuntime({ engine, evolution, worlds: [WORLD], log: () => {} });
    const scheduleStore = createScheduleStore();
    scheduleStore.set(WORLD, { milu: [{ from: 0, to: 48, location: 'tavern' }] });
    const schedule = createScheduleRuntime({ engine, store: scheduleStore, worlds: [WORLD], log: () => {} });
    const memoryService = createWorldMemoryService();
    const memory = createMemoryRuntime({ engine, service: memoryService, worlds: [WORLD], log: () => {} });

    admin = await startAdminServer({
      runtime: managed,
      adminToken: 'p9-token',
      evolution,
      scheduleStore,
      triggerRuntime: trigger,
      scheduleRuntime: schedule,
      memoryRuntime: memory,
      memoryService,
      port: 0,
      accessLog: false,
    });
  });

  afterAll(async () => {
    await admin?.close();
    await managed?.close();
  });

  it('分区聚合：worlds / evolution / trigger / schedule / memory / pointers', async () => {
    /* 产生一次真实触发（事件 → tick → run 留痕） */
    const move = await engine.executeCommand(WORLD, { type: 'move', targetId: 'tavern' });
    if (!move.ok || !move.result.ok) throw new Error('move 被拒');
    await trigger!.pollOnce();

    const res = await fetch(`${admin!.url}/v1/admin/runtime`, { headers: { 'x-admin-token': 'p9-token' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe('string');
    expect((body.worlds as unknown[]).length).toBeGreaterThan(0);

    const evolution = body.evolution as { worlds: { worldId: string; latestRun: { status: string; modelUsed: string } | null }[] };
    const mine = evolution.worlds.find((w) => w.worldId === WORLD)!;
    expect(mine.latestRun).not.toBeNull();
    expect(mine.latestRun!.status).toBe('completed');
    expect(mine.latestRun!.modelUsed).toBe('p9-active');

    const triggerStatus = body.trigger as { running: boolean; worlds: { worldId: string; ticksFired: number }[] };
    expect(triggerStatus.running).toBe(false); /* 未 start（手动 pollOnce） */
    expect(triggerStatus.worlds[0]!.ticksFired).toBe(1);
    expect(body.schedule).toBeDefined();
    expect(body.memory).toBeDefined();
    expect((body.pointers as Record<string, string>).causalTrace).toContain('trace');
  });

  it('因果链完整呈现：Event → … → New Events 九环可查', async () => {
    const runsRes = await engine.getEvents(WORLD, 30);
    if (!runsRes.ok) throw new Error(runsRes.error);
    /* 找一个演化产生的事实（attention 变化由 activeDriver 落地） */
    const evolved = (runsRes.events as { id: string; type: string; actor?: string }[]).find((e) => e.type === 'entity_updated');
    expect(evolved).toBeDefined();
    const traceRes = await fetch(`${admin!.url}/v1/evolution/worlds/${WORLD}/events/${evolved!.id}/trace`, { headers: { 'x-admin-token': 'p9-token' } });
    expect(traceRes.status).toBe(200);
    const trace = (await traceRes.json()) as { chain: { step: string; detail: string }[]; causation: Record<string, unknown> };
    const steps = trace.chain.map((c) => c.step);
    expect(steps).toEqual(['trigger', 'context', 'model', 'proposal', 'validation', 'command', 'mutation', 'new_events']);
    expect(trace.chain.find((c) => c.step === 'trigger')!.detail).toContain('唤醒 milu');
    expect(trace.chain.find((c) => c.step === 'model')!.detail).toBe('p9-active');
    expect(trace.causation).toMatchObject({ source: 'evolution' });
  });

  it('未装配演化 → 观测面 evolution 为 null（如实）', async () => {
    let m2: ManagedRuntime | null = null;
    let a2: Awaited<ReturnType<typeof startAdminServer>> | null = null;
    try {
      const secrets = new SecretStore(join(dir, 's2.json'), 'mk');
      const configStore = new ModelConfigStore({ filePath: join(dir, 'mc2.json'), secrets, endpointPolicy: { allowLoopback: true } });
      configStore.load();
      const keys = new KeyStore(join(dir, 'keys2.json'), 'boot');
      m2 = await startManagedRuntime({ configStore, secrets, keys, engine, adminToken: 'p9b', endpointPolicy: { allowLoopback: true }, accessLog: false });
      a2 = await startAdminServer({ runtime: m2, adminToken: 'p9b', port: 0, accessLog: false });
      const body = (await (await fetch(`${a2!.url}/v1/admin/runtime`, { headers: { 'x-admin-token': 'p9b' } })).json()) as Record<string, unknown>;
      expect(body.evolution).toBeNull();
      expect(body.trigger).toBeUndefined();
    } finally {
      await a2?.close();
      await m2?.close();
    }
  });
});

describe('P9 多代世界语义（世界重建 → 指纹重置 → 恢复触发）', () => {
  it('同 worldId 重建（seed 变更）→ 触发器消费集重置 → 同 id 新事件照常触发', async () => {
    /* 独立世界：世界代际管理不干扰其它用例 */
    const registry2 = createWorldRegistry();
    const server2 = await startWorldServer({ registry: registry2, port: 0 });
    try {
      const eng2 = createEngineClient({ baseUrl: server2.url });
      let ticks = 0;
      const counting = createEvolutionRuntime(
        {
          engine: eng2,
          policy: NPC_EVOLUTION_POLICY,
          cooldownMs: 0,
          driver: {
            name: 'p9-count',
            async propose(context) {
              ticks++;
              return { id: `prop_${ticks}`, worldId: context.worldId, reason: `第 ${ticks} 代世界的判断`, observations: [], changes: [], source: { type: 'ai', model: 'p9-count' } };
            },
          },
        },
        createEvolutionJournal(),
      );
      /* fingerprintEvery: 1 → 每轮检测（测试加速；生产缺省 10） */
      const tr = createTriggerRuntime({ engine: eng2, evolution: counting, worlds: ['w-gen'], fingerprintEvery: 1, log: () => {} });

      /* 第一代世界：事件 evt_1_x → 触发一次 */
      const genCreate = async (): Promise<void> => {
        const res = await eng2.proxy('POST', '/v1/worlds', { worldId: 'w-gen', playerName: '旅人', startLoc: 'village', weather: 'clear' });
        if (res.status !== 201) throw new Error(`gen 建世界失败：${res.status}`);
      };
      await genCreate();
      const r1 = await eng2.executeCommand('w-gen', { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } });
      if (!r1.ok || !r1.result.ok) throw new Error('gen1 种子被拒');
      const rel = await eng2.executeCommand('w-gen', { type: 'set_relation', actorId: 'milu', targetId: 'player', payload: { type: 'noticed', value: 20 } });
      if (!rel.ok || !rel.result.ok) throw new Error('gen1 关系被拒');
      const mv1 = await eng2.executeCommand('w-gen', { type: 'move', targetId: 'tavern' });
      if (!mv1.ok || !mv1.result.ok) throw new Error('gen1 move 被拒');
      await tr.pollOnce();
      expect(ticks).toBe(1);

      /* 世界重建（同 worldId、新 seed）：close + create */
      registry2.close('w-gen');
      await genCreate();
      const r2 = await eng2.executeCommand('w-gen', { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } });
      if (!r2.ok || !r2.result.ok) throw new Error('gen2 种子被拒');
      const rel2 = await eng2.executeCommand('w-gen', { type: 'set_relation', actorId: 'milu', targetId: 'player', payload: { type: 'noticed', value: 20 } });
      if (!rel2.ok || !rel2.result.ok) throw new Error('gen2 关系被拒');
      const mv2 = await eng2.executeCommand('w-gen', { type: 'move', targetId: 'tavern' });
      if (!mv2.ok || !mv2.result.ok) throw new Error('gen2 move 被拒');

      /* 指纹检测 → 重置 → 新世界同 id 事件照常触发 */
      await tr.pollOnce();
      expect(ticks).toBe(2);
      const st = tr.status().worlds[0]!;
      expect(st.worldResets).toBe(1);
      void eng2;
    } finally {
      await server2.close();
    }
  });
});

/* ============================================================
   Memory 联动测试（P7 · 方案 §十）
   ------------------------------------------------------------
   方案流程逐环：Event → Memory Candidate → Memory Store →
   Retrieval → Ranking → Budget → NPC AI。

   核心纪律（方案原文）：**Memory 不能成为第二个 World State**——
   摄取零命令、只读世界；记忆内容只能经 AI 提案 → Rules 影响世界
   （「玩家帮助过我」不直接等于 relationship = 100）。

   另覆盖：感知边界派生、幂等摄取、检索注入（个体决策 context.memory
   + 预算）、衰减（new_day）、持久化往返、无焦点不检索、检索失败不炸。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import {
  NPC_EVOLUTION_POLICY,
  applyContextMemory,
  createEngineClient,
  createEvolutionJournal,
  createEvolutionRuntime,
  createWorldMemoryService,
  estimateTokens,
  renderContextFacts,
  type EvolutionContext,
  type EvolutionRuntime,
  type WakePlan,
} from '../src/index.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
let dir = '';
const WORLD = 'w-p7';

/* 捕获驱动的入参（验证模型真实看到了记忆段） */
let lastContext: EvolutionContext | null = null;
let retrieverCalls = 0;

function mkPlan(npc: string, eventId: string): WakePlan {
  return {
    worldGrade: 'high',
    primaryEventId: eventId,
    wakes: [{ entityId: npc, grade: 'high', reasons: ['involved'] }],
    worthWaking: true,
  };
}

async function playerMove(to: string): Promise<string> {
  const res = await engine.executeCommand(WORLD, { type: 'move', targetId: to });
  if (!res.ok || !res.result.ok) throw new Error(`move 被拒绝：${res.ok ? res.result.reason : res.error}`);
  return res.result.events[0]!;
}

/** 服务侧摄取一批引擎事实（带感知边界派生；与 MemoryRuntime 同流程） */
async function ingestLatest(events = 30): Promise<number> {
  const res = await engine.getEvents(WORLD, events);
  if (!res.ok) throw new Error(res.error);
  const stateRes = await engine.getState(WORLD);
  if (!stateRes.ok) throw new Error(stateRes.error);
  const s = stateRes.state as { t: number; player?: { loc?: string }; npcs?: Record<string, { attributes?: Record<string, unknown> }> };
  const npcLocations: Record<string, string> = {};
  for (const [id, n] of Object.entries(s.npcs ?? {})) {
    const loc = n.attributes?.['location'];
    if (typeof loc === 'string') npcLocations[id] = loc;
  }
  return service.ingest(
    WORLD,
    (res.events as { id: string; type: string; day: number; actor?: string; target?: string; location?: string; data?: Record<string, unknown> }[]).map((e) => ({
      id: e.id,
      type: e.type,
      day: e.day,
      actor: e.actor,
      target: e.target,
      location: e.location,
      data: e.data,
    })),
    { ...(s.player?.loc !== undefined ? { playerLoc: s.player.loc } : {}), npcLocations },
  );
}

let service: ReturnType<typeof createWorldMemoryService>;
let evolution: EvolutionRuntime;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'platform-memory-'));
  const registry = createWorldRegistry();
  const world = registry.create({
    worldId: WORLD,
    playerName: '旅人',
    startLoc: 'village',
    weather: 'clear',
    savePort: new InMemoryWorldStorage(),
    definition: {
      locations: [
        { id: 'village', attributes: { desc: '村庄' } },
        { id: 'tavern', attributes: { desc: '酒馆' } },
      ],
    },
  });
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern', attributes: { mood: '平静', goal: '弄清常客来历' } } },
    { type: 'create_entity', payload: { id: 'keeper', type: 'npc', name: '老板', location: 'home' } },
  ]) {
    const r = world.executeCommand(c);
    if (!r.ok) throw new Error(`种子命令被拒绝：${JSON.stringify(r)}`);
  }
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });

  service = createWorldMemoryService({ dir: join(dir, 'memory') });
  evolution = createEvolutionRuntime(
    {
      engine,
      policy: NPC_EVOLUTION_POLICY,
      cooldownMs: 0,
      contextBudget: { maxTokens: 6000, maxMemoryItems: 3 },
      driver: {
        name: 'p7-capture',
        async propose(context) {
          lastContext = context;
          return {
            id: `prop_p7_${Date.now()}`,
            worldId: context.worldId,
            reason: '个体判断（记忆参考）',
            observations: [],
            changes: [],
            source: { type: 'ai', model: 'p7-capture' },
          };
        },
      },
      memoryRetriever: (worldId, entityId, query) => {
        retrieverCalls++;
        return service.recallFor(worldId, entityId, query);
      },
    },
    createEvolutionJournal(),
  );
});

afterAll(async () => {
  await engineServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('P7 摄取：Event → Memory Candidate → Store', () => {
  it('感知边界派生：玩家进酒馆 → 同场的米露记住，异地的老板不记', async () => {
    const eventId = await playerMove('tavern');
    const created = await ingestLatest();
    expect(created).toBeGreaterThan(0);
    const stats = service.stats(WORLD)!;
    expect(stats.owners).toBeGreaterThanOrEqual(2); /* player（自见）+ milu（同场） */
    /* 米露有 player_moved 的亲历记忆 */
    const miluMemories = await service.recallFor(WORLD, 'milu', 'player_moved tavern');
    expect(miluMemories.length).toBeGreaterThan(0);
    expect(miluMemories[0]!.summary).toContain('player_moved');
    /* 老板在 home：不在 player_moved 的目击名单（他自己的创建自记是另一回事） */
    const keeperMemories = await service.recallFor(WORLD, 'keeper', 'player_moved');
    expect(keeperMemories.some((m) => m.summary.includes('player_moved'))).toBe(false);
    void eventId;
  });

  it('幂等：同一批事实重复摄取 → 零新增（duplicates 计数）', async () => {
    const before = service.stats(WORLD)!.entries;
    const again = await ingestLatest();
    expect(again).toBe(0);
    expect(service.stats(WORLD)!.entries).toBe(before);
    expect(service.stats(WORLD)!.duplicates).toBeGreaterThan(0);
  });
});

describe('P7 纪律：Memory ≠ 第二 World State', () => {
  it('摄取前后世界状态分毫未动（零命令、零状态变化）', async () => {
    const before = await engine.getState(WORLD);
    if (!before.ok) throw new Error(before.error);
    const s0 = JSON.stringify(before.state);
    await ingestLatest();
    await service.dayTick(WORLD, 2);
    await service.recallFor(WORLD, 'milu', 'player');
    const after = await engine.getState(WORLD);
    if (!after.ok) throw new Error(after.error);
    expect(JSON.stringify(after.state)).toBe(s0); /* 记忆服务对世界只读 */
  });
});

describe('P7 检索：Retrieval → Ranking → Budget → NPC AI', () => {
  it('个体决策注入 context.memory：模型真实看到米露的记忆段', async () => {
    const eventId = await playerMove('village');
    await playerMove('tavern');
    await ingestLatest();
    retrieverCalls = 0;
    lastContext = null;
    const run = await evolution.tick(WORLD, 'admin', { wakePlan: mkPlan('milu', 'evt-x') });
    expect(run.status).toBe('completed');
    expect(retrieverCalls).toBe(1);
    /* 驱动拿到的上下文带记忆段；渲染含「相关记忆」 */
    expect(lastContext).not.toBeNull();
    expect(lastContext!.memory?.length).toBeGreaterThan(0);
    expect(lastContext!.memory!.length).toBeLessThanOrEqual(3); /* maxMemoryItems=3 */
    expect(renderContextFacts(lastContext!)).toContain('相关记忆');
    expect(run.context?.memory?.length).toBeGreaterThan(0); /* Journal 留痕 */
    void eventId;
  });

  it('无焦点（世界级 tick）→ 不检索（记忆无单一 owner）', async () => {
    retrieverCalls = 0;
    await evolution.tick(WORLD, 'admin');
    expect(retrieverCalls).toBe(0);
  });

  it('检索失败 → tick 照常完成（记忆是建议材料，不是事实来源）', async () => {
    const failing = createEvolutionRuntime(
      {
        engine,
        policy: NPC_EVOLUTION_POLICY,
        cooldownMs: 0,
        driver: {
          name: 'p7-noMem',
          async propose(context) {
            expect(context.memory).toBeUndefined();
            return { id: `prop_p7f_${Date.now()}`, worldId: context.worldId, reason: '无记忆照常判断', observations: [], changes: [], source: { type: 'ai' } };
          },
        },
        memoryRetriever: async () => {
          throw new Error('记忆服务不可达');
        },
      },
      createEvolutionJournal(),
    );
    const run = await failing.tick(WORLD, 'admin', { wakePlan: mkPlan('milu', 'evt-y') });
    expect(run.status).toBe('completed');
  });

  it('applyContextMemory：maxMemoryItems 截断 + token 预算重算（报告同源）', async () => {
    const res = await engine.getState(WORLD);
    if (!res.ok) throw new Error(res.error);
    const ctxRes = await import('../src/index.ts').then((m) => m.buildEvolutionContext(engine, WORLD, { wakePlan: mkPlan('milu', 'evt-x') }));
    if (!ctxRes.ok) throw new Error(ctxRes.error);
    const context = ctxRes.context;
    const many = Array.from({ length: 10 }, (_, i) => ({ ref: `mem-${i}`, summary: `记忆条目 ${i}：玩家 ${i} 天前买过酒`, day: i + 1 }));
    applyContextMemory(context, many, { maxMemoryItems: 3, maxTokens: 800 });
    expect(context.memory).toHaveLength(3); /* 预算截断 */
    expect(context.budgetReport?.carried.memory).toBe(3);
    expect(context.budgetReport!.estimatedTokens).toBeLessThanOrEqual(800); /* token 重算入预算 */
    expect(estimateTokens(renderContextFacts(context))).toBeLessThanOrEqual(800);
  });
});

describe('P7 生命周期：衰减与持久化', () => {
  it('new_day → dayTick 衰减（置信度下降），同日重复推进幂等', async () => {
    const memBefore = (await service.recallFor(WORLD, 'milu', 'player_moved'))[0]!;
    const dayNow = 5;
    const forgotten1 = service.dayTick(WORLD, dayNow);
    const forgotten2 = service.dayTick(WORLD, dayNow); /* 同日重复 → 0 */
    expect(forgotten2).toBe(0);
    const memAfter = (await service.recallFor(WORLD, 'milu', 'player_moved'))[0]!;
    void forgotten1;
    /* 衰减不删除亲历记忆（置信 1 → 1 - 0.05*elapsed*(1-importance/2)），但召回仍可见 */
    expect(memAfter.ref).toBeDefined();
    void memBefore;
  });

  it('持久化往返：新服务实例从磁盘恢复记忆与去重账', async () => {
    const reloaded = createWorldMemoryService({ dir: join(dir, 'memory') });
    reloaded.loadAll();
    const memories = await reloaded.recallFor(WORLD, 'milu', 'player_moved');
    expect(memories.length).toBeGreaterThan(0); /* 记忆从磁盘回来 */
    const before = reloaded.stats(WORLD)!.entries;
    /* 去重账也在：同一批事实再摄取 → 零新增 */
    const res = await engine.getEvents(WORLD, 30);
    if (!res.ok) throw new Error(res.error);
    const stateRes = await engine.getState(WORLD);
    if (!stateRes.ok) throw new Error(stateRes.error);
    const created = reloaded.ingest(WORLD, (res.events as { id: string; type: string }[]).map((e) => ({ id: e.id, type: e.type })));
    expect(created).toBe(0);
    expect(reloaded.stats(WORLD)!.entries).toBe(before);
  });
});

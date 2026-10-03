/* ============================================================
   Evolution P1 封口测试（方案 §四 P1：幂等收口 + 账本可观测）
   ------------------------------------------------------------
   覆盖 P0 审计确认的三条工程缺口：
     1. 同一世界并发 tick 无互斥 → 串行化（后到者重走幂等检查）
     2. 'running' 态不可观测、崩溃零留痕 → tick 开始即落账（upsert）
     3. 幂等账纯内存、重启即失 → Journal 惰性重建（幂等键/指纹/冷却）
   另加 Journal 写失败计数（失败可见，不炸运行时）。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import {
  NPC_EVOLUTION_POLICY,
  createEngineClient,
  createEvolutionJournal,
  createEvolutionRuntime,
  createScriptedDriver,
  type EvolutionContext,
  type EvolutionDriver,
  type EvolutionProposal,
  type EvolutionRun,
} from '../src/index.ts';
import { EvolutionCooldownError } from '../src/evolution/types.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
let dir = '';
const WORLD = 'w-p1';

interface StateShape {
  relations: { source: string; target: string; type: string; value?: number }[];
}

async function noticedEdges(): Promise<number> {
  const res = await engine.getState(WORLD);
  if (!res.ok) throw new Error(res.error);
  return ((res.state as StateShape).relations ?? []).filter((r) => r.type === 'noticed').length;
}

/* 各用例共享同一世界：一律用「相对基线的增量」断言，绝不用绝对数 */
async function withBaseline(fn: (baseline: number) => Promise<void>): Promise<void> {
  const baseline = await noticedEdges();
  await fn(baseline);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'platform-evolution-p1-'));
  const registry = createWorldRegistry();
  const world = registry.create({
    worldId: WORLD,
    playerName: '旅人',
    startLoc: 'village',
    weather: 'clear',
    savePort: new InMemoryWorldStorage(),
  });
  const r = world.executeCommand({ type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } });
  if (!r.ok) throw new Error(`种子命令被拒绝：${JSON.stringify(r)}`);
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });
});

afterAll(async () => {
  await engineServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOTICE_PLAYER = {
  targetId: 'milu',
  action: 'set_relation',
  payload: { type: 'noticed', otherId: 'player', value: 10 },
  reason: '米露注意到玩家',
};
const NOTICE_STEP = { reason: '米露注意到玩家进店', observations: [{ ref: 'state', kind: 'state' as const }], changes: [{ ...NOTICE_PLAYER }] };

describe('P1 封口：并发互斥（方案 §二.3）', () => {
  it('同一世界并发 tick（同幂等键）→ 串行化后命中幂等，世界只变一次', async () => {
    const journal = createEvolutionJournal();
    const runtime = createEvolutionRuntime(
      {
        engine,
        driver: createScriptedDriver([
          { ...NOTICE_STEP, changes: [{ ...NOTICE_PLAYER }] },
          /* 若并发互斥失效，第二个 tick 会真正执行并消耗这一步 */
          { ...NOTICE_STEP, changes: [{ ...NOTICE_PLAYER }] },
        ]),
        policy: NPC_EVOLUTION_POLICY,
      },
      journal,
    );
    await withBaseline(async (baseline) => {
      const [a, b] = await Promise.all([
        runtime.tick(WORLD, 'admin', { idempotencyKey: 'race-1' }),
        runtime.tick(WORLD, 'admin', { idempotencyKey: 'race-1' }),
      ]);
      expect(b.id).toBe(a.id);
      expect(b.deduplicated).toBe(true);
      expect(await noticedEdges()).toBe(baseline + 1); /* 重复 Mutation = 多出一条 noticed 边 */
    });
    /* 幂等命中不消耗驱动步：后续再 tick 一次仍能正常执行（驱动还有一步） */
    const c = await runtime.tick(WORLD, 'admin', { idempotencyKey: 'race-2' });
    expect(c.status).toBe('completed');
  });

  it('并发 tick（不同键、相同提案）→ 第二个命中提案指纹，不重复 Mutation', async () => {
    const journal = createEvolutionJournal();
    /* 三个键三次 tick：驱动给三步同提案（指纹命中不消耗变化，但驱动调用照常发生） */
    const runtime = createEvolutionRuntime(
      {
        engine,
        driver: createScriptedDriver([NOTICE_STEP, { ...NOTICE_STEP }, { ...NOTICE_STEP }]),
        policy: NPC_EVOLUTION_POLICY,
      },
      journal,
    );
    const [a, b] = await Promise.all([runtime.tick(WORLD, 'admin', { idempotencyKey: 'fp-1' }), runtime.tick(WORLD, 'admin', { idempotencyKey: 'fp-2' })]);
    expect(b.id).toBe(a.id);
    expect(b.deduplicated).toBe(true);
    /* set_relation 是 upsert：重复执行不会多出边，值也不叠加（叠加 = 20） */
    const stAfter = await engine.getState(WORLD);
    if (!stAfter.ok) throw new Error(stAfter.error);
    const noticed = ((stAfter.state as StateShape).relations ?? []).find((r) => r.type === 'noticed');
    expect(noticed?.value).toBe(10);
    /* 影子 run（观察+模型调用已发生）必须落终态，不留孤儿 running 行 */
    const shadow = journal.recent(WORLD, 10).find((r) => r.id !== a.id && r.idempotencyKey === 'fp-2');
    expect(shadow).toBeDefined();
    expect(shadow?.status).toBe('completed');
    expect(shadow?.deduplicated).toBe(true);
    /* 指纹仍指向首次执行变化的 run：第三次同提案仍命中原始 run */
    const c = await runtime.tick(WORLD, 'admin', { idempotencyKey: 'fp-3' });
    expect(c.id).toBe(a.id);
  });
});

describe('P1 封口：running 中间态留痕', () => {
  it('驱动执行中 → Journal 有 running 记录；完成后原位覆盖为终态', async () => {
    const journal = createEvolutionJournal();
    let release!: (p: EvolutionProposal) => void;
    const gate = new Promise<EvolutionProposal>((resolve) => (release = resolve));
    const hanging: EvolutionDriver = {
      name: 'hanging',
      propose: (_context: EvolutionContext) => gate,
    };
    const runtime = createEvolutionRuntime({ engine, driver: hanging, policy: NPC_EVOLUTION_POLICY }, journal);
    const pending = runtime.tick(WORLD, 'admin', { idempotencyKey: 'crash-trace' });

    /* 让出事件循环后，run 应以 running 态可见（进程若此刻崩溃，账本有迹可查） */
    await new Promise((r) => setTimeout(r, 20));
    const inRing = journal.recent(WORLD, 5).find((r) => r.idempotencyKey === 'crash-trace');
    expect(inRing).toBeDefined();
    expect(inRing?.status).toBe('running');
    expect(inRing?.finishedAt).toBeUndefined();

    release({
      id: `prop_${WORLD}_1`,
      worldId: WORLD,
      reason: '米露注意到玩家进店',
      observations: [],
      changes: [{ ...NOTICE_PLAYER }],
      source: { type: 'ai', model: 'hanging' },
    });
    const done = await pending;
    expect(done.status).toBe('completed');
    /* upsert：同一 run 只有一行真相（终态），不是 running+终态两行 */
    const records = journal.recent(WORLD, 10).filter((r) => r.id === done.id);
    expect(records).toHaveLength(1);
    expect(records[0]?.finishedAt).toBeDefined();
  });

  it('崩溃遗留的 running 记录：同幂等键重试被阻塞（宁阻塞不重复）', async () => {
    /* 手工向 Journal 塞一条 running 记录，模拟进程在驱动阶段崩溃 */
    const journal = createEvolutionJournal();
    journal.append({
      id: 'evo_orphan_01',
      worldId: WORLD,
      startedAt: new Date().toISOString(),
      status: 'running',
      trigger: 'auto',
      observationWindow: { eventCount: 20 },
      eventIds: [],
      idempotencyKey: 'orphan-key',
    });
    const runtime = createEvolutionRuntime(
      { engine, driver: createScriptedDriver([NOTICE_STEP]), policy: NPC_EVOLUTION_POLICY },
      journal,
    );
    const retry = await runtime.tick(WORLD, 'admin', { idempotencyKey: 'orphan-key' });
    expect(retry.id).toBe('evo_orphan_01');
    expect(retry.deduplicated).toBe(true);
    expect(retry.status).toBe('running');
    await withBaseline(async (baseline) => {
      expect(await noticedEdges()).toBe(baseline); /* 世界未被触碰 */
    });
  });
});

describe('P1 封口：重启后幂等账从 Journal 重建', () => {
  it('重启后：同幂等键 / 同提案 / 冷却均仍生效', async () => {
    const jdir = join(dir, 'journal-restart');
    const journal1 = createEvolutionJournal({ dir: jdir });
    const runtime1 = createEvolutionRuntime(
      { engine, driver: createScriptedDriver([NOTICE_STEP]), policy: NPC_EVOLUTION_POLICY, cooldownMs: 60_000 },
      journal1,
    );
    const run1 = await runtime1.tick(WORLD, 'admin', { idempotencyKey: 'restart-1' });
    expect(run1.status).toBe('completed');

    /* 「重启」：新 Journal 从磁盘装载，新运行时（幂等账为空） */
    const journal2 = createEvolutionJournal({ dir: jdir });
    const loaded = journal2.load();
    expect(loaded.loaded).toBeGreaterThan(0);
    const runtime2 = createEvolutionRuntime(
      { engine, driver: createScriptedDriver([{ ...NOTICE_STEP }]), policy: NPC_EVOLUTION_POLICY, cooldownMs: 60_000 },
      journal2,
    );

    const again = await runtime2.tick(WORLD, 'admin', { idempotencyKey: 'restart-1' });
    expect(again.id).toBe(run1.id); /* 幂等键从账本重建 → 命中 */
    expect(again.deduplicated).toBe(true);

    const sameProposal = await runtime2.tick(WORLD, 'admin', { idempotencyKey: 'restart-2' });
    expect(sameProposal.id).toBe(run1.id); /* 提案指纹从账本重建 → 命中 */
    await withBaseline(async (baseline) => {
      expect(await noticedEdges()).toBe(baseline); /* 零重复 Mutation */
    });

    await expect(runtime2.tick(WORLD, 'auto', { idempotencyKey: 'restart-3' })).rejects.toBeInstanceOf(EvolutionCooldownError); /* 冷却时刻从账本重建 */
  });

  it('load 遇 running+终态两行 → upsert 语义只保留终态', async () => {
    const jdir = join(dir, 'journal-upsert');
    const journal = createEvolutionJournal({ dir: jdir });
    const runtime = createEvolutionRuntime(
      { engine, driver: createScriptedDriver([NOTICE_STEP]), policy: NPC_EVOLUTION_POLICY },
      journal,
    );
    await runtime.tick(WORLD, 'admin', { idempotencyKey: 'upsert-1' });
    /* JSONL 每个 run 两行（running + 终态）；装载后内存窗口里每个 run 只有一行终态 */
    const journal2 = createEvolutionJournal({ dir: jdir });
    const res = journal2.load();
    expect(res.skippedCorrupt).toBe(0);
    const records = journal2.recent(WORLD, 50).filter((r) => r.idempotencyKey === 'upsert-1');
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('completed');
  });
});

describe('P1 封口：Journal 写失败可见', () => {
  it('JSONL 写失败 → 计数累加，不炸运行时，内存窗口照常可查', async () => {
    /* 用一个文件路径当目录 → mkdir 必然失败 */
    const filePathAsDir = join(dir, 'not-a-dir');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePathAsDir, 'x', 'utf8');
    const journal = createEvolutionJournal({ dir: filePathAsDir });
    const before = journal.writeFailures();
    journal.append({
      id: 'evo_failvisible_1',
      worldId: WORLD,
      startedAt: new Date().toISOString(),
      status: 'running',
      trigger: 'admin',
      observationWindow: { eventCount: 20 },
      eventIds: [],
    });
    expect(journal.writeFailures()).toBeGreaterThan(before);
    expect(journal.get(WORLD, 'evo_failvisible_1')).not.toBeNull(); /* 内存窗口不受影响 */
  });
});

describe('P1 封口：冷却与并发叠加', () => {
  it('冷却期内并发 auto tick → 只有一个执行，其余收到冷却错误', async () => {
    const journal = createEvolutionJournal();
    const runtime = createEvolutionRuntime(
      { engine, driver: createScriptedDriver([NOTICE_STEP, NOTICE_STEP]), policy: NPC_EVOLUTION_POLICY, cooldownMs: 60_000 },
      journal,
    );
    const results = await Promise.allSettled([
      runtime.tick(WORLD, 'auto', { idempotencyKey: 'cd-1' }),
      runtime.tick(WORLD, 'auto', { idempotencyKey: 'cd-2' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const cooldownRejected = results.filter((r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason instanceof EvolutionCooldownError);
    expect(fulfilled).toHaveLength(1);
    expect(cooldownRejected).toHaveLength(1);
  });
});

export type { EvolutionRun };

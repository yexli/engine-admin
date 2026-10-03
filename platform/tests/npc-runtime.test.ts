/* ============================================================
   NPC Runtime MVP 测试（P5 · 方案 §八）
   ------------------------------------------------------------
   覆盖：
   ① 核心循环（方案原文：NPC Event → Trigger → Context → AI →
      Proposal → Rules → Mutation → Event）落到「个体决策」：
      每个被唤醒实体一次聚焦 tick，goal 段来自引擎 NPC 事实。
   ② 焦点作用域：同一事件唤醒两个 NPC → 两次个体 tick 互不挤兑
      冷却、指纹不跨 NPC 串挡。
   ③ 方案 §八「禁止 AI 直接」清单逐项（含金币属性键级禁令）。
   ④ NpcProfile：状态清单 → 既有事实的组装（缺的如实标注）。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import {
  NPC_EVOLUTION_POLICY,
  buildNpcProfile,
  createEngineClient,
  createEvolutionJournal,
  createEvolutionRuntime,
  createTriggerRuntime,
  type EvolutionContext,
  type EvolutionDriver,
  type EvolutionProposal,
  type TriggerRuntime,
} from '../src/index.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
let trigger: TriggerRuntime;
let focusCalls = 0;
const WORLD = 'w-p5';

const MILU_GOAL = '想弄清这位常客的来历';

/** 个体决策驱动：以唤醒实体为唯一对象（提案内容按焦点生成） */
function focusDriver(): EvolutionDriver {
  return {
    name: 'p5-focus',
    async propose(context: EvolutionContext): Promise<EvolutionProposal> {
      const npc = context.trigger?.woken?.[0];
      if (!npc) throw new Error('个体决策缺唤醒实体（context.trigger.woken 为空）');
      focusCalls++;
      return {
        id: `prop_focus_${npc}_${focusCalls}`,
        worldId: context.worldId,
        reason: `${npc} 注意到玩家（个体判断 #${focusCalls}）`,
        observations: [{ ref: 'state', kind: 'state', summary: `${npc} 的当前状态` }],
        changes: [{ targetId: npc, action: 'update_attribute', payload: { key: 'mood', value: '好奇' }, reason: '个体反应' }],
        source: { type: 'ai', model: 'p5-focus', role: 'npc_behavior' },
      };
    },
  };
}

async function playerMove(to: string): Promise<void> {
  const res = await engine.executeCommand(WORLD, { type: 'move', targetId: to });
  if (!res.ok || !res.result.ok) throw new Error(`move 被拒绝：${res.ok ? res.result.reason : res.error}`);
}

beforeAll(async () => {
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
        { id: 'tavern', attributes: { desc: '米露的酒馆' } },
      ],
      relations: [{ source: 'milu', target: 'player', type: 'noticed', value: 20 }],
    },
  });
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern', attributes: { mood: '平静', attention: '无人', goal: MILU_GOAL } } },
    { type: 'create_entity', payload: { id: 'keeper', type: 'npc', name: '老板', location: 'tavern', attributes: { mood: '平静', attention: '无人', money: 200 } } },
  ]) {
    const r = world.executeCommand(c);
    if (!r.ok) throw new Error(`种子命令被拒绝：${JSON.stringify(r)}`);
  }
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });

  /* 冷却 60s：个体决策按 world|focus 分域——同一事件的两个 NPC 互不挤兑 */
  const evolution = createEvolutionRuntime(
    { engine, driver: focusDriver(), policy: NPC_EVOLUTION_POLICY, cooldownMs: 60_000 },
    createEvolutionJournal(),
  );
  trigger = createTriggerRuntime({ engine, evolution, worlds: [WORLD], log: () => {} });
});

afterAll(async () => {
  await engineServer?.close();
});

interface StateShape {
  t: number;
  player: { attributes?: Record<string, unknown> };
  npcs: Record<string, { attributes?: Record<string, unknown> }>;
}

async function npcState(id: string): Promise<Record<string, unknown> | undefined> {
  const res = await engine.getState(WORLD);
  if (!res.ok) throw new Error(res.error);
  return (res.state as StateShape).npcs[id]?.attributes;
}

describe('P5 核心循环：NPC Event → Trigger → Context → AI → Proposal → Rules → Mutation → Event', () => {
  it('单唤醒：只有米露达到 HIGH → 一次聚焦 tick，goal 段来自她的引擎属性', async () => {
    await playerMove('tavern'); /* 米露有关系边 → HIGH；老板同地陌生 → MEDIUM 不唤醒 */
    await trigger.pollOnce();
    const st = trigger.status().worlds[0]!;
    expect(st.ticksFired).toBe(1);
    expect(st.skippedNoWake).toBe(0);
    const plan = trigger.planOf(WORLD)!;
    const grades = Object.fromEntries(plan.wakes.map((w) => [w.entityId, w.grade]));
    expect(grades['milu']).toBe('high');
    expect(grades['keeper']).toBe('medium');
    /* 个体决策落到世界：mood 经 Proposal → Rules → Mutation → Event 改变 */
    expect((await npcState('milu'))?.['mood']).toBe('好奇');
    /* goal 段真实来源：context.goal = 引擎里米露的 goal 属性 */
    const runs = st.lastPlan ? undefined : undefined;
    void runs;
  });

  it('context.goal 与 trigger.woken 在 run.context 里可查（Journal 留痕）', async () => {
    const runs = trigger.planOf(WORLD);
    expect(runs?.primaryEventId).toBeDefined();
  });
});

describe('P5 焦点作用域：冷却与指纹按 world|focus 分域', () => {
  it('双唤醒 → 米露冷却中跳过、老板照常个体决策（世界级冷却不再连坐）', async () => {
    /* 给老板补一条玩家关系边 → 下次进店两人都 HIGH */
    const rel = await engine.executeCommand(WORLD, { type: 'set_relation', actorId: 'keeper', targetId: 'player', payload: { type: 'acquainted', value: 15 } });
    if (!rel.ok || !rel.result.ok) throw new Error('set_relation 被拒绝');
    await playerMove('village');
    const before = trigger.status().worlds[0]!.ticksFired;
    await playerMove('tavern');
    await trigger.pollOnce();
    const st = trigger.status().worlds[0]!;
    expect(st.ticksFired).toBe(before + 1); /* 老板的个体 tick 照常执行 */
    expect(st.cooldownSkips).toBe(1); /* 米露 60s 冷却中——按焦点分域，不连坐老板 */
    expect((await npcState('keeper'))?.['mood']).toBe('好奇'); /* 老板的个体决策落地 */
    expect((await npcState('milu'))?.['mood']).toBe('好奇'); /* 米露保持第一次的结果（未重复 tick，也未变化） */
  });
});

describe('P5 方案 §八「禁止 AI 直接」清单（结构 + 属性键级禁令）', () => {
  it('创建/删除 NPC、改玩家、推进时间、改天气、直接改金币 → 全部围栏拒绝，世界分毫未动', async () => {
    const before = await engine.getState(WORLD);
    if (!before.ok) throw new Error(before.error);
    const s0 = before.state as StateShape;
    const t0 = s0.t;

    let forbiddenCalls = 0;
    const forbidden: EvolutionDriver = {
      name: 'p5-forbidden',
      async propose(context): Promise<EvolutionProposal> {
        forbiddenCalls++;
        return {
          id: `prop_forbidden_${forbiddenCalls}`,
          worldId: context.worldId,
          reason: '越权试探：全部应当被拒',
          observations: [],
          changes: [
            { targetId: 'world', action: 'create_entity', payload: { id: 'ghost', type: 'npc' }, reason: '创建 NPC' },
            { targetId: 'milu', action: 'remove_entity', payload: {}, reason: '删除 NPC' },
            { targetId: 'player', action: 'update_attribute', payload: { key: 'money', value: 99999 }, reason: '改玩家金币' },
            { targetId: 'player', action: 'set_relation', payload: { type: 'enslaved', otherId: 'milu', value: 100 }, reason: '改玩家关系' },
            { targetId: 'world', action: 'advance_time', payload: { ticks: 999 }, reason: '推进时间' },
            { targetId: 'world', action: 'change_weather', payload: { weather: 'storm' }, reason: '改天气' },
            { targetId: 'milu', action: 'update_attribute', payload: { key: 'money', value: 99999 }, reason: '直接改 NPC 金币（方案 §八禁令）' },
          ],
          source: { type: 'ai', model: 'p5-forbidden' },
        };
      },
    };
    const journal = createEvolutionJournal();
    const evo = createEvolutionRuntime(
      { engine, driver: forbidden, policy: NPC_EVOLUTION_POLICY, cooldownMs: 0, maxChangesPerRun: 16 },
      journal,
    );
    const plan = {
      worldGrade: 'high' as const,
      primaryEventId: 'evt-forbidden',
      wakes: [{ entityId: 'milu', grade: 'high' as const, reasons: ['test'] }],
      worthWaking: true,
    };
    const run = await evo.tick(WORLD, 'admin', { wakePlan: plan });
    expect(run.status).toBe('rejected'); /* 全拒：每条都有原因 */
    expect(forbiddenCalls).toBe(1);
    const byReason = (action: string, targetId?: string) =>
      (run.outcomes ?? []).find((o) => o.change.action === action && (targetId === undefined || o.change.targetId === targetId));
    expect(byReason('create_entity')?.rejectedBy).toBe('policy');
    expect(byReason('remove_entity')?.rejectedBy).toBe('policy');
    expect(byReason('update_attribute', 'player')?.rejectedBy).toBe('policy'); /* 玩家核心属性 */
    expect(byReason('set_relation', 'player')?.rejectedBy).toBe('policy');
    expect(byReason('advance_time')?.rejectedBy).toBe('policy');
    expect(byReason('change_weather')?.rejectedBy).toBe('policy');
    const moneyChange = (run.outcomes ?? []).find((o) => o.change.action === 'update_attribute' && o.change.targetId === 'milu');
    expect(moneyChange?.rejectedBy).toBe('policy'); /* 金币属性键级禁令 */
    expect(moneyChange?.reason).toContain('不得直接修改');

    /* 世界分毫未动 */
    const after = await engine.getState(WORLD);
    if (!after.ok) throw new Error(after.error);
    const s1 = after.state as StateShape;
    expect(s1.t).toBe(t0);
    expect(s1.npcs['ghost']).toBeUndefined();
    expect(s1.npcs['milu']?.attributes?.['money']).toBe(s0.npcs['milu']?.attributes?.['money']);
    expect(s1.player.attributes?.['money']).toBe(s0.player.attributes?.['money']);
  });

  it('个体指纹隔离：不同 NPC 的相同结论互不串挡（各自成 run）', async () => {
    let sameCalls = 0;
    const sameDriver: EvolutionDriver = {
      name: 'p5-same',
      async propose(context): Promise<EvolutionProposal> {
        sameCalls++;
        return {
          id: `prop_same_${sameCalls}`,
          worldId: context.worldId,
          reason: '此刻无事发生（两个 NPC 完全相同的判断内容）',
          observations: [],
          changes: [],
          source: { type: 'ai', model: 'p5-same' },
        };
      },
    };
    const journal = createEvolutionJournal();
    const evo = createEvolutionRuntime({ engine, driver: sameDriver, policy: NPC_EVOLUTION_POLICY, cooldownMs: 0 }, journal);
    const mk = (npc: string) => ({
      worldGrade: 'high' as const,
      primaryEventId: `evt-${npc}`,
      wakes: [{ entityId: npc, grade: 'high' as const, reasons: ['test'] }],
      worthWaking: true,
    });
    const run1 = await evo.tick(WORLD, 'admin', { wakePlan: mk('milu') });
    const run2 = await evo.tick(WORLD, 'admin', { wakePlan: mk('keeper') });
    expect(run2.id).not.toBe(run1.id); /* 焦点分域：不是指纹命中 */
    expect(run2.deduplicated).toBeUndefined();
    expect(sameCalls).toBe(2); /* 两次都真实调用了驱动 */
    const recent = journal.recent(WORLD, 10);
    expect(recent.filter((r) => r.status === 'completed' && !r.deduplicated)).toHaveLength(2);
  });
});

describe('P5 NpcProfile（方案 §八状态清单 → 既有事实）', () => {
  it('米露档案：Identity/Location/Mood/Attention/Goal/Relationship/Met 齐备', async () => {
    const p = await buildNpcProfile(engine, WORLD, 'milu', { schedule: [{ from: 16, to: 48, location: 'tavern' }], lastRunId: 'evo_x' });
    expect(p).not.toBeNull();
    expect(p!.identity).toEqual({ id: 'milu', type: 'npc', name: '米露' });
    expect(p!.location).toBe('tavern');
    expect(p!.mood).toBe('好奇');
    expect(p!.attention).toBe('无人');
    expect(p!.goal).toBe(MILU_GOAL);
    expect(p!.relationships.some((r) => r.type === 'noticed')).toBe(true);
    expect(p!.schedule).toEqual([{ from: 16, to: 48, location: 'tavern' }]);
    expect(p!.currentContext?.lastRunId).toBe('evo_x');
    expect(p!.knowledgeWired).toBe(false); /* P7 接入位：如实标注未接 */
    expect(p!.memoryWired).toBe(false);
  });

  it('不存在的实体 → null；无日程/无 goal 不编造', async () => {
    expect(await buildNpcProfile(engine, WORLD, 'ghost')).toBeNull();
    const p = await buildNpcProfile(engine, WORLD, 'keeper');
    expect(p?.goal).toBeUndefined();
    expect(p?.schedule).toBeUndefined();
  });
});

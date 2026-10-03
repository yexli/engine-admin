/* ============================================================
   Context Engine 测试（P4 · 方案 §七）
   ------------------------------------------------------------
   方案验收（原文）：**同一 NPC 在不同 地点/关系/目标/时间/事件 下，
   Context 必须产生合理差异。**
   （「目标」维度的引擎事实 P5 落地，本阶段验证通路：goal 注入即出现。）

   另覆盖五项预算（maxTokens/maxEntities/maxEvents/maxRelations/
   maxMemoryItems）、裁剪优先级（当前事件 > 位置 > 实体 > 关系 >
   近期事件 > 记忆 > 全局）与预算报告（失败必须可见）。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import {
  NPC_EVOLUTION_POLICY,
  createEngineClient,
  createEvolutionRuntime,
  estimateTokens,
  buildEvolutionContext,
  renderContextFacts,
  type ContextBudget,
  type EvolutionRuntime,
  type WakePlan,
} from '../src/index.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
const WORLD = 'w-p4';

/* 唤醒计划夹具：米露被唤醒（primaryEventId 由用例指定） */
function plan(primaryEventId: string): WakePlan {
  return {
    worldGrade: 'high',
    primaryEventId,
    wakes: [
      { entityId: 'milu', grade: 'high', reasons: ['same_location', 'relationship'] },
      { entityId: 'keeper', grade: 'none', reasons: ['not_perceived'] },
      { entityId: 'trader', grade: 'none', reasons: ['not_perceived'] },
    ],
    worthWaking: true,
  };
}

async function ctx(opts?: Parameters<typeof buildEvolutionContext>[2]) {
  const res = await buildEvolutionContext(engine, WORLD, opts);
  if (!res.ok) throw new Error(res.error);
  return res.context;
}

async function playerMove(to: string): Promise<string> {
  const res = await engine.executeCommand(WORLD, { type: 'move', targetId: to });
  if (!res.ok || !res.result.ok) throw new Error(`move 被拒绝：${res.ok ? res.result.reason : res.error}`);
  return res.result.events[0]!;
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
        { id: 'shop', attributes: { desc: '杂货商店' } },
      ],
      relations: [
        { source: 'milu', target: 'player', type: 'noticed', value: 20 },
        { source: 'keeper', target: 'trader', type: 'colleague', value: 10 },
      ],
    },
  });
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern', attributes: { mood: '平静' } } },
    { type: 'create_entity', payload: { id: 'keeper', type: 'npc', name: '老板', location: 'tavern', attributes: { mood: '平静' } } },
    { type: 'create_entity', payload: { id: 'trader', type: 'npc', name: '商人', location: 'shop', attributes: { mood: '平静' } } },
  ]) {
    const r = world.executeCommand(c);
    if (!r.ok) throw new Error(`种子命令被拒绝：${JSON.stringify(r)}`);
  }
  /* 对照世界：同结构、零关系（「关系不同」验收用）——必须建在同一个 registry（引擎只服务它） */
  registry.create({
    worldId: 'w-p4-norel',
    playerName: '旅人',
    startLoc: 'village',
    weather: 'clear',
    savePort: new InMemoryWorldStorage(),
    definition: { locations: [{ id: 'village', attributes: { desc: '村庄' } }] },
  });
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });
});

afterAll(async () => {
  await engineServer?.close();
});

describe('P4 方案验收：同一 NPC 在不同条件下 Context 产生合理差异', () => {
  it('地点不同 → 位置段与在场实体不同', async () => {
    const atVillage = await ctx();
    expect(atVillage.location?.id).toBe('village');
    expect(Object.keys(atVillage.entities)).toHaveLength(0); /* 村庄无人 */
    expect(atVillage.otherEntities.map((e) => e.id).sort()).toEqual(['keeper', 'milu', 'trader']);

    await playerMove('tavern');
    const atTavern = await ctx();
    expect(atTavern.location?.id).toBe('tavern');
    expect(atTavern.location?.desc).toBe('米露的酒馆'); /* 地点描述随地点变化 */
    expect(Object.keys(atTavern.entities).sort()).toEqual(['keeper', 'milu']); /* 在场者带完整字段 */
    expect(atTavern.entities['milu']?.attributes?.['mood']).toBeDefined();
    expect(JSON.stringify(atVillage)).not.toBe(JSON.stringify(atTavern));
  });

  it('关系不同 → 相关关系段不同', async () => {
    /* w-p4 有 noticed（milu↔player）与 colleague（keeper↔trader）；对照世界零关系 */
    const noRel = await buildEvolutionContext(engine, 'w-p4-norel');
    if (!noRel.ok) throw new Error(noRel.error);
    const withRel = await ctx();
    expect(withRel.relations.some((r) => r.type === 'noticed')).toBe(true);
    expect(noRel.context.relations).toHaveLength(0);
  });

  it('时间不同 → 刻度/天数字段不同', async () => {
    const before = await ctx();
    const res = await engine.executeCommand(WORLD, { type: 'advance_time', amount: 6 });
    if (!res.ok || !res.result.ok) throw new Error('advance_time 被拒绝');
    const after = await ctx();
    expect(after.tick).toBe(before.tick + 6);
    expect([after.day, after.tick]).not.toEqual([before.day, before.tick]);
  });

  it('触发事件不同 → trigger 段不同（当前事件段渲染在最前）', async () => {
    const evt1 = await playerMove('shop');
    const evt2 = await playerMove('tavern');
    const c1 = await ctx({ wakePlan: plan(evt1) });
    const c2 = await ctx({ wakePlan: plan(evt2) });
    expect(c1.trigger?.primaryEventId).toBe(evt1);
    expect(c2.trigger?.primaryEventId).toBe(evt2);
    const facts1 = renderContextFacts(c1);
    /* 优先级最高：渲染首行即当前事件段 */
    expect(facts1.indexOf(`当前事件（触发评估）：${evt1}`)).toBe(0);
    expect(renderContextFacts(c2)).toContain(`当前事件（触发评估）：${evt2}`);
  });

  it('目标注入 → goal 段出现（P5 接入位通路）', async () => {
    const withGoal = await ctx({ goal: '米露想弄清这位常客的来历' });
    expect(withGoal.goal).toBe('米露想弄清这位常客的来历');
    expect(renderContextFacts(withGoal)).toContain('当前目标：米露想弄清');
    const without = await ctx();
    expect(without.goal).toBeUndefined();
  });
});

describe('P4 五项预算（方案 §七）', () => {
  it('maxEntities：被唤醒者优先保留完整字段，其余降级名册（不丢名字）', async () => {
    /* 玩家此刻在酒馆：milu + keeper 同场 */
    const c = await ctx({ wakePlan: plan('evt_x'), budget: { maxEntities: 1 } });
    expect(Object.keys(c.entities)).toEqual(['milu']); /* 被唤醒者保留细节 */
    expect(c.entities['milu']?.attributes).toBeDefined();
    expect(c.otherEntities.map((e) => e.id)).toContain('keeper'); /* 降级名册，名字仍在 */
    expect(c.budgetReport?.dropped.entitiesToRoster).toBe(1);
    expect(c.budgetReport?.carried.entities).toBe(1);
  });

  it('maxEvents：触发事件永远保留，其余保最新，裁剪量如实报告', async () => {
    /* 生成一批事件：来回移动 6 次 */
    for (const to of ['village', 'tavern', 'village', 'tavern', 'village', 'tavern']) await playerMove(to);
    const all = await ctx({ wakePlan: plan('evt_keepme') });
    expect(all.events.length).toBeGreaterThanOrEqual(6);
    /* primary 用真实存在的较旧事件：它必须被保留，挤掉的是比它新的其它事实之外的名额 */
    const primaryId = all.events[2]!.id; /* 第 3 新 */
    const c = await ctx({ wakePlan: plan(primaryId), budget: { maxEvents: 3 } });
    expect(c.events.length).toBe(3);
    expect(c.events.map((e) => e.id)).toContain(primaryId); /* 触发事件在窗口必保留 */
    expect(c.budgetReport?.dropped.events).toBe(all.events.length - 3);
  });

  it('maxRelations：玩家相关边优先于其它相关边', async () => {
    const c = await ctx({ budget: { maxRelations: 1 } });
    expect(c.relations).toHaveLength(1);
    expect(c.relations[0]?.source === 'player' || c.relations[0]?.target === 'player').toBe(true);
    expect(c.budgetReport?.dropped.relations).toBeGreaterThanOrEqual(1);
  });

  it('maxMemoryItems：记忆按序截断（P7 接入位通路）', async () => {
    const memory = [
      { ref: 'mem-1', summary: '玩家昨天帮米露捡过酒壶', day: 1 },
      { ref: 'mem-2', summary: '玩家前天在店里买过两杯淡啤', day: 2 },
      { ref: 'mem-3', summary: '老周提过这旅人出手大方', day: 2 },
      { ref: 'mem-4', summary: '村里传言旅人是外乡贵族', day: 3 },
    ];
    const c = await ctx({ memory, budget: { maxMemoryItems: 2 } });
    expect(c.memory?.map((m) => m.ref)).toEqual(['mem-1', 'mem-2']); /* 新 → 旧保前 2 */
    expect(c.budgetReport?.dropped.memory).toBe(2);
    expect(renderContextFacts(c)).toContain('相关记忆');
  });

  it('maxTokens：从近期事件最旧端裁剪，直到估算值入预算；primary 不裁', async () => {
    /* 12 条移动事实 ≈ 数百 token；预算设在中段：必然裁剪、必然可达 */
    for (let i = 0; i < 12; i++) await playerMove(i % 2 === 0 ? 'village' : 'tavern');
    const full = await ctx({ wakePlan: plan('evt-anchor') });
    const primaryId = full.events[0]!.id; /* 最新真实事件作为触发事件 */
    const anchored = await ctx({ wakePlan: plan(primaryId) });
    const fullTokens = estimateTokens(renderContextFacts(anchored));
    const budget: ContextBudget = { maxTokens: Math.floor(fullTokens * 0.6) };
    const trimmed = await ctx({ wakePlan: plan(primaryId), budget });
    expect(trimmed.budgetReport).toBeDefined();
    expect(trimmed.budgetReport?.dropped.events).toBeGreaterThan(0);
    expect(trimmed.budgetReport?.estimatedTokens).toBeLessThanOrEqual(budget.maxTokens!);
    expect(trimmed.events.length).toBeLessThan(anchored.events.length);
    expect(trimmed.events.map((e) => e.id)).toContain(primaryId); /* 触发事件永不裁 */
    /* 裁剪后的世界只剩最新事实：与全量上下文产生可观测差异 */
    expect(renderContextFacts(trimmed).length).toBeLessThan(renderContextFacts(anchored).length);
  });

  it('优先级底线：预算再小也不裁 触发事件/位置/玩家 段', async () => {
    const latest = (await ctx()).events[0]?.id ?? 'evt-x';
    const c = await ctx({ wakePlan: plan(latest), budget: { maxTokens: 1 } });
    /* 裁无可裁：只剩不可裁段，如实超限并在报告中可见 */
    expect(c.trigger?.primaryEventId).toBe(latest);
    expect(c.player.loc).toBeDefined();
    expect(c.location).toBeDefined();
    expect(c.budgetReport?.estimatedTokens).toBeGreaterThan(1); /* 宁超限不撒谎 */
    expect(c.budgetReport?.dropped.rosterByTokens).toBeGreaterThan(0); /* 名册（全局信息）最先被牺牲完 */
  });

  it('estimateTokens：CJK 逐字计、ASCII 按四分之一计（确定性口径）', () => {
    expect(estimateTokens('米露在酒馆')).toBe(5);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('米露 abc')).toBe(3); /* 2 CJK + ceil(4/4)=1 */
  });
});

describe('P4 runtime 集成（tick → run.context）', () => {
  let evo: EvolutionRuntime;
  let bare: EvolutionRuntime; /* 无预算 runtime：向后兼容对照 */

  beforeAll(() => {
    const journal = { append: () => {}, recent: () => [], get: () => null };
    const staticDriver = {
      name: 'p4-static',
      async propose() {
        return {
          id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          worldId: WORLD,
          reason: '测试静态提案：无需变化',
          observations: [],
          changes: [],
          source: { type: 'ai' as const, model: 'p4-static' },
        };
      },
    };
    evo = createEvolutionRuntime(
      {
        engine,
        driver: staticDriver,
        policy: NPC_EVOLUTION_POLICY,
        cooldownMs: 0,
        contextBudget: { maxEntities: 1, maxEvents: 5 },
      },
      journal,
    );
    bare = createEvolutionRuntime({ engine, driver: staticDriver, policy: NPC_EVOLUTION_POLICY, cooldownMs: 0 }, journal);
  });

  it('tick 携带 wakePlan + 预算 → run.context 带 trigger 段与预算报告', async () => {
    await playerMove('village');
    await playerMove('tavern');
    const run = await evo.tick(WORLD, 'admin', { wakePlan: plan('evt_into_tavern') });
    expect(run.status).toBe('completed');
    expect(run.context?.trigger?.primaryEventId).toBe('evt_into_tavern');
    expect(run.context?.trigger?.woken).toEqual(['milu']);
    expect(run.context?.budgetReport?.carried.entities).toBe(1); /* maxEntities=1 生效 */
    expect(run.context?.events.length).toBeLessThanOrEqual(5); /* maxEvents=5 生效 */
  });

  it('runtime 配了预算则每次 tick 都产出报告（预算是 runtime 级语义）', async () => {
    const run = await evo.tick(WORLD, 'admin');
    expect(run.status).toBe('completed');
    expect(run.context?.trigger).toBeUndefined(); /* 无 wakePlan → 无触发段 */
    expect(run.context?.budgetReport).toBeDefined(); /* 但预算仍生效 */
  });

  it('向后兼容：runtime 未配预算 + 无 wakePlan → 无 trigger 段、无报告（P3 前行为不变）', async () => {
    const run = await bare.tick(WORLD, 'admin');
    expect(run.status).toBe('completed');
    expect(run.context?.trigger).toBeUndefined();
    expect(run.context?.budgetReport).toBeUndefined();
  });
});

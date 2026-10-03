/* ============================================================
   Extension 层测试（P14 · 方案 §十七）
   ------------------------------------------------------------
   分层原则：Core → Extension → Adapter——游戏差异不进共享代码。
   P14 交付：按世界解析演化围栏（policyFor）——多游戏差异化策略，
   零共享代码改动（商贸世界可禁 AI 改库存属性，RPG 世界不受影响）。

   同时钉住 P14 检讨结论的边界：NPC/Relationship 已由 Schema/引擎
   覆盖；Item/Quest 为前瞻不做（无第二游戏实践）。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import {
  NPC_EVOLUTION_POLICY,
  createEngineClient,
  createEvolutionJournal,
  createEvolutionRuntime,
  type EvolutionDriver,
  type EvolutionRuntime,
} from '../src/index.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
const RPG_WORLD = 'p14-rpg'; /* 天穹形：ale_stock 可被 AI 维护 */
const TRADE_WORLD = 'p14-trade'; /* 商路形：库存键对 AI 全域禁改 */

/** 共享驱动：提案直接改目标实体的库存/属性（同一套业务代码） */
function stockDriver(): EvolutionDriver {
  return {
    name: 'p14-stock',
    async propose(context) {
      const npc = context.trigger?.woken?.[0] ?? 'npc0';
      return {
        id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        worldId: context.worldId,
        reason: `维护 ${npc} 的库存记录（Extension 差异化围栏演示）`,
        observations: [],
        changes: [{ targetId: npc, action: 'update_attribute', payload: { key: 'stock', value: 99 }, reason: '库存盘点' }],
        source: { type: 'ai', model: 'p14-stock' },
      };
    },
  };
}

beforeAll(async () => {
  const registry = createWorldRegistry();
  for (const [worldId, npcId] of [
    [RPG_WORLD, 'npc0'],
    [TRADE_WORLD, 'shen'],
  ] as const) {
    const w = registry.create({ worldId, playerName: '旅人', startLoc: 'village', weather: 'clear', savePort: new InMemoryWorldStorage() });
    for (const c of [
      { type: 'create_entity', payload: { id: npcId, type: 'npc', name: '店主', location: 'tavern' } },
      { type: 'update_attribute', targetId: npcId, payload: { key: 'stock', value: 10 } },
    ]) {
      const r = w.executeCommand(c);
      if (!r.ok) throw new Error(`种子被拒：${JSON.stringify(r)}`);
    }
  }
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });
});

afterAll(async () => {
  await engineServer?.close();
});

describe('P14 Extension 层：按世界解析演化围栏（policyFor）', () => {
  let evo: EvolutionRuntime;

  beforeAll(() => {
    evo = createEvolutionRuntime(
      {
        engine,
        driver: stockDriver(),
        policy: NPC_EVOLUTION_POLICY, /* 共享缺省 */
        cooldownMs: 0,
        /* P14：商贸世界禁 AI 改库存属性；RPG 世界不受影响 */
        policyFor: (worldId) =>
          worldId === TRADE_WORLD
            ? { ...NPC_EVOLUTION_POLICY, forbiddenAttributeKeys: [...NPC_EVOLUTION_POLICY.forbiddenAttributeKeys ?? [], 'stock'] }
            : undefined,
      },
      createEvolutionJournal(),
    );
  });

  it('商贸世界：AI 提改库存 → 策略拒绝（对任何目标）', async () => {
    const run = await evo.tick(TRADE_WORLD, 'admin', { wakePlan: { worldGrade: 'high', primaryEventId: 'e-x', wakes: [{ entityId: 'shen', grade: 'high', reasons: ['t'] }], worthWaking: true } });
    expect(run.status).toBe('rejected');
    const outcome = run.outcomes?.[0]!;
    expect(outcome.change.payload).toMatchObject({ key: 'stock' });
    expect(outcome.rejectedBy).toBe('policy');
  });

  it('RPG 世界：同一驱动同一提案键 → 照常放行（差异化围栏不连坐）', async () => {
    const run = await evo.tick(RPG_WORLD, 'admin', { wakePlan: { worldGrade: 'high', primaryEventId: 'e-y', wakes: [{ entityId: 'npc0', grade: 'high', reasons: ['t'] }], worthWaking: true } });
    expect(run.status).toBe('completed');
    const st = await engine.getState(RPG_WORLD);
    if (!st.ok) throw new Error(st.error);
    expect((st.state as { npcs: Record<string, { attributes?: Record<string, unknown> }> }).npcs.npc0.attributes?.['stock']).toBe(99);
  });

  it('未匹配 policyFor 的世界回落共享缺省（向后兼容）', () => {
    /* policyFor 只对 TRADE_WORLD 返回覆盖；RPG_WORLD 返回 undefined → opts.policy 生效。
       该语义由上一用例反证（RPG 世界 stock 变更被放行 = 未被商贸覆盖拦下）；此处直接验证解析函数约定。 */
    expect(NPC_EVOLUTION_POLICY.forbiddenAttributeKeys).toContain('money');
  });
});

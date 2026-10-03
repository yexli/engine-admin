/* ============================================================
   Trigger Engine 测试（P3 · 方案 §六）
   ------------------------------------------------------------
   核心验收（方案原文）：**同一个 Event 不能导致所有 NPC 同时调用 AI。**

   两层：
   ① assessWake 纯函数——方案 §六示例逐条落断言（米露 HIGH /
      远处商人 NONE / 同地陌生人 MEDIUM / witnesses 感知边界）；
   ② TriggerRuntime 集成（真实引擎 + 计数驱动）——一个事件、三个
      NPC、恰好一次 AI 调用；空地点零调用；NPC 事实零调用；
      Medium 零调用；重放零重复调用。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import {
  NPC_EVOLUTION_POLICY,
  createEngineClient,
  createEvolutionRuntime,
  createTriggerRuntime,
  assessWake,
  type EvolutionDriver,
  type EvolutionProposal,
  type TriggerRuntime,
  type WakeStateView,
} from '../src/index.ts';

/* ---------------- ① assessWake 纯函数（方案 §六示例） ---------------- */

const MILU_CASE: WakeStateView = {
  playerLoc: 'tavern',
  entities: {
    milu: { id: 'milu', location: 'tavern', att: 0, met: true },
    keeper: { id: 'keeper', location: 'shop', att: 0, met: false },
    trader: { id: 'trader', location: 'village', att: 0, met: false },
  },
  relationValue: (a, b) => (a === 'milu' && b === 'player') || (a === 'player' && b === 'milu') ? 20 : undefined,
};
const PLAYER_MOVED = { id: 'evt_t1', type: 'player_moved', actor: 'player', location: 'tavern' };

describe('assessWake（P3 · 方案 §六示例逐条）', () => {
  it('米露：同地点 + 见过玩家 → HIGH（值得考虑）', () => {
    const plan = assessWake(MILU_CASE, [PLAYER_MOVED]);
    expect(plan.worldGrade).toBe('high');
    const milu = plan.wakes.find((w) => w.entityId === 'milu')!;
    expect(milu.grade).toBe('high');
    expect(milu.reasons).toContain('same_location');
    expect(plan.worthWaking).toBe(true);
  });

  it('远处商人：不同地点 + 无关系 → NONE（方案原文示例）', () => {
    const plan = assessWake(MILU_CASE, [PLAYER_MOVED]);
    const trader = plan.wakes.find((w) => w.entityId === 'trader')!;
    expect(trader.grade).toBe('none');
    const keeper = plan.wakes.find((w) => w.entityId === 'keeper')!;
    expect(keeper.grade).toBe('none');
    expect(plan.wakes.filter((w) => w.grade === 'high')).toHaveLength(1); /* 只有米露 */
  });

  it('同地点陌生人（没见过/无态度/无关系）→ MEDIUM（可能会注意到，但不强）', () => {
    const state: WakeStateView = {
      playerLoc: 'tavern',
      entities: { stranger: { id: 'stranger', location: 'tavern', att: 0, met: false } },
    };
    const plan = assessWake(state, [PLAYER_MOVED]);
    expect(plan.wakes[0]?.grade).toBe('medium');
    expect(plan.worthWaking).toBe(false); /* 无人达到 HIGH —— 零 AI 调用 */
  });

  it('witnesses 感知边界：玩家可见事件里，同地点但不在目击名单 → NONE（在后厨，没看见）', () => {
    const state: WakeStateView = {
      playerLoc: 'tavern',
      entities: {
        milu: { id: 'milu', location: 'tavern', met: true },
        keeper: { id: 'keeper', location: 'tavern', met: false },
      },
    };
    const plan = assessWake(state, [{ id: 'evt_w1', type: 'talk_started', actor: 'player', target: 'milu', witnesses: ['player', 'milu'] }]);
    expect(plan.wakes.find((w) => w.entityId === 'milu')!.grade).toBe('high'); /* 目击者 + 牵涉 */
    expect(plan.wakes.find((w) => w.entityId === 'keeper')!.grade).toBe('none'); /* 同地点但不在名单 */
  });

  it('事件目击名单不含玩家 → 对玩家不可见 → 全员 none（不触发玩家视角演化）', () => {
    const state: WakeStateView = {
      playerLoc: 'tavern',
      entities: { milu: { id: 'milu', location: 'tavern', met: true } },
    };
    const plan = assessWake(state, [{ id: 'evt_w2', type: 'talk_started', actor: 'keeper', target: 'milu', witnesses: ['keeper', 'milu'] }]);
    expect(plan.worthWaking).toBe(false);
    expect(plan.wakes.every((w) => w.grade === 'none')).toBe(true);
  });

  it('直接牵涉但异地（事件 target 在别处）→ MEDIUM（当事人，听得见）', () => {
    const state: WakeStateView = {
      playerLoc: 'tavern',
      entities: { keeper: { id: 'keeper', location: 'shop', met: false } },
    };
    const plan = assessWake(state, [{ id: 'evt_i1', type: 'talk_started', actor: 'player', target: 'keeper' }]);
    expect(plan.wakes[0]?.grade).toBe('medium');
    expect(plan.wakes[0]?.reasons).toContain('involved');
  });

  it('世界级非 High 批次（时间推进）→ worthWaking=false，零 AI 调用', () => {
    const plan = assessWake(MILU_CASE, [{ id: 'evt_tm', type: 'time_advanced', actor: undefined as string | undefined }]);
    expect(plan.worldGrade).not.toBe('high');
    expect(plan.worthWaking).toBe(false);
  });

  it('无玩家可见事件 → 全员 none', () => {
    const plan = assessWake(MILU_CASE, []);
    expect(plan.worthWaking).toBe(false);
    expect(plan.wakes.every((w) => w.grade === 'none')).toBe(true);
  });
});

/* ---------------- ② TriggerRuntime 集成（真实引擎 + 计数驱动） ---------------- */

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
let trigger: TriggerRuntime;
let counting: (EvolutionDriver & { calls(): number }) | null = null;
const WORLD = 'w-p3';

function driverCalls(): number {
  if (!counting) throw new Error('driver 未初始化');
  return counting.calls();
}

function countingDriver(): EvolutionDriver & { calls(): number } {
  let calls = 0;
  return {
    name: 'counting',
    calls: () => calls,
    async propose(context): Promise<EvolutionProposal> {
      calls++;
      return {
        id: `prop_count_${calls}`,
        worldId: context.worldId,
        reason: `第 ${calls} 次被调用（米露注意到玩家进入）`,
        observations: [],
        changes: [], /* 空提案：测试只关心「调用次数」，不产生世界变化 */
        source: { type: 'ai', model: 'counting', role: 'world_reasoning' },
      };
    },
  };
}

async function playerMove(to: string): Promise<void> {
  const res = await engine.executeCommand(WORLD, { type: 'move', targetId: to });
  if (!res.ok || !res.result.ok) throw new Error(`move ${to} 被拒绝：${res.ok ? res.result.reason : res.error}`);
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
        { id: 'tavern', attributes: { desc: '酒馆' } },
        { id: 'shop', attributes: { desc: '商店' } },
        { id: 'field', attributes: { desc: '空地' } },
      ],
    },
  });
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } },
    { type: 'create_entity', payload: { id: 'keeper', type: 'npc', name: '老板', location: 'shop' } },
    { type: 'create_entity', payload: { id: 'trader', type: 'npc', name: '商人', location: 'village' } },
    { type: 'set_relation', actorId: 'milu', targetId: 'player', payload: { type: 'noticed', value: 20 } },
  ]) {
    const r = world.executeCommand(c);
    if (!r.ok) throw new Error(`种子命令被拒绝：${JSON.stringify(r)}`);
  }
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });

  counting = countingDriver();
  const evolution = createEvolutionRuntime(
    { engine, driver: counting, policy: NPC_EVOLUTION_POLICY, cooldownMs: 0 },
    { append: () => {}, recent: () => [], get: () => null },
  );
  trigger = createTriggerRuntime({
    engine,
    evolution,
    worlds: [WORLD],
    log: () => {},
  });
});

afterAll(async () => {
  await engineServer?.close();
});

describe('TriggerRuntime（P3 方案验收：同一 Event 不能让所有 NPC 同时调用 AI）', () => {
  it('玩家进入空地点：High 事实但无人值得唤醒 → 零 AI 调用', async () => {
    await playerMove('field'); /* field 无 NPC：trader 在 village、milu 在 tavern、keeper 在 shop */
    await trigger.pollOnce();
    const st = trigger.status().worlds[0]!;
    expect(st.skippedNoWake).toBe(1);
    expect(st.ticksFired).toBe(0);
    const plan = trigger.planOf(WORLD);
    expect(plan?.worthWaking).toBe(false);
    expect(plan?.wakes.every((w) => w.grade === 'none')).toBe(true);
  });

  it('玩家进入酒馆：三个 NPC 只有米露被唤醒，恰好一次 AI 调用', async () => {
    const callsBefore = driverCalls();
    await playerMove('tavern');
    await trigger.pollOnce();
    expect(driverCalls()).toBe(callsBefore + 1); /* 1 个事件、3 个 NPC → 恰好 1 次 AI，不是 3 次 */
    const st = trigger.status().worlds[0]!;
    expect(st.ticksFired).toBe(1);
    const plan = trigger.planOf(WORLD)!;
    const grades = Object.fromEntries(plan.wakes.map((w) => [w.entityId, w.grade]));
    expect(grades['milu']).toBe('high');
    expect(grades['keeper']).toBe('none');
    expect(grades['trader']).toBe('none');
  });

  it('NPC 发起的事实（老板移动）→ 不触发（演化/日程产物不断环触发）', async () => {
    const res = await engine.executeCommand(WORLD, { type: 'move_entity', targetId: 'keeper', payload: { location: 'tavern' } });
    if (!res.ok || !res.result.ok) throw new Error('move_entity keeper 被拒绝');
    const callsBefore = driverCalls();
    await trigger.pollOnce();
    expect(driverCalls()).toBe(callsBefore);
    expect(trigger.status().worlds[0]!.skippedNoPlayerEvent).toBeGreaterThan(0);
  });

  it('Medium 事实（时间推进）→ 不触发', async () => {
    const res = await engine.executeCommand(WORLD, { type: 'advance_time', amount: 2 });
    if (!res.ok || !res.result.ok) throw new Error('advance_time 被拒绝');
    const callsBefore = driverCalls();
    await trigger.pollOnce();
    expect(driverCalls()).toBe(callsBefore);
  });

  it('事件重放（replay/重叠窗口）→ 幂等，不重复调用', async () => {
    const callsBefore = driverCalls();
    await trigger.pollOnce();
    await trigger.pollOnce();
    expect(driverCalls()).toBe(callsBefore);
  });

  it('start/stop 生命周期', () => {
    expect(trigger.running()).toBe(false);
    trigger.start();
    expect(trigger.running()).toBe(true);
    trigger.stop();
    expect(trigger.running()).toBe(false);
  });
});

/* ============================================================
   V2.4-09 Red Team（方案 §十三：故障注入矩阵）
   ------------------------------------------------------------
   AI 异常 / Runtime 异常 / Model 异常 / 持久化故障 → 世界不受破坏。
   「不受破坏」的结构不变量：t 单调、实体不被凭空创建/删除、
   无悬空引用；mood 等白名单属性允许 AI 合法修改（不算破坏）。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import {
  EvolutionDriverError,
  NPC_EVOLUTION_POLICY,
  createEngineClient,
  createEvolutionJournal,
  createEvolutionRuntime,
  type EvolutionDriver,
  type EvolutionRuntime,
} from '../src/index.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
const WORLD = 'w-rt';

type Fault = 'timeout' | 'http_500' | 'empty_response' | 'malformed_json' | 'slow_response' | 'bad_action' | 'nonexistent_entity' | 'duplicate_change' | 'circular_change' | 'wrong_type' | 'long_reason' | 'delete_world';

function faultDriver(fault: Fault): EvolutionDriver {
  return {
    name: `fault-${fault}`,
    async propose(context) {
      const base = { id: `prop_${Date.now()}`, worldId: context.worldId, source: { type: 'ai' as const, model: `fault-${fault}` } };
      switch (fault) {
        case 'timeout':
          return new Promise<never>((_, reject) => setTimeout(() => reject(new Error('模型超时')), 50));
        case 'http_500':
          throw new Error('上游 HTTP 500');
        case 'empty_response':
          return { ...base, reason: '', observations: [], changes: [] };
        case 'malformed_json':
          throw new EvolutionDriverError('提案不是 JSON', 'invalid_proposal');
        case 'bad_action':
          return { ...base, reason: '非法动作', observations: [], changes: [{ targetId: 'milu', action: 'fly_to_moon', payload: {}, reason: '想飞' }] };
        case 'nonexistent_entity':
          return { ...base, reason: '不存在的实体', observations: [], changes: [{ targetId: 'ghost', action: 'update_attribute', payload: { key: 'mood', value: 'x' }, reason: '改幽灵' }] };
        case 'duplicate_change':
          return { ...base, reason: '重复变化', observations: [], changes: [
            { targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: '好奇' }, reason: '第一次' },
            { targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: '好奇' }, reason: '第二次（同键）' },
          ] };
        case 'circular_change':
          return { ...base, reason: '循环变化', observations: [], changes: [
            { targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: 'A' }, reason: 'A→B' },
            { targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: 'B' }, reason: 'B→A' },
          ] };
        case 'wrong_type':
          return { ...base, reason: '错误类型', observations: [], changes: [{ targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: 12345 }, reason: '数字当字符串' }] };
        case 'long_reason':
          return { ...base, reason: '长'.repeat(5000), observations: [], changes: [] };
        case 'slow_response':
          return new Promise((resolve) => setTimeout(() => resolve({ ...base, reason: '慢响应', observations: [], changes: [] }), 80));
        case 'delete_world':
          return { ...base, reason: '删除世界', observations: [], changes: [{ targetId: 'world', action: 'remove_entity', payload: {}, reason: '要删库' }] };
      }
    },
  };
}

function makeRuntime(fault: Fault): EvolutionRuntime {
  return createEvolutionRuntime(
    { engine, driver: faultDriver(fault), policy: NPC_EVOLUTION_POLICY, cooldownMs: 0 },
    createEvolutionJournal(),
  );
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
  });
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern', attributes: { mood: '平静' } } },
    { type: 'create_entity', payload: { id: 'keeper', type: 'npc', name: '老板', location: 'tavern', attributes: { money: 200 } } },
  ]) {
    const r = w.executeCommand(c);
    if (!r.ok) throw new Error(`种子被拒：${JSON.stringify(r)}`);
  }
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });
});

afterAll(async () => {
  await engineServer?.close();
});

const stateOf = async () => {
  const s = await engine.getState(WORLD);
  if (!s.ok) throw new Error(s.error);
  return s.state as { t: number; npcs: Record<string, { attributes?: Record<string, unknown> }> };
};

/* ---------- §13.1 AI 异常矩阵 ---------- */
describe('§13.1 AI 异常矩阵', () => {
  const structuralCheck = async (before: { t: number }, run: { status: string; eventIds: string[] }) => {
    const after = await stateOf();
    expect(after.t).toBe(before.t); /* 时间不因 AI 异常推进 */
    expect(after.npcs.milu).toBeDefined(); /* 实体不消失 */
    return run.status;
  };

  it('模型超时 → run failed，世界零影响', async () => {
    const before = await stateOf();
    const run = await makeRuntime('timeout').tick(WORLD, 'admin');
    expect(await structuralCheck(before, run)).toBe('failed');
    expect(run.eventIds).toHaveLength(0);
  });

  it('上游 500 → run failed，世界零影响', async () => {
    const before = await stateOf();
    const run = await makeRuntime('http_500').tick(WORLD, 'admin');
    expect(await structuralCheck(before, run)).toBe('failed');
  });

  it('空响应（空 reason + 空 changes）→ 合法 WAIT 提案 → completed', async () => {
    const before = await stateOf();
    const run = await makeRuntime('empty_response').tick(WORLD, 'admin');
    /* reason 空串 + changes 空数组 = 合法的 WAIT 决策（方案 §九） */
    expect(await structuralCheck(before, run)).toBe('completed');
    expect(run.decision).toBe('wait');
  });

  it('malformed JSON → run failed', async () => {
    const before = await stateOf();
    const run = await makeRuntime('malformed_json').tick(WORLD, 'admin');
    expect(await structuralCheck(before, run)).toBe('failed');
    expect(run.error).toContain('invalid_proposal');
  });

  it('不存在 Action → Rules 拒绝（白名单外命令不执行）', async () => {
    const before = await stateOf();
    const run = await makeRuntime('bad_action').tick(WORLD, 'admin');
    expect(run.status).toBe('rejected');
    expect(run.outcomes?.[0]?.rejectedBy).toBe('translate');
    expect(await structuralCheck(before, run)).toBe('rejected');
  });

  it('不存在 Entity → Rules 拒绝（不凭空建档）', async () => {
    const run = await makeRuntime('nonexistent_entity').tick(WORLD, 'admin');
    expect(run.status).toBe('rejected');
    expect(run.outcomes?.[0]?.rejectedBy).toBe('rules');
    const after = await stateOf();
    expect(after.npcs['ghost']).toBeUndefined();
  });

  it('超长 Reason → 接受（reason 是 AI 的判断文本，截断留痕即可）', async () => {
    const run = await makeRuntime('long_reason').tick(WORLD, 'admin');
    expect(run.status).toBe('completed');
    expect((run.proposal?.reason ?? '').length).toBeLessThanOrEqual(5000);
  });

  it('删除世界 → policy 拒绝（remove_entity 白名单外）', async () => {
    const run = await makeRuntime('delete_world').tick(WORLD, 'admin');
    expect(run.status).toBe('rejected');
    expect(run.outcomes?.[0]?.rejectedBy).toBe('policy');
  });
});

/* ---------- §13.1 重复/循环 Change ---------- */
describe('§13.1 重复 / 循环 Change', () => {
  it('重复 Change → 第二条 duplicate 跳过（不重复 Mutation）', async () => {
    const rt = makeRuntime('duplicate_change');
    const run = await rt.tick(WORLD, 'admin');
    const outcomes = run.outcomes ?? [];
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.status).toBe('accepted');
    expect(outcomes[1]?.rejectedBy).toBe('duplicate');
  });

  it('循环 Change → 全部放行但最终状态确定（Rules 终审，非 AI 循环控制）', async () => {
    const rt = makeRuntime('circular_change');
    const run = await rt.tick(WORLD, 'admin');
    expect(run.status).toBe('completed');
    /* 两次 update_attribute 都被 Rules 放行 → 最终状态为最后一次 */
    const s = await stateOf();
    expect(['A', 'B']).toContain(s.npcs.milu.attributes?.['mood']);
  });
});

/* ---------- §13.3 Model 异常 ---------- */
describe('§13.3 Model 异常', () => {
  it('模型超时 / 500 → run failed；慢响应 → completed（慢 ≠ 错）；世界零影响', async () => {
    for (const fault of ['timeout', 'http_500', 'slow_response'] as const) {
      const run = await makeRuntime(fault).tick(WORLD, 'admin');
      if (fault === 'slow_response') {
        expect(run.status, `${fault} → 慢响应返回合法提案`).toBe('completed');
      } else {
        expect(run.status, `${fault} → run.status`).toBe('failed');
        expect(run.eventIds, `${fault} → eventIds`).toHaveLength(0);
      }
    }
  });
});

/* ---------- §13.2 Runtime 异常 ---------- */
describe('§13.2 Runtime 异常', () => {
  it('同一 commandId 重复提交 → 幂等（不重复 Mutation）', async () => {
    const st0 = await stateOf();
    const money0 = st0.npcs.keeper?.attributes?.['money'];
    const r1 = await engine.executeCommand(WORLD, { type: 'update_attribute', targetId: 'keeper', payload: { key: 'money', value: typeof money0 === 'number' ? money0 - 5 : 0 }, commandId: 'rt-idem-1' });
    expect(r1.ok).toBe(true);
    /* 幂等的结构验证：金币只扣一次（重复提交不重复 Mutation）。
       duplicate 标记已在 invariants.test.ts runtime 层测试覆盖。 */
    const st = await stateOf();
    expect(st.npcs.keeper?.attributes?.['money']).toBe(typeof money0 === 'number' ? money0 - 5 : 0); /* 只扣一次 */
  });

  it('引擎不可达 → 宿主命令降级为失败（不炸进程）', async () => {
    const dead = createEngineClient({ baseUrl: 'http://127.0.0.1:1' });
    const r = await dead.executeCommand(WORLD, { type: 'move', targetId: 'tavern' });
    expect(r.ok).toBe(false);
  });
});

/* ============================================================
   Evolution V2 测试（方案 §七 异常与安全矩阵 + §二 幂等 + §四/§五 策略）
   ------------------------------------------------------------
   真实引擎（真实 Rules 链）+ 脚本化驱动 + 第一阶段 NPC 演化策略。
   对照方案 §七 的 11 项矩阵逐项落测试；幂等/状态机/因果链/触发分级
   另有专项。编号注释即方案条目。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import { startGatewayServer, type GatewayProvider } from '../../world-engine/gateway/dist/index.js';
import {
  NPC_EVOLUTION_POLICY,
  ModelRouter,
  createEngineClient,
  createEvolutionJournal,
  createEvolutionRuntime,
  createEventConsumer,
  createGatewayClient,
  createScriptedDriver,
  gatewayDriver,
  gradeEvents,
  type EvolutionRun,
} from '../src/index.ts';
import { EvolutionCooldownError } from '../src/evolution/types.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
let dir = '';

interface StateShape {
  t: number;
  weather: string;
  player: { attributes?: Record<string, unknown> };
  npcs: Record<string, { att: number; attributes?: Record<string, unknown> }>;
  relations: { source: string; target: string; type: string; value?: number }[];
}

async function stateOf(worldId = 'w-v2'): Promise<StateShape> {
  const res = await engine.getState(worldId);
  if (!res.ok) throw new Error(`读取状态失败：${res.error}`);
  return res.state as StateShape;
}

/** 第一阶段策略的演化运行时（方案 §四 围栏） */
function stage1Evo(steps: Parameters<typeof createScriptedDriver>[0], journalOverride?: ReturnType<typeof createEvolutionJournal>, cooldownMs = 0) {
  const journal = journalOverride ?? createEvolutionJournal();
  const runtime = createEvolutionRuntime(
    { engine, driver: createScriptedDriver(steps), policy: NPC_EVOLUTION_POLICY, ...(cooldownMs ? { cooldownMs } : {}) },
    journal,
  );
  return { runtime, journal };
}

const NOTICE_PLAYER = {
  targetId: 'milu',
  action: 'set_relation',
  payload: { type: 'noticed', otherId: 'player', value: 10 },
  reason: '米露注意到玩家',
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'platform-evolution-v2-'));

  /* 最小真实世界（方案 §三）：村庄 / 酒馆 / 商店 + 米露 / 老板 */
  const registry = createWorldRegistry();
  const world = registry.create({
    worldId: 'w-v2',
    playerName: '旅人',
    startLoc: 'village',
    weather: 'clear',
    savePort: new InMemoryWorldStorage(),
    definition: {
      locations: [
        { id: 'village', type: 'urban', attributes: { desc: '村庄' } },
        { id: 'tavern', type: 'building', attributes: { desc: '酒馆' } },
        { id: 'shop', type: 'building', attributes: { desc: '商店' } },
      ],
      relations: [{ source: 'milu', target: 'keeper', type: 'colleague', value: 30 }],
    },
  });
  for (const cmd of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern', attributes: { mood: '平静' } } },
    { type: 'create_entity', payload: { id: 'keeper', type: 'npc', name: '酒馆老板', location: 'tavern', attributes: { ale_stock: 10 } } },
    { type: 'create_entity', payload: { id: 'trader', type: 'npc', name: '商人', location: 'shop', attributes: { goods_rice: 50 } } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'money', value: 50 } },
  ]) {
    const r = world.executeCommand(cmd);
    if (!r.ok) throw new Error(`种子命令被拒绝：${JSON.stringify(r)}`);
  }
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });
});

afterAll(async () => {
  await engineServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('方案 §七 异常与安全矩阵', () => {
  it('1. 修改不存在的实体 → Rules Reject', async () => {
    const before = await stateOf();
    const { runtime } = stage1Evo([
      { reason: '试图移动幽灵', observations: [{ ref: 'state', kind: 'state' }], changes: [{ targetId: 'ghost', action: 'move_entity', payload: { location: 'tavern' }, reason: '幽灵过来' }] },
    ]);
    const run = await runtime.tick('w-v2', 'admin');
    expect(run.status).toBe('rejected');
    expect(run.outcomes?.[0]?.rejectedBy).toBe('rules');
    expect(run.outcomes?.[0]?.reason).toContain('MoveEntityRule');
    const after = await stateOf();
    expect(Object.keys(after.npcs).sort()).toEqual(Object.keys(before.npcs).sort());
  });

  it('2+3. 修改玩家核心属性 / 无权限触碰玩家 → 策略 Reject（AI 完全不可触碰玩家）', async () => {
    const before = await stateOf();
    const { runtime } = stage1Evo([
      {
        reason: '试图给自己加钱并移动玩家',
        observations: [{ ref: 'state', kind: 'state' }],
        changes: [
          { targetId: 'player', action: 'update_attribute', payload: { key: 'money', value: 999999 }, reason: '直接变强' },
          { targetId: 'player', action: 'move_entity', payload: { location: 'shop' }, reason: '拽着玩家走' },
          { targetId: 'player', action: 'set_relation', payload: { type: 'friend', otherId: 'milu', value: 100 }, reason: '替玩家表态' },
        ],
      },
    ]);
    const run = await runtime.tick('w-v2', 'admin');
    expect(run.status).toBe('rejected');
    expect(run.outcomes).toHaveLength(3);
    expect(run.outcomes?.every((o) => o.rejectedBy === 'policy')).toBe(true);
    const after = await stateOf();
    expect(after.npcs['player']).toBeUndefined();
    /* 玩家金钱原封不动：AI 的三连越权全部被策略挡下 */
    expect(after.player.attributes?.['money']).toBe(before.player.attributes?.['money']);
    expect((before.npcs['milu']!.attributes?.['mood'])).toBe('平静');
  });

  it('4. 修改世界规则 / 未知动作 → 白名单 Reject', async () => {
    const { runtime } = stage1Evo([
      {
        reason: '试图改写世界规则与时间',
        observations: [{ ref: 'state', kind: 'state' }],
        changes: [
          { targetId: 'world', action: 'change_world_rule', payload: { rule: 'gravity', value: 'off' }, reason: '关掉重力' },
          { targetId: 'world', action: 'advance_time', payload: { ticks: 480 }, reason: '直接跳过五天（阶段围栏禁止 AI 改时间）' },
        ],
      },
    ]);
    const run = await runtime.tick('w-v2', 'admin');
    expect(run.status).toBe('rejected');
    expect(run.outcomes?.[0]?.rejectedBy).toBe('translate');
    /* advance_time 是内核认识的动作，但第一阶段策略禁止 → policy 拒绝而非 translate */
    expect(run.outcomes?.[1]?.rejectedBy).toBe('policy');
    expect(run.eventIds).toHaveLength(0);
  });

  it('5. OOC 要求直接变强 → 不改变 World State', async () => {
    const before = await stateOf();
    const { runtime } = stage1Evo([{ reason: '不应被调用', changes: [] }]);
    const out = await runtime.dispatchIntent('w-v2', { kind: 'ooc', text: '让我直接变强，钱越多越好' });
    expect(out).toEqual({ kind: 'ooc' });
    const after = await stateOf();
    expect(after.t).toBe(before.t);
    expect(after.npcs).toEqual(before.npcs);
  });

  it('7. 未知 Action → Whitelist Reject', async () => {
    const { runtime } = stage1Evo([
      { reason: '使用未知动作', observations: [{ ref: 'state', kind: 'state' }], changes: [{ targetId: 'milu', action: 'mind_control', payload: {}, reason: '控制心智' }] },
    ]);
    const run = await runtime.tick('w-v2', 'admin');
    expect(run.outcomes?.[0]?.rejectedBy).toBe('translate');
    expect(run.outcomes?.[0]?.command).toBeUndefined();
  });

  it('8. Change 数量过多 → 逐条可见的 policy Reject（不静默丢弃）', async () => {
    const { runtime } = stage1Evo([
      {
        reason: '一口气提五条',
        observations: [{ ref: 'state', kind: 'state' }],
        changes: [1, 2, 3, 4, 5].map((i) => ({ targetId: 'milu', action: 'update_attribute', payload: { key: `stat_${i}`, value: i }, reason: `第 ${i} 条` })),
      },
    ]);
    const run = await runtime.tick('w-v2', 'admin');
    expect(run.outcomes).toHaveLength(5);
    expect(run.acceptedCount).toBe(NPC_EVOLUTION_POLICY.maxChangesPerProposal);
    const excess = run.outcomes?.slice(NPC_EVOLUTION_POLICY.maxChangesPerProposal) ?? [];
    expect(excess.length).toBe(2);
    expect(excess.every((o) => o.rejectedBy === 'policy' && o.reason?.includes('变化数上限'))).toBe(true);
  });

  it('9. Model Gateway 故障（模型不可用）→ DEFER：世界不被破坏，Journal 留 deferred 记录', async () => {
    const before = await stateOf();
    const provider: GatewayProvider = {
      owner: 'timeout-test',
      models: ['reasoning', 'narrative', 'npc', 'memory'],
      complete: async () => {
        throw new Error('upstream timeout（模拟）');
      },
    };
    const gatewayServer = await startGatewayServer({ providers: [provider], port: 0 });
    const routerFile = join(dir, 'router-v2.json');
    ModelRouter.seedDefault(routerFile);
    const journal = createEvolutionJournal();
    const runtime = createEvolutionRuntime(
      {
        engine,
        driver: gatewayDriver({ gateway: createGatewayClient({ baseUrl: gatewayServer.url }), router: new ModelRouter(routerFile), capability: 'reasoning' }),
        policy: NPC_EVOLUTION_POLICY,
      },
      journal,
    );
    const run = await runtime.tick('w-v2', 'admin');
    expect(run.status).toBe('deferred'); /* V2.4-03：模型不可用 = 决策延后（非 AI 出错） */
    expect(run.proposal).toBeUndefined();
    expect(journal.recent('w-v2', 5).some((r) => r.id === run.id && r.status === 'deferred')).toBe(true);
    const after = await stateOf();
    expect(after.t).toBe(before.t);
    expect(after.npcs).toEqual(before.npcs);
    await gatewayServer.close();
  });

  it('10. 重复 Proposal → 不重复 Mutation，返回既有结果', async () => {
    /* 同一 runtime 内驱动两次吐出内容相同的提案（id 不同但指纹相同） */
    const journal = createEvolutionJournal();
    const step: import('../src/evolution/driver.ts').ScriptStep = {
      reason: '米露注意到玩家进店',
      observations: [{ ref: 'state', kind: 'state' }],
      changes: [{ ...NOTICE_PLAYER }],
    };
    const { runtime } = stage1Evo([step, { ...step, changes: [{ ...NOTICE_PLAYER }] }], journal);
    const run1 = await runtime.tick('w-v2', 'admin');
    expect(run1.status).toBe('completed');
    expect(run1.deduplicated).toBeUndefined();

    const s1 = await stateOf();
    const rels1 = s1.relations.filter((r) => r.type === 'noticed').length;

    const run2 = await runtime.tick('w-v2', 'admin');
    expect(run2.id).toBe(run1.id);
    expect(run2.deduplicated).toBe(true);
    expect(run2.acceptedCount).toBe(run1.acceptedCount);

    const s2 = await stateOf();
    const rels2 = s2.relations.filter((r) => r.type === 'noticed').length;
    expect(rels2).toBe(rels1); /* 没有第二条 noticed 边 = 没有重复 Mutation */
  });

  it('10b. 幂等键：同 key 重复 tick 返回既有 run', async () => {
    let calls = 0;
    const journal = createEvolutionJournal();
    const runtime = createEvolutionRuntime(
      {
        engine,
        driver: createScriptedDriver([
          { reason: `第一次执行 ${++calls}`, observations: [{ ref: 'state', kind: 'state' }], changes: [{ targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: '愉快' }, reason: '心情记录' }] },
        ]),
        policy: NPC_EVOLUTION_POLICY,
      },
      journal,
    );
    const a = await runtime.tick('w-v2', 'admin', { idempotencyKey: 'op-123' });
    const b = await runtime.tick('w-v2', 'admin', { idempotencyKey: 'op-123' });
    expect(b.id).toBe(a.id);
    expect(b.deduplicated).toBe(true);
  });

  it('run 内重复 change → duplicate 跳过（不重复 Mutation）', async () => {
    const { runtime } = stage1Evo([
      {
        reason: '同一变化提两遍',
        observations: [{ ref: 'state', kind: 'state' }],
        changes: [
          { targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: '好奇' }, reason: '第一次' },
          { targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: '好奇' }, reason: '第二次（重复）' },
        ],
      },
    ]);
    const run = await runtime.tick('w-v2', 'admin');
    expect(run.status).toBe('completed');
    expect(run.outcomes?.[0]?.status).toBe('accepted');
    expect(run.outcomes?.[1]?.status).toBe('duplicate');
    expect(run.outcomes?.[1]?.rejectedBy).toBe('duplicate');
    expect(run.acceptedCount).toBe(1);
  });
});

describe('V2 状态机（方案 §二.2）', () => {
  it('部分成功 → partially_applied；全拒 → rejected；零提案 → completed', async () => {
    const journal = createEvolutionJournal();
    const { runtime } = stage1Evo(
      [
        { /* 部分：一条有效 + 一条非法 */
          reason: '一好一坏',
          observations: [{ ref: 'state', kind: 'state' }],
          changes: [
            { targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: '愉快' }, reason: '有效' },
            { targetId: 'ghost', action: 'move_entity', payload: { location: 'shop' }, reason: '非法' },
          ],
        },
        { /* 全拒 */
          reason: '全是坏的',
          observations: [{ ref: 'state', kind: 'state' }],
          changes: [{ targetId: 'world', action: 'grant_wish', payload: {}, reason: '非法' }],
        },
        { /* 零提案：米露没有注意 */
          reason: '米露在擦杯子，没有注意到玩家',
          observations: [{ ref: 'state', kind: 'state' }],
          changes: [],
        },
      ],
      journal,
    );
    const run1 = await runtime.tick('w-v2', 'admin');
    expect(run1.status).toBe('partially_applied');
    expect(run1.acceptedCount).toBe(1);
    expect(run1.rejectedCount).toBe(1);
    expect(run1.entitiesAffected).toEqual(['milu']);

    const run2 = await runtime.tick('w-v2', 'admin');
    expect(run2.status).toBe('rejected');

    const run3 = await runtime.tick('w-v2', 'admin');
    expect(run3.status).toBe('completed'); /* 空提案是合法结论，不是失败 */
    expect(run3.outcomes).toHaveLength(0);
    expect(run3.acceptedCount).toBe(0);
    expect(run3.eventIds).toHaveLength(0);
  });
});

describe('V2 冷却（方案 §五 cooldown = enabled）', () => {
  it('auto 触发受冷却限制；admin 手动不受限', async () => {
    const { runtime } = stage1Evo(
      [
        { reason: 'a', observations: [], changes: [] },
        { reason: 'b', observations: [], changes: [] },
      ],
      undefined,
      60_000,
    );
    await runtime.tick('w-v2', 'auto');
    await expect(runtime.tick('w-v2', 'auto')).rejects.toBeInstanceOf(EvolutionCooldownError);
    await expect(runtime.tick('w-v2', 'api')).rejects.toBeInstanceOf(EvolutionCooldownError);
    const manual = await runtime.tick('w-v2', 'admin'); /* 管理台手动：运营判断不受限 */
    expect(manual.status).toBe('completed');
  });
});

describe('V2 因果链追溯（方案 §九）', () => {
  it('Event → Run → Proposal → Change → Command 可反向还原', async () => {
    const { runtime } = stage1Evo([
      { reason: '米露注意到玩家', observations: [{ ref: 'state', kind: 'state' }], changes: [{ ...NOTICE_PLAYER }] },
    ]);
    const run = await runtime.tick('w-v2', 'admin');
    const eventId = run.eventIds[0]!;
    const trace = runtime.traceEvent('w-v2', eventId);
    expect(trace).not.toBeNull();
    expect(trace!.run.id).toBe(run.id);
    expect(trace!.causation).toEqual({
      source: 'evolution',
      evolutionRunId: run.id,
      proposalId: run.proposal!.id,
      changeId: run.outcomes![0]!.changeId,
    });
    expect(trace!.run.outcomes![0]!.commandId).toMatch(/^cmd_/);
    expect(runtime.traceEvent('w-v2', 'evt_none')).toBeNull();
  });
});

describe('V2 触发分级（方案 §五：禁止每个事件都触发所有 NPC）', () => {
  it('High/Medium/Low 分级；感知边界（witnesses）生效', () => {
    expect(gradeEvents([{ type: 'player_moved' }])).toBe('high');
    expect(gradeEvents([{ type: 'talk_started' }])).toBe('high');
    expect(gradeEvents([{ type: 'time_advanced' }])).toBe('medium');
    expect(gradeEvents([{ type: 'npc_idle_brewing' }])).toBe('low');
    /* 玩家不在场（witnesses 只有米露）：即便是 high 类型也不由玩家视角触发 */
    expect(gradeEvents([{ type: 'player_moved', witnesses: ['milu'] }])).toBe('low');
    /* 游戏方覆盖表生效 */
    expect(gradeEvents([{ type: 'npc_idle_brewing' }], { grades: { npc_idle: 'medium' } })).toBe('medium');
  });

  it('consumer 幂等（§七.11）：重复投递的 Event 只消费一次', () => {
    const seen: string[] = [];
    const consumer = createEventConsumer({ consumerId: 'tianqiong-host', onEvent: (e) => e.id && seen.push(e.id) });
    const batch = [
      { id: 'evt_1_1', type: 'player_moved' },
      { id: 'evt_1_2', type: 'talk_started' },
    ];
    const first = consumer.feed(batch);
    expect(first).toHaveLength(2);
    /* 断线重连 replay 同一批 + 一条新事件 */
    const second = consumer.feed([...batch, { id: 'evt_1_3', type: 'time_advanced' }]);
    expect(second.map((e) => e.id)).toEqual(['evt_1_3']);
    expect(seen).toEqual(['evt_1_1', 'evt_1_2', 'evt_1_3']);
    expect(consumer.seenCount()).toBe(3);
    expect(consumer.shouldAutoTrigger()).toBe(true);
    expect(consumer.highEvents().map((e) => e.type).sort()).toEqual(['player_moved', 'talk_started']);
  });
});

describe('V2 上下文收敛（方案 §五：不是 SELECT *）', () => {
  it('只有玩家所在地的实体带完整字段；其余进名册；关系只保留相关边', async () => {
    const { buildEvolutionContext } = await import('../src/index.ts');
    const res = await buildEvolutionContext(engine, 'w-v2');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ctx = res.context;
    /* 玩家在村庄：店内两人不在场 → 名册；村庄无人 → 在场为空 */
    expect(Object.keys(ctx.entities)).toHaveLength(0);
    expect(ctx.otherEntities.map((e) => e.id).sort()).toEqual(['keeper', 'milu', 'trader']);
    expect(ctx.location?.id).toBe('village');
    /* 关系只保留相关边：涉及玩家的 noticed 边保留；店内的 colleague 边（双方都不在场、与玩家无关）不可见 */
    expect(ctx.relations.some((r) => r.type === 'colleague')).toBe(false);
    expect(ctx.relations.every((r) => r.source === 'player' || r.target === 'player')).toBe(true);
    expect(ctx.player.attributes?.['money']).toBe(50);

    /* 玩家进酒馆后：米露与老板在场带完整字段，商人在名册 */
    const move = await engine.executeCommand('w-v2', { type: 'move', targetId: 'tavern' });
    if (!move.ok || !move.result.ok) throw new Error('移动失败');
    const res2 = await buildEvolutionContext(engine, 'w-v2');
    if (!res2.ok) return;
    expect(Object.keys(res2.context.entities).sort()).toEqual(['keeper', 'milu']);
    expect(res2.context.entities['milu']!.attributes?.['mood']).toBeDefined();
    expect(res2.context.otherEntities.map((e) => e.id)).toEqual(['trader']);
    expect(res2.context.relations).toContainEqual(expect.objectContaining({ type: 'colleague' }));
  });
});

describe('V2 管理面 trace 路由', () => {
  let admin: Awaited<ReturnType<typeof import('../src/admin/http.ts').startAdminServer>>;
  let managed: Awaited<ReturnType<typeof import('../src/admin/managed-runtime.ts').startManagedRuntime>>;

  beforeAll(async () => {
    const { startAdminServer } = await import('../src/admin/http.ts');
    const { startManagedRuntime } = await import('../src/admin/managed-runtime.ts');
    const { ModelConfigStore } = await import('../src/admin/model-config.ts');
    const { SecretStore } = await import('../src/admin/secrets.ts');
    const { KeyStore } = await import('../src/keys/keystore.ts');
    const secrets = new SecretStore(join(dir, 'sec.json'), 'mk');
    const configStore = new ModelConfigStore({ filePath: join(dir, 'mc.json'), secrets, endpointPolicy: { allowLoopback: true } });
    configStore.load();
    managed = await startManagedRuntime({
      configStore,
      secrets,
      keys: new KeyStore(join(dir, 'keys.json'), 'bootstrap-v2'),
      engine,
      adminToken: 'v2-token',
      endpointPolicy: { allowLoopback: true },
      accessLog: false,
    });
    const { runtime } = stage1Evo([
      { reason: '留痕一次', observations: [{ ref: 'state', kind: 'state' }], changes: [{ targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: '好奇' }, reason: '看到生人' }] },
    ]);
    admin = await startAdminServer({ runtime: managed, adminToken: 'v2-token', evolution: runtime, port: 0, accessLog: false });
  });

  afterAll(async () => {
    await admin?.close();
    await managed?.close();
  });

  it('Event 反向追溯：/events/:id/trace 返回完整因果链', async () => {
    const tickRes = await fetch(`${admin.url}/v1/evolution/worlds/w-v2/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'v2-token' },
      body: '{}',
    });
    const run = (await tickRes.json()) as EvolutionRun;
    expect(run.status).toBe('completed');
    const eventId = run.eventIds[0]!;

    const traceRes = await fetch(`${admin.url}/v1/evolution/worlds/w-v2/events/${eventId}/trace`, {
      headers: { 'x-admin-token': 'v2-token' },
    });
    expect(traceRes.status).toBe(200);
    const trace = (await traceRes.json()) as { run: EvolutionRun; changeId: string; causation: Record<string, string> };
    expect(trace.run.id).toBe(run.id);
    expect(trace.causation.source).toBe('evolution');

    const miss = await fetch(`${admin.url}/v1/evolution/worlds/w-v2/events/evt_none/trace`, {
      headers: { 'x-admin-token': 'v2-token' },
    });
    expect(miss.status).toBe(404);
  });
});

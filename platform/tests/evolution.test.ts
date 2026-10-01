/* ============================================================
   AI World Evolution Runtime 闭环测试（方案 Phase B 验收）
   ------------------------------------------------------------
   真实引擎（真实 Rules 链 / 真实事件总线）+ 脚本化 AI 驱动——
   验证方案 §十九 的核心命题：

   「AI 能否在不直接修改世界的情况下，推动一个真实世界发生
     跨系统、可验证、可追踪的演化。」

   实验 A（§十）：玩家行为 → 世界事件 → AI 反应 → Rules → 落地
   实验 B（§十）：时间推进三日 → 跨系统推演（经济/关系） → 落地
   另覆盖：Rules 拒绝非法建议 / 白名单拒绝 / OOC 隔离 / 观察失败
   零影响 / 网关真驱动解析 / 管理面演化路由。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import { startGatewayServer, type GatewayProvider } from '../../world-engine/gateway/dist/index.js';
import {
  ModelRouter,
  createEngineClient,
  createEvolutionJournal,
  createEvolutionRuntime,
  createGatewayClient,
  createScriptedDriver,
  gatewayDriver,
  type EvolutionRun,
} from '../src/index.ts';
import { startManagedRuntime, type ManagedRuntime } from '../src/admin/managed-runtime.ts';
import { startAdminServer } from '../src/admin/http.ts';
import { ModelConfigStore } from '../src/admin/model-config.ts';
import { SecretStore } from '../src/admin/secrets.ts';
import { KeyStore } from '../src/keys/keystore.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let engine: ReturnType<typeof createEngineClient>;
let dir = '';

interface StateShape {
  t: number;
  weather: string;
  npcs: Record<string, { att: number; attributes?: Record<string, unknown> }>;
  relations: { source: string; target: string; type: string; value?: number }[];
}

async function stateOf(worldId = 'w-min'): Promise<StateShape> {
  const res = await engine.getState(worldId);
  if (!res.ok) throw new Error(`读取状态失败：${res.error}`);
  return res.state as StateShape;
}

async function relationsOf(worldId = 'w-min'): Promise<StateShape['relations']> {
  return (await stateOf(worldId)).relations ?? [];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'platform-evolution-'));

  /* 1) 真实引擎：方案 §十 的最小世界（村庄 / 酒馆 / 商店；米露 / 商人） */
  const registry = createWorldRegistry();
  const world = registry.create({
    worldId: 'w-min',
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
    },
  });
  /* 种子命令走同一条命令链（与游戏方客户端同权） */
  const seeds = [
    world.executeCommand({ type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern', attributes: { tavern_revenue: 100 } } }),
    world.executeCommand({ type: 'create_entity', payload: { id: 'trader', type: 'npc', name: '商人老葛', location: 'shop', attributes: { goods_rice: 50 } } }),
    world.executeCommand({ type: 'set_relation', actorId: 'milu', targetId: 'trader', payload: { type: 'friend', value: 20 } }),
  ];
  const bad = seeds.filter((r) => !r.ok);
  if (bad.length) throw new Error(`种子命令被拒绝：${JSON.stringify(bad)}`);
  engineServer = await startWorldServer({ registry, port: 0 });
  engine = createEngineClient({ baseUrl: engineServer.url });
});

afterAll(async () => {
  await engineServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('实验 A：玩家行为 → 世界事件 → AI 反应 → Rules → 落地', () => {
  it('玩家进酒馆；AI 观察到 player_moved 并提出提案；Rules 全部放行并落地', async () => {
    /* 玩家意图 → Command → Rules → Mutation → Event（不经 AI） */
    const move = await engine.executeCommand('w-min', { type: 'move', targetId: 'tavern' });
    if (!move.ok || !move.result.ok) throw new Error(`移动命令失败：${JSON.stringify(move)}`);
    const moveEventId = move.result.events[0]!;

    const journal = createEvolutionJournal();
    const evo = createEvolutionRuntime(
      {
        engine,
        driver: createScriptedDriver([
          {
            reason: '玩家进入酒馆，米露注意到常客归来',
            observations: [{ ref: moveEventId, kind: 'event', summary: '玩家移动到酒馆' }],
            changes: [
              { targetId: 'milu', action: 'set_relation', payload: { type: 'noticed', otherId: 'player', value: 10 }, reason: '米露看见玩家进店' },
              { targetId: 'milu', action: 'update_attribute', payload: { key: 'tavern_revenue', value: 130 }, reason: '客流带来营业额上升' },
            ],
            confidence: 0.8,
          },
        ]),
      },
      journal,
    );

    const run = await evo.tick('w-min', 'admin');
    expect(run.status).toBe('completed');
    expect(run.proposal?.observations[0]?.ref).toBe(moveEventId);
    expect(run.acceptedCount).toBe(2);
    expect(run.rejectedCount).toBe(0);
    expect(run.outcomes?.every((o) => o.eventIds.length > 0)).toBe(true);

    /* 世界真的变了：经 Mutation，而不是 AI 直接写 */
    const s = await stateOf();
    expect(s.npcs['milu']!.attributes?.['tavern_revenue']).toBe(130);
    const rels = await relationsOf();
    expect(rels).toContainEqual(expect.objectContaining({ source: 'milu', target: 'player', type: 'noticed', value: 10 }));

    /* 因果链：提案 → 裁决 → 事实 id 可反向追溯 */
    expect(run.eventIds.length).toBeGreaterThanOrEqual(2);
    const evRes = await engine.getEvents('w-min', 10);
    if (!evRes.ok) throw new Error(evRes.error);
    const ids = new Set((evRes.events as { id: string }[]).map((e) => e.id));
    for (const id of run.eventIds) expect(ids.has(id)).toBe(true);
  });
});

describe('实验 B：时间推进三日 → 跨系统演化（经济 + 关系）', () => {
  it('AI 依据三日时间跨度提出跨系统提案；全部经 Rules 落地', async () => {
    const advance = await engine.executeCommand('w-min', { type: 'advance_time', amount: 48 * 3 });
    expect(advance.ok).toBe(true);

    const journal = createEvolutionJournal();
    const evo = createEvolutionRuntime(
      {
        engine,
        driver: createScriptedDriver([
          {
            reason: '玩家离开三日：商店库存走低、酒馆收入回落、商人与米露的供货关系出现张力',
            observations: [{ ref: 'state', kind: 'state', summary: '时间推进三日后的状态快照' }],
            changes: [
              { targetId: 'trader', action: 'update_attribute', payload: { key: 'goods_rice', value: 35 }, reason: '三日无人采购，库存下调' },
              { targetId: 'milu', action: 'update_attribute', payload: { key: 'tavern_revenue', value: 80 }, reason: '常客未归，收入回落' },
              { targetId: 'trader', action: 'set_relation', payload: { type: 'supply_tension', otherId: 'milu', value: -15 }, reason: '供货关系出现张力' },
            ],
          },
        ]),
      },
      journal,
    );

    const run = await evo.tick('w-min', 'admin');
    expect(run.status).toBe('completed');
    expect(run.acceptedCount).toBe(3);

    const s = await stateOf();
    expect(s.npcs['trader']!.attributes?.['goods_rice']).toBe(35);
    expect(s.npcs['milu']!.attributes?.['tavern_revenue']).toBe(80);
    const rels = await relationsOf();
    expect(rels).toContainEqual(expect.objectContaining({ source: 'trader', target: 'milu', type: 'supply_tension', value: -15 }));
  });
});

describe('确定性边界：Rules 与白名单拒绝 AI 的非法建议', () => {
  it('引擎规则拒绝（移除不存在的实体）；状态不变', async () => {
    const before = await stateOf();
    const journal = createEvolutionJournal();
    const evo = createEvolutionRuntime(
      {
        engine,
        driver: createScriptedDriver([
          {
            reason: '尝试清理不存在的实体（非法建议）',
            observations: [{ ref: 'state', kind: 'state' }],
            changes: [{ targetId: 'ghost', action: 'remove_entity', reason: '清理幽灵' }],
          },
        ]),
      },
      journal,
    );
    const run = await evo.tick('w-min', 'admin');
    expect(run.status).toBe('completed');
    expect(run.acceptedCount).toBe(0);
    expect(run.outcomes?.[0]?.accepted).toBe(false);
    expect(run.outcomes?.[0]?.rejectedBy).toBe('rules');
    expect(run.outcomes?.[0]?.reason).toContain('RemoveEntityRule');
    const after = await stateOf();
    expect(after.npcs['ghost']).toBeUndefined();
    expect(Object.keys(after.npcs).sort()).toEqual(Object.keys(before.npcs).sort());
  });

  it('白名单拒绝：演化层不认识的 action 根本不进引擎', async () => {
    const journal = createEvolutionJournal();
    const evo = createEvolutionRuntime(
      {
        engine,
        driver: createScriptedDriver([
          {
            reason: '尝试越权动作',
            observations: [{ ref: 'state', kind: 'state' }],
            changes: [{ targetId: 'world', action: 'grant_god_mode', reason: '想要神权' }],
          },
        ]),
      },
      journal,
    );
    const run = await evo.tick('w-min', 'admin');
    expect(run.outcomes?.[0]?.accepted).toBe(false);
    expect(run.outcomes?.[0]?.rejectedBy).toBe('translate');
    expect(run.outcomes?.[0]?.command).toBeUndefined();
    expect(run.eventIds).toHaveLength(0);
  });

  it('变化数硬上限：超限提案被截断，多出的变化不进引擎', async () => {
    const journal = createEvolutionJournal();
    const evo = createEvolutionRuntime(
      { engine, maxChangesPerRun: 2, driver: createScriptedDriver([
        {
          reason: '一口气提五条',
          observations: [{ ref: 'state', kind: 'state' }],
          changes: [1, 2, 3, 4, 5].map((i) => ({
            targetId: 'milu',
            action: 'update_attribute',
            payload: { key: `stat_${i}`, value: i },
            reason: `第 ${i} 条`,
          })),
        },
      ]) },
      journal,
    );
    const run = await evo.tick('w-min', 'admin');
    expect(run.outcomes).toHaveLength(2);
    expect(run.acceptedCount).toBe(2);
  });
});

describe('OOC 隔离与失败语义', () => {
  it('ooc / narrative 意图永不进引擎；ic_action 走命令链', async () => {
    const journal = createEvolutionJournal();
    const evo = createEvolutionRuntime(
      { engine, driver: createScriptedDriver([{ reason: '不应被调用', changes: [] }]) },
      journal,
    );
    const before = await engine.getEvents('w-min', 50);
    if (!before.ok) throw new Error(before.error);

    const ooc = await evo.dispatchIntent('w-min', { kind: 'ooc', text: '帮我把天气改成雨天' });
    expect(ooc).toEqual({ kind: 'ooc' });

    const nar = await evo.dispatchIntent('w-min', { kind: 'narrative', text: '（旁白：雨要来了）' });
    expect(nar).toEqual({ kind: 'narrative' });

    const ic = await evo.dispatchIntent('w-min', { kind: 'ic_action', text: '我想让天下雨', command: { type: 'change_weather', text: 'rain' } });
    expect(ic.commandResult?.ok).toBe(true);

    const s = await stateOf();
    expect(s.weather).toBe('rain');
    const after = await engine.getEvents('w-min', 50);
    if (!after.ok) throw new Error(after.error);
    /* OOC 没有产生任何世界事实；只有 ic_action 的 change_weather 产生了一条 */
    expect(after.events.length).toBe(before.events.length + 1);
  });

  it('观察失败（世界不存在）→ run failed，世界零影响', async () => {
    const before = await stateOf();
    const journal = createEvolutionJournal();
    const evo = createEvolutionRuntime(
      { engine, driver: createScriptedDriver([{ reason: '不应被调用', changes: [] }]) },
      journal,
    );
    const run = await evo.tick('w-missing', 'admin');
    expect(run.status).toBe('failed');
    expect(run.error).toContain('404');
    expect(run.proposal).toBeUndefined();
    const after = await stateOf();
    expect(after.t).toBe(before.t);
  });
});

describe('因果链账本', () => {
  it('runs / run 读取留痕；knownWorlds 列出有账本的世界', async () => {
    const journal = createEvolutionJournal();
    const evo = createEvolutionRuntime(
      { engine, driver: createScriptedDriver([
        { reason: '留痕一次', observations: [{ ref: 'state', kind: 'state' }], changes: [{ targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: 'calm' }, reason: '心情记录' }] },
      ]) },
      journal,
    );
    const run = await evo.tick('w-min', 'admin');
    const recent = evo.runs('w-min', 10);
    expect(recent.length).toBeGreaterThanOrEqual(1);
    expect(recent[0]!.id).toBe(run.id);
    expect(evo.run('w-min', run.id)?.context?.worldId).toBe('w-min');
    expect(evo.knownWorlds()).toContain('w-min');
    expect(evo.run('w-min', 'no-such-id')).toBeNull();
  });
});

describe('网关真驱动：模型 JSON 提案解析与失败语义', () => {
  it('脚本化模型供应商 → 网关驱动解析提案 → Rules 落地；坏 JSON → failed 零影响', async () => {
    const goodJson = [
      '好的，以下是我的提案：', // 前置闲话（解析须容忍）
      '```json',
      JSON.stringify({
        reason: '酒馆客流回落，建议调低营业额记录',
        observations: [{ ref: 'state', kind: 'state', summary: '状态快照' }],
        changes: [{ targetId: 'milu', action: 'update_attribute', payload: { key: 'tavern_revenue', value: 90 }, reason: '回落后的稳态' }],
        confidence: 0.6,
      }),
      '```',
      '以上。',
    ].join('\n');

    let calls = 0;
    const provider: GatewayProvider = {
      owner: 'evolution-test',
      models: ['narrative', 'npc', 'reasoning', 'memory'],
      complete: async (_model, _messages) => {
        calls++;
        return calls === 1 ? goodJson : '我觉得世界会变好，但我说不出结构化的理由。';
      },
    };
    const gatewayServer = await startGatewayServer({ providers: [provider], port: 0 });
    const routerFile = join(dir, 'router-gw.json');
    ModelRouter.seedDefault(routerFile);
    const router = new ModelRouter(routerFile);
    const driver = gatewayDriver({ gateway: createGatewayClient({ baseUrl: gatewayServer.url }), router, capability: 'reasoning' });

    const journal = createEvolutionJournal();
    const evo = createEvolutionRuntime({ engine, driver }, journal);

    const run1 = await evo.tick('w-min', 'admin');
    expect(run1.status).toBe('completed');
    expect(run1.modelUsed).toBe('reasoning');
    expect(run1.proposal?.source.model).toBe('reasoning');
    expect(run1.acceptedCount).toBe(1);
    expect((await stateOf()).npcs['milu']!.attributes?.['tavern_revenue']).toBe(90);

    /* 第二次：模型不守格式 → 提案非法 → failed，世界零影响 */
    const run2 = await evo.tick('w-min', 'admin');
    expect(run2.status).toBe('failed');
    expect(run2.error).toContain('invalid_proposal');
    expect(run2.proposal).toBeUndefined();

    await gatewayServer.close();
  });
});

describe('管理面演化路由（Phase C 数据面）', () => {
  let managed: ManagedRuntime;
  let admin: Awaited<ReturnType<typeof startAdminServer>>;
  let evolution: ReturnType<typeof createEvolutionRuntime>;

  beforeAll(async () => {
    const secrets = new SecretStore(join(dir, 'secrets-admin.json'), 'master-key');
    const configStore = new ModelConfigStore({ filePath: join(dir, 'model-config-admin.json'), secrets, endpointPolicy: { allowLoopback: true } });
    configStore.load();
    const keys = new KeyStore(join(dir, 'keys-admin.json'), 'bootstrap-evo-key');
    managed = await startManagedRuntime({
      configStore,
      secrets,
      keys,
      engine,
      adminToken: 'evo-admin-token',
      endpointPolicy: { allowLoopback: true },
      accessLog: false,
    });
    const journal = createEvolutionJournal();
    evolution = createEvolutionRuntime(
      { engine, driver: createScriptedDriver([
        { reason: '管理台触发的一次演化', observations: [{ ref: 'state', kind: 'state' }], changes: [{ targetId: 'milu', action: 'update_attribute', payload: { key: 'tavern_revenue', value: 88 }, reason: '稳态记录' }] },
      ]) },
      journal,
    );
    admin = await startAdminServer({
      runtime: managed,
      adminToken: 'evo-admin-token',
      evolution,
      port: 0,
      accessLog: false,
    });
  });

  afterAll(async () => {
    await admin?.close();
    await managed?.close();
  });

  const api = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${admin.url}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-admin-token': 'evo-admin-token', ...(init.headers ?? {}) },
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as unknown };
  };

  it('未触发时清单可见；触发 tick → 运行留痕与因果链可查', async () => {
    const list0 = await api('/v1/evolution/worlds');
    expect(list0.status).toBe(200);
    expect((list0.body as { worlds: { worldId: string }[] }).worlds.some((w) => w.worldId === 'w-min')).toBe(true);

    const tickRes = await api('/v1/evolution/worlds/w-min/tick', { method: 'POST', body: JSON.stringify({}) });
    expect(tickRes.status).toBe(200);
    const run = tickRes.body as EvolutionRun;
    expect(run.status).toBe('completed');
    expect(run.acceptedCount).toBe(1);

    const runs = await api('/v1/evolution/worlds/w-min/runs');
    expect((runs.body as { runs: EvolutionRun[] }).runs.length).toBeGreaterThanOrEqual(1);

    const one = await api(`/v1/evolution/worlds/w-min/runs/${run.id}`);
    expect((one.body as EvolutionRun).proposal?.reason).toBe('管理台触发的一次演化');
    expect((one.body as EvolutionRun).outcomes?.[0]?.eventIds.length).toBeGreaterThan(0);

    const missing = await api('/v1/evolution/worlds/w-min/runs/evo_none');
    expect(missing.status).toBe(404);
  });

  it('写操作需要权限；意图端点执行 OOC 隔离', async () => {
    /* 无令牌 → 401 */
    const anon = await fetch(`${admin.url}/v1/evolution/worlds/w-min/tick`, { method: 'POST' });
    expect(anon.status).toBe(401);

    const ooc = await api('/v1/evolution/worlds/w-min/intent', {
      method: 'POST',
      body: JSON.stringify({ kind: 'ooc', text: '场外话不进世界' }),
    });
    expect(ooc.status).toBe(200);
    expect(ooc.body).toEqual({ kind: 'ooc' });

    const badKind = await api('/v1/evolution/worlds/w-min/intent', {
      method: 'POST',
      body: JSON.stringify({ kind: 'cheat', text: 'x' }),
    });
    expect(badKind.status).toBe(400);

    const ic = await api('/v1/evolution/worlds/w-min/intent', {
      method: 'POST',
      body: JSON.stringify({ kind: 'ic_action', text: '把天气转晴', command: { type: 'change_weather', text: 'clear' } }),
    });
    expect(ic.status).toBe(200);
    expect((ic.body as { commandResult?: { ok: boolean } }).commandResult?.ok).toBe(true);
  });
});

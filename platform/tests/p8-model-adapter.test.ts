/* ============================================================
   Model Adapter / Gateway 收口测试（P8 · 方案 §十一）
   ------------------------------------------------------------
   方案验收（原文）：**替换 Provider 时，不修改 World Runtime 业务代码。**

   覆盖：
   ① 能力词表 = 方案 §十一 11 项 + 平台自有 roleplay；缺省路由合理；
   ② 受管配置兼容：六能力键磁盘必需（既有配置可载），新七能力可选；
   ③ 受管网关 embed 通道（buildManagedProvider.embed）；
   ④ 记忆语义召回钩子接线（EmbedHook 注入 + 失败回词面）；
   ⑤ 换 Provider 热切换：Admin 配置 revision 前进 → replaceRoutes →
      同一个演化运行时（业务代码零改动）用上新路由。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import {
  ModelRouter,
  NPC_EVOLUTION_POLICY,
  createEngineClient,
  createEvolutionRuntime,
  createWorldMemoryService,
  type EvolutionContext,
  type EvolutionDriver,
} from '../src/index.ts';
import { MANAGED_CAPABILITIES, REQUIRED_MANAGED_CAPABILITIES, ModelConfigStore } from '../src/admin/model-config.ts';
import { buildManagedProvider } from '../src/admin/managed-runtime.ts';
import { SecretStore } from '../src/admin/secrets.ts';
import { createEmbeddingsClient } from '../src/upstream/embeddings.ts';
import type { EvolutionRun } from '../src/index.ts';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'platform-p8-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('P8 能力词表（方案 §十一 11 项 + roleplay）', () => {
  it('平台 Capability 全集覆盖方案清单；缺省路由合理（evolution→reasoning、intent→fast、npc_behavior→npc）', () => {
    const router = new ModelRouter(null);
    for (const cap of ['roleplay', 'intent', 'world_reasoning', 'evolution', 'npc_behavior', 'narrative', 'memory', 'fast', 'cheap', 'long_context', 'structured_output'] as const) {
      const selected = router.select(cap);
      expect(selected, `缺省路由 ${cap}`).not.toBeNull(); /* 缺省路由到网关通道名（未注册通道 → 网关 404，如实） */
    }
    /* Embedding 统一治理：缺省无路由 = 无语义召回（词面照常），绝不假装有一个 'embedding' 模型 */
    expect(router.select('embedding')).toBeNull();
    expect(router.select('evolution')).toMatchObject({ model: 'reasoning' });
    expect(router.select('intent')).toMatchObject({ model: 'fast' });
    expect(router.select('npc_behavior')).toMatchObject({ model: 'npc' });
  });

  it('受管配置：六能力键磁盘必需；新七能力可选（既有配置文档可载）', async () => {
    expect(REQUIRED_MANAGED_CAPABILITIES).toHaveLength(6);
    expect(MANAGED_CAPABILITIES).toHaveLength(13);
    /* 既有形状（只有六能力键）可提交 */
    const secrets = new SecretStore(join(dir, 's1.json'), 'mk');
    const store = new ModelConfigStore({ filePath: join(dir, 'cfg1.json'), secrets, endpointPolicy: { allowLoopback: true } });
    store.load();
    const cfg = {
      version: 1,
      providers: [{ id: 'prov-x', name: 'X', endpoint: 'http://127.0.0.1:9/v1', auth: { kind: 'none' as const }, enabled: true }],
      /* 嵌入标签互斥（Embedding 统一治理）：对话模型不挂 embedding */
      models: [{ id: 'mdl-x', providerId: 'prov-x', enabled: true, wireModel: 'wire-x', tags: ['reasoning'] }],
      routes: {
        roleplay: { primary: 'mdl-x', fallback: null },
        narrative: { primary: 'mdl-x', fallback: null },
        reasoning: { primary: 'mdl-x', fallback: null },
        fast: { primary: 'mdl-x', fallback: null },
        cheap: { primary: 'mdl-x', fallback: null },
        memory: { primary: 'mdl-x', fallback: null },
        /* 新七能力缺省不写 → 可选 */
      },
    };
    const committed = store.commit(cfg as never, 0);
    expect(committed.revision).toBe(1);
    const current = store.current();
    expect(current.routes['evolution']).toMatchObject({ primary: null }); /* 未配置 = 诚实 null */
    expect(current.routes['reasoning']).toMatchObject({ primary: 'mdl-x' });
    /* 新能力键显式提供也合法 */
    const withNew = { ...cfg, routes: { ...cfg.routes, evolution: { primary: 'mdl-x', fallback: null } } };
    store.commit(withNew as never, 1);
    expect(store.current().routes['evolution']).toMatchObject({ primary: 'mdl-x' });
  });
});

describe('P8 受管网关 embed 通道 + 记忆语义召回接线', () => {
  it('buildManagedProvider.embed：解析目标 → 出站校验 → 远端向量（fetch mock）', async () => {
    const secrets = new SecretStore(join(dir, 's2.json'), 'mk');
    const store = new ModelConfigStore({ filePath: join(dir, 'cfg2.json'), secrets, endpointPolicy: { allowLoopback: true } });
    store.load();
    store.commit({
      version: 1,
      providers: [{ id: 'prov-x', name: 'X', endpoint: 'http://127.0.0.1:9/v1', auth: { kind: 'none' }, enabled: true }],
      models: [{ id: 'mdl-embed', providerId: 'prov-x', enabled: true, tags: ['embedding'], wireModel: 'text-embedding-x' }],
      routes: {
        roleplay: { primary: null, fallback: null },
        narrative: { primary: null, fallback: null },
        reasoning: { primary: null, fallback: null },
        fast: { primary: null, fallback: null },
        cheap: { primary: null, fallback: null },
        memory: { primary: null, fallback: null },
      },
    } as never, 0);

    const calls: { url: string; body: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 1 }, { embedding: [0.3, 0.4], index: 0 }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const provider = buildManagedProvider(store.current(), {
        secrets,
        timeoutMs: 1000,
        outboundValidator: async () => {},
      });
      if (!provider.embed) throw new Error('provider.embed 未实现（P8 应已接线）');
      const vectors = await provider.embed('mdl-embed', ['a', 'b']);
      expect(vectors).toEqual([[0.3, 0.4], [0.1, 0.2]]); /* 按 index 排序 */
      expect(calls[0]!.url).toContain('/embeddings');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('EmbedHook 注入记忆服务：召回走钩子；钩子失败回词面；setEmbed 热替换', async () => {
    let hookCalls = 0;
    let fail = false;
    const service = createWorldMemoryService({
      embed: {
        embed: async (texts) => {
          hookCalls++;
          if (fail) throw new Error('嵌入通道故障');
          return texts.map(() => [1, 0]);
        },
      },
    });
    service.ingest('w-emb', [
      { id: 'evt-1', type: 'player_moved', day: 1, actor: 'player', witnesses: ['milu'] },
    ]);
    await service.recallFor('w-emb', 'milu', 'player_moved');
    expect(hookCalls).toBeGreaterThan(0); /* 语义分并入检索 */
    /* 热替换为故障钩子 → 词面回退（契约：失败静默） */
    fail = true;
    const hits = await service.recallFor('w-emb', 'milu', 'player_moved');
    expect(hits.length).toBeGreaterThan(0);
    /* 热替换为 null → 纯词面 */
    service.setEmbed('w-emb', null);
    const plain = await service.recallFor('w-emb', 'milu', 'player_moved');
    expect(plain.length).toBeGreaterThan(0);
  });

  it('embeddings 客户端：向量按 index 排序；非 200 如实抛错', async () => {
    const good = createEmbeddingsClient({
      baseUrl: 'http://gw',
      fetchImpl: (async () => new Response(JSON.stringify({ data: [{ embedding: [9], index: 1 }, { embedding: [7], index: 0 }] }), { status: 200 })) as never,
    });
    await expect(good.embed('m', ['x', 'y'])).resolves.toEqual([[7], [9]]);
    const bad = createEmbeddingsClient({
      baseUrl: 'http://gw',
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: '通道未实现', code: 'not_implemented' } }), { status: 501 })) as never,
    });
    await expect(bad.embed('m', ['x'])).rejects.toThrow('通道未实现');
  });
});

describe('P8 验收：换 Provider 不修改 World Runtime 业务代码', () => {
  let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
  let engine: ReturnType<typeof createEngineClient>;
  const WORLD = 'w-p8';

  beforeAll(async () => {
    const registry = createWorldRegistry();
    const world = registry.create({ worldId: WORLD, playerName: '旅人', startLoc: 'village', weather: 'clear', savePort: new InMemoryWorldStorage() });
    const r = world.executeCommand({ type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } });
    if (!r.ok) throw new Error(`种子被拒：${JSON.stringify(r)}`);
    engineServer = await startWorldServer({ registry, port: 0 });
    engine = createEngineClient({ baseUrl: engineServer.url });
  });
  afterAll(async () => {
    await engineServer?.close();
  });

  it('Admin 配置热切换（revision 前进/回滚）→ 同一个演化运行时直接用上新路由', async () => {
    /* 「模型供应商 A/B」= 两个假网关模型通道；业务代码（演化运行时 + 驱动）全程零改动 */
    const seenModels: string[] = [];
    const makeGateway = (tag: string) => async (model: string) => {
      seenModels.push(model);
      return {
        ok: true as const,
        text: JSON.stringify({ reason: `由 ${model}（${tag}）产生：无事发生`, observations: [], changes: [] }),
      };
    };
    let gatewayChat = makeGateway('A');
    const driver: EvolutionDriver & { router: ModelRouter } = {
      name: 'p8-swap',
      async propose(context: EvolutionContext) {
        const selected = driver.router.select('evolution');
        if (!selected) throw new Error('no model');
        const m = await import('../src/evolution/driver.ts');
        const res = await gatewayChat(selected.model);
        return m.normalizeProposal(JSON.parse(res.text), { id: `prop_${Date.now()}`, worldId: context.worldId, model: selected.model });
      },
      router: new ModelRouter(null),
    };
    const evolution = createEvolutionRuntime(
      { engine, driver, policy: NPC_EVOLUTION_POLICY, cooldownMs: 0 },
      { append: () => {}, recent: () => [], get: () => null },
    );

    /* 初始路由：evolution → mdl-A */
    driver.router.replaceRoutes({ evolution: { primary: 'mdl-A', fallback: null } });
    const run1: EvolutionRun = await evolution.tick(WORLD, 'admin', { idempotencyKey: 'p8-swap-1' });
    expect(run1.modelUsed).toBe('mdl-A');

    /* 「换 Provider」：仅配置面操作（Admin 提交新 revision → replaceRoutes 热替换） */
    driver.router.replaceRoutes({ evolution: { primary: 'mdl-B', fallback: null } });
    const run2: EvolutionRun = await evolution.tick(WORLD, 'admin', { idempotencyKey: 'p8-swap-2' });
    expect(run2.modelUsed).toBe('mdl-B'); /* 同一段业务代码，路由已换 */
    expect(seenModels).toEqual(['mdl-A', 'mdl-B']);
  });
});

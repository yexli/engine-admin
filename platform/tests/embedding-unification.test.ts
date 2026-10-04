/* ============================================================
   Embedding 配置统一治理测试（2026-10）
   ------------------------------------------------------------
   方案 §14 测试矩阵：
     ✓ Primary：路由 primary=M1 → 实际用 M1
     ✓ Fallback：M1 失败 → markFailed 冷却 → M2 接管 → 正常拿到向量
     ✓ 模型修改：改 Router 路由 → 调用方零改动自动用新模型
     ✓ 维度：结果携带 dimensions；引擎维度变化有告警（memory 包侧另测）
     ✓ 旧配置：memory 配置端点 410（memory 包侧另测）；平台代理 404（admin-http 侧另测）
     ✓ POST /v1/embeddings：鉴权 / 拒绝客户端指定模型 / 无路由 503 / 上游失败 502
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore } from '../src/keys/keystore.ts';
import { ModelRouter } from '../src/router/modelrouter.ts';
import { createRoutedEmbeddingService, routedEmbeddingHook } from '../src/upstream/embeddings.ts';
import type { EmbeddingsClient } from '../src/upstream/embeddings.ts';
import { createWorldPlatform } from '../src/http/protocol.ts';
import type { EngineClient, GatewayClient, PlatformRequest } from '../src/types.ts';

/* ---------------- 桩件 ---------------- */

function fakeEmbeddings(failFor: Set<string>): { client: EmbeddingsClient; calls: { model: string; texts: string[] }[] } {
  const calls: { model: string; texts: string[] }[] = [];
  return {
    calls,
    client: {
      embed: async (model, texts) => {
        calls.push({ model, texts });
        if (failFor.has(model)) throw new Error(`上游不可用：${model}`);
        return texts.map((t) => [t.length, 1]);
      },
    },
  };
}

const fakeGateway = {
  chat: async () => ({ ok: true, text: 'ok' }),
  proxyChat: async () => ({ ok: true, status: 200, headers: {}, stream: new ReadableStream<Uint8Array>() }),
} as unknown as GatewayClient;

const fakeEngine = {
  proxy: async () => ({ status: 200, body: {} }),
  getState: async () => ({ ok: true, state: {} }),
  getEvents: async () => ({ ok: true, events: [] }),
} as unknown as EngineClient;

function setupPlatform(perms: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-emb-'));
  const keys = new KeyStore(join(dir, 'keys.json'));
  const { plaintext } = keys.create({ name: 'emb-test', permissions: perms as never });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { keys, plaintext, cleanup };
}

function call(platform: ReturnType<typeof createWorldPlatform>, token: string, body: unknown) {
  return platform
    .handle({
      method: 'POST',
      path: '/v1/embeddings',
      query: {},
      body,
      headers: { authorization: `Bearer ${token}` },
    } satisfies PlatformRequest)
    .then((r) => (r.kind === 'json' ? { status: r.status, body: r.body as any } : { status: r.status, body: '<stream>' }));
}

/* ---------------- RoutedEmbeddingService（Router 单源核心） ---------------- */

describe('createRoutedEmbeddingService：primary / fallback / 模型切换', () => {
  it('Primary：路由 primary=M1 → 实际调用 M1，成功清冷却', async () => {
    const router = new ModelRouter(null);
    router.replaceRoutes({ embedding: { primary: 'm1', fallback: 'm2' } });
    const { client, calls } = fakeEmbeddings(new Set());
    const svc = createRoutedEmbeddingService({ router, embeddings: client });

    const out = await svc.embed(['你好', '世界']);
    expect(out).toEqual({ vectors: [[2, 1], [2, 1]], model: 'm1', usedFallback: false });
    expect(calls.map((c) => c.model)).toEqual(['m1']);
    expect(router.isCoolingDown('m1')).toBe(false);
  });

  it('Fallback：M1 失败 → 冷却 → M2 接管；下一次调用直接走 M2', async () => {
    const router = new ModelRouter(null);
    router.replaceRoutes({ embedding: { primary: 'm1', fallback: 'm2' } });
    const { client, calls } = fakeEmbeddings(new Set(['m1']));
    const svc = createRoutedEmbeddingService({ router, embeddings: client });

    const out = await svc.embed(['probe']);
    expect(out).toEqual({ vectors: [[5, 1]], model: 'm2', usedFallback: true });
    expect(router.isCoolingDown('m1')).toBe(true); /* 失败已冷却（修复 fallback 死代码） */
    expect(calls.map((c) => c.model)).toEqual(['m1', 'm2']);

    const again = await svc.embed(['probe']);
    expect(again!.model).toBe('m2'); /* 冷却期内 primary 不再被选中 */
    expect(calls.map((c) => c.model)).toEqual(['m1', 'm2', 'm2']);
  });

  it('全部失败 → throw（调用方决定降级）；无路由 → null', async () => {
    const router = new ModelRouter(null);
    router.replaceRoutes({ embedding: { primary: 'm1', fallback: 'm2' } });
    const { client } = fakeEmbeddings(new Set(['m1', 'm2']));
    const svc = createRoutedEmbeddingService({ router, embeddings: client });
    await expect(svc.embed(['x'])).rejects.toThrow('m2');

    const empty = new ModelRouter(null);
    const none = createRoutedEmbeddingService({ router: empty, embeddings: client });
    await expect(none.embed(['x'])).resolves.toBeNull();
  });

  it('模型修改：只改 Router 路由，调用方零改动自动用新模型', async () => {
    const router = new ModelRouter(null);
    router.replaceRoutes({ embedding: { primary: 'old-model', fallback: null } });
    const { client, calls } = fakeEmbeddings(new Set());
    const hook = routedEmbeddingHook(createRoutedEmbeddingService({ router, embeddings: client }));

    expect(await hook(['a'])).toEqual([[1, 1]]);
    router.replaceRoutes({ embedding: { primary: 'new-model', fallback: null } });
    expect(await hook(['a'])).toEqual([[1, 1]]);
    expect(calls.map((c) => c.model)).toEqual(['old-model', 'new-model']);
  });

  it('EmbedHook 适配：上游失败 → null（词面召回兜底，不抛）', async () => {
    const router = new ModelRouter(null);
    router.replaceRoutes({ embedding: { primary: 'm1', fallback: null } });
    const { client } = fakeEmbeddings(new Set(['m1']));
    const hook = routedEmbeddingHook(createRoutedEmbeddingService({ router, embeddings: client }));
    await expect(hook(['x'])).resolves.toBeNull();
  });
});

/* ---------------- POST /v1/embeddings（跨进程 Memory 的传输层） ---------------- */

describe('POST /v1/embeddings：Router 单源公共端点', () => {
  it('成功：返回 { model, dimensions, vectors }；拒绝客户端指定模型', async () => {
    const { keys, plaintext: token, cleanup } = setupPlatform(['embeddings']);
    const router = new ModelRouter(null);
    router.replaceRoutes({ embedding: { primary: 'mdl-emb', fallback: null } });
    const { client } = fakeEmbeddings(new Set());
    const platform = createWorldPlatform({ keys, engine: fakeEngine, gateway: fakeGateway, router, embeddings: client });

    const ok = await call(platform, token, { input: ['米露在酒馆'] });
    expect(ok.status).toBe(200);
    expect(ok.body.model).toBe('mdl-emb');
    expect(ok.body.dimensions).toBe(2);
    expect(ok.body.vectors).toHaveLength(1);
    expect(ok.body.usedFallback).toBe(false);

    const forbidden = await call(platform, token, { input: ['x'], model: 'my-model' });
    expect(forbidden.status).toBe(400);
    expect(forbidden.body.error.code).toBe('model_forbidden');

    cleanup();
  });

  it('无 embeddings 权限 → 403；未配置路由 → 503 no_model_configured；上游失败 → 502', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'platform-emb3-'));
    const keys = new KeyStore(join(dir, 'keys.json'));
    const { plaintext: readonly } = keys.create({ name: 'ro', permissions: ['worlds:read'] });
    const { plaintext: full } = keys.create({ name: 'full', permissions: ['embeddings'] });

    const router = new ModelRouter(null);
    const { client } = fakeEmbeddings(new Set());
    const bare = createWorldPlatform({ keys, engine: fakeEngine, gateway: fakeGateway, router, embeddings: client });
    const noRoute = await call(bare, full, { input: ['x'] });
    expect(noRoute.status).toBe(503);
    expect(noRoute.body.error.code).toBe('no_model_configured');

    router.replaceRoutes({ embedding: { primary: 'bad-model', fallback: null } });
    const failing = fakeEmbeddings(new Set(['bad-model']));
    const boom = createWorldPlatform({ keys, engine: fakeEngine, gateway: fakeGateway, router, embeddings: failing.client });
    const up = await call(boom, full, { input: ['x'] });
    expect(up.status).toBe(502);
    expect(up.body.error.code).toBe('upstream_error');

    const denied = await call(boom, readonly, { input: ['x'] });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('insufficient_permission');

    rmSync(dir, { recursive: true, force: true });
  });
});

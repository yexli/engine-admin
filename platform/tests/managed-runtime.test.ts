/* ============================================================
   Task 2 测试：ManagedRuntime（受管运行时 · 热更新双快照）
   ------------------------------------------------------------
   · 空配置启动 → world-agent 503 no_model_configured（不假装修好）
   · 提交配置（不重启）→ 下一条 world-agent 请求走新配置，
     出站 wireModel / Bearer 凭证符合预期
   · 路由替换 / 模型移除 立即生效
   · 进行中的请求完成在旧快照上
   · 凭证被上游拒绝 → 显式上报、不进冷却（第二次仍尝试主模型）
   · auth:"none" 不发送 Authorization 头
   · ModelRouter.replaceRoutes 清理已移除/变更模型的冷却
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore } from '../src/keys/keystore.ts';
import type { EngineClient } from '../src/types.ts';
import { ModelRouter } from '../src/router/modelrouter.ts';
import { ModelConfigStore } from '../src/admin/model-config.ts';
import { SecretStore } from '../src/admin/secrets.ts';
import { startManagedRuntime, type ManagedRuntime } from '../src/admin/managed-runtime.ts';

/* ---------------- 脚本化 OpenAI 兼容上游 ---------------- */

interface UpstreamRecord {
  model: string;
  authorization: string | undefined;
}

interface ScriptedUpstream {
  url: string;
  records: UpstreamRecord[];
  close(): Promise<void>;
}

/** reply 可以引用收到的请求；delayMs 模拟慢上游 */
function startScriptedUpstream(
  respond: (req: UpstreamRecord) => { status: number; content: string } | Promise<{ status: number; content: string }>,
  opts: { delayMs?: number } = {},
): Promise<ScriptedUpstream> {
  const records: UpstreamRecord[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { model?: string };
      const record: UpstreamRecord = {
        model: body.model ?? '',
        authorization: req.headers.authorization,
      };
      records.push(record);
      const out = await respond(record);
      setTimeout(() => {
        res.writeHead(out.status, { 'content-type': 'application/json' });
        if (out.status === 200) {
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: out.content } }] }));
        } else {
          res.end(JSON.stringify({ error: { message: out.content } }));
        }
      }, opts.delayMs ?? 0);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        records,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/* ---------------- 受管运行时 harness ---------------- */

let dir: string;
let cleanups: Array<() => Promise<void>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'managed-runtime-'));
  cleanups = [];
});

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  rmSync(dir, { recursive: true, force: true });
});

const stubEngine: EngineClient = {
  proxy: async () => ({ status: 404, body: { error: { message: 'no engine in test' } } }),
  getState: async () => ({ ok: false, status: 404, error: 'no engine in test' }),
  getEvents: async () => ({ ok: false, status: 404, error: 'no engine in test' }),
  executeCommand: async () => ({ ok: false, status: 404, error: 'no engine in test' }),
};

async function harness(): Promise<{ runtime: ManagedRuntime; adminKey: string }> {
  const secrets = new SecretStore(join(dir, `secrets-${cleanups.length}.json`), 'runtime-master-key');
  const configStore = new ModelConfigStore({
    filePath: join(dir, `model-config-${cleanups.length}.json`),
    secrets,
    endpointPolicy: { allowLoopback: true },
  });
  configStore.load();
  const keys = new KeyStore(join(dir, `keys-${cleanups.length}.json`), 'bootstrap-test-key');
  const runtime = await startManagedRuntime({
    configStore,
    secrets,
    keys,
    engine: stubEngine,
    adminToken: 'test-admin-token',
    endpointPolicy: { allowLoopback: true },
    accessLog: false,
  });
  cleanups.push(() => runtime.close());
  return { runtime, adminKey: 'bootstrap-test-key' };
}

/** 模拟 UI 完整工作流：建档（禁用）→ 传凭证 → 启用 + 指派全部六能力路由 */
async function applyWorkflow(
  runtime: ManagedRuntime,
  spec: { providerId: string; endpoint: string; credential: string | null; modelId: string; wireModel: string },
): Promise<void> {
  let rev = runtime.config.revision;
  const disabled = {
    version: 1,
    providers: [{ id: spec.providerId, name: spec.providerId, endpoint: spec.endpoint, auth: { kind: spec.credential ? 'secret' : 'none' }, enabled: false }],
    models: [{ id: spec.modelId, providerId: spec.providerId, wireModel: spec.wireModel, tags: ['fast', 'cheap', 'narrative', 'reasoning', 'roleplay', 'memory'], enabled: false }],
    routes: allNullRoutes(),
  };
  runtime.apply(disabled, rev);
  rev = runtime.config.revision;
  if (spec.credential !== null) {
    runtime.applyCredential(spec.providerId, spec.credential);
    rev = runtime.config.revision;
  }
  const enabled = {
    version: 1,
    providers: [{ id: spec.providerId, name: spec.providerId, endpoint: spec.endpoint, auth: { kind: spec.credential ? 'secret' : 'none' }, enabled: true }],
    models: [{ id: spec.modelId, providerId: spec.providerId, wireModel: spec.wireModel, tags: ['fast', 'cheap', 'narrative', 'reasoning', 'roleplay', 'memory'], enabled: true }],
    routes: routeAllTo(spec.modelId),
  };
  runtime.apply(enabled, rev);
}

function allNullRoutes(): Record<string, { primary: string | null; fallback: string | null }> {
  const caps = ['roleplay', 'narrative', 'reasoning', 'fast', 'cheap', 'memory'];
  return Object.fromEntries(caps.map((c) => [c, { primary: null, fallback: null }]));
}

function routeAllTo(modelId: string): Record<string, { primary: string | null; fallback: string | null }> {
  const caps = ['roleplay', 'narrative', 'reasoning', 'fast', 'cheap', 'memory'];
  return Object.fromEntries(caps.map((c) => [c, { primary: modelId, fallback: null }]));
}

function chat(runtime: ManagedRuntime, key: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return fetch(`${runtime.platformUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'world-agent', messages: [{ role: 'user', content: '随便说点什么' }], ...body }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ---------------- 测试 ---------------- */

describe('ManagedRuntime（受管运行时）', () => {
  it('空配置启动：world-agent → 503 no_model_configured，不假装成功', async () => {
    const upstream = await startScriptedUpstream(() => ({ status: 200, content: '不应被调用' }));
    const { runtime, adminKey } = await harness();

    const res = await chat(runtime, adminKey, {});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('no_model_configured');
    expect(upstream.records).toEqual([]);
  });

  it('提交配置后无需重启：world-agent 立即走新模型（wireModel + Bearer 凭证正确）', async () => {
    const upstream = await startScriptedUpstream((req) => ({
      status: 200,
      content: `reply-for:${req.model}:${req.authorization}`,
    }));
    const { runtime, adminKey } = await harness();

    await applyWorkflow(runtime, {
      providerId: 'prov-a',
      endpoint: upstream.url,
      credential: 'sk-upstream-secret-1',
      modelId: 'mdl-a',
      wireModel: 'wire-model-a',
    });

    const res = await chat(runtime, adminKey, {});
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('reply-for:wire-model-a:Bearer sk-upstream-secret-1');
    expect(res.body.platform.model_used).toBe('mdl-a');
  });

  it('路由替换立即生效；移除模型后路由悬空 → 拒绝提交；路由置空 → 503', async () => {
    const upstream1 = await startScriptedUpstream((req) => ({ status: 200, content: `one:${req.model}` }));
    const upstream2 = await startScriptedUpstream((req) => ({ status: 200, content: `two:${req.model}` }));
    const { runtime, adminKey } = await harness();

    await applyWorkflow(runtime, { providerId: 'prov-1', endpoint: upstream1.url, credential: null, modelId: 'mdl-1', wireModel: 'wire-1' });
    expect((await chat(runtime, adminKey, {})).body.choices[0].message.content).toBe('one:wire-1');

    /* 换供应商 + 换模型：立即生效 */
    await applyWorkflow(runtime, { providerId: 'prov-2', endpoint: upstream2.url, credential: null, modelId: 'mdl-2', wireModel: 'wire-2' });
    const second = await chat(runtime, adminKey, {});
    expect(second.body.choices[0].message.content).toBe('two:wire-2');
    expect(second.body.platform.model_used).toBe('mdl-2');
    expect(upstream1.records.length).toBe(1); /* 旧上游不再被调用 */

    /* 路由指向被移除的模型 → 提交被拒绝，当前配置不变 */
    const dangling = {
      version: 1,
      providers: [{ id: 'prov-2', name: 'p2', endpoint: upstream2.url, auth: { kind: 'none' }, enabled: true }],
      models: [{ id: 'mdl-2', providerId: 'prov-2', wireModel: 'wire-2', tags: ['fast'], enabled: true }],
      routes: routeAllTo('mdl-ghost'),
    };
    expect(() => runtime.apply(dangling, runtime.config.revision)).toThrow(/mdl-ghost/);
    expect(runtime.config.revision).toBe(4);

    /* 路由显式置空 → 诚实的 503 */
    const nulled = {
      version: 1,
      providers: [{ id: 'prov-2', name: 'p2', endpoint: upstream2.url, auth: { kind: 'none' }, enabled: true }],
      models: [{ id: 'mdl-2', providerId: 'prov-2', wireModel: 'wire-2', tags: ['fast'], enabled: true }],
      routes: allNullRoutes(),
    };
    runtime.apply(nulled, runtime.config.revision);
    const res = await chat(runtime, adminKey, {});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('no_model_configured');
  });

  it('进行中的请求完成在旧快照上；之后的请求走新快照', async () => {
    const slow = await startScriptedUpstream(() => ({ status: 200, content: 'OLD-SNAPSHOT' }), { delayMs: 500 });
    const fast = await startScriptedUpstream(() => ({ status: 200, content: 'NEW-SNAPSHOT' }));
    const { runtime, adminKey } = await harness();

    await applyWorkflow(runtime, { providerId: 'prov-slow', endpoint: slow.url, credential: null, modelId: 'mdl-a', wireModel: 'wire-a' });

    const inflight = chat(runtime, adminKey, {});
    await sleep(120); /* 请求已进入旧提供方的远端调用 */
    await applyWorkflow(runtime, { providerId: 'prov-fast', endpoint: fast.url, credential: null, modelId: 'mdl-b', wireModel: 'wire-b' });

    const first = await inflight;
    expect(first.status).toBe(200);
    expect(first.body.choices[0].message.content).toBe('OLD-SNAPSHOT');
    expect(first.body.platform.model_used).toBe('mdl-a');

    const next = await chat(runtime, adminKey, {});
    expect(next.body.choices[0].message.content).toBe('NEW-SNAPSHOT');
  });

  it('上游拒绝凭证：显式上报 upstream_credential_rejected，且不进冷却（第二次仍尝试主模型）', async () => {
    let hits = 0;
    const upstream = await startScriptedUpstream(() => {
      hits += 1;
      return { status: 401, content: 'invalid api key' };
    });
    const { runtime, adminKey } = await harness();
    await applyWorkflow(runtime, { providerId: 'prov-a', endpoint: upstream.url, credential: 'sk-will-be-rejected', modelId: 'mdl-a', wireModel: 'wire-a' });

    const first = await chat(runtime, adminKey, {});
    expect(first.status).toBe(502);
    expect(first.body.error.code).toBe('upstream_credential_rejected');

    const second = await chat(runtime, adminKey, {});
    expect(second.status).toBe(502);
    expect(second.body.error.code).toBe('upstream_credential_rejected');
    expect(hits).toBe(2); /* 未冷却：主模型被再次尝试；否则是 503 no_model_configured */
    expect(second.body.error.message).not.toContain('sk-will-be-rejected'); /* 凭证不进错误信息 */
  });

  it('auth:"none" 的本地供应商：出站不带 Authorization 头', async () => {
    const upstream = await startScriptedUpstream((req) => ({
      status: 200,
      content: `auth=${req.authorization ?? 'NONE'}`,
    }));
    const { runtime, adminKey } = await harness();
    await applyWorkflow(runtime, { providerId: 'prov-local', endpoint: upstream.url, credential: null, modelId: 'mdl-local', wireModel: 'qwen3:8b' });

    const res = await chat(runtime, adminKey, {});
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('auth=NONE');
  });

  it('上游错误体中的凭证值被清洗后才进入错误信息', async () => {
    const upstream = await startScriptedUpstream(() => ({
      status: 500,
      content: 'boom with sk-leaked-value inside',
    }));
    const { runtime, adminKey } = await harness();
    await applyWorkflow(runtime, { providerId: 'prov-a', endpoint: upstream.url, credential: 'sk-leaked-value', modelId: 'mdl-a', wireModel: 'wire-a' });

    const res = await chat(runtime, adminKey, {});
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('sk-leaked-value');
  });
});

describe('ModelRouter.replaceRoutes（托管路由热替换）', () => {
  it('替换全部六能力路由；清理已移除/变更模型的冷却', () => {
    const router = new ModelRouter(null);
    router.markFailed('mdl-old');
    expect(router.isCoolingDown('mdl-old')).toBe(true);

    router.replaceRoutes(routeAllTo('mdl-new'));
    expect(router.route('fast')).toEqual({ primary: 'mdl-new', fallback: null });
    expect(router.isCoolingDown('mdl-old')).toBe(false); /* 不再被引用 → 冷却清除 */
    expect(router.select('fast')).toEqual({ model: 'mdl-new', usedFallback: false });

    /* 仍被引用的模型冷却保留 */
    router.markFailed('mdl-new');
    router.replaceRoutes(routeAllTo('mdl-new'));
    expect(router.isCoolingDown('mdl-new')).toBe(true);
  });
});

/* 纯协议测试：注入假 engine / gateway / keystore，覆盖分层边界与 world-agent 管线 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore } from '../src/keys/keystore.ts';
import { ModelRouter } from '../src/router/modelrouter.ts';
import { createWorldPlatform } from '../src/http/protocol.ts';
import type { EngineClient, GatewayClient, PlatformRequest } from '../src/types.ts';

const STATE = {
  worldId: 'w-main',
  t: 42,
  weather: 'cloudy',
  player: { name: '云生', loc: 'plaza', bag: [] },
  npcs: { lita: { att: 5, met: true } },
  locations: { plaza: { id: 'plaza' } },
};

function fakeEngine(over: Partial<EngineClient> = {}): EngineClient {
  return {
    proxy: async (method, path) => ({ status: 200, body: { proxied: true, method, path } }),
    getState: async () => ({ ok: true, state: STATE }),
    getEvents: async () => ({ ok: true, events: [{ id: 'evt_1', type: 'time_advanced', day: 1, tick: 42 }] }),
    ...over,
  } as EngineClient;
}

function fakeGateway(text = '（模型回复）', failFor: string[] = []): GatewayClient {
  return {
    chat: async (model) =>
      failFor.includes(model)
        ? { ok: false, status: 503, error: 'upstream down' }
        : { ok: true, text },
    proxyChat: async (body) => ({
      ok: true,
      status: 200,
      headers: { 'content-type': 'application/json' },
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify({ echoed: body })));
          c.close();
        },
      }),
    }),
  };
}

function setup(opts: { gateway?: GatewayClient; engine?: EngineClient; routes?: object } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-proto-'));
  const keys = new KeyStore(join(dir, 'keys.json'));
  const { plaintext } = keys.create({ name: 'test', permissions: ['chat:completions', 'worlds:read', 'worlds:write'] });
  const router = new ModelRouter(null);
  if (opts.routes) {
    Object.assign(router['routes'], opts.routes);
  }
  const platform = createWorldPlatform({
    keys,
    engine: opts.engine ?? fakeEngine(),
    gateway: opts.gateway ?? fakeGateway(),
    router,
    requestId: () => 'req-test',
  });
  const call = (method: string, path: string, body?: unknown, token = plaintext, extraQuery?: Record<string, string>): Promise<{
    status: number;
    body: any;
  }> =>
    platform
      .handle({
        method,
        path,
        query: extraQuery ?? {},
        body,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      } satisfies PlatformRequest)
      .then((r) => (r.kind === 'json' ? { status: r.status, body: r.body } : { status: r.status, body: '<stream>' }));
  return { call, platform, plaintext, dir, keys };
}

describe('分层与鉴权', () => {
  it('healthz 免鉴权', async () => {
    const { call } = setup();
    const res = await call('GET', '/healthz', undefined, '');
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  it('无 Key / 坏 Key → 401', async () => {
    const { call } = setup();
    expect((await call('GET', '/v1/models', undefined, '')).status).toBe(401);
    expect((await call('GET', '/v1/models', undefined, 'sk-world-bad')).status).toBe(401);
  });

  it('权限不足 → 403（worlds:write 缺失时 POST /v1/worlds）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'platform-proto-'));
    const keys = new KeyStore(join(dir, 'keys.json'));
    const { plaintext } = keys.create({ name: 'readonly', permissions: ['worlds:read'] });
    const platform = createWorldPlatform({
      keys,
      engine: fakeEngine(),
      gateway: fakeGateway(),
      router: new ModelRouter(null),
    });
    const res = await platform.handle({
      method: 'POST',
      path: '/v1/worlds',
      body: { worldId: 'w-x' },
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.kind === 'json' && res.status === 403).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('Admin 层只定义形状 → 501', async () => {
    const { call } = setup();
    const res = await call('GET', '/v1/admin/users');
    expect(res.status).toBe(501);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_implemented');
  });

  it('未知路由 → 404（OpenAI 错误形状）', async () => {
    const { call } = setup();
    const res = await call('GET', '/v1/nothing');
    expect(res.status).toBe(404);
    expect((res.body as { error: { type: string } }).error.type).toBe('not_found_error');
  });
});

describe('worlds 透传', () => {
  it('GET 列表与 query 原样转发给引擎', async () => {
    let captured = '';
    const { call } = setup({
      engine: fakeEngine({
        proxy: async (method, path) => {
          captured = `${method} ${path}`;
          return { status: 200, body: { worlds: [] } };
        },
      }),
    });
    const res = await call('GET', '/v1/worlds', undefined, undefined, { n: '5' });
    expect(res.status).toBe(200);
    expect(captured).toBe('GET /v1/worlds?n=5');
  });

  it('POST commands 走 worlds:write 并透传 body', async () => {
    let capturedBody: unknown;
    const { call } = setup({
      engine: fakeEngine({
        proxy: async (_m, _p, body) => {
          capturedBody = body;
          return { status: 200, body: { ok: true } };
        },
      }),
    });
    const res = await call('POST', '/v1/worlds/w-main/commands', { type: 'advance_time', amount: 2 });
    expect(res.status).toBe(200);
    expect(capturedBody).toEqual({ type: 'advance_time', amount: 2 });
  });

  it('引擎错误状态码原样返回（404 世界不存在）', async () => {
    const { call } = setup({
      engine: fakeEngine({ proxy: async () => ({ status: 404, body: { error: 'world not found' } }) }),
    });
    const res = await call('GET', '/v1/worlds/missing/state');
    expect(res.status).toBe(404);
  });
});

describe('world-agent 管线', () => {
  it('完整链路：世界上下文 → 路由 → OpenAI 响应 + platform 元数据', async () => {
    const { call } = setup();
    const res = await call('POST', '/v1/chat/completions', {
      model: 'world-agent',
      world: 'w-main',
      messages: [{ role: 'user', content: '周围有什么？' }],
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('world-agent');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(typeof body.choices[0].message.content).toBe('string');
    expect(body.usage.total_tokens).toBeGreaterThan(0);
    expect(body.platform.world_agent).toBe(true);
    expect(body.platform.world_id).toBe('w-main');
    expect(body.platform.capability).toBe('roleplay');
  });

  it('世界不存在 → 404 world_not_found', async () => {
    const { call } = setup({
      engine: fakeEngine({ getState: async () => ({ ok: false, status: 404, error: 'world not found' }) }),
    });
    const res = await call('POST', '/v1/chat/completions', {
      model: 'world-agent',
      world: 'missing',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('world_not_found');
  });

  it('能力未配置模型 → 503 no_model_configured', async () => {
    const { call } = setup({
      routes: { roleplay: { primary: null, fallback: null } },
    });
    const res = await call('POST', '/v1/chat/completions', {
      model: 'world-agent',
      world: 'w-main',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(503);
    expect((res.body as { error: { code: string } }).error.code).toBe('no_model_configured');
  });

  it('primary 失败 → fallback 接管（platform.model_used 与 fallback_used）', async () => {
    const { call } = setup({
      gateway: fakeGateway('（来自 fallback 的回复）', ['npc']),
      routes: { roleplay: { primary: 'npc', fallback: 'narrative' } },
    });
    const res = await call('POST', '/v1/chat/completions', {
      model: 'world-agent',
      world: 'w-main',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.platform.model_used).toBe('narrative');
    expect(body.platform.fallback_used).toBe(true);
  });

  it('主备全挂 → 502 upstream_error', async () => {
    const { call } = setup({
      gateway: fakeGateway('x', ['npc', 'narrative']),
      routes: { roleplay: { primary: 'npc', fallback: 'narrative' } },
    });
    const res = await call('POST', '/v1/chat/completions', {
      model: 'world-agent',
      world: 'w-main',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(502);
    expect((res.body as { error: { code: string } }).error.code).toBe('upstream_error');
  });

  it('world-agent + stream=true → 400（Phase 1 明确不支持）', async () => {
    const { call } = setup();
    const res = await call('POST', '/v1/chat/completions', {
      model: 'world-agent',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(400);
  });

  it('缺 messages / 缺 model → 400', async () => {
    const { call } = setup();
    expect((await call('POST', '/v1/chat/completions', { model: 'world-agent' })).status).toBe(400);
    expect((await call('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] })).status).toBe(400);
  });
});

describe('非 world-agent 模型：保真代理', () => {
  it('透传请求体（含 stream 标志），返回流式响应', async () => {
    const { platform, plaintext } = setup();
    const out = await platform.handle({
      method: 'POST',
      path: '/v1/chat/completions',
      body: { model: 'npc', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(out.kind).toBe('stream');
    const reader = (out as { body: ReadableStream<Uint8Array> }).body.getReader();
    const { value } = await reader.read();
    const echoed = JSON.parse(new TextDecoder().decode(value)) as { echoed: { model: string; stream: boolean } };
    expect(echoed.echoed.model).toBe('npc');
    expect(echoed.echoed.stream).toBe(true);
  });

  it('网关不可达 → 502', async () => {
    const { call } = setup({
      gateway: {
        chat: async () => ({ ok: false, status: 502, error: 'down' }),
        proxyChat: async () => ({ ok: false, status: 502, error: 'AI Gateway 不可达' }),
      },
    });
    const res = await call('POST', '/v1/chat/completions', {
      model: 'npc',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(502);
    expect((res.body as { error: { code: string } }).error.code).toBe('upstream_error');
  });
});

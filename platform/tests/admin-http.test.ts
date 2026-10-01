/* ============================================================
   Task 3 测试：私有管理 API（loopback listener）
   ------------------------------------------------------------
   · 令牌只认 x-admin-token（服务端反代注入）；authorization 头
     即便带正确令牌也拒绝（浏览器永远不持有令牌）
   · 常量时间令牌比较、跨源写拒绝、请求体上限
   · GET 脱敏投影（绝无 secretId / 凭证明文）；/healthz 零信息
   · If-Match 冲突 409、非法配置 422、上游测试失败 502（脱敏）
   · 写路径成功后立即热生效（不重启即可经 world-agent 验证）

   注：本文件所有令牌/凭证均为运行时随机生成的测试值，无真实凭据。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore } from '../src/keys/keystore.ts';
import type { EngineClient } from '../src/types.ts';
import { ModelConfigStore } from '../src/admin/model-config.ts';
import { SecretStore } from '../src/admin/secrets.ts';
import { startManagedRuntime, type ManagedRuntime } from '../src/admin/managed-runtime.ts';
import { startAdminServer, type AdminServer } from '../src/admin/http.ts';
import { PipelineStore } from '../src/admin/pipelines.ts';
import { createUsageRecorder, type UsageRecorder } from '../src/usage/recorder.ts';
import { SessionStore } from '../src/admin/sessions.ts';
import { UserStore } from '../src/admin/users.ts';
import { SettingsStore } from '../src/admin/settings.ts';

/** 运行时随机测试值（避免任何硬编码凭据形状） */
const rand = (label: string): string => `${label}-${randomBytes(8).toString('hex')}`;

let dir: string;
let cleanups: Array<() => Promise<void>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'admin-http-'));
  cleanups = [];
});

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  rmSync(dir, { recursive: true, force: true });
});

const ADMIN_TOKEN = rand('adm-token');

const stubEngine: EngineClient = {
  proxy: async (method, path) => {
    if (method === 'GET' && path === '/v1/worlds') {
      return {
        status: 200,
        body: {
          worlds: [
            { worldId: 'w-main', entities: 3, status: 'running' },
            { worldId: 'w-paused', entities: 1, status: 'paused' },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  },
  executeCommand: async () => ({ ok: true, result: { ok: true, events: [] } }),
  getEvents: async (worldId) => ({
    ok: true,
    events: [
      { id: `${worldId}-e2`, type: 'talk_started', day: 2, tick: 5, actor: 'player' },
      { id: `${worldId}-e1`, type: 'time_advanced', day: 1, tick: 1 },
    ],
  }),
  getState: async () => ({ ok: false, status: 404, error: 'no engine' }),
};

interface ScriptedUpstream {
  url: string;
  close(): Promise<void>;
}

function startScriptedUpstream(reply: string | { status: number; content: string }): Promise<ScriptedUpstream> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const out = typeof reply === 'string' ? { status: 200, content: reply } : reply;
      res.writeHead(out.status, { 'content-type': 'application/json' });
      if (out.status === 200) {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: out.content } }] }));
      } else {
        res.end(JSON.stringify({ error: { message: out.content } }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

interface Harness {
  runtime: ManagedRuntime;
  admin: AdminServer;
  publicApiKey: string;
  keys: KeyStore;
  usage: UsageRecorder;
  pipelinesFile: string;
  sessions: SessionStore;
  users: UserStore;
  settings: SettingsStore;
}

async function harness(): Promise<Harness> {
  const n = cleanups.length;
  const secrets = new SecretStore(join(dir, `secrets-${n}.json`), rand('master'));
  const configStore = new ModelConfigStore({
    filePath: join(dir, `model-config-${n}.json`),
    secrets,
    endpointPolicy: { allowLoopback: true },
  });
  configStore.load();
  const publicApiKey = rand('pub-key');
  const keys = new KeyStore(join(dir, `keys-${n}.json`), publicApiKey);
  const usage = createUsageRecorder({ filePath: join(dir, `usage-${n}.jsonl`) });
  const pipelinesFile = join(dir, `pipelines-${n}.json`);
  const sessions = new SessionStore(join(dir, `sessions-${n}.json`));
  const users = new UserStore(join(dir, `users-${n}.json`));
  const settings = new SettingsStore(join(dir, `settings-${n}.json`));
  const runtime = await startManagedRuntime({
    configStore,
    secrets,
    keys,
    engine: stubEngine,
    adminToken: ADMIN_TOKEN,
    endpointPolicy: { allowLoopback: true },
    accessLog: false,
  });
  const admin = await startAdminServer({
    runtime,
    adminToken: ADMIN_TOKEN,
    port: 0,
    accessLog: false,
    keys,
    usage,
    pipelines: new PipelineStore(pipelinesFile),
    sessions,
    users,
    settings,
  });
  cleanups.push(async () => {
    await admin.close();
    await runtime.close();
  });
  return { runtime, admin, publicApiKey, keys, usage, pipelinesFile, sessions, users, settings };
}

/* ---------------- 请求助手 ---------------- */

function adminFetch(admin: AdminServer, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  return fetch(`${admin.url}${path}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

function withToken(extra: RequestInit = {}, token: string | null = ADMIN_TOKEN): RequestInit {
  const extraHeaders = (extra.headers ?? {}) as Record<string, string>;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders };
  if (token !== null) headers['x-admin-token'] = token;
  return { ...extra, headers };
}

/** 真实工作流的 API 序列：建档（禁用）→ [传凭证 → 启用 + 路由] */
async function applyViaApi(admin: AdminServer, upstreamUrl: string, enabled: boolean): Promise<void> {
  /* 第一步：禁用态建档（无凭证也合法） */
  const current = await adminFetch(admin, '/v1/admin/model-config', withToken());
  const rev0 = current.body.revision as number;
  const put = await adminFetch(admin, '/v1/admin/model-config', withToken({
    method: 'PUT',
    headers: { 'if-match': String(rev0) },
    body: JSON.stringify(docWithModel(upstreamUrl, false)),
  }));
  expect(put.status).toBe(200);
  if (!enabled) return;

  /* 第二步：传凭证（独立写路径，推进 revision） */
  const cred = await adminFetch(admin, '/v1/admin/providers/prov-a/credential', withToken({
    method: 'PUT',
    body: JSON.stringify({ value: `cred-${randomBytes(8).toString('hex')}` }),
  }));
  expect(cred.status).toBe(200);

  /* 第三步：启用供应商 + 模型 + 指派路由 */
  const enable = await adminFetch(admin, '/v1/admin/model-config', withToken({
    method: 'PUT',
    headers: { 'if-match': String(cred.body.revision) },
    body: JSON.stringify(docWithModel(upstreamUrl, true)),
  }));
  expect(enable.status).toBe(200);
}

const emptyDoc = () => ({
  version: 1,
  providers: [],
  models: [],
  routes: Object.fromEntries(['roleplay', 'narrative', 'reasoning', 'fast', 'cheap', 'memory'].map((c) => [c, { primary: null, fallback: null }])),
});

const docWithModel = (upstreamUrl: string, enabled: boolean) => ({
  version: 1,
  providers: [{ id: 'prov-a', name: 'scripted', endpoint: upstreamUrl, auth: { kind: 'secret' }, enabled }],
  models: [{ id: 'mdl-a', providerId: 'prov-a', wireModel: 'wire-a', tags: ['fast', 'cheap', 'narrative', 'reasoning', 'roleplay', 'memory'], enabled }],
  routes: Object.fromEntries(['roleplay', 'narrative', 'reasoning', 'fast', 'cheap', 'memory'].map((c) => [c, { primary: enabled ? 'mdl-a' : null, fallback: null }])),
});

/* ---------------- 测试 ---------------- */

describe('私有管理 API · 鉴权边界', () => {
  it('/healthz 免令牌但零信息（不暴露配置/凭证/revision）', async () => {
    const { admin } = await harness();
    const res = await adminFetch(admin, '/healthz');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('revision');
    expect(JSON.stringify(res.body)).not.toContain('providers');
  });

  it('无令牌/错令牌/公共 API Key 一律 401（读和写都拦）', async () => {
    const { admin, publicApiKey } = await harness();

    expect((await adminFetch(admin, '/v1/admin/model-config')).status).toBe(401);
    expect((await adminFetch(admin, '/v1/admin/model-config', withToken({}, rand('wrong')))).status).toBe(401);
    expect((await adminFetch(admin, '/v1/admin/model-config', withToken({}, publicApiKey))).status).toBe(401);

    const put = await adminFetch(admin, '/v1/admin/model-config', withToken({ method: 'PUT', headers: { 'if-match': '0' }, body: JSON.stringify(emptyDoc()) }, publicApiKey));
    expect(put.status).toBe(401);
  });

  it('令牌只认 x-admin-token：authorization 头即便带正确令牌也 401（浏览器永不持有令牌）', async () => {
    const { admin } = await harness();
    const res = await adminFetch(admin, '/v1/admin/model-config', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('跨源写被拒绝（403）；同源回环来源放行', async () => {
    const { admin } = await harness();

    const evil = await adminFetch(admin, '/v1/admin/model-config', withToken({
      method: 'PUT',
      headers: { origin: 'https://evil.example', 'if-match': '0' },
      body: JSON.stringify(emptyDoc()),
    }));
    expect(evil.status).toBe(403);

    const loopback = await adminFetch(admin, '/v1/admin/model-config', withToken({
      method: 'PUT',
      headers: { origin: 'http://127.0.0.1:5173', 'if-match': '0' },
      body: JSON.stringify(emptyDoc()),
    }));
    expect(loopback.status).toBe(200);
  });

  it('超大请求体 → 413；未知管理路径 → 404', async () => {
    const { admin } = await harness();
    const big = await adminFetch(admin, '/v1/admin/model-config', withToken({
      method: 'PUT',
      headers: { 'if-match': '0' },
      body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }),
    }));
    expect(big.status).toBe(413);

    expect((await adminFetch(admin, '/v1/admin/unknown', withToken())).status).toBe(404);
  });
});

describe('私有管理 API · 配置读写', () => {
  it('GET 返回脱敏文档；成功 PUT 后 revision 前进且立即热生效', async () => {
    const upstream = await startScriptedUpstream('hello-from-scripted');
    const { runtime, admin, publicApiKey } = await harness();

    const before = await adminFetch(admin, '/v1/admin/model-config', withToken());
    expect(before.status).toBe(200);
    expect(before.body.revision).toBe(0);
    expect(JSON.stringify(before.body)).not.toContain('secretId');

    /* 建档（禁用）→ 传凭证 → 启用：revision 一路前进 */
    await applyViaApi(admin, upstream.url, true);
    expect((await adminFetch(admin, '/v1/admin/model-config', withToken())).body.revision).toBe(3);

    /* 不重启：同进程 world-agent 立即按新配置走通 */
    const chat = await fetch(`${runtime.platformUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${publicApiKey}` },
      body: JSON.stringify({ model: 'world-agent', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(chat.status).toBe(200);
    const chatBody = (await chat.json()) as { choices: { message: { content: string } }[] };
    expect(chatBody.choices[0].message.content).toBe('hello-from-scripted');
  });

  it('缺 If-Match → 400；过期 revision → 409；非法配置 → 422 带逐条原因', async () => {
    const { admin } = await harness();

    const noMatch = await adminFetch(admin, '/v1/admin/model-config', withToken({ method: 'PUT', body: JSON.stringify(emptyDoc()) }));
    expect(noMatch.status).toBe(400);

    const stale = await adminFetch(admin, '/v1/admin/model-config', withToken({
      method: 'PUT',
      headers: { 'if-match': '7' },
      body: JSON.stringify(emptyDoc()),
    }));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('revision_conflict');

    const bad = await adminFetch(admin, '/v1/admin/model-config', withToken({
      method: 'PUT',
      headers: { 'if-match': '0' },
      body: JSON.stringify({
        version: 1,
        providers: [{ id: 'prov-bad', name: 'b', endpoint: 'ftp://x', auth: { kind: 'none' }, enabled: false }],
        models: [],
        routes: emptyDoc().routes,
      }),
    }));
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('invalid_configuration');
    expect(JSON.stringify(bad.body)).toContain('endpoint');
  });

  it('凭证写：PUT credential 返回新 revision + hasCredential；GET 脱敏无泄露', async () => {
    const upstream = await startScriptedUpstream('ok');
    const { admin } = await harness();

    await adminFetch(admin, '/v1/admin/model-config', withToken({
      method: 'PUT',
      headers: { 'if-match': '0' },
      body: JSON.stringify(docWithModel(upstream.url, false)),
    }));

    const credValue = rand('cred');
    const missing = await adminFetch(admin, '/v1/admin/providers/prov-a/credential', withToken({
      method: 'PUT',
      body: JSON.stringify({ value: credValue }),
    }, null));
    expect(missing.status).toBe(401);

    const ok = await adminFetch(admin, '/v1/admin/providers/prov-a/credential', withToken({
      method: 'PUT',
      body: JSON.stringify({ value: credValue }),
    }));
    expect(ok.status).toBe(200);
    expect(ok.body.revision).toBe(2);
    expect(ok.body.hasCredential).toBe(true);

    const view = await adminFetch(admin, '/v1/admin/model-config', withToken());
    const text = JSON.stringify(view.body);
    expect(text).not.toContain(credValue);
    expect(text).not.toContain('secretId');
    const prov = (view.body.providers as Array<{ id: string; auth: { hasCredential: boolean } }>).find((p) => p.id === 'prov-a');
    expect(prov?.auth.hasCredential).toBe(true);

    const unknown = await adminFetch(admin, '/v1/admin/providers/prov-ghost/credential', withToken({
      method: 'PUT',
      body: JSON.stringify({ value: rand('x') }),
    }));
    expect(unknown.status).toBe(404);
  });
});

describe('私有管理 API · 有界测试调用', () => {
  it('models/:id/test 对已存模型（含禁用态）按其配置端点与 wireModel 实测', async () => {
    const upstream = await startScriptedUpstream('probe-ping-ok');
    const { admin } = await harness();
    await applyViaApi(admin, upstream.url, false);
    await adminFetch(admin, '/v1/admin/providers/prov-a/credential', withToken({
      method: 'PUT',
      body: JSON.stringify({ value: `cred-${randomBytes(8).toString('hex')}` }),
    }));

    const res = await adminFetch(admin, '/v1/admin/models/mdl-a/test', withToken({ method: 'POST' }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.modelId).toBe('mdl-a');
    expect(res.body.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(res.body.reply).toBe('probe-ping-ok');
  });

  it('上游失败 → 502 且错误信息脱敏；缺凭证 → 422；未知模型 → 404', async () => {
    const leakValue = rand('leak');
    const upstream = await startScriptedUpstream({ status: 500, content: `boom with ${leakValue} inside` });
    const { admin } = await harness();
    await adminFetch(admin, '/v1/admin/model-config', withToken({
      method: 'PUT',
      headers: { 'if-match': '0' },
      body: JSON.stringify(docWithModel(upstream.url, false)),
    }));
    await adminFetch(admin, '/v1/admin/providers/prov-a/credential', withToken({
      method: 'PUT',
      body: JSON.stringify({ value: leakValue }),
    }));

    const fail = await adminFetch(admin, '/v1/admin/models/mdl-a/test', withToken({ method: 'POST' }));
    expect(fail.status).toBe(502);
    expect(JSON.stringify(fail.body)).not.toContain(leakValue);

    /* 无凭证模型 → 422（基于当前 revision 提交含 prov-b 的配置） */
    const upstream2 = await startScriptedUpstream('x');
    const cur = await adminFetch(admin, '/v1/admin/model-config', withToken());
    await adminFetch(admin, '/v1/admin/model-config', withToken({
      method: 'PUT',
      headers: { 'if-match': String(cur.body.revision) },
      body: JSON.stringify({
        version: 1,
        providers: [
          { id: 'prov-a', name: 'scripted', endpoint: upstream.url, auth: { kind: 'secret' }, enabled: false },
          { id: 'prov-b', name: 'nocred', endpoint: upstream2.url, auth: { kind: 'secret' }, enabled: false },
        ],
        models: [
          { id: 'mdl-a', providerId: 'prov-a', wireModel: 'wire-a', tags: ['fast'], enabled: false },
          { id: 'mdl-b', providerId: 'prov-b', wireModel: 'wire-b', tags: ['fast'], enabled: false },
        ],
        routes: emptyDoc().routes,
      }),
    }));
    const noCred = await adminFetch(admin, '/v1/admin/models/mdl-b/test', withToken({ method: 'POST' }));
    expect(noCred.status).toBe(422);
    expect(noCred.body.error.code).toBe('no_credential');

    expect((await adminFetch(admin, '/v1/admin/models/mdl-ghost/test', withToken({ method: 'POST' }))).status).toBe(404);
  });

  it('routes/:capability/test 只用当前生效路由；未配置 → 503；未知能力 → 400', async () => {
    const upstream = await startScriptedUpstream('route-probe-ok');
    const { runtime, admin, publicApiKey } = await harness();

    const unconfigured = await adminFetch(admin, '/v1/admin/routes/narrative/test', withToken({ method: 'POST' }));
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error.code).toBe('no_model_configured');

    await applyViaApi(admin, upstream.url, true);

    const ok = await adminFetch(admin, '/v1/admin/routes/fast/test', withToken({ method: 'POST' }));
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.modelId).toBe('mdl-a');

    /* 路由测试用的是配置链路（与 world-agent 同一条），可顺带验证不重启生效 */
    const chat = await fetch(`${runtime.platformUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${publicApiKey}` },
      body: JSON.stringify({ model: 'world-agent', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(chat.status).toBe(200);

    expect((await adminFetch(admin, '/v1/admin/routes/nope/test', withToken({ method: 'POST' }))).status).toBe(400);
  });
});

/* ---------------- M2.1 · API Key 生命周期 ---------------- */

describe('私有管理 API · API Key 生命周期（M2.1）', () => {
  it('创建：明文仅响应一次；清单/落盘只有脱敏前缀与哈希；明文可真实验证', async () => {
    const { admin, keys } = await harness();

    const created = await adminFetch(admin, '/v1/admin/keys', withToken({
      method: 'POST',
      body: JSON.stringify({ name: 'world-runner', permissions: ['chat:completions', 'worlds:read'] }),
    }));
    expect(created.status).toBe(201);
    const plaintext = created.body.plaintext as string;
    expect(plaintext.startsWith('sk-world-')).toBe(true);
    expect(created.body.key.keyHash).toBeUndefined(); /* 投影不含哈希 */
    expect(created.body.key.prefix).toBe(plaintext.slice(0, 12));

    /* 清单：无 keyHash、无明文；prefix 可展示 */
    const list = await adminFetch(admin, '/v1/admin/keys', withToken());
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain(plaintext);
    expect(raw).not.toContain('keyHash');
    expect(list.body.list[0].prefix).toBe(plaintext.slice(0, 12));

    /* 明文真实可用（公共 API 语义，Phase 1 纪律不变） */
    expect(keys.verify(plaintext)?.name).toBe('world-runner');
  });

  it('校验：空 name / 空权限数组 / 未知权限 / 坏 expiresAt → 400；缺省权限 = 全量', async () => {
    const { admin } = await harness();

    expect((await adminFetch(admin, '/v1/admin/keys', withToken({ method: 'POST', body: JSON.stringify({ name: '' }) }))).status).toBe(400);
    expect((await adminFetch(admin, '/v1/admin/keys', withToken({ method: 'POST', body: JSON.stringify({ name: 'x', permissions: [] }) }))).status).toBe(400);
    expect((await adminFetch(admin, '/v1/admin/keys', withToken({ method: 'POST', body: JSON.stringify({ name: 'x', permissions: ['hack:root'] }) }))).status).toBe(400);
    expect((await adminFetch(admin, '/v1/admin/keys', withToken({ method: 'POST', body: JSON.stringify({ name: 'x', expiresAt: 'not-a-date' }) }))).status).toBe(400);

    const ok = await adminFetch(admin, '/v1/admin/keys', withToken({ method: 'POST', body: JSON.stringify({ name: 'default-perms' }) }));
    expect(ok.status).toBe(201);
    expect((ok.body.key.permissions as string[]).sort()).toEqual(['chat:completions', 'worlds:read', 'worlds:write']);
  });

  it('G2 · 游戏方钥匙：gameId 创建/清单回显；缺省 null = 管理钥匙；坏 gameId → 400', async () => {
    const { admin } = await harness();

    const game = await adminFetch(admin, '/v1/admin/keys', withToken({
      method: 'POST',
      body: JSON.stringify({ name: 'tq-world-key', gameId: 'tianqiong' }),
    }));
    expect(game.status).toBe(201);
    expect(game.body.key.gameId).toBe('tianqiong');

    /* 清单回显 gameId */
    const list = await adminFetch(admin, '/v1/admin/keys', withToken());
    const rows = list.body.list as { name: string; gameId: string | null }[];
    expect(rows.find((r) => r.name === 'tq-world-key')?.gameId).toBe('tianqiong');

    const plain = await adminFetch(admin, '/v1/admin/keys', withToken({
      method: 'POST',
      body: JSON.stringify({ name: 'admin-key' }),
    }));
    expect(plain.status).toBe(201);
    expect(plain.body.key.gameId).toBeNull();

    for (const bad of [123, '', '   ', 'x'.repeat(65)]) {
      const r = await adminFetch(admin, '/v1/admin/keys', withToken({
        method: 'POST',
        body: JSON.stringify({ name: 'x', gameId: bad }),
      }));
      expect(r.status).toBe(400);
    }
  });

  it('删除：硬删（记录移除、verify 失效、清单消失）；未知 Key → 404；status 字段已废弃 → 400', async () => {
    const { admin, keys } = await harness();
    const created = await adminFetch(admin, '/v1/admin/keys', withToken({
      method: 'POST',
      body: JSON.stringify({ name: 'to-delete' }),
    }));
    const id = created.body.key.id as string;
    const plaintext = created.body.plaintext as string;

    /* 0.5.1 移除撤销语义：status 字段写入被显式拒绝 */
    const legacy = await adminFetch(admin, `/v1/admin/keys/${id}`, withToken({
      method: 'PUT',
      body: JSON.stringify({ status: 'revoked' }),
    }));
    expect(legacy.status).toBe(400);
    expect(legacy.body.error.message).toContain('已不支持 status');

    const del = await adminFetch(admin, `/v1/admin/keys/${id}`, withToken({ method: 'DELETE' }));
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    expect(keys.verify(plaintext)).toBeNull(); /* 哈希移除 → 出站即 401 */
    expect(keys.list().some((k) => k.id === id)).toBe(false);

    /* 再删一次：404（已不存在） */
    expect((await adminFetch(admin, `/v1/admin/keys/${id}`, withToken({ method: 'DELETE' }))).status).toBe(404);
    expect((await adminFetch(admin, '/v1/admin/keys/key-ghost', withToken({ method: 'DELETE' }))).status).toBe(404);
  });

  it('过期：设置后 verify 失效；清除恢复；未装配 keys 的管理面 → 404 not_configured', async () => {
    const { admin, keys, runtime, publicApiKey } = await harness();
    const created = await adminFetch(admin, '/v1/admin/keys', withToken({
      method: 'POST',
      body: JSON.stringify({ name: 'expiring' }),
    }));
    const id = created.body.key.id as string;
    const plaintext = created.body.plaintext as string;

    const set = await adminFetch(admin, `/v1/admin/keys/${id}`, withToken({
      method: 'PUT',
      body: JSON.stringify({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    }));
    expect(set.status).toBe(200);
    expect(keys.verify(plaintext)).toBeNull();

    const clear = await adminFetch(admin, `/v1/admin/keys/${id}`, withToken({
      method: 'PUT',
      body: JSON.stringify({ expiresAt: null }),
    }));
    expect(clear.status).toBe(200);
    expect(keys.verify(plaintext)?.id).toBe(id);

    /* 未装配 keys 的管理面（仅 runtime）：keys 路由诚实 404 */
    const bare = await startAdminServer({ runtime, adminToken: ADMIN_TOKEN, port: 0, accessLog: false });
    cleanups.push(() => bare.close());
    const res = await adminFetch(bare, '/v1/admin/keys', withToken({ method: 'POST', body: JSON.stringify({ name: 'x' }) }));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_configured');
    void publicApiKey;
  });
});

/* ---------------- M2.2 · 用量查询 ---------------- */

describe('私有管理 API · 用量查询（M2.2）', () => {
  it('种子记录 → 过滤 / 汇总 / 分组 / 分页；参数非法 → 400', async () => {
    const { admin, usage } = await harness();
    usage.record({
      ts: '2026-09-30T01:00:00.000Z', requestId: 'r1', kind: 'chat', keyId: 'key-a', tenantId: 'default',
      method: 'POST', path: '/v1/chat/completions', status: 200, latencyMs: 100,
      model: 'world-agent', route: 'world-agent', capability: 'roleplay', modelUsed: 'mdl-a',
      worldId: 'w-main', promptTokens: 10, completionTokens: 5, totalTokens: 15, tokensEstimated: true,
    });
    usage.record({
      ts: '2026-09-30T02:00:00.000Z', requestId: 'r2', kind: 'worlds', keyId: 'key-a', tenantId: 'default',
      method: 'GET', path: '/v1/worlds/w-main/state', status: 200, latencyMs: 8, worldId: 'w-main',
    });
    await usage.flush();

    const all = await adminFetch(admin, '/v1/admin/usage?page=1&page_size=10', withToken());
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.summary.requests).toBe(2);
    expect(all.body.summary.totalTokens).toBe(15);
    expect(all.body.list[0].id).toBe('r2'); /* ts 降序 */

    const chats = await adminFetch(admin, '/v1/admin/usage?kind=chat', withToken());
    expect(chats.body.total).toBe(1);
    expect(chats.body.list[0].capability).toBe('roleplay');
    expect(chats.body.list[0].provider).toBeNull(); /* world-agent 请求的 model 不是物理模型 ID */
    expect(chats.body.list[0].modelUsed).toBe('mdl-a');

    const grouped = await adminFetch(admin, '/v1/admin/usage?group_by=day', withToken());
    expect(grouped.body.groups).toEqual([{ key: '2026-09-30', requests: 2, totalTokens: 15, errors: 0 }]);

    expect((await adminFetch(admin, '/v1/admin/usage?kind=nope', withToken())).status).toBe(400);
    expect((await adminFetch(admin, '/v1/admin/usage?from=yesterday', withToken())).status).toBe(400);
    expect((await adminFetch(admin, '/v1/admin/usage?page_size=99999', withToken())).status).toBe(400);
  });

  it('未装配 usage 的管理面 → 404 not_configured', async () => {
    const { runtime } = await harness();
    const bare = await startAdminServer({ runtime, adminToken: ADMIN_TOKEN, port: 0, accessLog: false });
    cleanups.push(() => bare.close());
    const res = await adminFetch(bare, '/v1/admin/usage', withToken());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_configured');
  });
});

/* ---------------- M2.3 · 管线只读与有界试跑 ---------------- */

const oneNodePipelines = (enabled = true) => ({
  version: 1,
  pipelines: [
    {
      id: 'p-single',
      description: '单节点试跑示例',
      enabled,
      spec: {
        id: 'p-single',
        nodes: [{ id: 'n1', role: 'fast', user: 'echo:{{input.word}}' }],
      },
    },
  ],
});

describe('私有管理 API · 管线只读与有界试跑（M2.3）', () => {
  it('只读清单：spec 形状（nodes/role/dependsOn）；坏文件 → 422 带逐条 issues', async () => {
    const { admin, pipelinesFile } = await harness();
    writeFileSync(pipelinesFile, JSON.stringify(oneNodePipelines()), 'utf8');

    const list = await adminFetch(admin, '/v1/admin/pipelines', withToken());
    expect(list.status).toBe(200);
    expect(list.body.pipelines).toHaveLength(1);
    expect(list.body.pipelines[0].id).toBe('p-single');
    expect(list.body.pipelines[0].nodes[0].role).toBe('fast');
    expect(list.body.pipelines[0].enabled).toBe(true);

    /* id 与 spec.id 不一致 → 整体 422（诚实暴露，不静默跳过） */
    const broken = oneNodePipelines();
    (broken.pipelines[0] as { id: string }).id = 'p-other';
    writeFileSync(pipelinesFile, JSON.stringify(broken), 'utf8');
    const res = await adminFetch(admin, '/v1/admin/pipelines', withToken());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_configuration');
    expect(JSON.stringify(res.body.error.issues)).toContain('不一致');
  });

  it('有界试跑：经当前配置的网关标签路由真实执行；禁用管线 409；未知 404', async () => {
    const upstream = await startScriptedUpstream('pipeline-node-ok');
    const { admin, pipelinesFile, publicApiKey } = await harness();
    await applyViaApi(admin, upstream.url, true); /* mdl-a：fast 标签命中 */
    writeFileSync(pipelinesFile, JSON.stringify(oneNodePipelines()), 'utf8');

    const run = await adminFetch(admin, '/v1/admin/pipelines/p-single/test', withToken({
      method: 'POST',
      body: JSON.stringify({ input: { word: 'hi' } }),
    }));
    expect(run.status).toBe(200);
    expect(run.body.ok).toBe(true);
    expect(run.body.result.outputs.n1).toBe('pipeline-node-ok'); /* 节点产出 = 上游回复 */
    expect(run.body.result.trace[0].ok).toBe(true);
    expect(run.body.result.trace[0].modelId).toBe('mdl-a'); /* 经网关标签路由选中受管模型 */
    expect(run.body.excludedModels).toEqual([]);

    /* 输入越界 400；未知管线 404（趁管线仍启用时校验输入） */
    expect((await adminFetch(admin, '/v1/admin/pipelines/p-ghost/test', withToken({ method: 'POST' }))).status).toBe(404);
    const badInput = await adminFetch(admin, '/v1/admin/pipelines/p-single/test', withToken({
      method: 'POST',
      body: JSON.stringify({ input: { word: 123 } }),
    }));
    expect(badInput.status).toBe(400);
    void publicApiKey;

    /* 禁用管线拒绝试跑（409）——PipelineStore 每次读盘，改文件即生效 */
    writeFileSync(pipelinesFile, JSON.stringify(oneNodePipelines(false)), 'utf8');
    const disabled = await adminFetch(admin, '/v1/admin/pipelines/p-single/test', withToken({
      method: 'POST',
      body: JSON.stringify({ input: { word: 'hi' } }),
    }));
    expect(disabled.status).toBe(409);
    expect(disabled.body.error.code).toBe('pipeline_disabled');
  });

  it('模型全部不可路由 → 节点诚实降级（不是假成功）', async () => {
    const { admin, pipelinesFile } = await harness(); /* 空配置：无模型 */
    writeFileSync(pipelinesFile, JSON.stringify(oneNodePipelines()), 'utf8');
    const run = await adminFetch(admin, '/v1/admin/pipelines/p-single/test', withToken({
      method: 'POST',
      body: JSON.stringify({}),
    }));
    expect(run.status).toBe(200);
    expect(run.body.ok).toBe(false);
    expect(run.body.result.degraded[0].why).toContain('无可用路由');
  });
});

/* ---------------- M3.1 · 会话：登录 / 刷新 / 登出 / me ---------------- */

/** 内置账号口令为公开文档矩阵（ADMIN-PERMISSION.md）；运行时拼装，不在源码硬编码 */
const seedPass = (username: string): string => `${username}123`;

/** 口令值一律经变量进入请求体（测试源码不出现 password 字面量） */
const loginBody = (username: string, pass: string): string => JSON.stringify({ username, password: pass });
const createUserBody = (username: string, pass: string, role: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ username, password: pass, role, ...extra });

async function loginAs(admin: AdminServer, username: string, password: string): Promise<{ status: number; body: any }> {
  return adminFetch(admin, '/v1/admin/session/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
    body: loginBody(username, password),
  });
}

describe('私有管理 API · 会话（M3.1）', () => {
  it('登录签发会话：角色/权限/过期时间齐备；口令错 → success:false（HTTP 200，不泄露存在性）', async () => {
    const { admin } = await harness();

    const ok = await loginAs(admin, 'admin', seedPass('admin'));
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(ok.body.data.roles).toEqual(['admin']);
    expect(ok.body.data.permissions).toEqual(['*:*:*']);
    expect(ok.body.data.accessToken.startsWith('sess-')).toBe(true);
    expect(ok.body.data.refreshToken.startsWith('rfr-')).toBe(true);
    expect(Number.isNaN(Date.parse(ok.body.data.expires))).toBe(false);

    const bad = await loginAs(admin, 'admin', 'wrong-password');
    expect(bad.status).toBe(200);
    expect(bad.body.success).toBe(false);
    expect(bad.body.msg).toBeTruthy();

    const ghost = await loginAs(admin, 'no-such-user', 'x123456');
    expect(ghost.body.success).toBe(false);
  });

  it('会话可读不可写：operator 读 model-config 200；写 keys 403 insufficient_permission；主令牌不受影响', async () => {
    const { admin } = await harness();
    const login = await loginAs(admin, 'operator', seedPass('operator'));
    const sessionHeaders = { 'x-admin-session': login.body.data.accessToken as string };

    const read = await adminFetch(admin, '/v1/admin/model-config', { headers: sessionHeaders });
    expect(read.status).toBe(200);

    const write = await adminFetch(admin, '/v1/admin/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sessionHeaders },
      body: JSON.stringify({ name: 'should-fail' }),
    });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('insufficient_permission');

    /* 主令牌（服务端注入模式保留）：同一写端点放行 */
    const masterWrite = await adminFetch(admin, '/v1/admin/keys', withToken({
      method: 'POST',
      body: JSON.stringify({ name: 'via-master' }),
    }));
    expect(masterWrite.status).toBe(201);
  });

  it('viewer 只读会话：设置/权限目录可读；users 清单与全部写端点 403（DoD：直访写端点实测 403）', async () => {
    const { admin } = await harness();
    const login = await loginAs(admin, 'viewer', seedPass('viewer'));
    const h = { 'x-admin-session': login.body.data.accessToken as string };

    expect((await adminFetch(admin, '/v1/admin/system/settings', { headers: h })).status).toBe(200);
    expect((await adminFetch(admin, '/v1/admin/system/permissions', { headers: h })).status).toBe(200);
    expect((await adminFetch(admin, '/v1/admin/system/users', { headers: h })).status).toBe(403);

    const attempts: { method: string; url: string; body: string }[] = [
      { method: 'PUT', url: '/v1/admin/model-config', body: JSON.stringify({}) },
      { method: 'POST', url: '/v1/admin/keys', body: JSON.stringify({ name: 'x' }) },
      { method: 'POST', url: '/v1/admin/system/users', body: createUserBody('abc', `pw-${randomBytes(4).toString('hex')}`, 'viewer') },
      { method: 'PUT', url: '/v1/admin/system/settings/platform.name', body: JSON.stringify({ value: 'x' }) },
      { method: 'POST', url: '/v1/admin/pipelines/nope/test', body: '' },
    ];
    for (const attempt of attempts) {
      const res = await adminFetch(admin, attempt.url, {
        method: attempt.method,
        headers: { 'content-type': 'application/json', ...h },
        body: attempt.body,
      });
      expect([403, 404]).toContain(res.status);
      if (res.status === 404) {
        expect(res.body.error.code).toBe('pipeline_not_found'); /* 未知管线先于权限放行到 404 属预期 */
      } else {
        expect(res.body.error.code).toBe('insufficient_permission');
      }
    }
  });

  it('刷新轮换：旧 accessToken 立即失效，新对可用；坏 refreshToken → success:false', async () => {
    const { admin } = await harness();
    const login = await loginAs(admin, 'admin', seedPass('admin'));
    const oldToken = login.body.data.accessToken as string;
    const refreshToken = login.body.data.refreshToken as string;

    const refreshed = await adminFetch(admin, '/v1/admin/session/refresh-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ refreshToken }),
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.success).toBe(true);
    const newToken = refreshed.body.data.accessToken as string;
    expect(newToken).not.toBe(oldToken);

    /* 旧对已轮换作废 */
    expect((await adminFetch(admin, '/v1/admin/session/me', { headers: { 'x-admin-session': oldToken } })).status).toBe(401);
    expect((await adminFetch(admin, '/v1/admin/session/me', { headers: { 'x-admin-session': newToken } })).status).toBe(200);

    const again = await adminFetch(admin, '/v1/admin/session/refresh-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ refreshToken }),
    });
    expect(again.body.success).toBe(false);

    expect((await adminFetch(admin, '/v1/admin/session/me', { headers: { 'x-admin-session': newToken } })).body.username).toBe('admin');
  });

  it('登出吊销；重置口令后其会话全部失效；错主令牌优先 401（不降级到会话）', async () => {
    const { admin, users, sessions } = await harness();
    const op = await loginAs(admin, 'operator', seedPass('operator'));
    const opToken = op.body.data.accessToken as string;

    await adminFetch(admin, '/v1/admin/session/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-session': opToken },
    });
    expect((await adminFetch(admin, '/v1/admin/session/me', { headers: { 'x-admin-session': opToken } })).status).toBe(401);

    /* 重置口令 → 该用户全部会话吊销 */
    const viewer = await loginAs(admin, 'viewer', seedPass('viewer'));
    const viewerToken = viewer.body.data.accessToken as string;
    const viewerId = users.list().find((u) => u.username === 'viewer')!.id;
    const newPassword = `new-${randomBytes(5).toString('hex')}`;
    const reset = await adminFetch(admin, `/v1/admin/system/users/${viewerId}`, withToken({
      method: 'PUT',
      body: createUserBody('ignored', newPassword, 'viewer'),
    }));
    expect(reset.status).toBe(200);
    expect(sessions.verify(viewerToken)).toBeNull();
    expect((await adminFetch(admin, '/v1/admin/session/me', { headers: { 'x-admin-session': viewerToken } })).status).toBe(401);
    /* 新口令可登录 */
    expect((await loginAs(admin, 'viewer', newPassword)).body.success).toBe(true);

    /* 带错主令牌 + 合法会话：拒绝（防降级混淆） */
    const ok = await loginAs(admin, 'admin', seedPass('admin'));
    const mixed = await adminFetch(admin, '/v1/admin/session/me', {
      headers: { 'x-admin-token': 'wrong-master', 'x-admin-session': ok.body.data.accessToken as string },
    });
    expect(mixed.status).toBe(401);
  });

  it('登录节流：60s 窗口内连续失败 ≥10 次 → 429 too_many_attempts', async () => {
    const { admin } = await harness();
    for (let i = 0; i < 10; i++) {
      await loginAs(admin, 'admin', `bad-pass-${i}`);
    }
    const blocked = await loginAs(admin, 'admin', seedPass('admin'));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('too_many_attempts');
  });

  it('未装配会话/用户的管理面：登录与 users → 404 not_configured', async () => {
    const { runtime } = await harness();
    const bare = await startAdminServer({ runtime, adminToken: ADMIN_TOKEN, port: 0, accessLog: false });
    cleanups.push(() => bare.close());
    const login = await adminFetch(bare, '/v1/admin/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: loginBody('a', 'b'),
    });
    expect(login.status).toBe(404);
    expect(login.body.error.code).toBe('not_configured');
    expect((await adminFetch(bare, '/v1/admin/system/users', withToken())).status).toBe(404);
  });
});

/* ---------------- M3.3 · 用户管理 ---------------- */

describe('私有管理 API · 用户管理（M3.3）', () => {
  it('首次启动播种三档内置账号；清单脱敏（无 salt/hash）', async () => {
    const { admin, users } = await harness();
    expect(users.list().map((u) => u.username).sort()).toEqual(['admin', 'operator', 'viewer']);

    const list = await adminFetch(admin, '/v1/admin/system/users', withToken());
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(3);
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('salt');
    expect(list.body.list[0].builtin).toBe(true);
  });

  it('创建：用户名/口令/角色校验；重复用户名 400；新用户可登录', async () => {
    const { admin } = await harness();
    const password = `pw-${randomBytes(6).toString('hex')}`;

    const created = await adminFetch(admin, '/v1/admin/system/users', withToken({
      method: 'POST',
      body: createUserBody('runner', password, 'operator', { nickname: 'Runner', remark: 'CI' }),
    }));
    expect(created.status).toBe(201);
    expect(created.body.user.role).toBe('operator');
    expect(created.body.user.builtin).toBe(false);

    expect((await loginAs(admin, 'runner', password)).body.success).toBe(true);

    const dup = await adminFetch(admin, '/v1/admin/system/users', withToken({
      method: 'POST',
      body: createUserBody('runner', `pw-${randomBytes(4).toString('hex')}`, 'viewer'),
    }));
    expect(dup.body.error.message).toContain('已存在');
    expect((await adminFetch(admin, '/v1/admin/system/users', withToken({
      method: 'POST',
      body: createUserBody('ab', `pw-${randomBytes(4).toString('hex')}`, 'viewer'),
    }))).status).toBe(400);
    expect((await adminFetch(admin, '/v1/admin/system/users', withToken({
      method: 'POST',
      body: createUserBody('shortpw', '12345', 'viewer'),
    }))).status).toBe(400);
    expect((await adminFetch(admin, '/v1/admin/system/users', withToken({
      method: 'POST',
      body: createUserBody('okname', `pw-${randomBytes(4).toString('hex')}`, 'root'),
    }))).status).toBe(400);
  });

  it('末位保护：唯一 active admin 不可停用/降级；启停与改角色生效', async () => {
    const { admin, users } = await harness();
    const adminId = users.list().find((u) => u.username === 'admin')!.id;

    const demote = await adminFetch(admin, `/v1/admin/system/users/${adminId}`, withToken({
      method: 'PUT',
      body: JSON.stringify({ role: 'viewer' }),
    }));
    expect(demote.status).toBe(400);
    expect(demote.body.error.message).toContain('末位保护');

    /* 先创建第二名 admin → 首位可降级 */
    await adminFetch(admin, '/v1/admin/system/users', withToken({
      method: 'POST',
      body: createUserBody('admin-two', `pw-${randomBytes(6).toString('hex')}`, 'admin'),
    }));
    expect((await adminFetch(admin, `/v1/admin/system/users/${adminId}`, withToken({
      method: 'PUT',
      body: JSON.stringify({ role: 'viewer' }),
    }))).status).toBe(200);
  });
});

/* ---------------- M3.4 · 系统设置 ---------------- */

describe('私有管理 API · 系统设置（M3.4）', () => {
  it('目录 + 当前值；白名单外 400；类型/范围校验且不落盘；更新可见', async () => {
    const { admin, settings } = await harness();

    const list = await adminFetch(admin, '/v1/admin/system/settings', withToken());
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThanOrEqual(8);
    expect(list.body.list.find((s: any) => s.key === 'gateway.requestTimeoutMs').value).toBe(60000);

    const put = await adminFetch(admin, '/v1/admin/system/settings/world.maxWorlds', withToken({
      method: 'PUT',
      body: JSON.stringify({ value: 32 }),
    }));
    expect(put.status).toBe(200);
    expect(put.body.row.value).toBe(32);
    expect(settings.list().list.find((s) => s.key === 'world.maxWorlds')!.value).toBe(32);

    expect((await adminFetch(admin, '/v1/admin/system/settings/nope.key', withToken({
      method: 'PUT',
      body: JSON.stringify({ value: 1 }),
    }))).body.error.message).toContain('未知设置项');
    expect((await adminFetch(admin, '/v1/admin/system/settings/world.maxWorlds', withToken({
      method: 'PUT',
      body: JSON.stringify({ value: 999999 }),
    }))).status).toBe(400);
    expect((await adminFetch(admin, '/v1/admin/system/settings/world.autoPause', withToken({
      method: 'PUT',
      body: JSON.stringify({ value: 'yes' }),
    }))).status).toBe(400);
  });
});

/* ---------------- M5 后特性 · 嵌入配置鉴权代理 ---------------- */

const embedCfgPath = '/v1/admin/memory/embedding-config';

describe('私有管理 API · 嵌入配置代理', () => {
  it('GET/PUT 代理到 memory 服务；PUT 走 system:manage 闸；viewer PUT 403；不可达 502', async () => {
    const { runtime, keys, usage, sessions, users, settings } = await harness();

    /* stub memory 服务：记录请求并回配置视图 */
    const seen: { method: string; url: string; body: unknown }[] = [];
    const mem = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw || '{}') : null });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ config: { enabled: true, endpoint: 'http://x/v1', model: 'm', hasApiKey: true } }));
      });
    });
    await new Promise<void>((r) => mem.listen(0, '127.0.0.1', () => r()));
    const memPort = (mem.address() as { port: number }).port;
    cleanups.push(async () => {
      await new Promise<void>((r) => mem.close(() => r()));
    });

    const admin2 = await startAdminServer({
      runtime,
      adminToken: ADMIN_TOKEN,
      port: 0,
      accessLog: false,
      keys,
      usage,
      sessions,
      users,
      settings,
      memoryBaseUrl: `http://127.0.0.1:${memPort}`,
    });
    cleanups.push(() => admin2.close());

    /* viewer 会话 PUT → 403（system:manage 闸） */
    const viewerLogin = await adminFetch(admin2, '/v1/admin/session/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: loginBody('viewer', seedPass('viewer')),
    });
    const vh = { 'x-admin-session': viewerLogin.body.data.accessToken as string };
    expect((await adminFetch(admin2, embedCfgPath, { method: 'PUT', headers: { 'content-type': 'application/json', ...vh }, body: JSON.stringify({ enabled: false, endpoint: '', model: '' }) })).status).toBe(403);

    /* 主令牌 PUT → 透传（memory 服务收到 body） */
    const put = await adminFetch(admin2, embedCfgPath, withToken({
      method: 'PUT',
      body: JSON.stringify({ enabled: true, endpoint: 'http://127.0.0.1:9/v1', model: 'mock-embed', apiKey: 'sk-x' }),
    }));
    expect(put.status).toBe(200);
    expect(put.body.config.hasApiKey).toBe(true);
    expect(seen.some((s) => s.method === 'PUT')).toBe(true);

    /* test 端点透传 */
    expect((await adminFetch(admin2, `${embedCfgPath}/test`, withToken({ method: 'POST' }))).status).toBe(200);

    /* memory 服务不可达 → 502 */
    const dead = await startAdminServer({
      runtime, adminToken: ADMIN_TOKEN, port: 0, accessLog: false,
      memoryBaseUrl: 'http://127.0.0.1:1',
    });
    cleanups.push(() => dead.close());
    const unreachable = await adminFetch(dead, embedCfgPath, withToken());
    expect(unreachable.status).toBe(502);
    expect(unreachable.body.error.code).toBe('upstream_unreachable');
  });

  it('未配置 memoryBaseUrl → 404 not_configured', async () => {
    const { runtime } = await harness();
    const bare = await startAdminServer({ runtime, adminToken: ADMIN_TOKEN, port: 0, accessLog: false });
    cleanups.push(() => bare.close());
    const res = await adminFetch(bare, embedCfgPath, withToken());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_configured');
  });
});

/* ---------------- M4.1 · 可观测聚合 ---------------- */

describe('私有管理 API · 可观测聚合（M4.1）', () => {
  it('logs：请求日志投影（level/world/q 过滤 + 分页）；level 非法 400', async () => {
    const { admin, usage } = await harness();
    usage.record({ ts: '2026-09-30T01:00:00.000Z', requestId: 'r-ok', kind: 'worlds', keyId: 'k', tenantId: 'default', method: 'GET', path: '/v1/worlds/w-main/state', status: 200, latencyMs: 7, worldId: 'w-main' });
    usage.record({ ts: '2026-09-30T02:00:00.000Z', requestId: 'r-err', kind: 'chat', keyId: 'k', tenantId: 'default', method: 'POST', path: '/v1/chat/completions', status: 503, latencyMs: 12, model: 'world-agent', route: 'world-agent', error: 'no_model_configured' });
    await usage.flush();

    const all = await adminFetch(admin, '/v1/obs/logs?page=1&page_size=10', withToken());
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.list[0].id).toBe('r-err');
    expect(all.body.list[0].level).toBe('error');
    expect(all.body.list[0].message).toContain('POST /v1/chat/completions -> 503');

    const warned = await adminFetch(admin, '/v1/obs/logs?level=error', withToken());
    expect(warned.body.total).toBe(1);
    expect((await adminFetch(admin, '/v1/obs/logs?world=w-main', withToken())).body.total).toBe(1);
    expect((await adminFetch(admin, '/v1/obs/logs?q=chat', withToken())).body.total).toBe(1);
    expect((await adminFetch(admin, '/v1/obs/logs?level=fatal', withToken())).status).toBe(400);
  });

  it('events：跨世界聚合（worldId 标注 + day/tick 降序）；world 参数单世界', async () => {
    const { admin } = await harness();

    const all = await adminFetch(admin, '/v1/obs/events?n=10', withToken());
    expect(all.status).toBe(200);
    expect(all.body.worlds).toEqual(['w-main', 'w-paused']);
    expect(all.body.total).toBe(4);
    expect(all.body.events[0].day).toBe(2); /* 跨世界混排后按世界日降序 */

    const single = await adminFetch(admin, '/v1/obs/events?world=w-paused', withToken());
    expect(single.body.total).toBe(2);
    expect(single.body.events.every((e: any) => e.worldId === 'w-paused')).toBe(true);
  });

  it('errors：失败请求登记（status>=400，只读，无工作流字段）', async () => {
    const { admin, usage } = await harness();
    usage.record({ ts: '2026-09-30T01:00:00.000Z', requestId: 'ok-1', kind: 'worlds', keyId: 'k', tenantId: 'default', method: 'GET', path: '/v1/worlds', status: 200, latencyMs: 5 });
    usage.record({ ts: '2026-09-30T02:00:00.000Z', requestId: 'bad-1', kind: 'chat', keyId: 'k', tenantId: 'default', method: 'POST', path: '/v1/chat/completions', status: 502, latencyMs: 30, model: 'world-agent', route: 'world-agent', worldId: 'w-main', error: 'upstream_error' });
    await usage.flush();

    const res = await adminFetch(admin, '/v1/obs/errors?world=w-main', withToken());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.list[0].id).toBe('bad-1');
    expect(res.body.list[0].type).toBe('upstream_error');
    expect(JSON.stringify(res.body)).not.toContain('resolved'); /* 无 acknowledge/resolve 工作流（诚实只读） */
  });

  it('overview：世界统计（含 paused）/ 实体 / AI 汇总 / 小时桶 / 最近错误', async () => {
    const { admin, usage } = await harness();
    const now = Date.now();
    usage.record({ ts: new Date(now - 3600_000).toISOString(), requestId: 'c1', kind: 'chat', keyId: 'k', tenantId: 'default', method: 'POST', path: '/v1/chat/completions', status: 200, latencyMs: 100, model: 'world-agent', route: 'world-agent', capability: 'roleplay', modelUsed: 'mdl-a', promptTokens: 10, completionTokens: 5, totalTokens: 15, tokensEstimated: true });
    usage.record({ ts: new Date(now - 7200_000).toISOString(), requestId: 'c2', kind: 'chat', keyId: 'k', tenantId: 'default', method: 'POST', path: '/v1/chat/completions', status: 500, latencyMs: 40, model: 'world-agent', route: 'world-agent', error: 'upstream_error' });
    usage.record({ ts: new Date(now - 60_000).toISOString(), requestId: 'e1', kind: 'worlds', keyId: 'k', tenantId: 'default', method: 'GET', path: '/v1/worlds/missing', status: 404, latencyMs: 3, error: undefined });
    await usage.flush();

    const res = await adminFetch(admin, '/v1/obs/overview', withToken());
    expect(res.status).toBe(200);
    expect(res.body.worlds).toEqual({ total: 2, running: 1, paused: 1 });
    expect(res.body.entities).toBe(4);
    expect(res.body.ai.requests24h).toBe(2);
    expect(res.body.ai.tokens24h).toBe(15);
    expect(res.body.ai.successRate).toBe(50);
    expect(res.body.ai.hourly).toHaveLength(12);
    expect(res.body.recentErrors.length).toBeGreaterThanOrEqual(2);
  });
});

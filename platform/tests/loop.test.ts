/* 集成测试：真实引擎 + 真实网关（脚本化提供方）+ 平台服务 —— 方案 §38 最小商业闭环全链路 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import { startGatewayServer } from '../../world-engine/gateway/dist/index.js';
import type { GatewayProvider } from '../../world-engine/gateway/dist/index.js';
import {
  KeyStore,
  ModelRouter,
  createEngineClient,
  createGatewayClient,
  startPlatformServer,
} from '../src/index.ts';
import { ModelConfigStore } from '../src/admin/model-config.ts';
import { SecretStore } from '../src/admin/secrets.ts';
import { startManagedRuntime, type ManagedRuntime } from '../src/admin/managed-runtime.ts';
import { RevisionConflictError } from '../src/admin/errors.ts';

let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
let gatewayServer: Awaited<ReturnType<typeof startGatewayServer>>;
let platformServer: Awaited<ReturnType<typeof startPlatformServer>>;
let plaintextKey = '';
let readonlyKey = '';
let dataDir = '';

/* 脚本化提供方：记录收到的消息，返回带标记的固定回复（证明世界上下文真的流经了管线） */
const seenMessages: Array<{ role: string; content: string }>[] = [];
const scriptedProvider: GatewayProvider = {
  owner: 'scripted-test',
  models: ['narrative', 'npc', 'reasoning', 'memory'],
  complete: async (_model, messages) => {
    seenMessages.push(messages.map((m) => ({ role: m.role, content: m.content })));
    return '（scripted 回复）世界事实已注入。';
  },
};

beforeAll(async () => {
  /* 1) 真实引擎：注册表模式 + 预置世界 */
  const registry = createWorldRegistry();
  const world = registry.create({
    worldId: 'w-loop',
    playerName: '云生',
    startLoc: 'plaza',
    weather: 'sunny',
    savePort: new InMemoryWorldStorage(),
    definition: {
      locations: [{ id: 'plaza', type: 'urban' }],
      relations: [{ source: 'lita', target: 'borin', type: 'friend', value: 40 }],
    },
  });
  world.executeCommand({ type: 'spawn_entity', payload: { id: 'lita', name: '莉安', kind: 'npc', loc: 'plaza' } });
  world.executeCommand({ type: 'advance_time', amount: 6 });
  engineServer = await startWorldServer({ registry, port: 0 });

  /* 2) 真实网关：注册脚本化提供方（模型 = 能力通道） */
  gatewayServer = await startGatewayServer({ providers: [scriptedProvider], port: 0 });

  /* 3) 平台：临时数据目录 + 真实上游客户端 */
  dataDir = mkdtempSync(join(tmpdir(), 'platform-loop-'));
  const keys = new KeyStore(join(dataDir, 'keys.json'));
  plaintextKey = keys.create({ name: 'loop-test' }).plaintext;
  readonlyKey = keys.create({ name: 'readonly', permissions: ['chat:completions'] }).plaintext;
  keys.flush();
  ModelRouter.seedDefault(join(dataDir, 'router.json'));

  platformServer = await startPlatformServer({
    keys,
    engine: createEngineClient({ baseUrl: engineServer.url }),
    gateway: createGatewayClient({ baseUrl: gatewayServer.url }),
    router: new ModelRouter(join(dataDir, 'router.json')),
    port: 0,
    accessLog: false,
  });
});

afterAll(async () => {
  await platformServer?.close();
  await gatewayServer?.close();
  await engineServer?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${platformServer.url}${path}`, init).then(async (r) => ({
    status: r.status,
    headers: r.headers,
    body: await r.json().catch(() => null),
  }));

const authed = (extra: RequestInit = {}): RequestInit => ({
  ...extra,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${plaintextKey}`, ...(extra.headers ?? {}) },
});

describe('§38 最小商业闭环：API Key → Base URL → world-agent → World Runtime', () => {
  it('healthz 免鉴权可探活', async () => {
    const res = await api('/healthz');
    expect(res.status).toBe(200);
    expect((res.body as { service: string }).service).toBe('world-platform');
  });

  it('无 Key → 401；GET /v1/models 只暴露 world-agent', async () => {
    expect((await api('/v1/models')).status).toBe(401);

    const res = await api('/v1/models', authed());
    expect(res.status).toBe(200);
    const data = (res.body as { data: Array<{ id: string }> }).data;
    expect(data.map((m) => m.id)).toEqual(['world-agent']);
  });

  it('world-agent：OpenAI 格式请求 → 世界事实注入 → 网关通道 → OpenAI 格式响应', async () => {
    const res = await api(
      '/v1/chat/completions',
      authed({
        method: 'POST',
        body: JSON.stringify({
          model: 'world-agent',
          world: 'w-loop',
          messages: [{ role: 'user', content: '现在世界是什么状况？' }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('world-agent');
    expect(body.choices[0].message.content).toContain('scripted 回复');
    expect(body.platform.world_id).toBe('w-loop');
    expect(body.platform.capability).toBe('roleplay');
    expect(body.platform.model_used).toBe('npc'); // 缺省路由 roleplay → npc

    /* 上游收到 2 条消息：平台注入的 system（世界事实）+ 原始 user。
       注：引擎 spawn_entity 的 name 只落在事件 data，不进状态——
       上下文里 NPC 以 id 呈现（真实引擎行为的诚实投影）。 */
    expect(seenMessages.length).toBe(1);
    const sent = seenMessages[0];
    expect(sent[0].role).toBe('system');
    expect(sent[0].content).toContain('w-loop');
    expect(sent[0].content).toContain('lita'); // NPC id 进入上下文
    expect(sent.some((m) => m.content === '现在世界是什么状况？')).toBe(true);
  });

  it('worlds 公共 API：真实引擎数据（列表 / 命令 / 状态）', async () => {
    const list = await api('/v1/worlds', authed());
    expect(list.status).toBe(200);
    expect(
      (list.body as { worlds: Array<{ worldId: string }> }).worlds.map((w) => w.worldId),
    ).toContain('w-loop');

    const cmd = await api(
      '/v1/worlds/w-loop/commands',
      authed({
        method: 'POST',
        body: JSON.stringify({ type: 'advance_time', amount: 3 }),
      }),
    );
    expect(cmd.status).toBe(200);
    expect((cmd.body as { ok: boolean }).ok).toBe(true);

    const state = await api('/v1/worlds/w-loop/state', authed());
    expect(state.status).toBe(200);
    expect((state.body as { t: number }).t).toBe(25); // 引擎开局 t=16，+6（种子）+3（本测试）
  });

  it('权限隔离：无 worlds:write 的 Key 不能创建世界', async () => {
    const res = await fetch(`${platformServer.url}/v1/worlds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${readonlyKey}` },
      body: JSON.stringify({ worldId: 'w-hack' }),
    });
    expect(res.status).toBe(403);
  });

  it('Admin 层边界：501（Phase 4/9 落地）', async () => {
    const res = await api('/v1/admin/providers', authed());
    expect(res.status).toBe(501);
  });
});

/* ============================================================
   受管模式 E2E（Task 5 完成门槛）
   ------------------------------------------------------------
   两个可脚本化 OpenAI 兼容上游 + 一个固定 401 上游，覆盖：
   主模型成功 → 瞬时失败降级 fallback → 主备全挂显式报错 →
   凭证拒绝显式上报且不进冷却 → 重启后配置与凭证持久化 →
   过期 revision 无法覆盖 → 回滚恢复上一版本并热生效。
   ============================================================ */

interface E2EUpstream {
  url: string;
  hits: () => number;
  setMode: (m: 'ok' | 'fail') => void;
  close(): Promise<void>;
}

function startE2EUpstream(name: string, fixedStatus: number | null): Promise<E2EUpstream> {
  let mode: 'ok' | 'fail' = 'ok';
  let hits = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits += 1;
      const fail = fixedStatus !== null || mode === 'fail';
      const status = fixedStatus ?? (fail ? 500 : 200);
      res.writeHead(status, { 'content-type': 'application/json' });
      if (status === 200) {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `${name}-回复` } }] }));
      } else {
        res.end(JSON.stringify({ error: { message: `${name}-失败(status=${status})` } }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        hits: () => hits,
        setMode: (m) => {
          mode = m;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('受管模式 E2E（Task 5）：降级链 / 凭证拒绝 / 重启持久化 / 回滚', () => {
  let dir = '';
  let up1: E2EUpstream;
  let up2: E2EUpstream;
  let up401: E2EUpstream;
  let runtime: ManagedRuntime;
  const MASTER_KEY = 'loop-e2e-master-key';
  let secrets: SecretStore;
  let store: ModelConfigStore;
  let bootstrapKey: string;

  const chat = (capability?: string): Promise<{ status: number; body: any }> =>
    fetch(`${runtime.platformUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bootstrapKey}` },
      body: JSON.stringify({
        model: 'world-agent',
        ...(capability ? { capability } : {}),
        messages: [{ role: 'user', content: '说点什么' }],
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'managed-e2e-'));
    up1 = await startE2EUpstream('UP1', null);
    up2 = await startE2EUpstream('UP2', null);
    up401 = await startE2EUpstream('UP401', 401);

    secrets = new SecretStore(join(dir, 'secrets.json'), MASTER_KEY);
    store = new ModelConfigStore({
      filePath: join(dir, 'model-config.json'),
      secrets,
      endpointPolicy: { allowLoopback: true },
    });
    store.load();
    const keys = new KeyStore(join(dir, 'keys.json'), 'e2e-bootstrap');
    bootstrapKey = 'e2e-bootstrap';

    runtime = await startManagedRuntime({
      configStore: store,
      secrets,
      keys,
      engine: createEngineClient({ baseUrl: 'http://127.0.0.1:1' }),
      adminToken: 'e2e-admin',
      endpointPolicy: { allowLoopback: true },
      accessLog: false,
    });

    /* 建档（全部禁用）→ 凭证 → 启用 fast 链路 */
    let rev = runtime.config.revision;
    runtime.apply(
      {
        version: 1,
        providers: [
          { id: 'prov-1', name: 'one', endpoint: up1.url, auth: { kind: 'secret' }, enabled: false },
          { id: 'prov-2', name: 'two', endpoint: up2.url, auth: { kind: 'none' }, enabled: false },
          { id: 'prov-401', name: 'bad', endpoint: up401.url, auth: { kind: 'secret' }, enabled: false },
        ],
        models: [
          { id: 'mdl-1', providerId: 'prov-1', wireModel: 'wire-1', tags: ['fast'], enabled: false },
          { id: 'mdl-2', providerId: 'prov-2', wireModel: 'wire-2', tags: ['fast'], enabled: false },
          { id: 'mdl-401', providerId: 'prov-401', wireModel: 'wire-401', tags: ['narrative'], enabled: false },
        ],
        routes: {
          roleplay: { primary: null, fallback: null },
          narrative: { primary: null, fallback: null },
          reasoning: { primary: null, fallback: null },
          fast: { primary: null, fallback: null },
          cheap: { primary: null, fallback: null },
          memory: { primary: null, fallback: null },
        },
      },
      rev,
    );
    rev = runtime.applyCredential('prov-1', 'sk-prov1-secret').revision;
    rev = runtime.applyCredential('prov-401', 'sk-prov401-secret').revision;
    runtime.apply(
      {
        version: 1,
        providers: [
          { id: 'prov-1', name: 'one', endpoint: up1.url, auth: { kind: 'secret' }, enabled: true },
          { id: 'prov-2', name: 'two', endpoint: up2.url, auth: { kind: 'none' }, enabled: true },
          { id: 'prov-401', name: 'bad', endpoint: up401.url, auth: { kind: 'secret' }, enabled: false },
        ],
        models: [
          { id: 'mdl-1', providerId: 'prov-1', wireModel: 'wire-1', tags: ['fast'], enabled: true },
          { id: 'mdl-2', providerId: 'prov-2', wireModel: 'wire-2', tags: ['fast'], enabled: true },
          { id: 'mdl-401', providerId: 'prov-401', wireModel: 'wire-401', tags: ['narrative'], enabled: false },
        ],
        routes: {
          roleplay: { primary: null, fallback: null },
          narrative: { primary: null, fallback: null },
          reasoning: { primary: null, fallback: null },
          fast: { primary: 'mdl-1', fallback: 'mdl-2' },
          cheap: { primary: null, fallback: null },
          memory: { primary: null, fallback: null },
        },
      },
      rev,
    );
  }, 30_000);

  afterAll(async () => {
    await runtime?.close();
    await up1?.close();
    await up2?.close();
    await up401?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('主模型成功：world-agent → UP1', async () => {
    const res = await chat();
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('UP1-回复');
    expect(res.body.platform.model_used).toBe('mdl-1');
    expect(res.body.platform.fallback_used).toBe(false);
  });

  it('主模型瞬时失败 → fallback 接管（UP2）', async () => {
    up1.setMode('fail');
    const res = await chat();
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('UP2-回复');
    expect(res.body.platform.model_used).toBe('mdl-2');
    expect(res.body.platform.fallback_used).toBe(true);
  });

  it('主备全挂 → 显式 502 upstream_error（不假装成功）', async () => {
    up2.setMode('fail');
    const res = await chat();
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('upstream_error');
  });

  it('凭证被拒：显式 502 upstream_credential_rejected，且不进冷却（重复请求仍打主模型）', async () => {
    up1.setMode('ok');
    up2.setMode('ok');
    /* 启用 prov-401/mdl-401 并指派 narrative（凭证是坏的） */
    const rev = runtime.config.revision;
    runtime.apply(
      {
        version: 1,
        providers: [
          { id: 'prov-1', name: 'one', endpoint: up1.url, auth: { kind: 'secret' }, enabled: true },
          { id: 'prov-2', name: 'two', endpoint: up2.url, auth: { kind: 'none' }, enabled: true },
          { id: 'prov-401', name: 'bad', endpoint: up401.url, auth: { kind: 'secret' }, enabled: true },
        ],
        models: [
          { id: 'mdl-1', providerId: 'prov-1', wireModel: 'wire-1', tags: ['fast'], enabled: true },
          { id: 'mdl-2', providerId: 'prov-2', wireModel: 'wire-2', tags: ['fast'], enabled: true },
          { id: 'mdl-401', providerId: 'prov-401', wireModel: 'wire-401', tags: ['narrative'], enabled: true },
        ],
        routes: {
          roleplay: { primary: null, fallback: null },
          narrative: { primary: 'mdl-401', fallback: null },
          reasoning: { primary: null, fallback: null },
          fast: { primary: 'mdl-1', fallback: 'mdl-2' },
          cheap: { primary: null, fallback: null },
          memory: { primary: null, fallback: null },
        },
      },
      rev,
    );
    const before = up401.hits();
    const first = await chat('narrative');
    expect(first.status).toBe(502);
    expect(first.body.error.code).toBe('upstream_credential_rejected');
    expect(first.body.error.message).not.toContain('sk-prov401-secret');

    const second = await chat('narrative');
    expect(second.status).toBe(502);
    expect(second.body.error.code).toBe('upstream_credential_rejected');
    expect(up401.hits()).toBe(before + 2); /* 未冷却：每次都真实重试主模型 */
  });

  it('重启（新运行时实例）后：配置 revision、凭证与路由全部持久化', async () => {
    await runtime.close();
    const secrets2 = new SecretStore(join(dir, 'secrets.json'), MASTER_KEY);
    const store2 = new ModelConfigStore({
      filePath: join(dir, 'model-config.json'),
      secrets: secrets2,
      endpointPolicy: { allowLoopback: true },
    });
    store2.load();
    const keys2 = new KeyStore(join(dir, 'keys.json'), 'e2e-bootstrap');
    runtime = await startManagedRuntime({
      configStore: store2,
      secrets: secrets2,
      keys: keys2,
      engine: createEngineClient({ baseUrl: 'http://127.0.0.1:1' }),
      adminToken: 'e2e-admin',
      endpointPolicy: { allowLoopback: true },
      accessLog: false,
    });
    expect(runtime.config.revision).toBe(5);

    /* fast 路由仍在（冷却已随重启清零）→ UP1 */
    const res = await chat();
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('UP1-回复');
    secrets = secrets2;
    store = store2;
  });

  it('过期 revision 无法覆盖（乐观锁）', async () => {
    const stale = JSON.parse(JSON.stringify(runtime.config)) as Record<string, unknown>;
    expect(() => runtime.apply(stale, 1)).toThrow(RevisionConflictError);
    expect(runtime.config.revision).toBe(5);
  });

  it('回滚到上一版本：配置与密钥引用恢复，热生效（无需重启）', async () => {
    /* 当前 revision 5（prov-401 启用、narrative 指向坏凭证）→ 回滚恢复上一版本备份 */
    const restored = runtime.rollback(runtime.config.revision);
    expect(restored.revision).toBe(6); /* 回滚本身也是一次提交，revision 前进 */
    /* 上一版本备份 = revision 4：narrative 未指派、prov-401 未启用 */

    const narrative = await chat('narrative');
    expect(narrative.status).toBe(503);
    expect(narrative.body.error.code).toBe('no_model_configured');

    /* fast 链路（rev5 内容）照常工作：凭证引用回滚后仍可解析 */
    const fast = await chat();
    expect(fast.status).toBe(200);
    expect(fast.body.choices[0].message.content).toBe('UP1-回复');
  });
});

/* 集成测试：真实引擎 + 真实网关（脚本化提供方）+ 平台服务 —— 方案 §38 最小商业闭环全链路 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

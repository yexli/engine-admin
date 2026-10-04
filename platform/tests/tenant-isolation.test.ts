/* ============================================================
   平台租户隔离测试（V2.4 复审加固 · G2 在平台转发面的兑现）
   ------------------------------------------------------------
   引擎侧 owns() 隔离只在引擎装配钥匙表时生效；平台转发不带引擎
   凭证。本组测试钉死：游戏方钥匙（带 gameId）在平台公共口的可见域——
     ✓ GET /v1/worlds 清单只返回 ownerGame 匹配的世界
     ✓ POST /v1/worlds 建世界强制盖章 ownerGame = key.gameId
     ✓ 他游戏世界 / 未归属世界的一切访问 → 404（不泄露存在性）
     ✓ 引擎不可达 → 502（不可达不是授权答案）
     ✓ 管理钥匙（无 gameId）全域可见，行为不变
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore } from '../src/keys/keystore.ts';
import { ModelRouter } from '../src/router/modelrouter.ts';
import { createWorldPlatform } from '../src/http/protocol.ts';
import type { EngineClient, GatewayClient, PlatformRequest } from '../src/types.ts';

function fakeEngine(over: Partial<EngineClient> = {}): EngineClient {
  return {
    proxy: async (method, path) => ({ status: 200, body: { proxied: true, method, path } }),
    getState: async () => ({ ok: true, state: { worldId: 'w' } }),
    getEvents: async () => ({ ok: true, events: [] }),
    ...over,
  } as EngineClient;
}

const gatewayStub: GatewayClient = {
  chat: async () => ({ ok: true, text: 'ok' }),
  proxyChat: async () => ({ ok: true, status: 200, headers: {}, stream: new ReadableStream<Uint8Array>() }),
} as unknown as GatewayClient;

function setup(engine: EngineClient) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-tenant-'));
  const keys = new KeyStore(join(dir, 'keys.json'));
  const gameA = keys.create({ name: 'game-a', permissions: ['worlds:read', 'worlds:write'], gameId: 'game-a' });
  const gameB = keys.create({ name: 'game-b', permissions: ['worlds:read', 'worlds:write'], gameId: 'game-b' });
  const master = keys.create({ name: 'master', permissions: ['worlds:read', 'worlds:write'] });
  const platform = createWorldPlatform({
    keys,
    engine,
    gateway: gatewayStub,
    router: new ModelRouter(null),
    requestId: () => 'req-tenant',
  });
  const call = (method: string, path: string, token: string, body?: unknown, query: Record<string, string> = {}) =>
    platform
      .handle({ method, path, query, body, headers: { authorization: `Bearer ${token}` } } satisfies PlatformRequest)
      .then((r) => (r.kind === 'json' ? { status: r.status, body: r.body as any } : { status: r.status, body: '<stream>' }));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { call, gameA: gameA.plaintext, gameB: gameB.plaintext, master: master.plaintext, cleanup };
}

describe('平台租户隔离（V2.4 加固）', () => {
  it('清单过滤：游戏方钥匙只看到自己游戏的世界', async () => {
    const engine = fakeEngine({
      proxy: async (_method, path) =>
        path.startsWith('/v1/worlds') && !path.includes('/w-')
          ? {
              status: 200,
              body: {
                worlds: [
                  { worldId: 'a-1', ownerGame: 'game-a' },
                  { worldId: 'b-1', ownerGame: 'game-b' },
                  { worldId: 'free', ownerGame: undefined },
                ],
              },
            }
          : { status: 200, body: { proxied: true } },
    });
    const { call, gameA, cleanup } = setup(engine);
    const res = await call('GET', '/v1/worlds', gameA);
    expect(res.status).toBe(200);
    expect(res.body.worlds.map((w: { worldId: string }) => w.worldId)).toEqual(['a-1']);
    cleanup();
  });

  it('建世界盖章：客户端自报 ownerGame 被忽略，强制 key.gameId', async () => {
    let captured: unknown;
    const engine = fakeEngine({
      proxy: async (_method, _path, body) => {
        captured = body;
        return { status: 201, body: { worldId: 'w-new', ownerGame: 'game-a' } };
      },
    });
    const { call, gameA, cleanup } = setup(engine);
    const res = await call('POST', '/v1/worlds', gameA, { worldId: 'w-new', ownerGame: 'game-b' });
    expect(res.status).toBe(201);
    expect((captured as { ownerGame?: string }).ownerGame).toBe('game-a');
    cleanup();
  });

  it('世界域越权：他游戏世界与未归属世界一律 404，不泄露存在性', async () => {
    const engine = fakeEngine({
      proxy: async (_method, path) => {
        if (path === '/v1/worlds/b-1') return { status: 200, body: { worldId: 'b-1', ownerGame: 'game-b' } };
        if (path === '/v1/worlds/free') return { status: 200, body: { worldId: 'free' } };
        return { status: 200, body: { worldId: 'a-1', ownerGame: 'game-a' } };
      },
    });
    const { call, gameA, gameB, cleanup } = setup(engine);
    /* 自己的世界：放行 */
    expect((await call('GET', '/v1/worlds/a-1/state', gameA)).status).toBe(200);
    /* 他游戏的世界：404（引擎明明有，也不泄露） */
    const foreign = await call('GET', '/v1/worlds/b-1/state', gameA);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('world not found');
    /* 未归属（无 ownerGame）的遗留世界：对游戏方钥匙同样不可见 */
    expect((await call('GET', '/v1/worlds/free/state', gameA)).status).toBe(404);
    /* 写操作同样拦截 */
    expect((await call('POST', '/v1/worlds/b-1/commands', gameA, { type: 'move' })).status).toBe(404);
    /* 反向：gameB 看不见 gameA 的世界 */
    expect((await call('GET', '/v1/worlds/a-1/state', gameB)).status).toBe(404);
    cleanup();
  });

  it('不存在的世界：404（与越权同形，无枚举信号）', async () => {
    const engine = fakeEngine({
      proxy: async () => ({ status: 404, body: { error: 'world not found' } }),
    });
    const { call, gameA, cleanup } = setup(engine);
    expect((await call('GET', '/v1/worlds/ghost/state', gameA)).status).toBe(404);
    cleanup();
  });

  it('引擎不可达：502 如实上报（不可达不是授权答案）', async () => {
    const engine = fakeEngine({
      proxy: async () => ({ status: 502, body: { error: { message: 'World Engine 不可达', type: 'upstream_error' } } }),
    });
    const { call, gameA, cleanup } = setup(engine);
    const res = await call('GET', '/v1/worlds/any/state', gameA);
    expect(res.status).toBe(502);
    cleanup();
  });

  it('管理钥匙（无 gameId）：全域可见，转发行为不变', async () => {
    const engine = fakeEngine({
      proxy: async (_method, path) =>
        path === '/v1/worlds'
          ? { status: 200, body: { worlds: [{ worldId: 'a-1', ownerGame: 'game-a' }, { worldId: 'b-1', ownerGame: 'game-b' }] } }
          : { status: 200, body: { worldId: 'b-1', ownerGame: 'game-b' } },
    });
    const { call, master, cleanup } = setup(engine);
    const list = await call('GET', '/v1/worlds', master);
    expect(list.body.worlds).toHaveLength(2); /* 不过滤 */
    expect((await call('GET', '/v1/worlds/b-1/state', master)).status).toBe(200); /* 任意世界放行 */
    cleanup();
  });
});

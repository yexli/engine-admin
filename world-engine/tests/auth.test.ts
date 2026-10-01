/* ============================================================
   G2 · 多游戏托管（1.1.0）：HTTP 面 API Key 鉴权 —— 纯路由协议测试
   ------------------------------------------------------------
   · 缺省关：不传 auth，1.0 行为完全不变（兼容回归）；
   · 401：无钥匙 / 未知钥匙；x-api-key 与 Authorization: Bearer 皆可；
   · 403：只读钥匙碰写入类路由（建世界 / commands / time / pause / close）；
   · 可见域：游戏方钥匙只见 ownerGame 匹配的世界，越权 404 不泄露
     存在性；管理钥匙（无 gameId）全可见；无主世界只归管理钥匙；
   · 归属盖章：游戏方钥匙建世界强制打自己 gameId，冒名不生效。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { createWorldRegistry } from '../src/index';
import { createWorldHttp, type HttpRequest, type WorldAuthInit } from '../src/http/index';

/* 钥匙表：tq=天穹（读+写）/ nv=nova（只读）/ admin=平台管理（全可见） */
const auth: WorldAuthInit = {
  keys: {
    'tq-secret-key': { gameId: 'tianqiong', scopes: ['worlds:read', 'worlds:write'], name: '天穹' },
    'nv-readonly-key': { gameId: 'nova', name: 'nova 只读' },
    'admin-master-key': { name: '平台管理' },
  },
};

const req = (method: string, path: string, body?: unknown, key?: string): HttpRequest => ({
  method,
  path,
  body,
  ...(key ? { headers: { 'x-api-key': key } } : {}),
});

function authedHttp() {
  const registry = createWorldRegistry();
  const http = createWorldHttp({ registry, auth });
  return { registry, http };
}

/** 管理钥匙播种：两个已归属世界 + 一个无主世界（G2 前的存量形态） */
async function seedTwoGames() {
  const { http } = authedHttp();
  await http.handle(req('POST', '/v1/worlds', { worldId: 'w-tq', ownerGame: 'tianqiong' }, 'admin-master-key'));
  await http.handle(req('POST', '/v1/worlds', { worldId: 'w-nv', ownerGame: 'nova' }, 'admin-master-key'));
  await http.handle(req('POST', '/v1/worlds', { worldId: 'w-free' }, 'admin-master-key'));
  return { http };
}

const worldIds = (body: unknown): string[] =>
  (body as { worlds: { worldId: string }[] }).worlds.map((w) => w.worldId).sort();

describe('G2 · 鉴权关闭 = 1.0 行为', () => {
  it('不传 auth：无钥匙照常读写（兼容回归）', async () => {
    const registry = createWorldRegistry();
    const http = createWorldHttp({ registry });
    expect((await http.handle(req('POST', '/v1/worlds', { worldId: 'w-a' }))).status).toBe(201);
    expect((await http.handle(req('GET', '/v1/worlds'))).status).toBe(200);
    expect((await http.handle(req('POST', '/v1/worlds/w-a/commands', { type: 'move', targetId: 'market' }))).status).toBe(200);
  });
});

describe('G2 · 401 认证闸门', () => {
  it('无钥匙 / 未知钥匙 → 401；有效钥匙（x-api-key 或 Bearer）→ 200', async () => {
    const { http } = authedHttp();
    expect((await http.handle(req('GET', '/v1/worlds'))).status).toBe(401);
    expect((await http.handle(req('GET', '/v1/worlds', undefined, 'bogus-key'))).status).toBe(401);
    expect((await http.handle(req('GET', '/v1/worlds', undefined, 'admin-master-key'))).status).toBe(200);

    /* Bearer 等价通道 */
    const bearer = await http.handle({
      method: 'GET',
      path: '/v1/worlds',
      headers: { authorization: 'Bearer admin-master-key' },
    });
    expect(bearer.status).toBe(200);
  });
});

describe('G2 · 403 写权限（worlds:write）', () => {
  it('只读钥匙：读全通；建世界/命令/推进/暂停/关闭 → 403 need worlds:write', async () => {
    const { http } = await seedTwoGames();
    const K = 'nv-readonly-key';

    /* 读不受限（本方世界内） */
    expect((await http.handle(req('GET', '/v1/worlds', undefined, K))).status).toBe(200);
    expect((await http.handle(req('GET', '/v1/worlds/w-nv', undefined, K))).status).toBe(200);
    expect((await http.handle(req('GET', '/v1/worlds/w-nv/events', undefined, K))).status).toBe(200);

    const create = await http.handle(req('POST', '/v1/worlds', { worldId: 'w-x' }, K));
    expect(create.status).toBe(403);
    expect((create.body as { need?: string }).need).toBe('worlds:write');

    expect((await http.handle(req('POST', '/v1/worlds/w-nv/commands', { type: 'move', targetId: 'market' }, K))).status).toBe(403);
    expect((await http.handle(req('POST', '/v1/worlds/w-nv/time', { ticks: 1 }, K))).status).toBe(403);
    expect((await http.handle(req('POST', '/v1/worlds/w-nv/pause', undefined, K))).status).toBe(403);
    expect((await http.handle(req('DELETE', '/v1/worlds/w-nv', undefined, K))).status).toBe(403);

    /* 带写权限的管理钥匙同样动作 → 通 */
    const cmd = await http.handle(req('POST', '/v1/worlds/w-nv/commands', { type: 'move', targetId: 'market' }, 'admin-master-key'));
    expect(cmd.status).toBe(200);
    expect((cmd.body as { ok: boolean }).ok).toBe(true);
  });
});

describe('G2 · 世界可见域隔离', () => {
  it('游戏方钥匙只见自己游戏的世界；越权访问 404；无主世界只归管理钥匙', async () => {
    const { http } = await seedTwoGames();

    /* 列表隔离 */
    expect(worldIds((await http.handle(req('GET', '/v1/worlds', undefined, 'tq-secret-key'))).body)).toEqual(['w-tq']);
    expect(worldIds((await http.handle(req('GET', '/v1/worlds', undefined, 'nv-readonly-key'))).body)).toEqual(['w-nv']);
    expect(worldIds((await http.handle(req('GET', '/v1/worlds', undefined, 'admin-master-key'))).body)).toEqual(['w-free', 'w-nv', 'w-tq']);

    /* 越权单世界访问 → 404（不泄露存在性；顺序在写权限检查之前） */
    expect((await http.handle(req('GET', '/v1/worlds/w-nv', undefined, 'tq-secret-key'))).status).toBe(404);
    expect((await http.handle(req('GET', '/v1/worlds/w-tq', undefined, 'nv-readonly-key'))).status).toBe(404);
    /* 无主世界对游戏方钥匙不存在 */
    expect((await http.handle(req('GET', '/v1/worlds/w-free', undefined, 'tq-secret-key'))).status).toBe(404);
  });

  it('?game= 过滤（管理台按方聚合）；归属盖章：游戏方钥匙建世界强制打自己 gameId', async () => {
    const { http } = authedHttp();

    await http.handle(req('POST', '/v1/worlds', { worldId: 'w-tq', ownerGame: 'tianqiong' }, 'admin-master-key'));
    await http.handle(req('POST', '/v1/worlds', { worldId: 'w-nv', ownerGame: 'nova' }, 'admin-master-key'));

    /* ?game= 过滤（管理钥匙视角；query 是协议的独立字段） */
    const only = await http.handle({
      method: 'GET',
      path: '/v1/worlds',
      query: { game: 'tianqiong' },
      headers: { 'x-api-key': 'admin-master-key' },
    });
    expect(worldIds(only.body)).toEqual(['w-tq']);

    /* 游戏方钥匙建世界：ownerGame 强制为自己的 gameId（冒名 nova 不生效） */
    const forged = await http.handle(req('POST', '/v1/worlds', { worldId: 'w-forged', ownerGame: 'nova' }, 'tq-secret-key'));
    expect(forged.status).toBe(201);
    expect((forged.body as { ownerGame?: string }).ownerGame).toBe('tianqiong');

    /* 盖章后立刻进入本方可见域 */
    expect(worldIds((await http.handle(req('GET', '/v1/worlds', undefined, 'tq-secret-key'))).body)).toEqual(['w-forged', 'w-tq']);
  });
});

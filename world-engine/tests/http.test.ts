/* World HTTP（V0.4→V0.9）：两层验证
   ① 协议适配器：纯路由测试（单世界兼容 + V0.9 注册表多世界）
   ② 真实服务器：node:http + fetch 打 127.0.0.1 临时端口的端到端 */
import { afterEach, describe, expect, it } from 'vitest';
import { createWorld, createWorldRegistry } from '../src/index';
import { createWorldHttp, startWorldServer, type HttpRequest } from '../src/http/index';

const get = (path: string, query?: Record<string, string>): HttpRequest => ({ method: 'GET', path, query });
const post = (path: string, body?: unknown): HttpRequest => ({ method: 'POST', path, body });

describe('HTTP 协议适配器（纯路由 · 单世界模式兼容）', () => {
  it('POST /v1/worlds 创建 → 201；重复创建 → 409；GET 清单单元素', async () => {
    const http = createWorldHttp();
    const created = await http.handle(post('/v1/worlds', { worldId: 'w-1', playerName: '旅人' }));
    expect(created.status).toBe(201);
    expect((created.body as { worldId: string }).worldId).toBe('w-1');

    const again = await http.handle(post('/v1/worlds', { worldId: 'w-2' }));
    expect(again.status).toBe(409);

    const list = await http.handle(get('/v1/worlds'));
    expect((list.body as { worlds: unknown[] }).worlds).toHaveLength(1);
  });

  it('GET state / GET info / GET events?n 与引擎同源', async () => {
    const world = createWorld({ worldId: 'w-2' });
    const http = createWorldHttp({ world });
    world.executeCommand({ type: 'move', targetId: 'forest' });

    expect((await http.handle(get('/v1/worlds/w-2/state'))).status).toBe(200);
    expect(((await http.handle(get('/v1/worlds/w-2/state'))).body as { player: { loc: string } }).player.loc).toBe('forest');

    const info = await http.handle(get('/v1/worlds/w-2'));
    expect((info.body as { location: string }).location).toBe('forest');

    world.advanceTime(2);
    const events = await http.handle(get('/v1/worlds/w-2/events', { n: '1' }));
    expect((events.body as { events: unknown[] }).events).toHaveLength(1);
  });

  it('POST commands：合法命令 200+ok；无 type 的载荷 400；世界不存在 404', async () => {
    const http = createWorldHttp({ createOptions: { worldId: 'w-3' } });
    /* 未创建世界 → 404（懒创建：只有 POST /v1/worlds 会建） */
    expect((await http.handle(post('/v1/worlds/w-3/commands', { type: 'move', targetId: 'x' }))).status).toBe(404);

    await http.handle(post('/v1/worlds', { worldId: 'w-3' }));
    const ok = await http.handle(post('/v1/worlds/w-3/commands', { type: 'move', targetId: 'market' }));
    expect(ok.status).toBe(200);
    expect((ok.body as { ok: boolean }).ok).toBe(true);
    expect(((await http.handle(get('/v1/worlds/w-3/state'))).body as { player: { loc: string } }).player.loc).toBe('market');

    expect((await http.handle(post('/v1/worlds/w-3/commands', { nope: 1 }))).status).toBe(400);
    expect((await http.handle(post('/v1/worlds/other/commands', { type: 'move' }))).status).toBe(404);
  });

  it('POST time：正数推进；非法载荷 400', async () => {
    const world = createWorld({ worldId: 'w-4' });
    const http = createWorldHttp({ world });
    const t0 = world.getState()!.t;
    const r = await http.handle(post('/v1/worlds/w-4/time', { ticks: 5 }));
    expect(r.status).toBe(200);
    expect(world.getState()!.t).toBe(t0 + 5);
    expect((await http.handle(post('/v1/worlds/w-4/time', { ticks: 0 }))).status).toBe(400);
    expect((await http.handle(post('/v1/worlds/w-4/time', { ticks: 'many' }))).status).toBe(400);
  });

  it('命令载荷净化：未知键与嵌套结构截在门口；超长 type → 400', async () => {
    const world = createWorld({ worldId: 'w-san' });
    const http = createWorldHttp({ world });

    const r = await http.handle(
      post('/v1/worlds/w-san/commands', {
        type: 'spawn_entity',
        evil: 'x'.repeat(5000),
        targetId: 'y'.repeat(9999),
        payload: {
          id: 'lita',
          name: '莉安',
          kind: 'npc',
          nested: { deep: '结构不放行' },
        },
      }),
    );
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    expect(world.query.get_entity('lita')?.met).toBe(false);

    const bad = await http.handle(post('/v1/worlds/w-san/commands', { type: 'x'.repeat(100) }));
    expect(bad.status).toBe(400);
  });

  it('创建参数净化：worldId/labels 白名单化（未知键与坏形状不透传）', async () => {
    const http = createWorldHttp();
    const r = await http.handle(
      post('/v1/worlds', {
        worldId: 'w-clean',
        rules: '不应该被透传',
        labels: { months: '不是数组', baseYear: 2077, daysPerMonth: 20 },
      }),
    );
    expect(r.status).toBe(201);
    const t = http.world!.query.get_time()!;
    expect(t.year).toBe(2077);
  });

  it('未知路由 404；方法不对 405；id 不匹配 404', async () => {
    const world = createWorld({ worldId: 'w-5' });
    const http = createWorldHttp({ world });
    expect((await http.handle(get('/nope'))).status).toBe(404);
    expect((await http.handle(get('/v1/worlds/w-5/state'))).status).toBe(200);
    expect((await http.handle(post('/v1/worlds/w-5/state'))).status).toBe(405);
    expect((await http.handle(get('/v1/worlds/not-this-world'))).status).toBe(404);
    expect((await http.handle(get('/v1/worlds/w-5/banana'))).status).toBe(404);
  });
});

describe('V0.9 · 注册表模式（多世界共存，DR-003 兑现）', () => {
  it('POST /v1/worlds 可多次（每世界独立作用域）；{id} 为真实路由键', async () => {
    const registry = createWorldRegistry();
    const http = createWorldHttp({ registry });

    expect((await http.handle(post('/v1/worlds', { worldId: 'alpha', playerName: 'A' }))).status).toBe(201);
    expect((await http.handle(post('/v1/worlds', { worldId: 'beta', playerName: 'B' }))).status).toBe(201);

    /* 各走各的命令，互不可见 */
    await http.handle(post('/v1/worlds/alpha/commands', { type: 'move', targetId: 'forest' }));
    await http.handle(post('/v1/worlds/beta/commands', { type: 'move', targetId: 'market' }));

    const aState = (await http.handle(get('/v1/worlds/alpha/state'))).body as { player: { loc: string } };
    const bState = (await http.handle(get('/v1/worlds/beta/state'))).body as { player: { loc: string } };
    expect(aState.player.loc).toBe('forest');
    expect(bState.player.loc).toBe('market');

    const list = await http.handle(get('/v1/worlds'));
    expect((list.body as { worlds: unknown[] }).worlds).toHaveLength(2);
    expect((await http.handle(get('/v1/worlds/gamma'))).status).toBe(404);
  });

  it('POST /v1/worlds 支持 locations（P2 additive）：地点表物化、可查询、坏条目净化', async () => {
    const registry = createWorldRegistry();
    const http = createWorldHttp({ registry });

    const created = await http.handle(
      post('/v1/worlds', {
        worldId: 'w-locs',
        playerName: '旅人',
        startLoc: 'village',
        locations: [
          { id: 'village', name: '村庄' },
          { id: 'tavern', type: 'building', name: '米露的酒馆' },
          { id: 'shop', name: '杂货商店' },
          { id: '', name: '坏地点被截下' },
          '不是对象也截下',
        ],
      }),
    );
    expect(created.status).toBe(201);

    const body = (await http.handle(get('/v1/worlds/w-locs/locations'))).body as {
      total: number;
      locations: { id: string; type?: string; attributes?: Record<string, unknown>; occupants?: string[] }[];
    };
    expect(body.total).toBe(3); /* 坏条目被净化截下 */
    const byId = new Map(body.locations.map((l) => [l.id, l]));
    expect(byId.get('village')?.attributes?.['desc']).toBe('村庄'); /* 与 G1 种子同约定：name → desc */
    expect(byId.get('tavern')?.type).toBe('building');
    expect(byId.get('shop')?.type).toBe('urban'); /* 缺省类型 */
    expect(byId.get('village')?.occupants).toContain('player:旅人'); /* 驻留统计照常派生 */
  });
});

describe('真实服务器端到端（node:http + fetch）', () => {
  const servers: Awaited<ReturnType<typeof startWorldServer>>[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  it('端到端：创建 → 命令 → 状态 → 事件（127.0.0.1 临时端口）', async () => {
    const server = await startWorldServer({ port: 0, createOptions: { worldId: 'e2e' } });
    servers.push(server);
    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
    const base = server.url;

    const created = await fetch(`${base}/v1/worlds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerName: '网上旅人' }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { worldId: string }).worldId).toBe('e2e');

    expect((await fetch(`${base}/v1/worlds`, { method: 'POST', body: '{}' })).status).toBe(409);

    const cmd = await fetch(`${base}/v1/worlds/e2e/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'move', targetId: 'docks' }),
    });
    expect(((await cmd.json()) as { ok: boolean }).ok).toBe(true);

    const state = await (await fetch(`${base}/v1/worlds/e2e/state`)).json();
    expect((state as { player: { loc: string } }).player.loc).toBe('docks');

    await fetch(`${base}/v1/worlds/e2e/time`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticks: 3 }),
    });
    const events = (await (await fetch(`${base}/v1/worlds/e2e/events?n=5`)).json()) as { events: { type: string }[] };
    expect(events.events.some((e) => e.type === 'time_advanced')).toBe(true);

    expect((await fetch(`${base}/v1/worlds/e2e/commands`, { method: 'POST', body: '{oops' })).status).toBe(400);
  });

  it('安全基线：默认只绑 127.0.0.1', async () => {
    const server = await startWorldServer({ port: 0 });
    servers.push(server);
    expect(server.url).toContain('127.0.0.1');
  });
});

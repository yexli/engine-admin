/* M1 只读数据面（G2/G3/G4/G5）：协议适配器纯路由测试 + 端到端
   scheduler / entities / locations / relations / commands 历史 / 世界元数据 */
import { afterEach, describe, expect, it } from 'vitest';
import { createWorld, createWorldRegistry, type WorldHandle } from '../src/index';
import { createWorldHttp, startWorldServer, type HttpRequest } from '../src/http/index';
import type { EngineWorldState } from '../src/types';

const get = (path: string, query?: Record<string, string>): HttpRequest => ({ method: 'GET', path, query });
const post = (path: string, body?: unknown): HttpRequest => ({ method: 'POST', path, body });

/** 种一个带地点/实体/关系的小世界（协议测试共用） */
function seedWorld(worldId: string): WorldHandle<EngineWorldState> {
  const w = createWorld<EngineWorldState>({
    worldId,
    playerName: '云生',
    startLoc: 'plaza',
    definition: {
      locations: [
        { id: 'plaza', type: 'urban', attributes: { desc: '中央广场' } },
        { id: 'tavern', type: 'building' },
      ],
      entities: [
        { id: 'lita', name: '莉安', type: 'character', location: 'tavern' },
        { id: 'borin', name: '波林', type: 'character', location: 'plaza' },
        { id: 'cart', type: 'vehicle', location: 'plaza' },
      ],
      relations: [{ source: 'lita', target: 'borin', type: 'friend', value: 40 }],
    },
  });
  return w;
}

describe('M1.5 · 世界元数据（G2）', () => {
  it('POST /v1/worlds 带 name/description → info 回读；列表同样携带', async () => {
    const registry = createWorldRegistry();
    const http = createWorldHttp({ registry });
    const created = await http.handle(post('/v1/worlds', { worldId: 'w-meta', name: '主世界', description: '演示用' }));
    expect(created.status).toBe(201);
    const body = created.body as { name?: string; description?: string; createdAt?: string; updatedAt?: string };
    expect(body.name).toBe('主世界');
    expect(body.description).toBe('演示用');
    expect(body.createdAt).toBeTruthy();
    expect(body.updatedAt).toBe(body.createdAt);

    const one = (await http.handle(get('/v1/worlds/w-meta'))).body as { name?: string };
    expect(one.name).toBe('主世界');
    const list = (await http.handle(get('/v1/worlds'))).body as { worlds: { name?: string }[] };
    expect(list.worlds[0].name).toBe('主世界');
  });

  it('活动时间戳：成功的命令/推进刷新 updatedAt；被拒命令不刷新', async () => {
    const registry = createWorldRegistry();
    const http = createWorldHttp({ registry });
    await http.handle(post('/v1/worlds', { worldId: 'w-touch' }));
    const before = (await http.handle(get('/v1/worlds/w-touch'))).body as { createdAt?: string; updatedAt?: string };

    /* 被拒：无规则处理 → updatedAt 不动 */
    await http.handle(post('/v1/worlds/w-touch/commands', { type: 'no_such_cmd' }));
    const afterReject = (await http.handle(get('/v1/worlds/w-touch'))).body as { updatedAt?: string };
    expect(afterReject.updatedAt).toBe(before.updatedAt);

    /* 成功：move → updatedAt 被刷新 */
    await new Promise((r) => setTimeout(r, 5));
    await http.handle(post('/v1/worlds/w-touch/commands', { type: 'move', targetId: 'market' }));
    const afterMove = (await http.handle(get('/v1/worlds/w-touch'))).body as { updatedAt?: string };
    expect(afterMove.updatedAt !== before.updatedAt).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    await http.handle(post('/v1/worlds/w-touch/time', { ticks: 2 }));
    const afterTime = (await http.handle(get('/v1/worlds/w-touch'))).body as { updatedAt?: string };
    expect(afterTime.updatedAt !== afterMove.updatedAt).toBe(true);
  });

  it('未带元数据的既有世界：字段缺省不炸（向后兼容）', async () => {
    const w = createWorld({ worldId: 'w-legacy' });
    const http = createWorldHttp({ world: w });
    const info = (await http.handle(get('/v1/worlds/w-legacy'))).body as { name?: string; createdAt?: string };
    expect(info.name).toBeUndefined();
    expect(info.createdAt).toBeUndefined();
  });
});

describe('M1.2 · 调度观测（G4）', () => {
  it('GET /v1/worlds/{id}/scheduler：stats + scheduled（定时）+ deadLetters', async () => {
    const w = seedWorld('w-sched');
    const http = createWorldHttp({ world: w });

    /* 定时事件：3 天后到期 */
    const ev = w.events.makeEvent({ type: 'harvest_due', day: 2, tick: 0 });
    w.bus.schedule(ev, 3);

    /* 死信：因果链超深 */
    w.bus.emit(w.events.makeEvent({ type: 'too_deep', day: 1, tick: 0 }), { chainDepth: 9 });

    const res = await http.handle(get('/v1/worlds/w-sched/scheduler'));
    expect(res.status).toBe(200);
    const body = res.body as {
      stats: { subscribers: number; scheduled: number; deadLetters: number; tickEmitted: number; deferred: number };
      scheduled: { dueDay: number; event: { type: string } }[];
      deferred: unknown[];
      deadLetters: { type: string }[];
    };
    expect(body.stats.scheduled).toBe(1);
    expect(body.stats.deadLetters).toBe(1);
    expect(body.scheduled).toHaveLength(1);
    expect(body.scheduled[0].dueDay).toBe(5); // day 2 + delay 3
    expect(body.scheduled[0].event.type).toBe('harvest_due');
    expect(body.deadLetters[0].type).toBe('too_deep');
    expect(body.deferred).toEqual([]);
  });

  it('世界不存在 → 404', async () => {
    const http = createWorldHttp({ world: createWorld({ worldId: 'w-x' }) });
    expect((await http.handle(get('/v1/worlds/other/scheduler'))).status).toBe(404);
  });
});

describe('M1.3 · 实体/地点/关系独立端点（G3）', () => {
  it('GET entities：分页 + type 筛选 + q 前缀 + player 概要', async () => {
    const w = seedWorld('w-ent');
    const http = createWorldHttp({ world: w });

    const all = (await http.handle(get('/v1/worlds/w-ent/entities'))).body as {
      total: number;
      page: number;
      pageSize: number;
      player: { name: string; loc: string } | null;
      entities: { id: string; type: string; location: string }[];
    };
    expect(all.total).toBe(3);
    expect(all.entities.map((e) => e.id)).toEqual(['borin', 'cart', 'lita']); // id 序稳定分页
    expect(all.player).toEqual({ name: '云生', loc: 'plaza', bagCount: 0 });
    expect(all.entities.find((e) => e.id === 'lita')!.location).toBe('tavern'); // 档案 location 单列

    const paged = (await http.handle(get('/v1/worlds/w-ent/entities', { page: '2', pageSize: '1' }))).body as {
      total: number;
      entities: { id: string }[];
    };
    expect(paged.total).toBe(3);
    expect(paged.entities.map((e) => e.id)).toEqual(['cart']);

    const typed = (await http.handle(get('/v1/worlds/w-ent/entities', { type: 'character' }))).body as {
      total: number;
      entities: { id: string }[];
    };
    expect(typed.total).toBe(2);
    expect(typed.entities.every((e) => ['lita', 'borin'].includes(e.id))).toBe(true);

    const q = (await http.handle(get('/v1/worlds/w-ent/entities', { q: 'LI' }))).body as { total: number };
    expect(q.total).toBe(1);
  });

  it('GET entities/{eid}：详情含关系边；未知实体 404', async () => {
    const w = seedWorld('w-det');
    /* rels 邻接表是宿主侧字段：容器种子（组合根路径）；按声明形状播单边 */
    w.container.core.S!.npcs['lita'].rels = { borin: { type: 'friend', val: 40 } };
    const http = createWorldHttp({ world: w });

    const res = await http.handle(get('/v1/worlds/w-det/entities/lita'));
    expect(res.status).toBe(200);
    const body = res.body as {
      entity: { id: string; type: string; memCount: number; raw: { att: number } };
      relations: { source: string; target: string; type: string; value: number }[];
    };
    expect(body.entity.id).toBe('lita');
    expect(body.entity.type).toBe('character');
    expect(body.entity.raw.att).toBe(0);
    expect(body.relations).toEqual([{ source: 'lita', target: 'borin', type: 'friend', value: 40 }]);

    expect((await http.handle(get('/v1/worlds/w-det/entities/ghost'))).status).toBe(404);
  });

  it('GET locations：驻留统计 + 地点表之外的位置告警', async () => {
    const w = seedWorld('w-loc');
    w.container.core.S!.npcs['borin'].attributes = { location: 'nowhere' }; // 不在地点表
    const http = createWorldHttp({ world: w });

    const res = await http.handle(get('/v1/worlds/w-loc/locations'));
    expect(res.status).toBe(200);
    const body = res.body as {
      total: number;
      locations: { id: string; occupants: string[]; entityCount: number }[];
      unknown: string[];
    };
    expect(body.total).toBe(2);
    const plaza = body.locations.find((l) => l.id === 'plaza')!;
    expect(plaza.entityCount).toBe(2); // player + borin? 否——borin 在 nowhere；= player + cart
    expect(plaza.occupants.some((o) => o.startsWith('player:'))).toBe(true);
    const tavern = body.locations.find((l) => l.id === 'tavern')!;
    expect(tavern.occupants).toEqual(['lita']);
    expect(body.unknown).toEqual(['nowhere']);
  });

  it('GET relations：状态关系表 + 实体关系边双视图', async () => {
    const w = seedWorld('w-rel');
    const http = createWorldHttp({ world: w });
    await http.handle(post('/v1/worlds/w-rel/commands', { type: 'set_relation', targetId: 'borin', payload: { type: 'ally', value: 10 } }));
    w.container.core.S!.npcs['lita'].rels = { borin: { type: 'friend', val: 40 } };

    const res = await http.handle(get('/v1/worlds/w-rel/relations'));
    expect(res.status).toBe(200);
    const body = res.body as {
      totals: { state: number; edges: number };
      stateRelations: { source: string; target: string; type: string }[];
      edgeRelations: { source: string; target: string; type: string; value: number }[];
    };
    expect(body.totals).toEqual({ state: 2, edges: 1 }); // definition lita→borin + 命令新增 player→borin
    expect(body.stateRelations.some((r) => r.source === 'player' && r.type === 'ally')).toBe(true);
    expect(body.edgeRelations).toEqual([{ source: 'lita', target: 'borin', type: 'friend', value: 40 }]);

    const q = (await http.handle(get('/v1/worlds/w-rel/relations', { q: 'ally' }))).body as { totals: { state: number } };
    expect(q.totals.state).toBe(1);
  });
});

describe('M1.4 · 命令历史（G5）', () => {
  it('GET commands?n：新 → 旧；含被拒命令与快照', async () => {
    const w = seedWorld('w-hist');
    const http = createWorldHttp({ world: w });

    await http.handle(post('/v1/worlds/w-hist/commands', { type: 'move', targetId: 'tavern' }));
    await http.handle(post('/v1/worlds/w-hist/commands', { type: 'no_such_cmd' }));
    await http.handle(post('/v1/worlds/w-hist/commands', { type: 'advance_time', amount: 4 }));

    const res = await http.handle(get('/v1/worlds/w-hist/commands', { n: '2' }));
    expect(res.status).toBe(200);
    const body = res.body as { total: number; commands: { seq: number; command: { type: string }; ok: boolean; reason?: string; at: string; tick: number }[] };
    expect(body.total).toBe(2); // 窗口 = n
    expect(body.commands[0].command.type).toBe('advance_time'); // 新 → 旧
    expect(body.commands[0].ok).toBe(true);
    expect(body.commands[1].ok).toBe(false);
    expect(body.commands[1].reason).toContain('没有规则处理命令');
    expect(body.commands[0].at).toBeTruthy();

    const all = (await http.handle(get('/v1/worlds/w-hist/commands'))).body as { total: number; commands: unknown[] };
    expect(all.total).toBe(3);
    expect(all.commands).toHaveLength(3);
  });

  it('快照隔离：历史里的命令不受后续对象改动影响', async () => {
    const w = createWorld({ worldId: 'w-snap' });
    const http = createWorldHttp({ world: w });
    const cmd = { type: 'move', targetId: 'a' };
    await http.handle(post('/v1/worlds/w-snap/commands', cmd));
    cmd.targetId = 'b'; // 外部改动不得渗入留痕
    const body = (await http.handle(get('/v1/worlds/w-snap/commands'))).body as { commands: { command: { targetId?: string } }[] };
    expect(body.commands[0].command.targetId).toBe('a');
  });
});

describe('M1 新端点端到端（node:http + fetch）', () => {
  const servers: Awaited<ReturnType<typeof startWorldServer>>[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  it('端到端：meta 创建 → entities → scheduler → commands 历史', async () => {
    /* registry 模式 = isolated 作用域：bus 统计不受其它用例的全局缺省总线影响 */
    const server = await startWorldServer({ port: 0, registry: createWorldRegistry() });
    servers.push(server);
    const base = server.url;

    /* 懒创建：注册表模式必须带 worldId */
    await fetch(`${base}/v1/worlds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: 'e2e-m1' }) });

    /* 无元数据创建；命令后 updatedAt 出现 */
    await fetch(`${base}/v1/worlds/e2e-m1/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'move', targetId: 'docks' }),
    });
    const info = (await (await fetch(`${base}/v1/worlds/e2e-m1`)).json()) as { updatedAt?: string; createdAt?: string };
    expect(info.updatedAt).toBeTruthy();

    const entities = (await (await fetch(`${base}/v1/worlds/e2e-m1/entities?page=1&pageSize=5`)).json()) as { total: number; player: { loc: string } };
    expect(entities.total).toBe(0);
    expect(entities.player.loc).toBe('docks');

    const sched = (await (await fetch(`${base}/v1/worlds/e2e-m1/scheduler`)).json()) as { stats: { scheduled: number } };
    expect(sched.stats.scheduled).toBe(0);

    const hist = (await (await fetch(`${base}/v1/worlds/e2e-m1/commands?n=10`)).json()) as { commands: { command: { type: string } }[] };
    expect(hist.commands).toHaveLength(1);
    expect(hist.commands[0].command.type).toBe('move');
  });

  it('端到端（registry 模式）：创建带 meta 的世界并读取元数据', async () => {
    const registry = createWorldRegistry();
    const server = await startWorldServer({ port: 0, registry });
    servers.push(server);

    const created = await fetch(`${server.url}/v1/worlds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worldId: 'w-http-meta', name: '网元世界', description: '端到端' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { name?: string; createdAt?: string };
    expect(body.name).toBe('网元世界');
    expect(body.createdAt).toBeTruthy();
  });
});

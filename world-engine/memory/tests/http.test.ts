/* M1.1 · Memory HTTP（G7）：纯路由协议 + 真实服务器端到端 */
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryEngine } from '../src/engine';
import { InMemoryMemoryStorage } from '../src/storage';
import { createMemoryHttp, startMemoryServer, type HttpRequest } from '../src/http/index';

const get = (path: string, query?: Record<string, string>): HttpRequest => ({ method: 'GET', path, query });
const post = (path: string, body?: unknown): HttpRequest => ({ method: 'POST', path, body });

function fixtureStores() {
  const worldEvents = new MemoryEngine({ save: new InMemoryMemoryStorage() });
  worldEvents.ingestFact({
    id: 'ev-1',
    type: 'talk',
    day: 3,
    actor: 'lita',
    target: 'player',
    location: 'tavern',
    witnesses: ['lita', 'borin'],
  });
  worldEvents.remember({ ownerId: 'lita', text: '铁匠对玩家的态度转为中立，倾向于交易武器', day: 3, kind: 'observation', importance: 0.6 });
  worldEvents.remember({ ownerId: 'borin', text: '黑松森林深处出现过狼嚎', day: 4, kind: 'observation', importance: 0.4 });

  const personas = new MemoryEngine({ save: new InMemoryMemoryStorage() });
  personas.remember({ ownerId: 'lita', text: '喜欢搜集旧硬币', day: 2, kind: 'preference', importance: 0.5 });

  return [
    { name: 'world-events', engine: worldEvents, description: '世界事实摄取' },
    { name: 'npc-personas', engine: personas, description: 'NPC 人格', embed: { name: 'text-embedding-demo', dimension: 768 } },
  ];
}

describe('Memory HTTP 协议（纯路由）', () => {
  it('GET /v1/memory/stores：清单 + 真实统计', async () => {
    const http = createMemoryHttp({ stores: fixtureStores() });
    const res = await http.handle(get('/v1/memory/stores'));
    expect(res.status).toBe(200);
    const body = res.body as {
      stores: { id: string; documentCount: number; stats: { total: number; owners: number }; embed: { attached: boolean; dimension?: number } }[];
    };
    expect(body.stores).toHaveLength(2);
    const we = body.stores.find((s) => s.id === 'world-events')!;
    /* ingestFact 两个目击者各记一条 + remember 两条（lita / borin） */
    expect(we.stats.total).toBe(4);
    expect(we.stats.owners).toBe(2);
    expect(we.embed.attached).toBe(false);
    const persona = body.stores.find((s) => s.id === 'npc-personas')!;
    expect(persona.embed.attached).toBe(true);
    expect(persona.embed.dimension).toBe(768);
  });

  it('GET /v1/memory/records：分页 + store/entity/type/q 筛选 + 行形状', async () => {
    const http = createMemoryHttp({ stores: fixtureStores() });
    const res = await http.handle(get('/v1/memory/records', { store: 'world-events', page: '1', pageSize: '2' }));
    expect(res.status).toBe(200);
    const body = res.body as {
      total: number;
      page: number;
      pageSize: number;
      list: { id: string; store: string; entity: string; type: string; content: string; createdAt: string | null; via: string }[];
    };
    expect(body.total).toBe(4);
    expect(body.list).toHaveLength(2);
    expect(body.list[0].store).toBe('world-events');
    expect(body.list[0].via).toBe('self'); // 新 → 旧：最后摄取的 remember 在最前

    const full = await http.handle(get('/v1/memory/records', { pageSize: '50' }));
    const fullBody = full.body as { list: { via: string }[] };
    expect(fullBody.list.some((r) => r.via === 'witness')).toBe(true);
    expect(typeof body.list[0].createdAt).toBe('string');

    const filtered = await http.handle(get('/v1/memory/records', { entity: 'borin' }));
    /* borin：目击亲历 1 条 + remember 1 条 */
    expect((filtered.body as { total: number }).total).toBe(2);

    const q = await http.handle(get('/v1/memory/records', { q: '狼嚎' }));
    expect((q.body as { total: number }).total).toBe(1);

    const noStore = await http.handle(get('/v1/memory/records', { store: 'nope' }));
    expect(noStore.status).toBe(404);
  });

  it('POST /v1/memory/retrieval：真实评分排序 + took；非法载荷 400', async () => {
    const http = createMemoryHttp({ stores: fixtureStores() });
    const res = await http.handle(post('/v1/memory/retrieval', { query: '狼嚎 森林', entity: 'borin', topK: 5, day: 4 }));
    expect(res.status).toBe(200);
    const body = res.body as {
      query: string;
      took: number;
      results: { id: string; content: string; score: number; via: string; metadata: { owner: string } }[];
    };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].content).toContain('狼嚎');
    expect(body.results[0].score).toBeGreaterThan(0);
    expect(body.results[0].metadata.owner).toBe('borin');
    expect(typeof body.took).toBe('number');

    const bad = await http.handle(post('/v1/memory/retrieval', { nope: 1 }));
    expect(bad.status).toBe(400);

    const cross = await http.handle(post('/v1/memory/retrieval', { query: '硬币', store: 'npc-personas' }));
    expect(((cross.body as { results: { content: string }[] }).results)[0].content).toContain('硬币');
  });

  it('GET /v1/memory/embedding：通道声明 + 检索统计（诚实口径）', async () => {
    const stores = fixtureStores();
    const http = createMemoryHttp({ stores });
    await http.handle(post('/v1/memory/retrieval', { query: '狼嚎' }));
    const res = await http.handle(get('/v1/memory/embedding'));
    expect(res.status).toBe(200);
    const body = res.body as {
      channels: { store: string; attached: boolean }[];
      stats: { total: number; last24h: number; avgLatencyMs: number; failureRate: number };
    };
    expect(body.channels.find((c) => c.store === 'npc-personas')!.attached).toBe(true);
    expect(body.stats.total).toBe(1);
    expect(body.stats.last24h).toBe(1);
  });

  it('未知路由 404；方法不对 405', async () => {
    const http = createMemoryHttp({ stores: fixtureStores() });
    expect((await http.handle(get('/v1/memory/banana'))).status).toBe(404);
    expect((await http.handle(post('/v1/memory/stores'))).status).toBe(405);
    expect((await http.handle(get('/v1/other'))).status).toBe(404);
  });
});

describe('Memory HTTP 真实服务器端到端（node:http + fetch）', () => {
  const servers: Awaited<ReturnType<typeof startMemoryServer>>[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  it('端到端：stores → records → retrieval（127.0.0.1 临时端口）', async () => {
    const server = await startMemoryServer({ port: 0, stores: fixtureStores() });
    servers.push(server);
    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);

    const stores = (await (await fetch(`${server.url}/v1/memory/stores`)).json()) as { stores: unknown[] };
    expect(stores.stores).toHaveLength(2);

    const records = (await (await fetch(`${server.url}/v1/memory/records?entity=lita`)).json()) as { total: number };
    expect(records.total).toBeGreaterThanOrEqual(1);

    const search = await fetch(`${server.url}/v1/memory/retrieval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '铁匠 态度' }),
    });
    expect(search.status).toBe(200);
    const found = (await search.json()) as { results: { content: string }[] };
    expect(found.results.some((r) => r.content.includes('铁匠'))).toBe(true);

    expect((await fetch(`${server.url}/v1/memory/retrieval`, { method: 'POST', body: '{oops' })).status).toBe(400);
  });

  it('安全基线：默认只绑 127.0.0.1', async () => {
    const server = await startMemoryServer({ port: 0, stores: [] });
    servers.push(server);
    expect(server.url).toContain('127.0.0.1');
  });
});

/* Embedding 配置统一治理（2026-10）：配置端点已删除——唯一配置源 =
   平台 Model Router 的 embedding 能力路由；本服务只经注入的
   EmbeddingService 消费向量。旧端点一律 410 Gone（诚实指路）。 */
describe('embedding-config 端点已删除（410 Gone）', () => {
  const http = createMemoryHttp({ stores: fixtureStores() });

  it('GET / PUT /test 一律 410，且响应不含任何配置内容', async () => {
    const got = await http.handle(get('/v1/memory/embedding-config'));
    expect(got.status).toBe(410);
    const put = await http.handle(put2('/v1/memory/embedding-config', { enabled: true, endpoint: 'http://x/v1', model: 'm', apiKey: 'sk-x' }));
    expect(put.status).toBe(410);
    const test = await http.handle({ method: 'POST', path: '/v1/memory/embedding-config/test', body: {} });
    expect(test.status).toBe(410);
    const body = JSON.stringify(put.body);
    expect(body).not.toContain('sk-x');
    expect(body).toContain('模型路由');
  });
});

/* 维度保护（Embedding 统一治理）：观测端点透出引擎实测维度与变化告警 */
describe('GET /v1/memory/embedding：引擎维度实况', () => {
  it('维度变化 → dimensionChanged 告警（不静默）', async () => {
    let dims = 3;
    const engine = new MemoryEngine({ save: new InMemoryMemoryStorage() });
    engine.remember({ ownerId: 'lita', text: '铁匠对玩家的态度转为中立', day: 3 });
    engine.setEmbed({
      embed: async (texts) => texts.map((_, i) => Array.from({ length: dims }, (_, k) => i + k)),
    });
    await engine.recallScored('lita', '态度');
    dims = 4;
    await engine.recallScored('lita', '态度');

    const http = createMemoryHttp({ stores: [{ name: 's', engine }] });
    const res = await http.handle(get('/v1/memory/embedding'));
    const ch = (res.body as { channels: { store: string; engineDimension?: number; dimensionChanged?: { from: number; to: number } }[] }).channels[0]!;
    expect(ch.engineDimension).toBe(4);
    expect(ch.dimensionChanged).toEqual({ from: 3, to: 4 });
  });
});

function put2(path: string, body: unknown): HttpRequest {
  return { method: 'PUT', path, body };
}

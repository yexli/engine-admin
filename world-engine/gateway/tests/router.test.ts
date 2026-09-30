/* Model Router（V0.6）：配置 fail-fast / 确定性路由 / 降级链 / 密钥剔除 / 双上游分流 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  CAPABILITY_TAGS,
  createGateway,
  createModelRouter,
  parseRouteConfig,
  routedProvider,
  startGatewayServer,
  RouteConfigError,
  type ModelRef,
} from '../src/index';

const ref = (id: string, tags: string[], endpoint = 'https://api.example.com/v1', env = 'K_TEST'): ModelRef => ({
  id,
  endpoint,
  apiKeyRef: { env },
  tags: tags as ModelRef['tags'],
});

/* K_MISSING 专门模拟「环境变量没配」；其余一律视为已配置 */
const resolveEnv = (n: string) => (n === 'K_MISSING' ? undefined : 'sk-' + n.toLowerCase());

describe('配置 fail-fast（W6.3）', () => {
  it('合法配置通过', () => {
    const c = parseRouteConfig({
      models: [{ id: 'a', endpoint: 'http://127.0.0.1:9/v1', apiKeyRef: { env: 'K_A' }, tags: ['fast', 'cheap'] }],
      routes: { intent: { tags: ['fast'], prefer: ['a'] } },
    });
    expect(c.models).toHaveLength(1);
  });

  it('各类错误当场抛：空 models / 坏 URL / 非 http(s) / 未知标签 / 密钥非引用 / 重复 id', () => {
    const good = { id: 'a', endpoint: 'https://x/v1', apiKeyRef: { env: 'K_A' }, tags: ['fast'] };
    expect(() => parseRouteConfig({ models: [] })).toThrow(RouteConfigError);
    expect(() => parseRouteConfig({ models: [{ ...good, endpoint: 'not a url' }] })).toThrow(/合法 URL/);
    expect(() => parseRouteConfig({ models: [{ ...good, endpoint: 'ftp://x' }] })).toThrow(/http\/https/);
    expect(() => parseRouteConfig({ models: [{ ...good, tags: ['快'] }] })).toThrow(/未知标签/);
    expect(() => parseRouteConfig({ models: [{ ...good, apiKeyRef: { literal: 'sk-1' } }] })).toThrow(/apiKeyRef/);
    expect(() => parseRouteConfig({ models: [good, good] })).toThrow(/重复/);
    expect(() => parseRouteConfig({ models: [good], routes: { intent: { tags: ['不存在'] } } })).toThrow(/未知标签/);
  });

  it('标签字典是 §66 固定集', () => {
    expect(CAPABILITY_TAGS).toEqual(['fast', 'cheap', 'reasoning', 'roleplay', 'narrative', 'memory', 'embedding', 'structured-output', 'long-context']);
  });
});

describe('路由选择（W6.2：确定性 + 降级链 + 密钥剔除）', () => {
  it('预置路由：intent → 带 fast 标签的模型；六角色到标签的映射生效', () => {
    const r = createModelRouter(
      parseRouteConfig({ models: [ref('slow', ['reasoning']), ref('quick', ['fast'])] }),
      { resolveEnv },
    );
    expect(r.route('intent')!.model.id).toBe('quick');
    expect(r.route('reasoning')!.model.id).toBe('slow');
  });

  it('确定性：同配置同任务同结果（prefer 参与排序但不引入随机）', () => {
    const config = parseRouteConfig({
      models: [ref('b', ['narrative']), ref('a', ['narrative'])],
      routes: { narrative: { prefer: ['b'] } },
    });
    const r = createModelRouter(config, { resolveEnv });
    expect(r.route('narrative')!.model.id).toBe('b'); // prefer 生效
    const r2 = createModelRouter(parseRouteConfig({ models: [ref('b', ['narrative']), ref('a', ['narrative'])] }), { resolveEnv });
    expect(r2.route('narrative')!.model.id).toBe('b'); // 无 prefer → 配置顺序稳定
  });

  it('降级链：全命中优先于部分命中；零命中的角色回退宿主缺省（null）', () => {
    const r = createModelRouter(
      parseRouteConfig({
        models: [ref('general', ['long-context']), ref('good', ['narrative', 'long-context'])],
        routes: { narrative: { tags: ['narrative', 'long-context'] } },
      }),
      { resolveEnv },
    );
    expect(r.route('narrative')!.model.id).toBe('good'); // 全命中胜过部分命中
    const partial = r.route('narrative', ['fast']);
    expect(partial!.model.id).toBe('good'); // 额外标签无人命中 → 部分命中仍放行（降级链）
    expect(r.route('no_such_role')).toBeNull(); // 零命中 → 回退宿主缺省
  });

  it('密钥缺失的模型被剔除并留痕（explain 可追溯，W6.5）', () => {
    const r = createModelRouter(
      parseRouteConfig({ models: [ref('nokey', ['fast'], 'https://x/v1', 'K_MISSING'), ref('haskey', ['fast'])] }),
      { resolveEnv },
    );
    const d = r.explain('intent');
    expect(d.chosen!.id).toBe('haskey');
    expect(d.candidates.find((c) => c.id === 'nokey')!.why).toContain('未设置');
    expect(d.why).toContain('全标签命中');
  });
});

describe('双上游分流 + routedProvider（网关组合）', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  /** 起一个脚本化 OpenAI 兼容上游（本地环回 = 本地推理端点的合法场景） */
  function upstream(port: number, reply: string): Promise<Server> {
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
        });
      });
      servers.push(s);
      s.listen(port, '127.0.0.1', () => resolve(s));
    });
  }

  it('两个不同端点按通道分流：intent 走 A，narrative 走 B（§66 真实分流）', async () => {
    const sA = await upstream(0, '来自快速端点');
    const sB = await upstream(0, '来自叙事端点');
    const addrA = (sA.address() as { port: number }).port;
    const addrB = (sB.address() as { port: number }).port;

    const router = createModelRouter(
      parseRouteConfig({
        models: [
          { id: 'fast-endpoint', endpoint: `http://127.0.0.1:${addrA}/v1`, apiKeyRef: { env: 'K_FAST' }, tags: ['fast', 'cheap'] },
          { id: 'tale-endpoint', endpoint: `http://127.0.0.1:${addrB}/v1`, apiKeyRef: { env: 'K_HEAVY' }, tags: ['narrative', 'roleplay'] },
        ],
      }),
      { resolveEnv },
    );

    expect(router.route('intent')!.model.id).toBe('fast-endpoint');
    expect(router.route('narrative')!.model.id).toBe('tale-endpoint');

    /* 网关组合：routedProvider 挂进 V0.5 网关，OpenAI 客户端按通道说话 */
    const gw = createGateway();
    gw.registry.register(routedProvider(router));
    const intent = await gw.handle(post('/v1/chat/completions', { model: 'intent', messages: [{ role: 'user', content: 'x' }] }));
    expect((intent.body as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe('来自快速端点');
    const narrative = await gw.handle(post('/v1/chat/completions', { model: 'narrative', messages: [{ role: 'user', content: 'x' }] }));
    expect((narrative.body as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe('来自叙事端点');
  });

  it('远端错误如实上报：上游 500 → RemoteModelError → 网关 503（不假装修好）', async () => {
    const s = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(500);
        res.end('boom');
      });
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as { port: number }).port;

    const router = createModelRouter(parseRouteConfig({ models: [ref('bad', ['fast'], `http://127.0.0.1:${port}/v1`)] }), { resolveEnv });
    const gw = createGateway();
    gw.registry.register(routedProvider(router));
    const r = await gw.handle(post('/v1/chat/completions', { model: 'intent', messages: [{ role: 'user', content: 'x' }] }));
    expect(r.status).toBe(503);
    expect((r.body as { error: { message: string } }).error.message).toContain('500');
  });

  it('dist 外真实服务器 E2E：流式透传（routedProvider → 网关 SSE）', async () => {
    const s = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"上"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"游"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as { port: number }).port;

    const router = createModelRouter(parseRouteConfig({ models: [ref('streamy', ['narrative'], `http://127.0.0.1:${port}/v1`)] }), { resolveEnv });
    const server = await startGatewayServer({ port: 0, providers: [routedProvider(router)] });
    try {
      const res = await fetch(`${server.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'narrative', messages: [{ role: 'user', content: 'x' }], stream: true }),
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toContain('上');
      expect(text).toContain('游');
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    } finally {
      await server.close();
    }
  });
});

/* ---- 测试工具 ---- */
function post(path: string, body?: unknown): { method: string; path: string; body?: unknown } {
  return { method: 'POST', path, body };
}

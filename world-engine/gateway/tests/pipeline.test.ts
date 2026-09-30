/* Multi-Model 编排管线（V0.7）：DAG / 模板契约 / 失败隔离 / 预算熔断 / 多模型协作 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  createModelRouter,
  createPipeline,
  parsePipelineSpec,
  parseRouteConfig,
  type ModelRef,
} from '../src/index';

const resolveEnv = () => 'sk-test';

/** 脚本化 OpenAI 兼容上游：按路径区分端点，按请求体里的 model 区分角色 */
function upstream(portReply: Record<number, string> | ((model: string) => string)): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const model = (() => {
          try {
            return (JSON.parse(body) as { model: string }).model;
          } catch {
            return '';
          }
        })();
        const reply = typeof portReply === 'function' ? portReply(model) : portReply;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function routerWithUpstream(s: Server, tagMap: Record<string, string>): Promise<ReturnType<typeof createModelRouter>> {
  const port = (s.address() as { port: number }).port;
  const models: ModelRef[] = Object.entries(tagMap).map(([id, tags]) => ({
    id,
    endpoint: `http://127.0.0.1:${port}/v1`,
    apiKeyRef: { env: 'K_TEST' },
    tags: tags.split(',') as ModelRef['tags'],
  }));
  return createModelRouter(parseRouteConfig({ models }), { resolveEnv });
}

describe('管线描述 fail-fast（W7.1）', () => {
  it('重复 id / 未知依赖 / 成环 / 坏 output 全部当场抛', () => {
    const base = { id: 'a', role: 'intent', user: 'x' };
    expect(() => parsePipelineSpec({ id: 'p', nodes: [base, { ...base, id: 'a' }] })).toThrow(/重复/);
    expect(() => parsePipelineSpec({ id: 'p', nodes: [base, { id: 'b', role: 'narrative', user: '{{a}}', dependsOn: ['ghost'] }] })).toThrow(/不存在/);
    expect(() =>
      parsePipelineSpec({
        id: 'p',
        nodes: [
          { id: 'a', role: 'intent', user: '{{b}}', dependsOn: ['b'] },
          { id: 'b', role: 'narrative', user: '{{a}}', dependsOn: ['a'] },
        ],
      }),
    ).toThrow(/成环/);
    expect(() => parsePipelineSpec({ id: 'p', nodes: [{ id: 'a', role: 'intent', user: 'x', output: 'yaml' }] })).toThrow(/output/);
    expect(() => parsePipelineSpec({ id: 'p', nodes: [{ id: '有.点', role: 'intent', user: 'x' }] })).toThrow(/id/);
  });
});

describe('编排运行（W7.1–W7.4）', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('三节点 DAG：intent → reason → narrative，模板引用贯通，双角色 = 双模型协作', async () => {
    /* replies 按**模型 id**（出站 wire model）键控 */
    const replies: Record<string, string> = {
      fast: JSON.stringify({ intent: 'observe', target: '' }),
      reasoner: '判定：安全。',
      tale: '他环顾四周，鸽子落在钟塔上。',
    };
    const s = await upstream((model) => replies[model] ?? '缺词');
    servers.push(s);
    const router = await routerWithUpstream(s, { fast: 'fast', reasoner: 'reasoning', tale: 'narrative' });

    const spec = parsePipelineSpec({
      id: 'free-turn',
      nodes: [
        { id: 'intent', role: 'intent', user: '解析：{{input.text}}', output: 'json' },
        { id: 'judge', role: 'reasoning', user: '意图是 {{intent}}，判定后果', dependsOn: ['intent'] },
        { id: 'tale', role: 'narrative', system: '你是说书人', user: '基于「{{judge}}」写正文：{{input.text}}', dependsOn: ['judge'] },
      ],
      deadlineMs: 5000,
    });
    const pipe = createPipeline(spec, router);
    const r = await pipe.run({ text: '我看看四周' });

    expect(r.ok).toBe(true);
    expect(Object.keys(r.outputs)).toEqual(['intent', 'judge', 'tale']);
    expect(r.json['intent']).toEqual({ intent: 'observe', target: '' });
    expect(r.outputs['tale']).toContain('鸽子');
    expect(r.degraded).toEqual([]);
    expect(r.timedOut).toBe(false);
    /* 多模型协作证据：三个节点命中两个不同角色标签（fast + reasoning + narrative 路由） */
    expect(new Set(r.trace.map((t) => t.role)).size).toBe(3);
    expect(r.trace.every((t) => t.ok)).toBe(true);
  });

  it('失败隔离：中间节点 500 → 自身与下游降级，兄弟分支照常，管线 ok=false', async () => {
    const s = await new Promise<Server>((resolve) => {
      const srv = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const model = (() => {
            try {
              return (JSON.parse(body) as { model: string }).model;
            } catch {
              return '';
            }
          })();
          if (model === 'boom') {
            res.writeHead(500);
            res.end('boom');
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'side ok' } }] }));
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    servers.push(s);
    const port = (s.address() as { port: number }).port;
    const router = createModelRouter(
      parseRouteConfig({
        models: [
          { id: 'boom', endpoint: `http://127.0.0.1:${port}/v1`, apiKeyRef: { env: 'K' }, tags: ['reasoning'] },
          { id: 'side', endpoint: `http://127.0.0.1:${port}/v1`, apiKeyRef: { env: 'K' }, tags: ['embedding'] },
        ],
      }),
      { resolveEnv: () => 'sk' },
    );

    const spec = parsePipelineSpec({
      id: 'iso',
      nodes: [
        { id: 'side', role: 'embedding', user: '旁支' },
        { id: 'boom', role: 'reasoning', user: '会炸' },
        { id: 'downstream', role: 'narrative', user: '{{boom}}', dependsOn: ['boom'] },
      ],
    });
    const r = await createPipeline(spec, router).run();
    expect(r.ok).toBe(false);
    expect(r.outputs['side']).toBe('side ok'); // 兄弟分支照常
    expect(r.outputs['downstream']).toBeUndefined();
    expect(r.degraded.map((d) => d.id)).toContain('boom');
    expect(r.degraded.find((d) => d.id === 'downstream')?.why).toContain('上游未产出：boom');
  });

  it('optional 节点失败不计管线失败；json 契约失败按节点失败处理', async () => {
    const s = await upstream((model) => (model === 'strict' ? '不是 JSON 的回复' : '正文'));
    servers.push(s);
    const router = await routerWithUpstream(s, { strict: 'structured-output', tale: 'narrative' });
    const spec = parsePipelineSpec({
      id: 'opt',
      nodes: [
        { id: 'strict', role: 'structured-output', user: '给 JSON', output: 'json', optional: true },
        { id: 'tale', role: 'narrative', user: '写正文' },
      ],
    });
    const r = await createPipeline(spec, router).run();
    expect(r.ok).toBe(true); // optional 失败不报废
    expect(r.outputs['strict']).toBeUndefined();
    expect(r.degraded.find((d) => d.id === 'strict')?.why).toContain('不是合法 JSON');
    expect(r.outputs['tale']).toBe('正文');
  });

  it('预算熔断：maxCalls 用尽后剩余节点按预算降级；deadline 超时置 timedOut', async () => {
    const s = await upstream('ok');
    servers.push(s);
    const router = await routerWithUpstream(s, { a: 'fast', b: 'reasoning', c: 'narrative', d: 'memory' });
    const spec = parsePipelineSpec({
      id: 'budget',
      nodes: [
        { id: 'a', role: 'intent', user: '1' },
        { id: 'b', role: 'reasoning', user: '2' },
        { id: 'c', role: 'narrative', user: '3' },
        { id: 'd', role: 'memory', user: '4' },
      ],
    });
    const r = await createPipeline(spec, router, { maxCalls: 2 }).run();
    expect(r.ok).toBe(false);
    expect(r.degraded.length).toBe(2);
    expect(r.degraded.every((d) => d.why.includes('maxCalls'))).toBe(true);

    /* deadline 竞态规避：三节点链，越靠后的节点越必然撞上 1ms 预算 */
    const tight = parsePipelineSpec({
      id: 't',
      nodes: [
        { id: 'a', role: 'intent', user: '1' },
        { id: 'b', role: 'reasoning', user: '2', dependsOn: ['a'] },
        { id: 'c', role: 'narrative', user: '3', dependsOn: ['b'] },
      ],
      deadlineMs: 1,
    });
    const r2 = await createPipeline(tight, router).run();
    expect(r2.timedOut).toBe(true);
    expect(r2.degraded.some((d) => d.id === 'c' && d.why.includes('deadlineMs'))).toBe(true);
  });
});

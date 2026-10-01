/* 注册表快照热替换（Model Control Plane · Task 2）
   replaceAll / replaceProviders：整体换注册表快照；
   进行中的请求持有已解析的旧提供方，跑完不受影响。 */
import { describe, expect, it } from 'vitest';
import { createGateway, startGatewayServer, type GatewayProvider, type GatewayRequest } from '../src/index';

const post = (path: string, body?: unknown): GatewayRequest => ({ method: 'POST', path, body });

function providerOf(owner: string, models: string[], reply: string, gate?: Promise<void>): GatewayProvider {
  return {
    owner,
    models,
    complete: async () => {
      if (gate) await gate;
      return reply;
    },
  };
}

describe('ProviderRegistry.replaceAll（原子快照替换）', () => {
  it('替换后新模型立即可用，旧模型消失；未注册 404', async () => {
    const gw = createGateway();
    gw.registry.register(providerOf('a', ['mdl-a'], 'A-1'));
    const before = await gw.handle(post('/v1/chat/completions', { model: 'mdl-a', messages: [{ role: 'user', content: 'x' }] }));
    expect(before.status).toBe(200);

    gw.registry.replaceAll([providerOf('b', ['mdl-b'], 'B-1')]);

    const after = await gw.handle(post('/v1/chat/completions', { model: 'mdl-b', messages: [{ role: 'user', content: 'x' }] }));
    expect(after.status).toBe(200);
    expect((after.body as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe('B-1');

    const gone = await gw.handle(post('/v1/chat/completions', { model: 'mdl-a', messages: [{ role: 'user', content: 'x' }] }));
    expect(gone.status).toBe(404);

    const models = await gw.handle({ method: 'GET', path: '/v1/models' });
    expect((models.body as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(['mdl-b']);
  });

  it('进行中的请求完成在旧提供方上（不悬挂、不串快照）', async () => {
    const gw = createGateway();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    gw.registry.register(providerOf('slow', ['mdl-slow'], 'OLD-SNAPSHOT', gate));

    const inflight = gw.handle(post('/v1/chat/completions', { model: 'mdl-slow', messages: [{ role: 'user', content: 'x' }] }));
    /* 提供方已解析、调用已挂起：此刻整体替换注册表 */
    gw.registry.replaceAll([providerOf('fast', ['mdl-slow'], 'NEW-SNAPSHOT')]);
    release();

    const out = await inflight;
    expect(out.status).toBe(200);
    expect((out.body as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe('OLD-SNAPSHOT');

    /* 后续请求走新快照 */
    const next = await gw.handle(post('/v1/chat/completions', { model: 'mdl-slow', messages: [{ role: 'user', content: 'x' }] }));
    expect((next.body as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe('NEW-SNAPSHOT');
  });
});

describe('startGatewayServer.replaceProviders（服务器级热替换）', () => {
  it('动态注册后无需重启即可路由', async () => {
    const server = await startGatewayServer({ port: 0 });
    try {
      const chat = (model: string) =>
        fetch(`${server.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
        });

      expect((await chat('mdl-x')).status).toBe(404);
      server.replaceProviders([providerOf('dyn', ['mdl-x'], 'DYNAMIC-OK')]);
      const res = await chat('mdl-x');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      expect(body.choices[0].message.content).toBe('DYNAMIC-OK');
    } finally {
      await server.close();
    }
  });
});

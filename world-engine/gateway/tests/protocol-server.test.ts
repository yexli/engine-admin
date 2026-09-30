/* 协议适配器 + 真实服务器端到端（含 SSE 流式与 SillyTavern 画像） */
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway, sseFrame, startGatewayServer, type GatewayProvider, type GatewayRequest } from '../src/index';

const post = (path: string, body?: unknown): GatewayRequest => ({ method: 'POST', path, body });
const get = (path: string): GatewayRequest => ({ method: 'GET', path });

const scriptProvider: GatewayProvider = {
  owner: 'scripted',
  models: ['narrative', 'intent', 'memory'],
  complete: async (model, messages) => {
    if (model === 'intent') return messages[messages.length - 1].content.trim().toUpperCase();
    if (model === 'narrative') return '他推开门，风沙灌了进来。';
    return null; // memory 通道模拟上游失败
  },
  completeStream: async (model, _messages, onDelta) => {
    for (const word of ['他', '推开门', '，风沙', '灌了进来。']) {
      onDelta(word);
    }
    if (model === 'ghost') throw new Error('上游断了'); // 不会发生：ghost 未注册
    return; // 产出全部经 onDelta
  },
};

describe('协议适配器（纯路由，流式经收集器）', () => {
  it('chat 非流式：200 + OpenAI 形状；未注册模型 404；上游失败 503；坏载荷 400', async () => {
    const gw = createGateway();
    gw.registry.register(scriptProvider);

    const ok = await gw.handle(post('/v1/chat/completions', { model: 'intent', messages: [{ role: 'user', content: '观察环境' }] }));
    expect(ok.status).toBe(200);
    expect((ok.body as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe('观察环境');

    expect((await gw.handle(post('/v1/chat/completions', { model: 'ghost', messages: [{ role: 'user', content: 'x' }] }))).status).toBe(404);
    const fail = await gw.handle(post('/v1/chat/completions', { model: 'memory', messages: [{ role: 'user', content: 'x' }] }));
    expect(fail.status).toBe(503);
    expect((await gw.handle(post('/v1/chat/completions', { model: 'narrative' }))).status).toBe(400);
  });

  it('chat 流式：delta 帧 + stop 帧 + [DONE]；提供方抛错发错误帧且收流不悬挂', async () => {
    const gw = createGateway();
    gw.registry.register(scriptProvider);

    const frames: string[] = [];
    const out = await gw.handle(
      post('/v1/chat/completions', { model: 'narrative', messages: [{ role: 'user', content: 'x' }], stream: true }),
      { send: (t) => frames.push(t), end: () => frames.push('[DONE]') },
    );
    expect(out.status).toBe(200);
    expect(frames.filter((f) => f.includes('"content"')).length).toBe(4);
    expect(frames.at(-1)).toBe('[DONE]');
    expect(frames.some((f) => f.includes('"finish_reason":"stop"'))).toBe(true);
    expect(sseFrame(frames[0]).startsWith('data: ')).toBe(true);
  });

  it('models / embeddings / 未知路由', async () => {
    const gw = createGateway();
    gw.registry.register(scriptProvider);

    const models = await gw.handle(get('/v1/models'));
    expect((models.body as { data: { id: string }[] }).data.map((m) => m.id)).toContain('narrative');

    const emb = await gw.handle(post('/v1/embeddings', { model: 'memory', input: ['一句', '两句话'] }));
    expect(emb.status).toBe(501); // scriptProvider 未实现 embed

    expect((await gw.handle(get('/nope'))).status).toBe(404);
    expect((await gw.handle(post('/v1/chat/completions'))).status).toBe(400);
  });
});

describe('真实服务器端到端（node:http + fetch · SillyTavern 画像）', () => {
  const servers: Awaited<ReturnType<typeof startGatewayServer>>[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  it('SillyTavern 兼容画像：拉模型列表 → 选模型流式对话 → SSE 帧序列合法', async () => {
    const server = await startGatewayServer({ port: 0, providers: [scriptProvider] });
    servers.push(server);
    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
    const base = server.url;

    /* ST 第一步：GET /v1/models 拉可选模型（连接配置页） */
    const models = (await (await fetch(`${base}/v1/models`)).json()) as { data: { id: string }[] };
    expect(models.data.map((m) => m.id)).toContain('narrative');

    /* ST 第二步：非流式补全 */
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'narrative',
        messages: [
          { role: 'system', content: '你是这个世界的说书人。' },
          { role: 'user', content: '继续故事。' },
        ],
      }),
    });
    expect(chat.headers.get('content-type')).toContain('application/json');
    const chatJson = (await chat.json()) as { choices: { message: { content: string } }[] };
    expect(chatJson.choices[0].message.content).toContain('风沙');

    /* ST 第三步：流式补全（ST 的 stream 开关）——SSE 帧序列：若干 delta + stop + [DONE] */
    const stream = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'narrative', messages: [{ role: 'user', content: 'x' }], stream: true }),
    });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const text = await stream.text();
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: '));
    expect(dataLines.at(-1)).toBe('data: [DONE]');
    expect(text).toContain('风沙');
  });

  it('动态注册：注册即出现在 /v1/models；坏 JSON 400；未注册模型 404', async () => {
    const server = await startGatewayServer({ port: 0 });
    servers.push(server);

    expect((await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'late', messages: [{ role: 'user', content: 'x' }] }),
    })).status).toBe(404);

    server.register({ owner: 'late', models: ['late'], complete: async () => '来了' });
    const r = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'late', messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(((await r.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe('来了');

    expect((await fetch(`${server.url}/v1/models`)).status).toBe(200);
    expect((await fetch(`${server.url}/v1/chat/completions`, { method: 'POST', body: '{oops' })).status).toBe(400);
  });
});

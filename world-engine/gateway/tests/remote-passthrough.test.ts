/* 0.7.1 · remoteChat 透传通道：extraPayload（思考强度等厂商参数）+ modelOverride */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { remoteChat } from '../src/remote';
import type { ModelRef } from '../src/router';

const ref: ModelRef = {
  id: 'mdl-a',
  endpoint: 'http://127.0.0.1:0/v1',
  apiKeyRef: { env: 'X' },
  tags: [],
  wireModel: 'wire-a',
};

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** 脚本上游：记录收到的 body，回固定补全 */
function captureUpstream() {
  const seen: Record<string, unknown>[] = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  servers.push(s);
  return new Promise<{ url: string; seen: Record<string, unknown>[] }>((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, seen });
    });
  });
}

describe('remoteChat 透传（0.7.1）', () => {
  it('extraPayload 并入顶层请求体（思考强度等厂商参数）', async () => {
    const up = await captureUpstream();
    await remoteChat({ ...ref, endpoint: up.url }, 'key', [{ role: 'user', content: 'hi' }], {
      extraPayload: { thinking: { type: 'enabled' }, enable_thinking: true },
    });
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]['thinking']).toEqual({ type: 'enabled' });
    expect(up.seen[0]['enable_thinking']).toBe(true);
    expect(up.seen[0]['model']).toBe('wire-a');
  });

  it('modelOverride 覆盖出站模型名（DeepSeek 思考模式按模型名切换），结果回显实际模型', async () => {
    const up = await captureUpstream();
    const out = await remoteChat({ ...ref, endpoint: up.url }, 'key', [{ role: 'user', content: 'hi' }], {
      modelOverride: 'deepseek-reasoner',
    });
    expect(up.seen[0]['model']).toBe('deepseek-reasoner');
    expect(out.model).toBe('deepseek-reasoner');
  });

  it('不传新参 → 行为与 0.7.0 完全一致（出站 wire model 不变）', async () => {
    const up = await captureUpstream();
    await remoteChat({ ...ref, endpoint: up.url }, 'key', [{ role: 'user', content: 'hi' }], {
      maxTokens: 16,
    });
    expect(up.seen[0]['model']).toBe('wire-a');
    expect(up.seen[0]['max_tokens']).toBe(16);
    expect(up.seen[0]['thinking']).toBeUndefined();
  });
});

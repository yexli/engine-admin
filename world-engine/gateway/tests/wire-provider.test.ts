/* 线格式与注册表：纯单元 */
import { describe, expect, it } from 'vitest';
import {
  chatCompletionResponse,
  deltaChunk,
  embeddingsResponse,
  modelsResponse,
  parseChatCompletionRequest,
  parseEmbeddingsRequest,
  sseFrame,
  stopChunk,
} from '../src/wire';
import { ProviderRegistry, type GatewayProvider } from '../src/provider';

describe('线格式', () => {
  it('chat 请求解析：合法通过；缺 model / 空 messages / 坏 role 拒绝', () => {
    const ok = parseChatCompletionRequest({
      model: 'narrative',
      messages: [
        { role: 'system', content: '你是说书人' },
        { role: 'user', content: '继续' },
      ],
      stream: true,
    });
    expect(ok?.model).toBe('narrative');
    expect(ok?.messages).toHaveLength(2);
    expect(parseChatCompletionRequest({ messages: [{ role: 'user', content: 'x' }] })).toBeNull();
    expect(parseChatCompletionRequest({ model: 'narrative', messages: [] })).toBeNull();
    expect(parseChatCompletionRequest({ model: 'narrative', messages: [{ role: 'tool', content: 'x' }] })).toBeNull();
    expect(parseChatCompletionRequest('not an object')).toBeNull();
  });

  it('响应/流块/嵌入的 OpenAI 形状', () => {
    const resp = chatCompletionResponse('narrative', '他推门而入。');
    expect(resp.object).toBe('chat.completion');
    expect(resp.choices[0].message.content).toBe('他推门而入。');

    const id = 'chatcmpl-x';
    expect(deltaChunk('narrative', id, '风').choices[0].delta).toEqual({ content: '风' });
    expect(stopChunk('narrative', id).choices[0].finish_reason).toBe('stop');
    expect(sseFrame(JSON.stringify({ a: 1 }))).toBe('data: {"a":1}\n\n');
    expect(sseFrame('[DONE]')).toBe('data: [DONE]\n\n');

    const emb = embeddingsResponse('memory', [[0.1, 0.2], [0.3]]);
    expect(emb.data[1]).toEqual({ object: 'embedding', embedding: [0.3], index: 1 });
    expect(modelsResponse([{ id: 'intent', object: 'model', owned_by: 't' }]).data).toHaveLength(1);

    expect(parseEmbeddingsRequest({ model: 'memory', input: '一句话' })?.input).toEqual(['一句话']);
    expect(parseEmbeddingsRequest({ model: 'memory', input: 42 })).toBeNull();
  });
});

describe('提供方注册表', () => {
  const provider: GatewayProvider = {
    owner: 'iron-and-sand',
    models: ['narrative', 'intent'],
    complete: async () => 'ok',
  };
  const embeddingProvider: GatewayProvider = {
    owner: 'vec',
    models: ['memory'],
    complete: async () => 'ok',
    embed: async (_m, input) => input.map((s) => [s.length, 1]),
  };

  it('解析：按通道命中提供方；未注册 → null', () => {
    const r = new ProviderRegistry();
    r.register(provider);
    r.register(embeddingProvider);
    expect(r.resolve('narrative')?.owner).toBe('iron-and-sand');
    expect(r.resolve('memory')?.owner).toBe('vec');
    expect(r.resolve('ghost')).toBeNull();
  });

  it('/v1/models 清单去重汇总', () => {
    const r = new ProviderRegistry();
    r.register(provider);
    r.register(embeddingProvider);
    expect(r.listModels().map((m) => m.id)).toEqual(['narrative', 'intent', 'memory']);
  });
});

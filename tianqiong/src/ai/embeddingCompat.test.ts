/* ============================================================
   向量模型配置与适配器（记忆方案 §11/§12）：
   与对话模型各自独立，任一没配都不影响另一个。
   ============================================================ */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatEmbedding, applyEmbeddingProvider, embeddingCoolingDown, resetEmbeddingCooldown } from './embeddingCompat';
import { DEFAULT_EMBEDDING, DEFAULT_LLM, embeddingUsable, resolveEmbedding, type LlmConfig } from './llmConfig';
import { embeddingAvailable, embeddingProvider, warmMemories } from '@/memory';

const base = (over: Partial<LlmConfig> = {}): LlmConfig => ({ ...DEFAULT_LLM, ...over });

afterEach(() => {
  vi.unstubAllGlobals();
  applyEmbeddingProvider(null);
  resetEmbeddingCooldown();
});

describe('向量模型配置', () => {
  it('复用对话模型时沿用其端点与 Key（省得填两遍）', () => {
    const c = base({
      enabled: true,
      baseURL: 'https://llm.example/v1',
      apiKey: 'sk-llm',
      embedding: { ...DEFAULT_EMBEDDING, enabled: true, reuseLlm: true },
    });
    const e = resolveEmbedding(c);
    expect(e.baseURL).toBe('https://llm.example/v1');
    expect(e.apiKey).toBe('sk-llm');
    expect(e.model, '模型名仍用向量自己的').toBe('BAAI/bge-m3');
  });

  it('不复用时完全走自己的端点与 Key', () => {
    const c = base({
      enabled: true,
      apiKey: 'sk-llm',
      embedding: { ...DEFAULT_EMBEDDING, enabled: true, reuseLlm: false, baseURL: 'https://emb.example/v1', model: 'bge-small', apiKey: 'sk-emb' },
    });
    const e = resolveEmbedding(c);
    expect(e.baseURL).toBe('https://emb.example/v1');
    expect(e.apiKey).toBe('sk-emb');
  });

  it('可用性独立：对话模型没配，向量模型照样能单独启用', () => {
    const onlyEmb = base({
      enabled: false,
      apiKey: '',
      embedding: { ...DEFAULT_EMBEDDING, enabled: true, reuseLlm: false, apiKey: 'sk-emb' },
    });
    expect(embeddingUsable(onlyEmb)).toBe(true);
    expect(embeddingUsable(base())).toBe(false);
    /* 复用时若对话模型没 Key，向量也跟着不可用（这是复用语义的应有之义） */
    const reuseNoKey = base({ apiKey: '', embedding: { ...DEFAULT_EMBEDDING, enabled: true, reuseLlm: true } });
    expect(embeddingUsable(reuseNoKey)).toBe(false);
  });
});

describe('向量适配器', () => {
  it('打 /embeddings 并解出向量，首调探测维度', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        });
      }),
    );
    const p = new OpenAiCompatEmbedding({ ...DEFAULT_EMBEDDING, baseURL: 'https://emb.example/v1/', model: 'bge-m3', apiKey: 'sk-x' });
    const v = await p.embed('你好');
    expect(v).toEqual([0.1, 0.2, 0.3]);
    expect(calls[0].url, '结尾斜杠不应产生双斜杠').toBe('https://emb.example/v1/embeddings');
    expect(calls[0].body).toEqual({ model: 'bge-m3', input: ['你好'] });
    expect(p.getDimension(), '维度首调探测，不用用户去查文档').toBe(3);
  });

  it('失败返回空向量而不是抛错（调用方据此退回关键词检索）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const p = new OpenAiCompatEmbedding({ ...DEFAULT_EMBEDDING, baseURL: 'https://emb.example/v1', model: 'm', apiKey: 'k' });
    await expect(p.embed('x')).resolves.toEqual([]);
    await expect(p.embedBatch([])).resolves.toEqual([]);
    const t = await p.testConnection();
    expect(t.ok).toBe(false);
  });

  it('失败后进入冷却：离线时不再每次白等一个超时', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        calls++;
        return Promise.reject(new Error('offline'));
      }),
    );
    const p = new OpenAiCompatEmbedding({ ...DEFAULT_EMBEDDING, baseURL: 'https://emb.example/v1', model: 'm', apiKey: 'k' });
    await p.embed('a');
    expect(calls).toBe(1);
    expect(embeddingCoolingDown()).toBe(true);
    await p.embed('b');
    expect(calls, '冷却期内不该再发请求').toBe(1);
    resetEmbeddingCooldown();
    await p.embed('c');
    expect(calls).toBe(2);
  });

  it('成功时不进冷却（正常路径不受影响）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ embedding: [1, 2] }] }) })),
    );
    const p = new OpenAiCompatEmbedding({ ...DEFAULT_EMBEDDING, baseURL: 'https://emb.example/v1', model: 'm', apiKey: 'k' });
    await p.embed('a');
    expect(embeddingCoolingDown()).toBe(false);
  });

  it('记忆多时自动分批，且单批失败不连累其余批次', async () => {
    const batches: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_u: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { input: string[] };
        batches.push(body.input.length);
        /* 第二批故意失败：验证其余批次仍能入缓存 */
        if (batches.length === 2) return Promise.reject(new Error('batch failed'));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: body.input.map(() => ({ embedding: [1, 0] })) }),
        });
      }),
    );
    applyEmbeddingProvider({ ...DEFAULT_EMBEDDING, enabled: true, apiKey: 'k', baseURL: 'https://emb.example/v1' });
    const items = Array.from({ length: 70 }, (_, i) => ({ id: 'm' + i, ownerId: 'lita', content: '一段记忆内容 ' + i }));
    const n = await warmMemories(items);
    expect(batches.length, '应分批而不是一次全发').toBeGreaterThan(1);
    expect(Math.max(...batches), '单批不超过条数上限').toBeLessThanOrEqual(32);
    expect(n, '失败那批之外的记忆仍应入缓存').toBeGreaterThan(0);
    expect(n).toBeLessThan(70);
  });

  it('装配与卸载：记忆层据此决定是否启用语义检索', () => {
    expect(embeddingAvailable()).toBe(false);
    applyEmbeddingProvider({ ...DEFAULT_EMBEDDING, enabled: true, apiKey: 'k' });
    expect(embeddingAvailable()).toBe(true);
    expect(embeddingProvider()?.name).toContain('openai-emb');
    applyEmbeddingProvider(null);
    expect(embeddingAvailable()).toBe(false);
  });
});

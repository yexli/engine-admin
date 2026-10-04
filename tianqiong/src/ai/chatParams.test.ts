/* ============================================================
   思考参数（Gemini / DeepSeek / GLM）
   ------------------------------------------------------------
   这一份钉的是「字段名」这件最容易悄悄错掉的事：
   Gemini 的 OpenAI 兼容层认 reasoning_effort，DeepSeek / GLM 认 thinking.type，
   名字写错不会报错——端点静静地忽略它，玩家那边只是「思考等级没生效」。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { buildChatBody, resolveThinkingStyle } from './chatParams';
import { DEFAULT_LLM } from './llmConfig';

const base = { ...DEFAULT_LLM, model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1' };
const body = (patch: Partial<typeof base> = {}) =>
  buildChatBody({ ...base, ...patch }, [{ role: 'user', content: 'x' }]);

describe('思考参数 · 端点识别', () => {
  it('Gemini → 档位式；DeepSeek / GLM → 开关式；认不出 → 两种都发', () => {
    expect(resolveThinkingStyle({ baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro' })).toBe('effort');
    expect(resolveThinkingStyle({ baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner' })).toBe('thinking');
    expect(resolveThinkingStyle({ baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6' })).toBe('thinking');
    expect(resolveThinkingStyle({ baseURL: 'https://proxy.local/v1', model: 'mystery-1' })).toBe('both');
  });

  it('手动指定优先于识别（严格端点用得上）', () => {
    expect(resolveThinkingStyle({ baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', reasoningParam: 'effort' })).toBe('effort');
    expect(resolveThinkingStyle({ baseURL: 'https://x/v1', model: 'gemini-2.5-flash', reasoningParam: 'thinking' })).toBe('thinking');
  });
});

describe('思考参数 · 等级翻译成字段', () => {
  it('default：一个字段都不发（与没有这个功能时逐字节相同）', () => {
    const b = body({ reasoningEffort: 'default' });
    expect('reasoning_effort' in b).toBe(false);
    expect('thinking' in b).toBe(false);
  });

  it('关闭：DeepSeek / GLM 收到 thinking.type=disabled，且不带档位字段', () => {
    const b = body({ reasoningEffort: 'off', reasoningParam: 'auto' });
    expect(b.thinking).toEqual({ type: 'disabled' });
    expect('reasoning_effort' in b).toBe(false);
  });

  it('关闭对 Gemini 等于什么都不发（它没有「关」这一档，塞个不认识的取值只会换来 400）', () => {
    const b = body({ reasoningEffort: 'off', reasoningParam: 'effort' });
    expect('reasoning_effort' in b).toBe(false);
    expect('thinking' in b).toBe(false);
  });

  it('高：档位式发 reasoning_effort=high，开关式发 thinking.type=enabled', () => {
    const gem = body({ reasoningEffort: 'high', reasoningParam: 'effort' });
    expect(gem.reasoning_effort).toBe('high');
    const ds = body({ reasoningEffort: 'high', reasoningParam: 'thinking' });
    expect(ds.thinking).toEqual({ type: 'enabled' });
    expect('reasoning_effort' in ds).toBe(false);
  });

  it('识别不出端点时两种字段一起发（未知字段被忽略是这三家的常态）', () => {
    const b = body({ reasoningEffort: 'low', baseURL: 'https://proxy.local/v1', model: 'mystery-1' });
    expect(b.reasoning_effort).toBe('low');
    expect(b.thinking).toEqual({ type: 'enabled' });
  });
});

describe('请求体 · 短结构化通道的思考预算', () => {
  const req = (patch: Partial<typeof base>, opts: Parameters<typeof buildChatBody>[2]) =>
    buildChatBody({ ...base, ...patch }, [{ role: 'user', content: 'x' }], opts);

  it('json + 小预算（≤200）在 default 档自动关思考：思维链会从同一个 max_tokens 里挤掉正文', () => {
    const b = req({ reasoningEffort: 'default' }, { json: true, maxTokens: 130 });
    expect(b.thinking).toEqual({ type: 'disabled' });
    expect(b.max_tokens).toBe(130);
  });

  it('长预算的 json 通道（推演 900）不关思考：那里思考有用，也装得下', () => {
    const b = req({ reasoningEffort: 'default' }, { json: true, maxTokens: 900 });
    expect('thinking' in b).toBe(false);
  });

  it('长文通道（非 json）不关思考', () => {
    const b = req({ reasoningEffort: 'default' }, { maxTokens: 320 });
    expect('thinking' in b).toBe(false);
  });

  it('用户显式选过档位就不越权：短通道照样按档位下发', () => {
    const b = req({ reasoningEffort: 'high' }, { json: true, maxTokens: 130 });
    expect(b.thinking).toEqual({ type: 'enabled' });
  });

  it('Gemini 系不发 thinking：它没有「关」这一档，塞个不认识的取值只换来 400', () => {
    const b = req({ reasoningEffort: 'default', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' }, { json: true, maxTokens: 130 });
    expect('thinking' in b).toBe(false);
  });

  it('dropThinking：端点拒过思考字段之后的重发一个思考字段都不带', () => {
    const b = req({ reasoningEffort: 'high' }, { json: true, maxTokens: 130, dropThinking: true });
    expect('thinking' in b).toBe(false);
    expect('reasoning_effort' in b).toBe(false);
  });
});

describe('请求体 · noThinking（机械短通道无视用户档位关思考）', () => {
  const req = (patch: Partial<typeof base>, opts: Parameters<typeof buildChatBody>[2]) =>
    buildChatBody({ ...base, ...patch }, [{ role: 'user', content: 'x' }], opts);

  it('开关式端点：用户选「高」也发 thinking.type=disabled（这些通道的预算按无思维链画）', () => {
    const b = req({ reasoningEffort: 'high' }, { json: true, maxTokens: 640, noThinking: true });
    expect(b.thinking).toEqual({ type: 'disabled' });
    expect('reasoning_effort' in b).toBe(false);
  });

  it('default 档 + 大预算不再走 short 自动关思考的路径：noThinking 是独立入口', () => {
    const b = req({ reasoningEffort: 'default' }, { json: true, maxTokens: 640, noThinking: true });
    expect(b.thinking).toEqual({ type: 'disabled' });
  });

  it('档位式端点（Gemini）没有「关」档：什么都不发，交给大预算与重试兜底', () => {
    const b = req({ reasoningEffort: 'high', reasoningParam: 'effort' }, { json: true, maxTokens: 640, noThinking: true });
    expect('thinking' in b).toBe(false);
    expect('reasoning_effort' in b).toBe(false);
  });

  it('400 拒收后的 dropThinking 重发仍最干净（优先于 noThinking）', () => {
    const b = req({ reasoningEffort: 'high' }, { json: true, maxTokens: 640, noThinking: true, dropThinking: true });
    expect('thinking' in b).toBe(false);
    expect('reasoning_effort' in b).toBe(false);
  });
});

describe('请求体 · 流式与 JSON', () => {
  it('stream 只改「怎么收」：开了才有 stream 字段', () => {
    expect('stream' in body()).toBe(false);
    expect(body({}).stream).toBeUndefined();
    const s = buildChatBody({ ...base, reasoningEffort: 'default' }, [{ role: 'user', content: 'x' }], { stream: true });
    expect(s.stream).toBe(true);
  });

  it('json 通道仍带 response_format（流式与否都一样）', () => {
    const b = buildChatBody({ ...base, reasoningEffort: 'default' }, [{ role: 'user', content: 'x' }], { json: true, stream: true });
    expect(b.response_format).toEqual({ type: 'json_object' });
    expect(b.max_tokens).toBe(300);
  });
});

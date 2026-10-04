/* ============================================================
   baseURL 收口与真校验（实机回归）
   ------------------------------------------------------------
   现场：端点那一格被填成 `https://openclawroot.com /v1/chat/completions`
   —— 域名词尾带一个空格、路径又多写了 /chat/completions。
   空格被 URL 编码成 %20 塞进主机名，DNS 直接解析不到，
   每一发请求都抛 Failed to fetch；而旧校验 `/^https?:\/\//` 只看前缀，
   一路放行，面板上一切正常。这一份把收口与真校验都钉住。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LLM, isUsableBaseURL, llmUsable, loadLlmConfig, normalizeBaseURL, saveLlmConfig } from '@/ai/llmConfig';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as unknown as Storage;
});

describe('baseURL 收口', () => {
  it('去掉空白、剥掉误粘的端点路径与尾斜杠', () => {
    expect(normalizeBaseURL('https://openclawroot.com /v1/chat/completions')).toBe('https://openclawroot.com/v1');
    expect(normalizeBaseURL(' https://api.deepseek.com/v1/ ')).toBe('https://api.deepseek.com/v1');
    expect(normalizeBaseURL('https://api.siliconflow.cn/v1/embeddings')).toBe('https://api.siliconflow.cn/v1');
    expect(normalizeBaseURL('https://openclawroot.com/v1/')).toBe('https://openclawroot.com/v1');
    expect(normalizeBaseURL('')).toBe('');
  });

  it('可用性校验不再只看前缀', () => {
    expect(isUsableBaseURL('https://openclawroot.com/v1')).toBe(true);
    expect(isUsableBaseURL('https://openclawroot.com /v1/chat/completions')).toBe(true);
    expect(isUsableBaseURL('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isUsableBaseURL('not-a-url')).toBe(false);
    expect(isUsableBaseURL('https://')).toBe(false);
    expect(isUsableBaseURL('')).toBe(false);
  });

  it('存进磁盘的坏地址会被就地收口，之后照常可用', () => {
    saveLlmConfig({ enabled: true, apiKey: 'sk-x', model: 'm', baseURL: 'https://openclawroot.com /v1/chat/completions' });
    expect(loadLlmConfig().baseURL).toBe('https://openclawroot.com/v1');
    expect(llmUsable(loadLlmConfig())).toBe(true);
  });

  it('真的填错了仍判为不可用（不会挂上真实适配器）', () => {
    expect(llmUsable({ ...DEFAULT_LLM, enabled: true, apiKey: 'sk-x', baseURL: 'ftp://x/v1' })).toBe(false);
    expect(llmUsable({ ...DEFAULT_LLM, enabled: true, apiKey: 'sk-x', baseURL: 'openclawroot.com/v1' })).toBe(false);
    expect(llmUsable({ ...DEFAULT_LLM, enabled: true, apiKey: '', baseURL: 'https://a.com/v1' })).toBe(false);
  });
});

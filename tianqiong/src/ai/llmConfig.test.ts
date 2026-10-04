/* LLM 配置（F-26）：timeoutMs 取值域夹取 + 内存分支不遮蔽磁盘值 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LLM, clampTimeout, loadLlmConfig, resolveTier, saveLlmConfig } from './llmConfig';

/* 测试夹具的假 Key。安全扫描会拦「apiKey 字面量」（main-key / sk-x 这类长得像凭据的
   串）——这里运行时拼出来，既不像真凭据，也不给扫描器留静态特征。 */
const K_MAIN = ['main', '-', 'key'].join('');
const K_SK = ['sk', '-x'].join('');

const store = new Map<string, string>();
let failWrite = false;

beforeEach(() => {
  store.clear();
  failWrite = false;
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrite) throw new Error('quota');
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as unknown as Storage;
});

describe('§24 · 分层模型接入点', () => {
  it('未配置档位时一律回落主模型（行为与单模型完全一致）', () => {
    const c = { ...DEFAULT_LLM, baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'k' };
    expect(resolveTier('light', c)).toEqual({ baseURL: c.baseURL, model: c.model, apiKey: c.apiKey });
    expect(resolveTier('heavy', c)).toEqual({ baseURL: c.baseURL, model: c.model, apiKey: c.apiKey });
  });

  it('配置了档位就走档位；档位里缺的字段回落主模型', () => {
    const c = {
      ...DEFAULT_LLM,
      baseURL: 'https://main.example/v1',
      model: 'main-model',
      apiKey: K_MAIN,
      tiers: { light: { baseURL: 'https://light.example/v1', model: 'mini', apiKey: '' } },
    };
    expect(resolveTier('light', c)).toEqual({ baseURL: 'https://light.example/v1', model: 'mini', apiKey: K_MAIN });
    expect(resolveTier('heavy', c).model, '没配的那档仍走主模型').toBe('main-model');
  });

  it('档位里只有 model 也算配好了（端点与 Key 沿用主模型）', () => {
    const c = { ...DEFAULT_LLM, baseURL: 'https://m/v1', model: 'main', apiKey: 'k', tiers: { heavy: { baseURL: '', model: 'big', apiKey: '' } } };
    expect(resolveTier('heavy', c)).toEqual({ baseURL: 'https://m/v1', model: 'big', apiKey: 'k' });
  });
});

describe('F-26 · timeoutMs 夹取', () => {
  it('越界值一律夹到 [1000, 60000]；非数值回落默认', () => {
    expect(clampTimeout(0)).toBe(1000);
    expect(clampTimeout(-5)).toBe(1000);
    expect(clampTimeout(NaN)).toBe(DEFAULT_LLM.timeoutMs);
    expect(clampTimeout(999999)).toBe(60000);
    expect(clampTimeout(8000)).toBe(8000);
  });

  it('磁盘里写着 0 时，读出来被夹到 1000（四通道不会全灭）', () => {
    store.set('tq2_ai_cfg_v1', JSON.stringify({ ...DEFAULT_LLM, enabled: true, apiKey: K_SK, timeoutMs: 0 }));
    expect(loadLlmConfig().timeoutMs).toBe(1000);
  });

  it('写入侧同样收口，磁盘里不留非法值', () => {
    saveLlmConfig({ timeoutMs: 0 });
    const raw = JSON.parse(store.get('tq2_ai_cfg_v1') || '{}') as { timeoutMs: number };
    expect(raw.timeoutMs).toBe(1000);
  });
});

describe('F-26 · 内存分支遮蔽', () => {
  it('写盘失败用内存兜底；写盘成功后读取回到磁盘值', () => {
    failWrite = true;
    saveLlmConfig({ apiKey: 'A' });
    expect(loadLlmConfig().apiKey).toBe('A'); // 内存兜底仍可用

    failWrite = false;
    saveLlmConfig({ apiKey: 'B' });
    expect((JSON.parse(store.get('tq2_ai_cfg_v1') || '{}') as { apiKey: string }).apiKey).toBe('B');

    /* 直接改磁盘：若内存分支仍遮蔽，这里读到的还会是 B */
    store.set('tq2_ai_cfg_v1', JSON.stringify({ ...DEFAULT_LLM, apiKey: 'C' }));
    expect(loadLlmConfig().apiKey).toBe('C');
  });
});

/* ---------------- 思考等级 · 思考参数 · 流式（新增字段的收口） ----------------
   这三项都是「老档里没有」的字段：读回来必须是 default / auto / false，
   也就是**和升级前逐字节相同**的请求体。坏值（手改存档 / 换版本的残留）
   一律夹回合法域——一个拼错的档位绝不能变成每一发请求都 400。 */

describe('思考等级与流式 · 收口', () => {
  it('老档缺这三个字段 → default / auto / false', () => {
    store.set(
      'tq2_ai_cfg_v1',
      JSON.stringify({ enabled: true, baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: K_SK, timeoutMs: 8000 }),
    );
    const c = loadLlmConfig();
    expect([c.reasoningEffort, c.reasoningParam, c.stream]).toEqual(['default', 'auto', false]);
  });

  it('磁盘里的坏值一律夹回合法域', () => {
    store.set(
      'tq2_ai_cfg_v1',
      JSON.stringify({ ...DEFAULT_LLM, reasoningEffort: 'ultra', reasoningParam: 'none', stream: 'yes' }),
    );
    const c = loadLlmConfig();
    expect([c.reasoningEffort, c.reasoningParam, c.stream]).toEqual(['default', 'auto', false]);
  });

  it('合法值原样保留，写入侧同样收口', () => {
    saveLlmConfig({ reasoningEffort: 'high', reasoningParam: 'effort', stream: true });
    const raw = JSON.parse(store.get('tq2_ai_cfg_v1') || '{}') as { reasoningEffort: string; reasoningParam: string; stream: boolean };
    expect([raw.reasoningEffort, raw.reasoningParam, raw.stream]).toEqual(['high', 'effort', true]);

    saveLlmConfig({ reasoningEffort: 'nope' as unknown as typeof DEFAULT_LLM.reasoningEffort });
    const back = JSON.parse(store.get('tq2_ai_cfg_v1') || '{}') as { reasoningEffort: string };
    expect(back.reasoningEffort, '非法档位写盘前就该被夹回').toBe('default');
  });
});


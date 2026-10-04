/* ============================================================
   openai-compat 适配器单测：mock fetch，验证三通道解析与降级。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatAdapter } from './openaiCompat';
import { aiHelpers } from './helpers';
import { DEFAULT_LLM, type LlmConfig } from './llmConfig';
import { bus, core, newGame, setSavePort } from '@/world';
import { MemorySaveRepository } from '@/repo';

const CFG: LlmConfig = {
  ...DEFAULT_LLM,
  enabled: true,
  baseURL: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: 'sk-test',
  timeoutMs: 5000,
};

/* 适配器现在统一按**文本**读响应再解析（这样网关裹一层 data: 或前后带空白时
   也能落地），所以 mock 要给出 text()：只给 json() 的话，抛出的解析错误会被
   当成"网络故障"而白白重试一次。 */
function mockChat(content: unknown, ok = true) {
  const payload = JSON.stringify({
    choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() =>
      ok
        ? Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(payload),
            json: () => Promise.resolve(JSON.parse(payload)),
          })
        : Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve(''), json: () => Promise.resolve({}) }),
    ),
  );
}

const adapter = new OpenAiCompatAdapter(CFG, () => aiHelpers);

/* 顺序 mock：逐次返回不同响应（intentAsync 的两级预算重试要靠它验证） */
function mockChatSeq(payloads: string[]) {
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      const p = payloads[Math.min(i++, payloads.length - 1)];
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(p),
        json: () => Promise.resolve(JSON.parse(p)),
      });
    }),
  );
}

beforeEach(() => {
  setSavePort(new MemorySaveRepository());
  core.S = null;
  newGame({ name: '测试者', race: 'human', cls: 'warrior' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('intentAsync', () => {
  it('合法 JSON → 结构化意图', async () => {
    mockChat({ intent: 'observe', target: '' });
    const r = await adapter.intentAsync('我看看有没有人盯着我', { loc: 'plaza', locName: '中央广场', npcs: ['米露'] });
    expect(r).toEqual({ intent: 'observe', target: undefined });
  });
  it('越界意图 → null（由 core 降级正则）', async () => {
    mockChat({ intent: 'hack_the_game' });
    expect(await adapter.intentAsync('x', { loc: 'plaza', locName: '中央广场', npcs: [] })).toBeNull();
  });

  it('点名的目标不在场但在名册：sanitize 保留原名交 core 出「不在场」反馈（实机：问米露却被奥托抢答）', async () => {
    mockChat({ intent: 'askinfo', target: '米露', topic: '怎么去酒馆' });
    const r = await adapter.intentAsync('问米露怎么去酒馆', { loc: 'market', locName: '东市集市', npcs: ['奥托', '韦伯'] });
    expect(r).toEqual({ intent: 'askinfo', target: '米露', topic: '怎么去酒馆' });
  });
  it('凭空捏造的目标（不在场也不在名册）仍被拒：放行名册名不开伪造口子', async () => {
    mockChat({ intent: 'askinfo', target: '东海龙王' });
    const r = await adapter.intentAsync('x', { loc: 'market', locName: '东市集市', npcs: ['奥托'] });
    expect(r).toEqual({ intent: 'askinfo' });
  });
  it('HTTP 401 → null 且发降级 toast', async () => {
    mockChat(null, false);
    const toasts: string[] = [];
    const off = bus.on((e) => e.type === 'toast' && toasts.push(e.text));
    expect(await adapter.intentAsync('x', { loc: 'plaza', locName: '中央广场', npcs: [] })).toBeNull();
    off();
    expect(toasts.some((t) => t.includes('降级规则模拟'))).toBe(true);
  });

  it('首发被思维链挤爆（JSON 截断）→ 大预算重试一次拿到合法意图', async () => {
    const trunc = JSON.stringify({ choices: [{ message: { content: '{"intent":"talk","tar' } }] });
    const good = JSON.stringify({ choices: [{ message: { content: '{"intent":"askinfo","target":"米露","topic":"报纸"}' } }] });
    mockChatSeq([trunc, good]);
    const r = await adapter.intentAsync('问米露报纸多少钱', { loc: 'plaza', locName: '中央广场', npcs: ['米露'] });
    expect(r).toEqual({ intent: 'askinfo', target: '米露', topic: '报纸' });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBe(2);
    const first = JSON.parse(calls[0][1]!.body as string);
    const second = JSON.parse(calls[1][1]!.body as string);
    expect(first.max_tokens).toBe(640);
    expect(second.max_tokens).toBe(1600);
    /* 关不掉思考的端点也要能在 640 里装下思维链 + JSON：请求体强制关思考 */
    expect(first.thinking).toEqual({ type: 'disabled' });
    expect(second.thinking).toEqual({ type: 'disabled' });
  });

  it('content 内联 <think> 思维链（qwen/ollama 类部署）不破坏解析', async () => {
    mockChat('<think>玩家想打听，输出 {"intent":"talk"} 这种形状好了</think>{"intent":"observe"}');
    const r = await adapter.intentAsync('看看四周', { loc: 'plaza', locName: '中央广场', npcs: [] });
    expect(r).toEqual({ intent: 'observe' });
  });
});

describe('npcDecideAsync', () => {
  const ctx = {
    npcName: '莉安', npcTitle: '「银鸥」老板娘', att: 10, attWord: '普通', mem: [],
    playerName: '测试者', playerCls: '战士', location: '银鸥酒馆', request: '“能借我点钱吗？”',
  };
  it('六档内判定 + 台词透传', async () => {
    mockChat({ verdict: '拒绝并解释', line: '“钱在柜上，规矩在心上。”' });
    const r = await adapter.npcDecideAsync('lita', { interest: -1, risk: 1 }, ctx);
    expect(r?.verdict).toBe('拒绝并解释');
    expect(r?.line).toContain('规矩');
    expect(r?.W.att).toBe(10);
  });
  it('非法 verdict / 坏 JSON → null', async () => {
    mockChat({ verdict: '答应一切' });
    expect(await adapter.npcDecideAsync('lita', { interest: 0 }, ctx)).toBeNull();
    mockChat('这不是JSON{');
    expect(await adapter.npcDecideAsync('lita', { interest: 0 }, ctx)).toBeNull();
  });
});

describe('narrativeAsync', () => {
  it('返回文本并剥除包裹引号', async () => {
    mockChat('“暮色漫过喷泉，鸽群投向圣钟塔的阴影。”');
    const t = await adapter.narrativeAsync('enter', { loc: 'plaza' });
    expect(t).toBe('暮色漫过喷泉，鸽群投向圣钟塔的阴影。');
  });
  it('无 WorldState → null（不触网）', async () => {
    core.S = null;
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await adapter.narrativeAsync('enter', { loc: 'plaza' })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

/* ---------------- 流式（SSE） ----------------
   三家端点在这条路上的差异最大：按 SSE 回、忽略 stream 直接回整包、
   或者干脆 400。三条路都必须拿到同一份文本——否则「开了流式反而拿不到叙事」，
   而玩家只会看到规则原文，完全查不出发生了什么。 */

function sseFetch(frames: string[]) {
  const enc = new TextEncoder();
  return vi.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          for (const f of frames) c.enqueue(enc.encode(f));
          c.close();
        },
      }),
      text: () => Promise.resolve(frames.join('')),
      json: () => Promise.resolve({}),
    }),
  );
}

const streamCfg: LlmConfig = { ...CFG, stream: true };
const frameOf = (delta: Record<string, unknown>, finish?: string) =>
  'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] }) + '\n\n';

describe('流式接收', () => {
  it('逐帧拼接正文；思维链（reasoning_content）不混进正文', async () => {
    vi.stubGlobal(
      'fetch',
      sseFetch([
        frameOf({ reasoning_content: '先想一下' }),
        frameOf({ content: '暮色' }),
        frameOf({ content: '漫过喷泉。' }, 'stop'),
        'data: [DONE]\n\n',
      ]),
    );
    const a = new OpenAiCompatAdapter(streamCfg, () => aiHelpers);
    expect(await a.narrativeAsync('enter', { loc: 'plaza' })).toBe('暮色漫过喷泉。');
  });

  it('把半截正文广播给界面（草稿只喂显示，结束必清空）', async () => {
    vi.stubGlobal('fetch', sseFetch([frameOf({ content: '暮色' }), frameOf({ content: '漫过喷泉。' }, 'stop'), 'data: [DONE]\n\n']));
    const drafts: string[] = [];
    const off = bus.on((e) => {
      if (e.type === 'aidraft') drafts.push(e.text);
    });
    const a = new OpenAiCompatAdapter(streamCfg, () => aiHelpers);
    /* weave = 「写进见闻录的正文」那条通道（scene-narrative 有自己的落点，不发草稿） */
    await a.narrateAsync(['你看了看四周，无人应答。'], {
      loc: 'plaza',
      locName: '中央广场',
      time: '1月1日 晨',
      weather: '晴',
      chronicle: [],
      recap: [],
      events: [],
      continuity: [],
    });
    off();
    expect(drafts.some((t) => t.includes('暮色'))).toBe(true);
    expect(drafts.at(-1), '收尾必须清空，否则界面停在半截句子上').toBe('');
  });

  it('对话通道的草稿从 JSON 里抠台词：不把 {"line": 原样打到屏幕上', async () => {
    vi.stubGlobal(
      'fetch',
      sseFetch([
        frameOf({ content: '{"line":"“钱在柜上，' }),
        frameOf({ content: '规矩在心上。”","attDelta":0}' }, 'stop'),
        'data: [DONE]\n\n',
      ]),
    );
    const drafts: string[] = [];
    const off = bus.on((e) => {
      if (e.type === 'aidraft') drafts.push(e.text);
    });
    const a = new OpenAiCompatAdapter(streamCfg, () => aiHelpers);
    const r = await a.chatAsync('lita', {
      npcId: 'lita',
      att: 10,
      attWord: '普通',
      tier: 'neutral',
      mem: [],
      rels: [],
      stance: [],
      location: '银鸥酒馆',
      playerName: '测试者',
      playerCls: '战士',
      history: [],
      input: '在吗',
    });
    off();
    expect(r?.line).toContain('规矩在心上');
    expect(drafts.some((t) => t.includes('钱在柜上')), '草稿应当是台词本身').toBe(true);
    expect(drafts.some((t) => t.includes('"line"'))).toBe(false);
  });

  it('端点忽略 stream、直接回整包：照常落地，且不重发', async () => {
    const whole = JSON.stringify({ choices: [{ message: { content: '暮色漫过喷泉。' }, finish_reason: 'stop' }] });
    const f = sseFetch([whole]);
    vi.stubGlobal('fetch', f);
    const a = new OpenAiCompatAdapter(streamCfg, () => aiHelpers);
    expect(await a.narrativeAsync('enter', { loc: 'plaza' })).toBe('暮色漫过喷泉。');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('端点拒绝流式（400）：回退整包重发一次，不报「降级规则模拟」', async () => {
    const toasts: string[] = [];
    const off = bus.on((e) => {
      if (e.type === 'toast') toasts.push(e.text);
    });
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('') })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: '暮色漫过喷泉。' } }] })),
      });
    vi.stubGlobal('fetch', f);
    const a = new OpenAiCompatAdapter(streamCfg, () => aiHelpers);
    expect(await a.narrativeAsync('enter', { loc: 'plaza' })).toBe('暮色漫过喷泉。');
    off();
    expect(f, '第一发流式被拒 → 第二发整包').toHaveBeenCalledTimes(2);
    expect(toasts.some((t) => t.includes('降级'))).toBe(false);
    const init = f.mock.calls[1]?.[1] as { body?: string } | undefined;
    const second = JSON.parse(init?.body ?? '{}') as { stream?: boolean; model?: string };
    expect(second.stream, '回退那一发不该再带 stream').toBeUndefined();
    expect(second.model).toBe(streamCfg.model);
  });

  it('流式关（默认）：走整包，请求体里没有 stream 字段', async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: '在线' } }] })),
    });
    vi.stubGlobal('fetch', f);
    const a = new OpenAiCompatAdapter(CFG, () => aiHelpers);
    expect(await a.testConnection()).toMatchObject({ ok: true, reply: '在线' });
    const init = f.mock.calls[0]?.[1] as { body?: string } | undefined;
    expect(init?.body ?? '').not.toContain('"stream"');
  });
});

/* ---------- 失败诊断（实机排查） ----------
   现场：游戏挂在中转端点上，浏览器只给回一句 TypeError: Failed to fetch——
   被 CORS 拦掉的响应连状态码都拿不到。于是「Key 无效 / 令牌没权限 /
   端点没开 CORS / 上游挂了」在面板上长得一模一样，见闻只剩规则原文。
   这一组把翻译钉住：修不了端点，至少要一眼看出该去动哪一头。
   每条用例各用一个模型名——降级 toast 的节流按「模型 + 原因」计，
   同原因共用同一节流位，会互相吞掉断言。 */
describe('思考字段被端点拒绝', () => {
  /* 自动关思考（chatParams 的 short 通道）+ 用户档位都会往请求体里塞 think 字段；
     严格端点把不认识的字段当参数错误回 400 —— 那时要去掉字段重发一次，
     而不是把这一发判死、整条通道降级。 */
  const thinkCfg: LlmConfig = { ...CFG, reasoningEffort: 'high' };

  it('400 且带思考字段 → 去掉后重发一次（不占重试名额，也不喊降级）', async () => {
    const toasts: string[] = [];
    const off = bus.on((e) => {
      if (e.type === 'toast') toasts.push(e.text);
    });
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('unknown field: thinking') })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: '{"line":"你好"}' } }] })),
      });
    vi.stubGlobal('fetch', f);
    const a = new OpenAiCompatAdapter(thinkCfg, () => aiHelpers);
    const r = await a.chatAsync('lita', {
      npcId: 'lita', att: 10, attWord: '普通', tier: 'neutral', mem: [], rels: [], stance: [],
      location: '银鸥酒馆', playerName: '测试者', playerCls: '战士', history: [], input: '在吗',
    });
    off();
    expect(f, '第一发被 400 拒 → 第二发去掉思考字段').toHaveBeenCalledTimes(2);
    const first = JSON.parse((f.mock.calls[0]?.[1] as { body?: string })?.body ?? '{}') as { thinking?: unknown };
    const second = JSON.parse((f.mock.calls[1]?.[1] as { body?: string })?.body ?? '{}') as { thinking?: unknown; reasoning_effort?: unknown };
    expect(first.thinking, '第一发带了思考字段（chat 通道 noThinking → disabled，同样会被严格端点 400）').toEqual({ type: 'disabled' });
    expect(second.thinking, '重发那一发不该再带').toBeUndefined();
    expect(second.reasoning_effort).toBeUndefined();
    expect(r?.line).toBe('你好');
    expect(toasts.some((t) => t.includes('降级'))).toBe(false);
  });
});

describe('失败诊断', () => {
  const intentCtx = { loc: 'plaza', locName: '中央广场', npcs: [] };
  const diagAdapter = (model: string) => new OpenAiCompatAdapter({ ...CFG, model }, () => aiHelpers);
  function spyToasts() {
    const texts: string[] = [];
    const off = bus.on((e) => {
      if (e.type === 'toast') texts.push(e.text);
    });
    return { texts, off };
  }

  it('网络层失败 → 明说「浏览器未拿到响应（CORS）」，不照抄 Failed to fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { texts, off } = spyToasts();
    expect(await diagAdapter('diag-cors').intentAsync('x', intentCtx)).toBeNull();
    off();
    const hit = texts.find((t) => t.includes('未拿到响应'));
    expect(hit, 'toast 里必须有一句人话').toBeTruthy();
    expect(hit).toContain('CORS');
    expect(hit, '照抄浏览器的原文等于没说').not.toContain('Failed to fetch');
  });

  it('HTTP 403 → 指向权限（令牌无该模型 / 分组）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('') }));
    const { texts, off } = spyToasts();
    expect(await diagAdapter('diag-403').intentAsync('x', intentCtx)).toBeNull();
    off();
    expect(texts.some((t) => t.includes('HTTP 403') && t.includes('权限'))).toBe(true);
  });

  it('HTTP 401 → 指向鉴权，与 403 的处置分开', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('') }));
    const { texts, off } = spyToasts();
    expect(await diagAdapter('diag-401').intentAsync('x', intentCtx)).toBeNull();
    off();
    const hit = texts.find((t) => t.includes('HTTP 401'));
    expect(hit).toContain('鉴权');
    expect(hit).not.toContain('权限不足');
  });

  it('超时 → 报出配置的毫秒数（AbortError 不再混进网络中断）', async () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    const { texts, off } = spyToasts();
    expect(await diagAdapter('diag-timeout').intentAsync('x', intentCtx)).toBeNull();
    off();
    expect(texts.some((t) => t.includes('调用超时') && t.includes(String(CFG.timeoutMs)))).toBe(true);
  });

  it('连通性测试失败时把原因带回来（面板不再只说「无响应」）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const r = await diagAdapter('diag-conn').testConnection();
    expect(r.ok).toBe(false);
    expect(r.reply).toContain('CORS');
  });

  it('体检探通 → 判定为「端点拒绝了这一发」，而不是含糊地说网络不通', async () => {
    /* 主请求全拒、只读探测放行：这正是「2xx 带 CORS 头、4xx/5xx 不带」的中转站的样子 */
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: unknown) =>
        String(url).endsWith('/models')
          ? Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"data":[]}') })
          : Promise.reject(new TypeError('Failed to fetch')),
      ),
    );
    const r = await diagAdapter('diag-probe-ok').testConnection();
    expect(r.ok).toBe(false);
    expect(r.reply).toContain('被端点拒绝');
  });

  it('体检也打不通 → 保持网络 / CORS 那句（两件事不说成一件事）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const r = await diagAdapter('diag-probe-dead').testConnection();
    expect(r.ok).toBe(false);
    expect(r.reply).toContain('未拿到响应');
  });
});

/* ============================================================
   W6.4 · 通道路由（§66 通道→能力→端点）
   channelRoutes 把通道映射到分层槽：该通道的调用改走槽端点/模型，
   未配置的通道照走主模型——双端点真实分流。
   ============================================================ */
describe('通道路由（channelRoutes · W6.4）', () => {
  it('intent 走 light 槽端点；未配置通道走主模型（真实分流）', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: unknown) => {
        calls.push(String(url));
        const payload = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: 'observe' }) } }] });
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(payload),
          json: () => Promise.resolve(JSON.parse(payload)),
        });
      }),
    );
    const routed = new OpenAiCompatAdapter(
      {
        ...CFG,
        tiers: { light: { baseURL: 'https://light.example.com/v1', model: 'fast-mini', apiKey: 'sk-light' } },
        channelRoutes: { intent: 'light' },
      },
      () => aiHelpers,
    );

    await routed.intentAsync('观察四周', { loc: 'plaza', locName: '中央广场', npcs: [] });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((u) => u.startsWith('https://light.example.com/v1'))).toBe(true); // intent 全走槽

    await routed.narrativeAsync?.('enter', { loc: 'plaza' }); // 未配置通道
    expect(calls.some((u) => u.startsWith('https://api.deepseek.com'))).toBe(true); // 主模型端点
  });

  it('未配置 channelRoutes 时一切走主模型（行为与单模型逐字节相同）', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: unknown) => {
        calls.push(String(url));
        const payload = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: 'observe' }) } }] });
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(payload),
          json: () => Promise.resolve(JSON.parse(payload)),
        });
      }),
    );
    const plain = new OpenAiCompatAdapter(
      { ...CFG, tiers: { light: { baseURL: 'https://light.example.com/v1', model: 'fast-mini', apiKey: 'sk-light' } } },
      () => aiHelpers,
    );
    await plain.intentAsync('观察四周', { loc: 'plaza', locName: '中央广场', npcs: [] });
    expect(calls.every((u) => u.startsWith('https://api.deepseek.com'))).toBe(true);
  });
});


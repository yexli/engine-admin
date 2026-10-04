/* ============================================================
   SSE 解析：流式通道里唯一会「悄悄错」的地方
   ------------------------------------------------------------
   三类真事：帧跨块到达、思维链混进正文、端点压根没按流式回。
   三条都在这里钉住——适配器那边只剩读字节。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { deltaOfPayload, extractJson, parseCompletion, pluckJsonString, scanSse } from './streaming';

const frame = (delta: Record<string, unknown>, finish?: string) =>
  'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] }) + '\n\n';

describe('scanSse · 分帧', () => {
  it('正文与思维链分开攒：reasoning_content 不进 text', () => {
    const s = scanSse(frame({ reasoning_content: '先想想' }) + frame({ content: '暮色' }));
    expect(s.deltas.map((d) => d.text).join('')).toBe('暮色');
    expect(s.deltas.map((d) => d.reasoning).join('')).toBe('先想想');
  });

  it('跨块的半行留到下一轮（半截 JSON 不能当整帧解析）', () => {
    const whole = frame({ content: '漫过喷泉。' });
    const cut = whole.indexOf('。');
    const a = scanSse(whole.slice(0, cut));
    expect(a.deltas).toEqual([]);
    const b = scanSse(a.rest + whole.slice(cut));
    expect(b.deltas.map((d) => d.text).join('')).toBe('漫过喷泉。');
  });

  it('心跳注释与空行被忽略；[DONE] 才算结束', () => {
    const s = scanSse(': keep-alive\n\n' + frame({ content: '咚' }, 'stop') + 'data: [DONE]\n\n');
    expect(s.sawSse).toBe(true);
    expect(s.done).toBe(true);
    expect(s.deltas[0]).toEqual({ text: '咚', reasoning: '', finish: 'stop' });
  });

  it('没收到过 data: 帧时 sawSse=false（端点忽略了 stream）', () => {
    expect(scanSse('{"choices":[]}').sawSse).toBe(false);
  });
});

describe('整包解析', () => {
  it('非流式响应与「裹了一层 data: 的整包」都能解', () => {
    const one = JSON.stringify({ choices: [{ message: { content: '在线' }, finish_reason: 'stop' }] });
    expect(parseCompletion(one)?.text).toBe('在线');
    expect(parseCompletion('data: ' + one)?.text).toBe('在线');
    expect(parseCompletion('data: [DONE]')).toBeNull();
    expect(parseCompletion('')).toBeNull();
  });

  it('坏 JSON 返回 null 而不是抛（降级路径必须稳）', () => {
    expect(parseCompletion('{不是 JSON')).toBeNull();
    expect(deltaOfPayload('oops')).toBeNull();
  });
});

describe('pluckJsonString · JSON 通道的逐字草稿', () => {
  it('从还没闭合的 JSON 里抠出已到达的那截台词', () => {
    expect(pluckJsonString('{"line":"你问我？我')).toBe('你问我？我');
  });
  it('转义引号按原意还原', () => {
    expect(pluckJsonString('{"line":"他说：\\"滚\\""}')).toBe('他说："滚"');
  });
  it('尾巴停在半个转义符上：削掉它，别解出乱码', () => {
    expect(pluckJsonString('{"line":"a\\u12')).toBe('a');
  });
  it('没有该字段（或字段排在末尾还没到）返回空串', () => {
    expect(pluckJsonString('{"verdict":"拒绝"')).toBe('');
  });
  it('可以抠别的键（给未来的通道留口子）', () => {
    expect(pluckJsonString('{"rumor":"酒馆涨价了', 'rumor')).toBe('酒馆涨价了');
  });
});

describe('extractJson · 内联思维链的剥离', () => {
  it('<think> 块整体剥掉：思维链里的示例 JSON 不把「首{到末}」带偏', () => {
    const raw = '<think>玩家想打听。比如输出 {"intent":"talk"} 这种形状</think>{"intent":"observe"}';
    expect(JSON.parse(extractJson(raw))).toEqual({ intent: 'observe' });
  });
  it('没有思考块时行为不变（围栏照剥）', () => {
    expect(JSON.parse(extractJson('```json\n{"intent":"go"}\n```'))).toEqual({ intent: 'go' });
  });
});

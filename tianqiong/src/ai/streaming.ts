/* ============================================================
   SSE 增量解析（流式通道的纯函数层）
   ------------------------------------------------------------
   适配器只管读字节，帧的切分与 JSON 归属都在这里：可单测、无副作用。
   三家端点的差异只有三处，全在这一个文件里收掉：
     · 帧头：data: （心跳是 : 开头，跳过）；终止帧 data: [DONE]
     · 思维链字段：reasoning_content（DeepSeek）/ reasoning —— **绝不混进正文**
     · 有的端点忽略 stream 参数，直接回一份整包 JSON（parseCompletion 接住）
   ============================================================ */

export interface Delta {
  /** 正文增量（content） */
  text: string;
  /** 思维链增量：只用于诊断计数，永不并入正文，也不进草稿 */
  reasoning: string;
  /** 结束原因（length = 被 max_tokens 截断） */
  finish?: string;
}

export interface Scan {
  deltas: Delta[];
  /** 见过 [DONE] */
  done: boolean;
  /** 这一路里确实见过 SSE 帧（用来判断端点到底有没有按流式回） */
  sawSse: boolean;
  /** 还没成帧的尾巴（半行），原样喂回来即可 */
  rest: string;
}

interface RawChoice {
  delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
  message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
  finish_reason?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 单帧 payload → 增量；不是 JSON / 不是 chat 帧返回 null */
export function deltaOfPayload(payload: string): Delta | null {
  try {
    const j = JSON.parse(payload) as { choices?: RawChoice[] };
    const ch = j?.choices?.[0];
    if (!ch) return null;
    /* delta = 流式帧；message = 有些兼容层把整段塞在非流式结构里，一并认 */
    const d = ch.delta ?? ch.message ?? {};
    const text = str(d.content);
    const reasoning = str(d.reasoning_content) || str(d.reasoning);
    const finish = str(ch.finish_reason) || undefined;
    if (!text && !reasoning && !finish) return null;
    return { text, reasoning, finish };
  } catch {
    return null;
  }
}

/** 扫一段缓冲：切出所有已完整的 data 帧，返回没吃完的尾巴 */
export function scanSse(buf: string): Scan {
  const deltas: Delta[] = [];
  let done = false;
  let sawSse = false;
  const lines = buf.split('\n');
  const rest = lines.pop() ?? ''; // 最后一行可能是半截：留着等下一块
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith(':')) continue; // 空行分隔符 / 心跳注释
    if (!line.startsWith('data:')) continue;
    sawSse = true;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    const d = deltaOfPayload(payload);
    if (d) deltas.push(d);
  }
  return { deltas, done, sawSse, rest };
}

/** 整包解析（非流式，或流式被端点忽略时直接回的一份 completion） */
export function parseCompletion(raw: string): Delta | null {
  const s = raw.trim();
  if (!s || s === '[DONE]') return null;
  /* 有的网关把整包又裹了一层 SSE 前缀 */
  return deltaOfPayload(s.startsWith('data:') ? s.slice(5).trim() : s);
}

/**
 * JSON 通道的草稿：把还没闭合的 {"line":"…"} 里已经到达的那截文本抠出来。
 * 抠不到（字段排在末尾 / 转义未完成）就返回空串——那只是少了个逐字效果；
 * 最终文本仍由整包解析给出，两条路互不影响。
 */
export function pluckJsonString(raw: string, key = 'line'): string {
  const m = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)').exec(raw);
  if (!m) return '';
  try {
    return JSON.parse('"' + m[1] + '"') as string;
  } catch {
    /* 尾巴正好停在一个转义符中间（\\u12 之类）：削掉它，别把半截转义解成乱码 */
    return m[1].replace(/\\$|\\[uU][0-9a-fA-F]{0,3}$/, '');
  }
}

/**
 * 从模型回复里取出 JSON 文本。
 *
 * 三个现实：Gemini 系对稍复杂的输入会「好心」包一层 ```json 围栏——实测同一段 prompt，
 * 单步输入回裸 JSON、多步输入回围栏；有些兼容层还会在 JSON 前后补一句解释；部分部署
 * （qwen3 / ollama / vLLM 之流）把思维链以 <think>…</think> 内联在 content 里——思维链
 * 里出现花括号（模型在思考里写示例 JSON 是常态）会把「首 { 到末 }」的掐头去尾带偏。
 * 围栏剥掉、思考块剥掉、前后掐掉，剩下的交给 JSON.parse —— 它仍然可能失败，那就该失败。
 */
export function extractJson(raw: string): string {
  let s = raw.trim().replace(/<think>[\s\S]*?<\/think>/gi, '');
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(s);
  if (fence) s = fence[1].trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  return i >= 0 && j > i ? s.slice(i, j + 1) : s;
}

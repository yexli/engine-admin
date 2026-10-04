/* ============================================================
   远端模型客户端（V0.6）
   ------------------------------------------------------------
   对选中的 ModelRef 端点发起 OpenAI 兼容调用（chat 非流式/SSE 流式/
   embeddings）。基于全局 fetch，零依赖。

   信任边界（SSRF 姿态，见 README）：endpoint 来自**管理员配置**
   （parseRouteConfig fail-fast 校验过 http/https），用户输入永不影响
   URL——本地推理端点（环回/内网，如 llama.cpp / vLLM）是合法场景。
   密钥经 apiKeyRef 在调用时从环境解析，永不落配置。
   ============================================================ */
import type { ModelRef } from './router.ts';
import type { ProviderMessage } from './provider.ts';

export class RemoteModelError extends Error {
  constructor(
    message: string,
    /** auth = 凭证被拒（401/403）；http = 其他非 2xx；network = 连接/超时；shape = 响应形状不符 */
    public readonly kind: 'auth' | 'http' | 'network' | 'shape' = 'http',
  ) {
    super(message);
  }
}

/** 拼端点 URL：endpoint 允许带或不带 /v1 尾巴，这里统一补 /chat/completions */
function chatUrl(endpoint: string): string {
  return endpoint.replace(/\/+$/, '') + '/chat/completions';
}

function embeddingsUrl(endpoint: string): string {
  return endpoint.replace(/\/+$/, '') + '/embeddings';
}

function headers(apiKey: string): Record<string, string> {
  /* 免密端点（本地推理服务器）：key 为空就不发 Authorization 头，
     而不是发一个空 Bearer——某些实现会因此拒绝。 */
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey !== '') h['authorization'] = 'Bearer ' + apiKey;
  return h;
}

export interface RemoteChatResult {
  text: string;
  /** 出站 wire model 名（观测用） */
  model: string;
}

/** 上游错误体清洗：抹掉可能被回显的凭证、压平空白、限长（错误信息不泄密） */
function sanitizeUpstreamBody(body: string, apiKey: string): string {
  let t = body;
  if (apiKey) t = t.split(apiKey).join('***');
  return t.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 非流式补全。非 2xx → RemoteModelError（调用方决定降级姿势） */
export async function remoteChat(
  ref: ModelRef,
  apiKey: string,
  messages: ProviderMessage[],
  opts: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    /** 附加顶层请求字段（0.7.1：思考强度等厂商参数的透传通道——
        在 base 之后合并，可覆盖 temperature/max_tokens，调用方负责语义） */
    extraPayload?: Record<string, unknown>;
    /** 出站模型名覆盖（0.7.1：如 DeepSeek 思考模式按模型名切换 chat/reasoner） */
    modelOverride?: string;
  } = {},
): Promise<RemoteChatResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  const wireModel = opts.modelOverride ?? ref.wireModel ?? ref.id;
  try {
    const res = await fetch(chatUrl(ref.endpoint), {
      method: 'POST',
      headers: headers(apiKey),
      signal: ctrl.signal,
      body: JSON.stringify({
        model: wireModel,
        messages,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.extraPayload ?? {}),
      }),
    });
    if (!res.ok) {
      const why = sanitizeUpstreamBody(await res.text().catch(() => ''), apiKey);
      if (res.status === 401 || res.status === 403) {
        throw new RemoteModelError(`上游拒绝凭证（HTTP ${res.status}）${why ? '：' + why : ''}`, 'auth');
      }
      throw new RemoteModelError(`端点 HTTP ${res.status}${why ? '：' + why : ''}`, 'http');
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new RemoteModelError('端点响应缺少 choices[0].message.content', 'shape');
    }
    return { text, model: wireModel };
  } catch (e) {
    if (e instanceof RemoteModelError) throw e;
    throw new RemoteModelError(e instanceof Error ? e.message : String(e), 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** 流式补全：解析 SSE，逐段回调 delta；返回全量文本。非 2xx → RemoteModelError */
export async function remoteChatStream(
  ref: ModelRef,
  apiKey: string,
  messages: ProviderMessage[],
  onDelta: (delta: string) => void,
  opts: {
    timeoutMs?: number;
    /** 附加顶层请求字段（0.7.1，同 remoteChat） */
    extraPayload?: Record<string, unknown>;
    /** 出站模型名覆盖（0.7.1，同 remoteChat） */
    modelOverride?: string;
  } = {},
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  const wireModel = opts.modelOverride ?? ref.wireModel ?? ref.id;
  try {
    const res = await fetch(chatUrl(ref.endpoint), {
      method: 'POST',
      headers: { ...headers(apiKey), accept: 'text/event-stream' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: wireModel,
        messages,
        stream: true,
        ...(opts.extraPayload ?? {}),
      }),
    });
    if (!res.ok || !res.body) {
      const why = sanitizeUpstreamBody(await res.text().catch(() => ''), apiKey);
      if (res.status === 401 || res.status === 403) {
        throw new RemoteModelError(`上游拒绝凭证（HTTP ${res.status}）${why ? '：' + why : ''}`, 'auth');
      }
      throw new RemoteModelError(`端点 HTTP ${res.status}${why ? '：' + why : ''}`, 'http');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          /* 非 JSON 行（心跳/注释）跳过 */
        }
      }
    }
    return full;
  } catch (e) {
    if (e instanceof RemoteModelError) throw e;
    throw new RemoteModelError(e instanceof Error ? e.message : String(e), 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** 嵌入。非 2xx → RemoteModelError */
export async function remoteEmbeddings(
  ref: ModelRef,
  apiKey: string,
  input: string[],
  opts: { timeoutMs?: number } = {},
): Promise<number[][]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(embeddingsUrl(ref.endpoint), {
      method: 'POST',
      headers: headers(apiKey),
      signal: ctrl.signal,
      body: JSON.stringify({ model: ref.wireModel ?? ref.id, input }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new RemoteModelError(`上游拒绝凭证（HTTP ${res.status}）`, 'auth');
    }
    if (!res.ok) {
      const why = sanitizeUpstreamBody(await res.text().catch(() => ''), apiKey);
      throw new RemoteModelError(`端点 HTTP ${res.status}${why ? '：' + why : ''}`, 'http');
    }
    const json = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
    if (!Array.isArray(json.data)) {
      throw new RemoteModelError('端点响应缺少 data 数组');
    }
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  } catch (e) {
    if (e instanceof RemoteModelError) throw e;
    throw new RemoteModelError(e instanceof Error ? e.message : String(e), 'network');
  } finally {
    clearTimeout(timer);
  }
}

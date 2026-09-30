/* ============================================================
   OpenAI 兼容线格式（V0.5 · 方案 §65/§68）
   ------------------------------------------------------------
   网关说标准 OpenAI 客户端的语言：/v1/chat/completions（含 SSE
   流式）、/v1/models、/v1/embeddings 的请求/响应映射。
   本文件是纯线格式：解析与组装，零 I/O、零厂商 SDK——「OpenAI
   兼容」是一种协议形状，不是对一个厂商的依赖（§66）。
   ============================================================ */

/* ---------------- chat/completions 请求 ---------------- */

export type WireRole = 'system' | 'user' | 'assistant';

export interface WireMessage {
  role: WireRole;
  content: string;
}

export interface ChatCompletionRequest {
  /** OpenAI 客户端眼里的「模型名」；在网关语义里 = AI 能力通道（§65 六角色） */
  model: string;
  messages: WireMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

/** 解析 chat/completions 请求体；形状不合法返回 null（→ 400） */
export function parseChatCompletionRequest(body: unknown): ChatCompletionRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const model = typeof b['model'] === 'string' && b['model'].length > 0 && b['model'].length <= 64 ? b['model'] : null;
  if (!model) return null;
  if (!Array.isArray(b['messages']) || b['messages'].length === 0 || b['messages'].length > 64) return null;
  const messages: WireMessage[] = [];
  for (const m of b['messages']) {
    if (!m || typeof m !== 'object') return null;
    const mm = m as Record<string, unknown>;
    const role = mm['role'];
    const content = mm['content'];
    if (role !== 'system' && role !== 'user' && role !== 'assistant') return null;
    if (typeof content !== 'string' || content.length > 100_000) return null;
    messages.push({ role, content });
  }
  return {
    model,
    messages,
    stream: b['stream'] === true,
    temperature: typeof b['temperature'] === 'number' && Number.isFinite(b['temperature']) ? b['temperature'] : undefined,
    max_tokens: typeof b['max_tokens'] === 'number' && Number.isFinite(b['max_tokens']) ? b['max_tokens'] : undefined,
  };
}

/* ---------------- chat/completions 响应（非流式） ---------------- */

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: { index: number; message: { role: 'assistant'; content: string }; finish_reason: 'stop' }[];
}

let completionSeq = 0;

export function chatCompletionResponse(model: string, text: string): ChatCompletionResponse {
  const id = 'chatcmpl-gw-' + Date.now().toString(36) + '-' + (++completionSeq).toString(36);
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
}

/* ---------------- chat/completions 流式块（SSE） ---------------- */

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: { index: number; delta: { content?: string; role?: 'assistant' }; finish_reason: 'stop' | null }[];
}

export function deltaChunk(model: string, id: string, delta: string): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
  };
}

export function stopChunk(model: string, id: string): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };
}

/** 一条 SSE 帧（data: {...}\n\n；结束帧 data: [DONE]\n\n） */
export function sseFrame(payload: string): string {
  return payload === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${payload}\n\n`;
}

/* ---------------- /v1/models ---------------- */

export interface ModelInfo {
  id: string;
  object: 'model';
  owned_by: string;
}

export function modelsResponse(models: readonly ModelInfo[]): { object: 'list'; data: ModelInfo[] } {
  return { object: 'list', data: [...models] };
}

/* ---------------- /v1/embeddings ---------------- */

export interface EmbeddingsResponse {
  object: 'list';
  data: { object: 'embedding'; embedding: number[]; index: number }[];
  model: string;
}

export function parseEmbeddingsRequest(body: unknown): { model: string; input: string[] } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const model = typeof b['model'] === 'string' && b['model'].length > 0 && b['model'].length <= 64 ? b['model'] : null;
  if (!model) return null;
  const input = Array.isArray(b['input'])
    ? b['input'].filter((s): s is string => typeof s === 'string' && s.length <= 32_000).slice(0, 32)
    : typeof b['input'] === 'string' && b['input'].length <= 32_000
      ? [b['input']]
      : null;
  if (!input || input.length === 0) return null;
  return { model, input };
}

export function embeddingsResponse(model: string, vectors: number[][]): EmbeddingsResponse {
  return {
    object: 'list',
    data: vectors.map((embedding, index) => ({ object: 'embedding' as const, embedding, index })),
    model,
  };
}

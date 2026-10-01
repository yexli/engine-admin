/* ============================================================
   AI Gateway HTTP 客户端（Phase 1 · 平台 → 网关）
   ------------------------------------------------------------
   网关是 OpenAI 兼容代理（模型名 = 能力通道）。平台对它只有两种
   用法：
   · chat()：world-agent 管线的非流式补全；
   · proxyChat()：非 world-agent 模型的原样透传（含 SSE 流）——
     平台不加解释、不改形状，保真转发。
   ============================================================ */
import type { GatewayClient } from '../types.ts';

interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    body: ReadableStream<Uint8Array> | null;
  }>;
}

export interface GatewayClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function createGatewayClient(opts: GatewayClientOptions): GatewayClient {
  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return {
    async chat(model, messages) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages }),
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.status !== 200) {
          const parsed = extractError(text);
          return { ok: false, status: res.status, error: parsed?.message ?? `网关返回 ${res.status}`, code: parsed?.code };
        }
        const parsed = JSON.parse(text) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          return { ok: false, status: 502, error: '网关响应缺少 choices[0].message.content' };
        }
        return { ok: true, text: content };
      } catch (err) {
        return {
          ok: false,
          status: 502,
          error: `AI Gateway 不可达：${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    async proxyChat(body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.body) {
          return { ok: false, status: 502, error: '网关响应无 body' };
        }
        const headers: Record<string, string> = {
          'content-type': res.headers.get('content-type') ?? 'application/json',
        };
        return { ok: true, status: res.status, headers, stream: res.body };
      } catch (err) {
        return {
          ok: false,
          status: 502,
          error: `AI Gateway 不可达：${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function extractError(text: string): { message: string; code?: string } | null {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } | string };
    if (parsed?.error) {
      if (typeof parsed.error === 'string') return { message: parsed.error };
      const message = parsed.error.message ?? null;
      if (message === null) return null;
      return { message, code: typeof parsed.error.code === 'string' ? parsed.error.code : undefined };
    }
  } catch {
    /* 非 JSON 错误体 */
  }
  return null;
}

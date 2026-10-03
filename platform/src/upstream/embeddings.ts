/* ============================================================
   AI Gateway Embeddings 客户端（P8 · 方案 §十一：embedding 能力通道）
   ------------------------------------------------------------
   网关 /v1/embeddings（OpenAI 兼容：{model, input} → {data:[{embedding,
   index}]}）。平台侧唯一消费方是记忆语义召回（world-memory EmbedHook：
   失败返回 null 静默回词面——渐进增强，不是硬依赖）。
   ============================================================ */
import type { GatewayClientOptions } from './gateway.ts';

export interface EmbeddingsClient {
  /** 嵌入一批文本；向量顺序与输入一致（按 index 排序）。非 2xx → throw。 */
  embed(model: string, input: string[]): Promise<number[][]>;
}

export function createEmbeddingsClient(opts: GatewayClientOptions): EmbeddingsClient {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>);
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return {
    async embed(model, input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${base}/v1/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input }),
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.status !== 200) {
          let message = `网关返回 ${res.status}`;
          let code: string | undefined;
          try {
            const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
            if (parsed.error?.message) message = parsed.error.message;
            code = parsed.error?.code;
          } catch {
            /* 非 JSON 错误体：保留状态码信息 */
          }
          const err = new Error(message) as Error & { code?: string; status?: number };
          err.code = code;
          err.status = res.status;
          throw err;
        }
        const parsed = JSON.parse(text) as { data?: { embedding?: unknown; index?: number }[] };
        if (!Array.isArray(parsed.data) || parsed.data.length === 0) {
          throw new Error('网关嵌入响应缺少 data 数组');
        }
        return [...parsed.data]
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map((d) => {
            if (!Array.isArray(d.embedding)) throw new Error('网关嵌入响应缺少 embedding 向量');
            return d.embedding as number[];
          });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

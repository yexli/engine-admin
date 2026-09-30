/* ============================================================
   网关协议适配器（V0.5 · 方案 §65/§68）
   ------------------------------------------------------------
   OpenAI 兼容路由 → 能力提供方调用。纯协议：输入已解析的
   { method, path, body }，输出状态码 + 载荷；流式经 io 回调
   （测试传收集器，服务器传 res 写手）——不碰 socket。

   AI 三禁自查（路线图 §0）：本文件对世界零影响——网关手里没有
   mutate、没有状态写入口；对世界的任何影响都发生在宿主的
   提供方实现里，且必须经宿主的 Command 通道（§45）。
   ============================================================ */
import {
  chatCompletionResponse,
  deltaChunk,
  embeddingsResponse,
  modelsResponse,
  parseChatCompletionRequest,
  parseEmbeddingsRequest,
  sseFrame,
  stopChunk,
} from './wire.ts';
import { ProviderRegistry, type ProviderMessage } from './provider.ts';

export interface GatewayRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface GatewayResponse {
  status: number;
  contentType: 'application/json';
  body: unknown;
}

/** 流式回调面：服务器传真实 res 写手，测试传收集器 */
export interface StreamIo {
  /** 发一条 SSE 帧（自动包 data: …\n\n） */
  send(frameText: string): void;
  /** 结束流（自动补 data: [DONE]\n\n） */
  end(): void;
}

export interface GatewayInit {
  registry?: ProviderRegistry;
}

export function createGateway(init: GatewayInit = {}): {
  handle(req: GatewayRequest, io?: StreamIo): Promise<GatewayResponse>;
  readonly registry: ProviderRegistry;
} {
  const registry = init.registry ?? new ProviderRegistry();

  async function handle(req: GatewayRequest, io?: StreamIo): Promise<GatewayResponse> {
    const method = req.method.toUpperCase();
    const path = req.path.replace(/\/+$/, '');

    /* ---------- GET /v1/models ---------- */
    if (path === '/v1/models' && method === 'GET') {
      const models = registry.listModels().map((m) => ({ id: m.id, object: 'model' as const, owned_by: m.owner }));
      return { status: 200, contentType: 'application/json', body: modelsResponse(models) };
    }

    /* ---------- POST /v1/chat/completions ---------- */
    if (path === '/v1/chat/completions' && method === 'POST') {
      const parsed = parseChatCompletionRequest(req.body);
      if (!parsed) {
        return { status: 400, contentType: 'application/json', body: { error: { message: '请求体须含 model 与非空 messages（≤64 条，role 合法，content ≤100k 字符）', type: 'invalid_request_error' } } };
      }
      const provider = registry.resolve(parsed.model);
      if (!provider) {
        return { status: 404, contentType: 'application/json', body: { error: { message: `model '${parsed.model}' 未注册（可用：${registry.listModels().map((m) => m.id).join(', ') || '无'}）`, type: 'invalid_request_error', code: 'model_not_found' } } };
      }
      const messages: ProviderMessage[] = parsed.messages.map((m) => ({ role: m.role, content: m.content }));

      if (parsed.stream) {
        if (!io) {
          return { status: 500, contentType: 'application/json', body: { error: { message: 'stream 请求缺少流式输出通道' } } };
        }
        /* 流式：提供方有 completeStream 就逐段；没有就用 complete 一次性 + 单帧吐出（不装流式能力的通道照常可用） */
        const id = 'chatcmpl-gw-' + Date.now().toString(36);
        try {
          if (provider.completeStream) {
            await provider.completeStream(parsed.model, messages, (delta) => {
              io.send(JSON.stringify(deltaChunk(parsed.model, id, delta)));
            });
          } else {
            const text = await provider.complete(parsed.model, messages);
            if (text === null) {
              io.send(JSON.stringify({ error: { message: '能力调用失败', type: 'upstream_error' } }));
              io.end();
              return { status: 200, contentType: 'application/json', body: { streamed: true, ok: false } };
            }
            io.send(JSON.stringify(deltaChunk(parsed.model, id, text)));
          }
        } catch (err) {
          /* 提供方抛错也要把流收干净：客户端拿到错误帧 + DONE，不悬挂 */
          io.send(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err), type: 'upstream_error' } }));
          io.end();
          return { status: 200, contentType: 'application/json', body: { streamed: true, ok: false } };
        }
        io.send(JSON.stringify(stopChunk(parsed.model, id)));
        io.end();
        return { status: 200, contentType: 'application/json', body: { streamed: true, ok: true } };
      }

      /* 非流式 */
      try {
        const text = await provider.complete(parsed.model, messages);
        if (text === null) {
          return { status: 503, contentType: 'application/json', body: { error: { message: '能力调用失败（提供方返回空）', type: 'upstream_error' } } };
        }
        return { status: 200, contentType: 'application/json', body: chatCompletionResponse(parsed.model, text) };
      } catch (err) {
        return { status: 503, contentType: 'application/json', body: { error: { message: err instanceof Error ? err.message : String(err), type: 'upstream_error' } } };
      }
    }

    /* ---------- POST /v1/embeddings ---------- */
    if (path === '/v1/embeddings' && method === 'POST') {
      const parsed = parseEmbeddingsRequest(req.body);
      if (!parsed) {
        return { status: 400, contentType: 'application/json', body: { error: { message: '请求体须含 model 与 input（字符串或字符串数组，≤32 条）', type: 'invalid_request_error' } } };
      }
      const provider = registry.resolve(parsed.model);
      if (!provider) {
        return { status: 404, contentType: 'application/json', body: { error: { message: `model '${parsed.model}' 未注册`, type: 'invalid_request_error', code: 'model_not_found' } } };
      }
      if (!provider.embed) {
        return { status: 501, contentType: 'application/json', body: { error: { message: `通道 '${parsed.model}' 未实现嵌入能力`, type: 'not_implemented' } } };
      }
      try {
        const vectors = await provider.embed(parsed.model, parsed.input);
        if (!vectors) {
          return { status: 503, contentType: 'application/json', body: { error: { message: '嵌入调用失败（提供方返回空）', type: 'upstream_error' } } };
        }
        return { status: 200, contentType: 'application/json', body: embeddingsResponse(parsed.model, vectors) };
      } catch (err) {
        return { status: 503, contentType: 'application/json', body: { error: { message: err instanceof Error ? err.message : String(err), type: 'upstream_error' } } };
      }
    }

    return { status: 404, contentType: 'application/json', body: { error: { message: 'no such route', path } } };
  }

  return { handle, registry };
}

export { sseFrame };

/* ============================================================
   World Platform 纯路由协议（Phase 1 · 方案 §6）
   ------------------------------------------------------------
   输入 { method, path, query, body, headers }，输出 JSON 或流式透传，
   不碰 socket（同 engine/gateway 惯例，可全量测试）。

   三层边界：
   · Public  /v1/chat/completions · /v1/models · /v1/worlds*
   · Admin   /v1/admin/*          —— 本阶段只定义形状（501），
                                     管理面真实化在 Phase 4/9；
   · Internal                   —— 不在公共端口暴露任何内部端点。

   world-agent 之外的模型：平台是「加了鉴权的保真代理」——请求与
   响应（含 SSE 流）原样转发给 Gateway，不改形状。
   ============================================================ */
import type {
  EngineClient,
  GatewayClient,
  PlatformRequest,
  PlatformResponse,
} from '../types.ts';
import { authenticate, hasPermission, permissionDenied } from '../auth.ts';
import type { KeyStore } from '../keys/keystore.ts';
import type { ApiKeyRecord } from '../types.ts';
import type { ChatMessage } from '../upstream/gateway.ts';
import { runWorldAgent, worldAgentResponse, extractWorldId } from '../worldagent/pipeline.ts';
import type { ModelRouter } from '../router/modelrouter.ts';
import type { UsageEntry, UsageSink } from '../usage/recorder.ts';
import { randomUUID } from 'node:crypto';

export const WORLD_AGENT_MODEL = 'world-agent';

export interface WorldPlatformInit {
  keys: KeyStore;
  engine: EngineClient;
  gateway: GatewayClient;
  router: ModelRouter;
  version?: string;
  /** 每请求唯一 ID（默认随机）；日志与响应头回传 */
  requestId?: () => string;
  /** 测试时钟注入点 */
  now?: () => number;
  /** 结构化用量记录（M2.2；缺省不计量）。已鉴权请求记一条，与访问日志凭 requestId 对账 */
  usage?: UsageSink;
}

export function createWorldPlatform(init: WorldPlatformInit): {
  handle(req: PlatformRequest): Promise<PlatformResponse>;
} {
  const version = init.version ?? '0.1.0';

  function json(status: number, body: unknown): PlatformResponse {
    return { kind: 'json', status, body };
  }

  function errorBody(code: string, message: string): Record<string, unknown> {
    return { error: { message, type: code, code } };
  }

  async function handle(req: PlatformRequest): Promise<PlatformResponse> {
    const startedAt = Date.now();
    const method = req.method.toUpperCase();
    const path = normalizePath(req.path);

    /* ---------- 计量辅助（M2.2）：只记已鉴权请求；失败也如实留痕 ---------- */
    const meter = (
      key: ApiKeyRecord,
      entry: Pick<UsageEntry, 'kind' | 'status'> & Partial<Pick<UsageEntry, 'model' | 'route' | 'capability' | 'modelUsed' | 'fallbackUsed' | 'worldId' | 'promptTokens' | 'completionTokens' | 'totalTokens' | 'tokensEstimated' | 'error'>>,
    ): void => {
      if (!init.usage) return;
      init.usage.record({
        ts: new Date().toISOString(),
        requestId: req.requestId ?? randomUUID(),
        kind: entry.kind,
        keyId: key.id,
        tenantId: key.tenantId,
        method,
        path,
        status: entry.status,
        latencyMs: Date.now() - startedAt,
        model: entry.model,
        route: entry.route,
        capability: entry.capability,
        modelUsed: entry.modelUsed,
        fallbackUsed: entry.fallbackUsed,
        worldId: entry.worldId,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        totalTokens: entry.totalTokens,
        tokensEstimated: entry.tokensEstimated,
        error: entry.error,
      });
    }

    /* ---------- 健康检查（免鉴权） ---------- */
    if (path === '/healthz' && method === 'GET') {
      return json(200, { ok: true, service: 'world-platform', version });
    }

    /* ---------- CORS 预检（公共 API 对浏览器客户端友好） ---------- */
    if (method === 'OPTIONS') {
      return json(204, null);
    }

    /* ---------- 鉴权（除健康检查外全部需要 API Key） ---------- */
    const auth = authenticate(init.keys, req.headers ?? {});
    if (!auth.ok) {
      return json(auth.status, errorBody(auth.code, auth.message));
    }
    const key = auth.key;

    /* ---------- /v1/models ---------- */
    if (path === '/v1/models' && method === 'GET') {
      /* 客户端只看得见平台级虚拟模型；底层通道/厂商不外露（方案 §2.1） */
      return json(200, {
        object: 'list',
        data: [
          {
            id: WORLD_AGENT_MODEL,
            object: 'model',
            owned_by: 'world-platform',
            platform: { world_agent: true, description: '平台虚拟模型：世界上下文 + 任务分析 + 能力路由' },
          },
        ],
      });
    }

    /* ---------- /v1/chat/completions ---------- */
    if (path === '/v1/chat/completions' && method === 'POST') {
      if (!hasPermission(key, 'chat:completions')) {
        const d = permissionDenied('chat:completions');
        meter(key, { kind: 'chat', status: d.status, error: d.code });
        return json(d.status, errorBody(d.code, d.message));
      }
      return handleChat(req, key, meter);
    }

    /* ---------- /v1/worlds*（引擎权威，平台鉴权后透传） ---------- */
    if (path === '/v1/worlds' || path.startsWith('/v1/worlds/')) {
      const writeOp =
        (method === 'POST') /* 创建世界 / commands / time */ ||
        (method === 'DELETE');
      const perm = writeOp ? 'worlds:write' : 'worlds:read';
      if (!hasPermission(key, perm)) {
        const d = permissionDenied(perm);
        meter(key, { kind: 'worlds', status: d.status, worldId: worldIdOfPath(path), error: d.code });
        return json(d.status, errorBody(d.code, d.message));
      }
      const query = req.query && Object.keys(req.query).length
        ? `?${new URLSearchParams(req.query).toString()}`
        : '';
      const res = await init.engine.proxy(method, `${path}${query}`, req.body);
      meter(key, { kind: 'worlds', status: res.status, worldId: worldIdOfPath(path) });
      return json(res.status, res.body);
    }

    /* ---------- /v1/admin/*（控制平面 API：Phase 4/9 落地） ---------- */
    if (path.startsWith('/v1/admin/')) {
      return json(501, errorBody('not_implemented', 'Admin API 将在平台化 Phase 4（Provider/路由产品化）与 Phase 9（安全体系）中落地；当前请使用 Admin Web + 运营脚本'));
    }

    /* ---------- 其余：404 ---------- */
    return json(404, errorBody('not_found_error', `no such route: ${method} ${path}`));
  }

  /* ---------------- chat/completions ---------------- */
  type Meter = (key: ApiKeyRecord, entry: Pick<UsageEntry, 'kind' | 'status'> & Partial<Pick<UsageEntry, 'model' | 'route' | 'capability' | 'modelUsed' | 'fallbackUsed' | 'worldId' | 'promptTokens' | 'completionTokens' | 'totalTokens' | 'tokensEstimated' | 'error'>>) => void;

  async function handleChat(req: PlatformRequest, key: ApiKeyRecord, meter: Meter): Promise<PlatformResponse> {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      meter(key, { kind: 'chat', status: 400, error: 'invalid_request_error' });
      return json(400, errorBody('invalid_request_error', '请求体必须是 JSON 对象'));
    }
    const b = body as Record<string, unknown>;
    const model = typeof b['model'] === 'string' ? b['model'] : '';
    if (!model) {
      meter(key, { kind: 'chat', status: 400, error: 'invalid_request_error' });
      return json(400, errorBody('invalid_request_error', '缺少 model 字段'));
    }
    const messages = b['messages'];
    if (!Array.isArray(messages) || messages.length === 0) {
      meter(key, { kind: 'chat', status: 400, model, error: 'invalid_request_error' });
      return json(400, errorBody('invalid_request_error', '缺少 messages 数组'));
    }
    const parsedMessages: ChatMessage[] = [];
    for (const m of messages) {
      const mm = m as Record<string, unknown> | null;
      const role = mm?.['role'];
      const content = mm?.['content'];
      if (role !== 'system' && role !== 'user' && role !== 'assistant') {
        meter(key, { kind: 'chat', status: 400, model, error: 'invalid_request_error' });
        return json(400, errorBody('invalid_request_error', `非法消息 role：${String(role)}`));
      }
      if (typeof content !== 'string') {
        meter(key, { kind: 'chat', status: 400, model, error: 'invalid_request_error' });
        return json(400, errorBody('invalid_request_error', '消息 content 必须是字符串'));
      }
      parsedMessages.push({ role, content });
    }

    /* world-agent：平台管线（Phase 1 非流式） */
    if (model === WORLD_AGENT_MODEL) {
      if (b['stream'] === true) {
        meter(key, { kind: 'chat', status: 400, model, error: 'invalid_request_error' });
        return json(400, errorBody('invalid_request_error', 'world-agent 暂不支持流式（Phase 1 非流式）；请 stream=false 或直连具体通道'));
      }
      const result = await runWorldAgent(
        { engine: init.engine, gateway: init.gateway, router: init.router },
        body,
        parsedMessages,
      );
      if (!result.ok) {
        meter(key, {
          kind: 'chat',
          status: result.status,
          model,
          route: 'world-agent',
          worldId: extractWorldId(body),
          error: result.code,
        });
        return json(result.status, errorBody(result.code, result.message));
      }
      const resBody = worldAgentResponse(result.result);
      /* 计量留痕直接取响应既有口径（tokens 为平台粗估，不重复实现） */
      const usage = resBody['usage'] as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      const platformMeta = resBody['platform'] as {
        capability: string;
        model_used: string;
        fallback_used: boolean;
        world_id: string | null;
      };
      meter(key, {
        kind: 'chat',
        status: 200,
        model,
        route: 'world-agent',
        capability: platformMeta.capability,
        modelUsed: platformMeta.model_used,
        fallbackUsed: platformMeta.fallback_used,
        worldId: platformMeta.world_id,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        tokensEstimated: true,
      });
      return json(200, resBody);
    }

    /* 其他模型：保真代理（JSON 与 SSE 均原样转发） */
    const proxied = await init.gateway.proxyChat(body);
    if (!proxied.ok) {
      meter(key, { kind: 'chat', status: proxied.status, model, route: 'proxy', error: 'upstream_error' });
      return json(proxied.status, errorBody('upstream_error', proxied.error));
    }
    /* 流的时延只有传输层知道：挂上计量元数据，泵完由 server.ts 代记 */
    return { kind: 'stream', status: proxied.status, headers: proxied.headers, body: proxied.stream, usageMeta: { keyId: key.id, tenantId: key.tenantId, model } };
  }

  return { handle };
}

function normalizePath(p: string): string {
  const stripped = p.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/** /v1/worlds/{id} 或 /v1/worlds/{id}/... → {id}；世界清单 → null（计量留痕用） */
function worldIdOfPath(path: string): string | null {
  const m = path.match(/^\/v1\/worlds\/([^/]+)(\/|$)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

/* ============================================================
   world-agent 管线（Phase 1 · 方案 §20 / §38 最小闭环）
   ------------------------------------------------------------
   world-agent 不是模型，是平台级虚拟模型：
     请求 → 世界上下文（可选）→ 任务分析 → 能力路由 → 网关调用
          → 结果整合（OpenAI 兼容响应 + platform 元数据）
   失败语义如实上抛：世界不存在 404 / 未配模型 503 / 上游全挂 502。
   Phase 1 不做流式（客户端拿到明确 400，而不是静默降级）。
   ============================================================ */
import type {
  EngineClient,
  GatewayClient,
  TaskAnalysis,
  WorldAgentResult,
} from '../types.ts';
import { analyzeTask } from '../tasks.ts';
import { ModelRouter } from '../router/modelrouter.ts';
import { buildWorldContext } from './context.ts';
import type { ChatMessage } from '../upstream/gateway.ts';

/** 从请求体提取 worldId（world / world_id / metadata.world_id 三种写法） */
export function extractWorldId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const meta = b['metadata'] as Record<string, unknown> | undefined;
  for (const v of [b['world'], b['world_id'], meta?.['world_id']]) {
    if (typeof v === 'string' && v.length > 0 && v.length <= 128) return v;
  }
  return null;
}

export interface WorldAgentDeps {
  engine: EngineClient;
  gateway: GatewayClient;
  router: ModelRouter;
}

export async function runWorldAgent(
  deps: WorldAgentDeps,
  body: unknown,
  messages: ChatMessage[],
): Promise<
  | { ok: true; result: WorldAgentResult }
  | { ok: false; status: number; code: string; message: string }
> {
  const worldId = extractWorldId(body);

  /* 1. 世界上下文（可选；指定了就必须存在——配置错误要可见） */
  let contextSystem: string | null = null;
  if (worldId) {
    const ctx = await buildWorldContext(deps.engine, worldId);
    if (!ctx.ok) {
      if (ctx.status === 404) {
        return { ok: false, status: 404, code: 'world_not_found', message: `世界不存在：${worldId}` };
      }
      return { ok: false, status: 502, code: 'upstream_error', message: `世界上下文获取失败：${ctx.error}` };
    }
    contextSystem = ctx.context;
  }

  /* 2. 任务分析 → 3. 能力路由 */
  const analysis: TaskAnalysis = analyzeTask(body, worldId !== null);
  const selected = deps.router.select(analysis.capability);
  if (!selected) {
    return {
      ok: false,
      status: 503,
      code: 'no_model_configured',
      message: `能力 '${analysis.capability}' 未配置可用模型（primary/fallback 均缺失或冷却中）；请检查 platform/data/router.json`,
    };
  }

  /* 4. 组装上游消息并调用（primary 失败 → fallback；再失败 → 502） */
  const upstreamMessages: ChatMessage[] = contextSystem
    ? [{ role: 'system', content: contextSystem }, ...messages]
    : messages;

  let modelUsed = selected.model;
  let usedFallback = selected.usedFallback;
  let text = await callModel(deps, modelUsed, upstreamMessages);
  if (text === null) {
    const { fallback } = deps.router.route(analysis.capability);
    if (fallback && fallback !== modelUsed) {
      usedFallback = true;
      modelUsed = fallback;
      text = await callModel(deps, fallback, upstreamMessages);
    }
  }
  if (text === null) {
    return {
      ok: false,
      status: 502,
      code: 'upstream_error',
      message: `模型调用失败：'${analysis.capability}' 的主备模型均不可用（${deps.router.route(analysis.capability).primary} / ${deps.router.route(analysis.capability).fallback}）`,
    };
  }

  return {
    ok: true,
    result: {
      text,
      analysis,
      modelUsed,
      fallbackUsed: usedFallback,
      worldId,
    },
  };
}

/** 调用网关；null = 失败（已记入路由冷却） */
async function callModel(
  deps: WorldAgentDeps,
  model: string,
  messages: ChatMessage[],
): Promise<string | null> {
  const res = await deps.gateway.chat(model, messages);
  if (res.ok) {
    deps.router.markHealthy(model);
    return res.text;
  }
  deps.router.markFailed(model);
  return null;
}

/* ---------------- 响应组装（OpenAI 兼容 + platform 元数据） ---------------- */

export function worldAgentResponse(
  result: WorldAgentResult,
): Record<string, unknown> {
  const pt = Math.ceil(estimateTokens(result.text) + 120); /* 粗估：system 上下文固定开销 */
  const ct = estimateTokens(result.text);
  return {
    id: `chatcmpl-platform-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'world-agent',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
    platform: {
      world_agent: true,
      capability: result.analysis.capability,
      task_reason: result.analysis.reason,
      model_used: result.modelUsed,
      fallback_used: result.fallbackUsed,
      world_id: result.worldId,
    },
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

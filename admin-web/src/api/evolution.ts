/**
 * AI World Evolution 控制台客户端（真实 API，非 Mock）
 * ------------------------------------------------------------
 * 数据面 = 私有管理监听 /control-api/v1/evolution/*（Phase C）：
 *   GET  /v1/evolution/worlds                有演化账本/引擎世界清单
 *   POST /v1/evolution/worlds/:id/tick       触发一次演化闭环
 *   GET  /v1/evolution/worlds/:id/runs       运行留痕（新 → 旧）
 *   GET  /v1/evolution/worlds/:id/runs/:rid  单次运行完整因果链
 *   POST /v1/evolution/worlds/:id/intent     意图处置（OOC 隔离闸）
 *
 * 因果链契约（方案 §九）：run = 观察 → 上下文 → 提案 → 逐条裁决
 * （白名单/规则两级拒绝）→ 事实 id。页面据此做「为什么」反向追溯。
 */

export interface EvolutionObservation {
  ref: string;
  kind: "event" | "state";
  summary: string;
}

export interface ProposedChange {
  changeId?: string;
  targetId: string;
  action: string;
  payload?: Record<string, unknown>;
  reason: string;
}

export interface EvolutionProposal {
  id: string;
  worldId: string;
  reason: string;
  observations: EvolutionObservation[];
  changes: ProposedChange[];
  confidence?: number;
  source: { type: "ai"; model?: string; role?: string };
}

export interface ChangeOutcome {
  change: ProposedChange;
  changeId: string;
  /** V2 状态机：独立执行状态（duplicate = 幂等跳过，不算失败） */
  status: "accepted" | "rejected" | "duplicate";
  /** 兼容字段 = status === "accepted" */
  accepted: boolean;
  command?: {
    type: string;
    actorId?: string;
    targetId?: string;
    amount?: number;
    text?: string;
    payload?: Record<string, unknown>;
  };
  commandId?: string;
  rejectedBy?: "translate" | "policy" | "rules" | "duplicate";
  reason?: string;
  eventIds: string[];
}

export interface EvolutionContext {
  worldId: string;
  builtAt: string;
  tick: number;
  day: number;
  weather: string;
  player: {
    name: string;
    loc: string;
    bagSize: number;
    attributes?: Record<string, unknown>;
  };
  location?: { id: string; desc?: string };
  entities: Record<
    string,
    {
      att: number;
      met: boolean;
      type?: string;
      location?: string;
      attributes?: Record<string, unknown>;
    }
  >;
  /** 世界其余实体（轻量名册：id/type/location） */
  otherEntities: { id: string; type?: string; location?: string }[];
  relations: { source: string; target: string; type: string; value?: number }[];
  events: {
    id: string;
    type: string;
    day: number;
    actor?: string;
    target?: string;
    location?: string;
    data?: Record<string, unknown>;
  }[];
}

export interface EvolutionRun {
  id: string;
  worldId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "partially_applied" | "rejected" | "failed";
  trigger: "admin" | "auto" | "api";
  triggerGrade?: "high" | "medium" | "low";
  observationWindow: { eventCount: number; latestEventId?: string };
  context?: EvolutionContext;
  modelUsed?: string | null;
  proposal?: EvolutionProposal;
  outcomes?: ChangeOutcome[];
  acceptedCount?: number;
  rejectedCount?: number;
  entitiesAffected?: string[];
  eventIds: string[];
  /** 幂等重放：同提案/同幂等键命中既有 run */
  deduplicated?: boolean;
  error?: string;
  tookMs?: number;
}

export interface EvolutionWorldRow {
  worldId: string;
  inEngine: boolean;
  hasRuns: boolean;
  latestRunStatus: "running" | "completed" | "failed" | null;
}

import { http } from "@/utils/http";

export async function listEvolutionWorlds(): Promise<{
  worlds: EvolutionWorldRow[];
}> {
  return http.request<{ worlds: EvolutionWorldRow[] }>(
    "get",
    "/control-api/v1/evolution/worlds"
  );
}

export async function tickEvolution(
  worldId: string,
  trigger: "admin" | "api" = "admin"
): Promise<EvolutionRun> {
  return http.request<EvolutionRun>(
    "post",
    `/control-api/v1/evolution/worlds/${encodeURIComponent(worldId)}/tick`,
    { data: { trigger } }
  );
}

export async function listEvolutionRuns(
  worldId: string,
  n = 20
): Promise<{ worldId: string; runs: EvolutionRun[] }> {
  return http.request<{ worldId: string; runs: EvolutionRun[] }>(
    "get",
    `/control-api/v1/evolution/worlds/${encodeURIComponent(worldId)}/runs`,
    { params: { n } }
  );
}

export async function getEvolutionRun(
  worldId: string,
  runId: string
): Promise<EvolutionRun> {
  return http.request<EvolutionRun>(
    "get",
    `/control-api/v1/evolution/worlds/${encodeURIComponent(
      worldId
    )}/runs/${encodeURIComponent(runId)}`
  );
}

export async function dispatchEvolutionIntent(
  worldId: string,
  intent: {
    kind: "ic_action" | "ooc" | "narrative";
    text: string;
    actorId?: string;
    command?: { type: string; targetId?: string; amount?: number; text?: string; payload?: Record<string, unknown> };
  }
): Promise<{
  kind: string;
  commandResult?: { ok: boolean; events: string[]; reason?: string };
}> {
  return http.request<{
    kind: string;
    commandResult?: { ok: boolean; events: string[]; reason?: string };
  }>(
    "post",
    `/control-api/v1/evolution/worlds/${encodeURIComponent(worldId)}/intent`,
    { data: intent }
  );
}

/** 事件反向追溯（V2 §九）：Event → Run → Proposal → Change → Command */
export interface EvolutionTrace {
  run: EvolutionRun;
  changeId: string;
  causation: {
    source: "evolution";
    evolutionRunId: string;
    proposalId: string;
    changeId: string;
  };
}

export async function traceEvolutionEvent(
  worldId: string,
  eventId: string
): Promise<EvolutionTrace> {
  return http.request<EvolutionTrace>(
    "get",
    `/control-api/v1/evolution/worlds/${encodeURIComponent(
      worldId
    )}/events/${encodeURIComponent(eventId)}/trace`
  );
}

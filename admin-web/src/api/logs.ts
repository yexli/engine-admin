/** Observability 客户端：平台级日志（当前 Mock；真实化见 ADMIN-API-GAP.md）
 *  列表默认不展示完整 Prompt / 堆栈，详情抽屉按需查看
 */
import { http } from "@/utils/http";
import type { PageResult } from "./event";

/* ---------- Logs ---------- */
export interface LogRow {
  id: string;
  time: string;
  level: "debug" | "info" | "warn" | "error";
  service: string;
  worldId: string | null;
  requestId: string;
  message: string;
}

export const listLogs = (params?: Record<string, unknown>) => {
  return http.request<{ success: boolean; data: PageResult<LogRow> }>(
    "get",
    "/admin-api/observability/logs",
    { params }
  );
};

/* ---------- AI Calls ---------- */
export interface AiCallRow {
  id: string;
  time: string;
  model: string;
  provider: string;
  worldId: string;
  capability: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  status: string;
  error: string | null;
  prompt: string;
  response: string | null;
}

export const listAiCalls = (params?: Record<string, unknown>) => {
  return http.request<{ success: boolean; data: PageResult<AiCallRow> }>(
    "get",
    "/admin-api/observability/ai-calls",
    { params }
  );
};

/* ---------- Errors ---------- */
export interface ErrorRow {
  id: string;
  time: string;
  service: string;
  worldId: string | null;
  type: string;
  message: string;
  status: "open" | "acknowledged" | "resolved";
  stack: string | null;
}

export const listErrors = (params?: Record<string, unknown>) => {
  return http.request<{ success: boolean; data: PageResult<ErrorRow> }>(
    "get",
    "/admin-api/observability/errors",
    { params }
  );
};

export const setErrorStatus = (id: string, status: string) => {
  return http.request<{ success: boolean; data: ErrorRow }>(
    "put",
    `/admin-api/observability/errors/${id}/status`,
    { data: { status } }
  );
};

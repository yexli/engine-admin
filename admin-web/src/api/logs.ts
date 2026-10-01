/** Observability 客户端（M4.1 起接真：管理监听 /v1/obs/*，数据源 = M2.2 用量数据面
 *  与引擎只读聚合）；AI Calls 见下方（M2.2 起接真）。诚实边界：Logs = 平台请求日志
 *  （公共面），不含引擎/记忆的进程内日志；Errors = 失败请求登记（只读，无工作流）。
 */
import { http } from "@/utils/http";
import type { UsageData, UsageRow } from "./usage";

async function failWith(e: unknown): Promise<never> {
  const err = e as {
    response?: { data?: { error?: { message?: string } | string } };
  };
  const raw = err?.response?.data?.error;
  const text = typeof raw === "string" ? raw : raw?.message;
  throw new Error(text || (e instanceof Error ? e.message : "请求失败"));
}

/* ---------- Logs（平台请求日志投影） ---------- */
export interface LogRow {
  /** requestId（与访问日志对账键） */
  id: string;
  time: string;
  /** 按 status 派生：>=500 error / >=400 warn / 其余 info */
  level: "info" | "warn" | "error";
  service: "platform";
  worldId: string | null;
  requestId: string;
  kind: "chat" | "worlds";
  keyId: string;
  status: number;
  message: string;
}

export interface LogPage {
  total: number;
  page: number;
  pageSize: number;
  list: LogRow[];
}

export async function listLogs(
  params?: Record<string, unknown>
): Promise<LogPage> {
  try {
    return await http.request<LogPage>("get", "/control-api/v1/obs/logs", {
      params
    });
  } catch (e) {
    return failWith(e);
  }
}

/* ---------- AI Calls（M2.2 起接真：与 Usage 页共用平台用量数据面） ---------- */
/* 诚实边界：记录不落 Prompt / 响应原文（隐私边界），详情只有路由留痕；
   代理透传路径拿不到上游 usage → tokens 为 null。 */
import { listUsage } from "./usage";
export type AiCallRow = UsageRow;
export type AiCallData = UsageData;

export const listAiCalls = (params?: Record<string, unknown>) => {
  return listUsage({ kind: "chat", ...params });
};

/* ---------- Errors（失败请求登记；只读投影） ---------- */
export interface ErrorRow {
  id: string;
  time: string;
  service: "platform";
  worldId: string | null;
  kind: "chat" | "worlds";
  keyId: string;
  method: string;
  path: string;
  /** 错误码（如 no_model_configured / upstream_error）；无码时 http_<status> */
  type: string;
  message: string;
}

export interface ErrorPage {
  total: number;
  page: number;
  pageSize: number;
  list: ErrorRow[];
}

export async function listErrors(
  params?: Record<string, unknown>
): Promise<ErrorPage> {
  try {
    return await http.request<ErrorPage>("get", "/control-api/v1/obs/errors", {
      params
    });
  } catch (e) {
    return failWith(e);
  }
}

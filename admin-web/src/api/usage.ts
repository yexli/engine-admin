/** AI Gateway：用量数据面（M2.2 起接真：平台结构化用量记录，管理监听聚合）
 *  Usage 页 / Dashboard「AI Requests」卡 / AI Calls 页共用本数据面；
 *  记录不落 Prompt/响应原文（隐私边界），代理透传路径无上游 usage →
 *  tokens 为 null，不编造；cost 无计价来源，不做列。
 */
import { http } from "@/utils/http";
import type { PageResult } from "./event";

export interface UsageRow {
  /** requestId（与访问日志对账键） */
  id: string;
  time: string;
  kind: "chat" | "worlds" | "embeddings";
  keyId: string;
  method: string;
  path: string;
  route: "world-agent" | "proxy" | "embedding" | null;
  model: string | null;
  modelUsed: string | null;
  provider: string | null;
  worldId: string | null;
  capability: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  tokensEstimated: boolean;
  latencyMs: number;
  status: "success" | "error";
  error: string | null;
}

export interface UsageSummary {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  successRate: number;
}

export interface UsageGroupRow {
  key: string;
  requests: number;
  totalTokens: number;
  errors: number;
}

export interface UsageData extends PageResult<UsageRow> {
  summary: UsageSummary;
  groups?: UsageGroupRow[] | null;
}

/** params: page / page_size / kind / status / route / model / capability /
 *  world_id / key_id / from / to（ISO）/ group_by（day|key|model|capability|world） */
export const listUsage = (params?: Record<string, unknown>) => {
  return http.request<UsageData>("get", "/control-api/v1/admin/usage", {
    params
  });
};

/** AI Gateway：Usage 用量（当前 Mock） */
import { http } from "@/utils/http";
import type { PageResult } from "./event";

export interface UsageRow {
  id: string;
  time: string;
  model: string;
  provider: string;
  worldId: string;
  capability: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  cost: number;
  status: string;
}

export interface UsageData extends PageResult<UsageRow> {
  summary: {
    requests: number;
    totalTokens: number;
    totalCost: number;
    successRate: number;
  };
}

export const listUsage = (params?: Record<string, unknown>) => {
  return http.request<{ success: boolean; data: UsageData }>(
    "get",
    "/admin-api/gateway/usage",
    { params }
  );
};

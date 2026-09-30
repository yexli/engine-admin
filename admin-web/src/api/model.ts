/** AI Gateway：Model 管理（当前 Mock） */
import { http } from "@/utils/http";
import type { PageResult } from "./event";

export interface ModelRow {
  id: string;
  name: string;
  provider: string;
  capabilities: string[];
  status: "enabled" | "disabled";
  contextWindow: number;
  pricing: { input: number; output: number; currency: string };
}

export const listModels = (params?: Record<string, unknown>) => {
  return http.request<{ success: boolean; data: PageResult<ModelRow> }>(
    "get",
    "/admin-api/gateway/models",
    { params }
  );
};

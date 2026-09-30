/** Extensions 管理（当前 Mock；真实化见 docs/ADMIN-API-GAP.md） */
import { http } from "@/utils/http";
import type { PageResult } from "./event";

export interface ExtensionRow {
  id: string;
  name: string;
  version: string;
  status: "enabled" | "disabled";
  description: string;
  capabilities: string[];
  loadedAt: string | null;
}

export const listExtensions = (params?: Record<string, unknown>) => {
  return http.request<{ success: boolean; data: PageResult<ExtensionRow> }>(
    "get",
    "/admin-api/extensions",
    { params }
  );
};

export const setExtensionStatus = (id: string, status: string) => {
  return http.request<{ success: boolean }>(
    "put",
    `/admin-api/extensions/${id}/status`,
    { data: { status } }
  );
};

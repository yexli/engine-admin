/** AI Gateway：API Key 管理（Key 全程脱敏，明文只在创建/重新生成响应出现一次）当前 Mock */
import { http } from "@/utils/http";
import type { PageResult } from "./event";

export interface ApiKeyRow {
  id: string;
  name: string;
  owner: string;
  maskedKey: string;
  createdAt: string;
  lastUsedAt: string | null;
  status: "active" | "disabled" | "revoked";
  permissions: string[];
}

export const listApiKeys = (params?: Record<string, unknown>) => {
  return http.request<{ success: boolean; data: PageResult<ApiKeyRow> }>(
    "get",
    "/admin-api/gateway/keys",
    { params }
  );
};

/** 创建 Key：明文仅在创建响应返回一次，前端提示用户立即保存 */
export const createApiKey = (data: {
  name: string;
  owner?: string;
  permissions?: string[];
}) => {
  return http.request<{
    success: boolean;
    data: ApiKeyRow & { plainKey: string };
  }>("post", "/admin-api/gateway/keys", { data });
};

export const setApiKeyStatus = (id: string, status: string) => {
  return http.request<{ success: boolean; data: ApiKeyRow }>(
    "put",
    `/admin-api/gateway/keys/${id}`,
    { data: { status } }
  );
};

export const regenerateApiKey = (id: string) => {
  return http.request<{
    success: boolean;
    data: ApiKeyRow & { plainKey: string };
  }>("post", `/admin-api/gateway/keys/${id}/regenerate`);
};

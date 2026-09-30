/** AI Gateway：Provider 管理（当前 Mock；管理面 API 待建，见 ADMIN-API-GAP.md） */
import { http } from "@/utils/http";
import type { PageResult } from "./event";

export interface ProviderRow {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  status: "online" | "offline" | "error";
  models: string[];
  lastCheckAt: string | null;
  latencyMs: number | null;
}

export const listProviders = (params?: Record<string, unknown>) => {
  return http.request<{ success: boolean; data: PageResult<ProviderRow> }>(
    "get",
    "/admin-api/gateway/providers",
    { params }
  );
};

export const checkProvider = (id: string) => {
  return http.request<{ success: boolean; data: ProviderRow }>(
    "post",
    `/admin-api/gateway/providers/${id}/check`
  );
};

/** 直连 Gateway 联通性测试（真实 /gateway-api 代理；Gateway 在线时可用） */
export const gatewayChatProbe = (data: { model: string; message: string }) => {
  return http.request<Record<string, unknown>>(
    "post",
    "/gateway-api/v1/chat/completions",
    {
      data: {
        model: data.model,
        messages: [{ role: "user", content: data.message }],
        max_tokens: 32
      },
      timeout: 15000
    }
  );
};

/** AI Gateway：Model Router（Capability → Primary/Fallback）当前 Mock */
import { http } from "@/utils/http";

export interface RouterRow {
  id: string;
  capability: string;
  primary: string | null;
  fallback: string | null;
  priority: number;
  budgetPerDay: number;
  status: "enabled" | "disabled";
}

export const listRouter = () => {
  return http.request<{
    success: boolean;
    data: { list: RouterRow[]; total: number };
  }>("get", "/admin-api/gateway/router");
};

export const createRouterEntry = (data: Partial<RouterRow>) => {
  return http.request<{ success: boolean; data: RouterRow }>(
    "post",
    "/admin-api/gateway/router",
    { data }
  );
};

export const updateRouterEntry = (id: string, data: Partial<RouterRow>) => {
  return http.request<{ success: boolean; data: RouterRow }>(
    "put",
    `/admin-api/gateway/router/${id}`,
    { data }
  );
};

export const deleteRouterEntry = (id: string) => {
  return http.request<{ success: boolean }>(
    "delete",
    `/admin-api/gateway/router/${id}`
  );
};

export interface RouterTestResult {
  ok: boolean;
  model: string | null;
  latencyMs: number;
  reply: string;
  testedAt: string;
}

export const testRouterEntry = (id: string) => {
  return http.request<{ success: boolean; data: RouterTestResult }>(
    "post",
    `/admin-api/gateway/router/${id}/test`
  );
};

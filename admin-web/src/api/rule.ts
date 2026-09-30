/** Rules 管理（当前 Mock；第一版只做查看/启停，不做在线编辑） */
import { http } from "@/utils/http";
import type { PageResult } from "./event";

export interface RuleRow {
  id: string;
  name: string;
  command: string;
  extension: string;
  status: "enabled" | "disabled";
  priority: number;
  updatedAt: string;
}

export const listRules = (params?: Record<string, unknown>) => {
  return http.request<{ success: boolean; data: PageResult<RuleRow> }>(
    "get",
    "/admin-api/rules",
    { params }
  );
};

export const setRuleStatus = (id: string, status: string) => {
  return http.request<{ success: boolean }>(
    "put",
    `/admin-api/rules/${id}/status`,
    {
      data: { status }
    }
  );
};

/** 扩展注册的命令目录（当前 Mock；引擎真实命令目录见 api/command.ts） */
export interface ExtensionCommandRow {
  id: string;
  type: string;
  extension: string;
  status: string;
  description: string;
}

export const listExtensionCommands = (params?: Record<string, unknown>) => {
  return http.request<{
    success: boolean;
    data: PageResult<ExtensionCommandRow>;
  }>("get", "/admin-api/extension-commands", { params });
};

/** System 客户端：Users / Permissions / Settings / Status（当前 Mock） */
import { http } from "@/utils/http";
import type { PageResult } from "./event";

/* ---------- Users ---------- */
export interface UserRow {
  id: string;
  username: string;
  nickname: string;
  roles: string[];
  status: "active" | "disabled";
  createdAt: string;
  lastLoginAt: string | null;
  remark: string;
}

export const listUsers = (params?: Record<string, unknown>) => {
  return http.request<{ success: boolean; data: PageResult<UserRow> }>(
    "get",
    "/admin-api/system/users",
    { params }
  );
};

export const createUser = (data: {
  username: string;
  nickname?: string;
  roles?: string[];
  remark?: string;
}) => {
  return http.request<{ success: boolean; data: UserRow; msg?: string }>(
    "post",
    "/admin-api/system/users",
    { data }
  );
};

export const updateUser = (
  id: string,
  data: Partial<Pick<UserRow, "nickname" | "roles" | "status" | "remark">>
) => {
  return http.request<{ success: boolean; data: UserRow; msg?: string }>(
    "put",
    `/admin-api/system/users/${id}`,
    { data }
  );
};

/* ---------- Permissions / Roles ---------- */
export interface PermissionItem {
  code: string;
  name: string;
  group: string;
  description: string;
}

export interface RoleRow {
  name: string;
  nickname: string;
  description: string;
  permissions: string[];
  builtin: boolean;
}

export const getPermissions = () => {
  return http.request<{
    success: boolean;
    data: { catalog: PermissionItem[]; roles: RoleRow[] };
  }>("get", "/admin-api/system/permissions");
};

export const updateRolePermissions = (name: string, permissions: string[]) => {
  return http.request<{ success: boolean; data: RoleRow; msg?: string }>(
    "put",
    `/admin-api/system/roles/${name}/permissions`,
    { data: { permissions } }
  );
};

/* ---------- Settings ---------- */
export interface SettingRow {
  key: string;
  name: string;
  value: string | number | boolean;
  type: "string" | "number" | "boolean";
  group: string;
  description: string;
}

export const listSettings = (params?: Record<string, unknown>) => {
  return http.request<{
    success: boolean;
    data: { list: SettingRow[]; total: number };
  }>("get", "/admin-api/system/settings", { params });
};

export const updateSetting = (
  key: string,
  value: string | number | boolean
) => {
  return http.request<{ success: boolean; data: SettingRow; msg?: string }>(
    "put",
    `/admin-api/system/settings/${encodeURIComponent(key)}`,
    { data: { value } }
  );
};

/* ---------- Status ---------- */
export interface SystemStatus {
  services: Array<{
    name: string;
    status: "up" | "down" | "degraded";
    version: string;
    uptime: string;
    detail: string;
  }>;
  engine: {
    worlds: number;
    running: number;
    tickRate: string;
    lastErrorAt: string | null;
  };
}

export const getSystemStatus = () => {
  return http.request<{ success: boolean; data: SystemStatus }>(
    "get",
    "/admin-api/system/status"
  );
};

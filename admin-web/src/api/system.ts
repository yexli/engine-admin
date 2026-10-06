/** System 客户端（M3 起接真：管理监听 users / permissions / settings 端点）
 *  Status 的服务连通性由本模块对同源代理做真实探测（无 Mock）。
 *  Control Plane 收束（docs/ENGINE-CORE-SCOPE.md §3.5）：不再探测 memory/gateway 服务。
 */
import { http } from "@/utils/http";

async function failWith(e: unknown): Promise<never> {
  const err = e as {
    response?: { data?: { error?: { message?: string } | string } };
  };
  const raw = err?.response?.data?.error;
  const text = typeof raw === "string" ? raw : raw?.message;
  throw new Error(text || (e instanceof Error ? e.message : "请求失败"));
}

/* ---------- Users（M3.3：本地三档用户，scrypt 存储；无删除，停用代替） ---------- */
export interface UserRow {
  id: string;
  username: string;
  nickname: string;
  /** 内置三档角色：admin / operator / viewer（单角色） */
  role: string;
  status: "active" | "disabled";
  builtin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  remark: string;
}

export interface UserPage {
  total: number;
  page: number;
  pageSize: number;
  list: UserRow[];
}

export async function listUsers(
  params?: Record<string, unknown>
): Promise<UserPage> {
  try {
    return await http.request<UserPage>(
      "get",
      "/control-api/v1/admin/system/users",
      { params }
    );
  } catch (e) {
    return failWith(e);
  }
}

export async function createUser(data: {
  username: string;
  password: string;
  nickname?: string;
  role: string;
  remark?: string;
}): Promise<{ user: UserRow }> {
  try {
    return await http.request<{ user: UserRow }>(
      "post",
      "/control-api/v1/admin/system/users",
      { data }
    );
  } catch (e) {
    return failWith(e);
  }
}

/** 改昵称/备注/角色/状态/重置口令；停用与重置口令会即时吊销该用户全部会话 */
export async function updateUser(
  id: string,
  data: {
    nickname?: string;
    remark?: string;
    role?: string;
    status?: "active" | "disabled";
    password?: string;
  }
): Promise<{ user: UserRow }> {
  try {
    return await http.request<{ user: UserRow }>(
      "put",
      `/control-api/v1/admin/system/users/${encodeURIComponent(id)}`,
      { data }
    );
  } catch (e) {
    return failWith(e);
  }
}

/* ---------- Permissions / Roles（真实契约：固定三档内置角色，不支持在线编辑） ---------- */
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

export async function getPermissions(): Promise<{
  catalog: PermissionItem[];
  roles: RoleRow[];
}> {
  try {
    return await http.request<{
      catalog: PermissionItem[];
      roles: RoleRow[];
    }>("get", "/control-api/v1/admin/system/permissions");
  } catch (e) {
    return failWith(e);
  }
}

/* ---------- Settings（M3.4：白名单目录 + 持久化；运行时生效口径见各项说明） ---------- */
export interface SettingRow {
  key: string;
  name: string;
  value: string | number | boolean;
  type: "string" | "number" | "boolean";
  group: string;
  description: string;
}

export async function listSettings(): Promise<{
  list: SettingRow[];
  total: number;
}> {
  try {
    return await http.request<{ list: SettingRow[]; total: number }>(
      "get",
      "/control-api/v1/admin/system/settings"
    );
  } catch (e) {
    return failWith(e);
  }
}

export async function updateSetting(
  key: string,
  value: string | number | boolean
): Promise<{ row: SettingRow }> {
  try {
    return await http.request<{ row: SettingRow }>(
      "put",
      `/control-api/v1/admin/system/settings/${encodeURIComponent(key)}`,
      { data: { value } }
    );
  } catch (e) {
    return failWith(e);
  }
}

/* ---------- Status（真实探测：同源代理的连通性；无版本/时长等编造字段） ---------- */
export interface ServiceRow {
  name: string;
  /** 探测端点（同源代理） */
  probe: string;
  status: "up" | "down";
  /** HTTP 状态码（可达时）；不可达为 null */
  httpStatus: number | null;
  detail: string;
}

export async function probeServices(): Promise<ServiceRow[]> {
  const targets: Array<{ name: string; probe: string }> = [
    { name: "world-engine", probe: "/world-api/v1/worlds" },
    { name: "platform-admin", probe: "/control-api/healthz" }
  ];
  return Promise.all(
    targets.map(async t => {
      try {
        const res = await fetch(t.probe);
        return {
          ...t,
          status: "up" as const,
          httpStatus: res.status,
          detail: `HTTP ${res.status}（可达）`
        };
      } catch (e) {
        return {
          ...t,
          status: "down" as const,
          httpStatus: null,
          detail: `不可达：${e instanceof Error ? e.message : String(e)}`
        };
      }
    })
  );
}

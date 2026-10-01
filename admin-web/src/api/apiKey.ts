/** AI Gateway：API Key 生命周期（M2.1 起接真：管理监听 KeyStore）
 *  0.5.1 起：撤销语义移除，改为**硬删除**（DELETE，记录移除、出站即 401）；
 *  明文只在创建响应出现一次；过期时间可设可清。
 */
import { http } from "@/utils/http";

/** 管理监听脱敏投影（无 keyHash——不可逆也是秘密，不给可比对材料） */
export interface ApiKeyRow {
  id: string;
  name: string;
  tenantId: string;
  prefix: string;
  permissions: string[];
  /** 归属游戏方（G2）：非空 = 游戏方钥匙；null = 平台管理钥匙 */
  gameId: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface ApiKeyList {
  total: number;
  page: number;
  pageSize: number;
  list: ApiKeyRow[];
}

/** 平台真实权限词表（embedding 路由等不在平台侧——诚实对齐） */
export const API_KEY_PERMISSIONS = [
  "chat:completions",
  "worlds:read",
  "worlds:write"
] as const;

async function failWith(e: unknown): Promise<never> {
  const err = e as {
    response?: { data?: { error?: { message?: string } | string } };
  };
  const raw = err?.response?.data?.error;
  const text = typeof raw === "string" ? raw : raw?.message;
  throw new Error(text || (e instanceof Error ? e.message : "请求失败"));
}

export async function listApiKeys(
  params?: Record<string, unknown>
): Promise<ApiKeyList> {
  try {
    return await http.request<ApiKeyList>(
      "get",
      "/control-api/v1/admin/keys",
      { params }
    );
  } catch (e) {
    return failWith(e);
  }
}

/** 创建：plaintext 仅此一次，调用方负责一次性保存提示 */
export async function createApiKey(data: {
  name: string;
  permissions?: string[];
  /** 归属游戏方（G2）：非空 = 游戏方钥匙 */
  gameId?: string;
  expiresAt?: string;
}): Promise<{ key: ApiKeyRow; plaintext: string }> {
  try {
    return await http.request<{ key: ApiKeyRow; plaintext: string }>(
      "post",
      "/control-api/v1/admin/keys",
      { data }
    );
  } catch (e) {
    return failWith(e);
  }
}

/** 设置过期（ISO 串；null = 清除）。过期后该 Key 出站即 401，清除后恢复 */
export async function updateApiKey(
  id: string,
  data: { expiresAt?: string | null }
): Promise<{ key: ApiKeyRow }> {
  try {
    return await http.request<{ key: ApiKeyRow }>(
      "put",
      `/control-api/v1/admin/keys/${encodeURIComponent(id)}`,
      { data }
    );
  } catch (e) {
    return failWith(e);
  }
}

/** 删除（硬删：记录移除，出站立即 401，不可恢复） */
export async function deleteApiKey(id: string): Promise<{ deleted: boolean }> {
  try {
    return await http.request<{ deleted: boolean }>(
      "delete",
      `/control-api/v1/admin/keys/${encodeURIComponent(id)}`
    );
  } catch (e) {
    return failWith(e);
  }
}

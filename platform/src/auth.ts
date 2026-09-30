/* ============================================================
   Bearer 鉴权（Phase 1）
   ------------------------------------------------------------
   Authorization: Bearer sk-world-xxxx
   · 缺失/格式错 → 401 invalid_api_key
   · 撤销/过期 → 401（verify 统一返回无效）
   · 权限不足 → 403 insufficient_permission
   纯函数：不触网、不执行任何外部进程。
   ============================================================ */
import type { ApiKeyRecord, PlatformPermission } from './types.ts';
import type { KeyStore } from './keys/keystore.ts';

type PlatformRequestHeaders = Record<string, string | string[] | undefined>;

export type AuthResult =
  | { ok: true; key: ApiKeyRecord }
  | { ok: false; status: number; code: string; message: string };

function headerOf(headers: PlatformRequestHeaders, name: string): string | null {
  const v = headers[name.toLowerCase()];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length === 1) return v[0] ?? null;
  return null;
}

export function extractBearer(headers: PlatformRequestHeaders): string | null {
  const raw = headerOf(headers, 'authorization');
  if (!raw) return null;
  const matched = raw.trim().match(/^Bearer\s+(.+)$/i);
  return matched && matched[1] ? matched[1] : null;
}

export function authenticate(store: KeyStore, headers: PlatformRequestHeaders): AuthResult {
  const token = extractBearer(headers);
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: 'invalid_api_key',
      message: '缺少 API Key：请以 Authorization: Bearer sk-world-... 携带密钥',
    };
  }
  const key = store.verify(token);
  if (!key) {
    /* verify 不区分「不存在」与「撤销/过期」——统一 401，避免向调用方
       泄露密钥存在性；运维可在 keyctl list 里核对状态。 */
    return {
      ok: false,
      status: 401,
      code: 'invalid_api_key',
      message: 'API Key 无效、已撤销或已过期',
    };
  }
  return { ok: true, key };
}

export function hasPermission(key: ApiKeyRecord, perm: PlatformPermission): boolean {
  return key.permissions.includes(perm);
}

export interface AuthFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
}

export function permissionDenied(perm: PlatformPermission): AuthFailure {
  return {
    ok: false,
    status: 403,
    code: 'insufficient_permission',
    message: `当前 API Key 缺少权限：${perm}`,
  };
}

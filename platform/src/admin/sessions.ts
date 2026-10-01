/* ============================================================
   管理会话存储（M3.1）
   ------------------------------------------------------------
   不透明随机令牌（非 JWT：无签名解析面，吊销即失效）；
   accessToken 12h / refreshToken 7d，刷新即轮换（旧对作废）；
   落盘 data/sessions.json（重启不丢会话；文件随写随落，量小）。

   安全姿态：
   · 主令牌（x-admin-token，服务端反代注入）与会话是两种凭证——
     浏览器只持有角色受限的会话，主令牌永不落浏览器；
   · 过期/吊销的会话一律 401，不泄露存在性细节。
   ============================================================ */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AdminRole } from './permissions.ts';

const STORE_VERSION = 1;
/** accessToken 有效期（毫秒） */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** refreshToken 有效期（毫秒）；到期后会话整体不可再刷新 */
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AdminSession {
  token: string;
  refreshToken: string;
  userId: string;
  username: string;
  role: AdminRole;
  createdAt: string;
  /** accessToken 过期时刻（ISO） */
  expiresAt: string;
  /** refreshToken 过期时刻（ISO） */
  refreshExpiresAt: string;
  lastRefreshAt: string | null;
}

export interface SessionIdentity {
  kind: 'session';
  session: AdminSession;
}

export interface MasterIdentity {
  kind: 'master';
}

/** 已鉴权身份：主令牌（全权）或会话（角色受限） */
export type Identity = SessionIdentity | MasterIdentity;

export class SessionStore {
  private sessions = new Map<string, AdminSession>();
  private readonly now: () => number;

  constructor(
    private readonly filePath: string,
    now: () => number = () => Date.now(),
  ) {
    this.now = now;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as { version?: number; sessions?: AdminSession[] };
      if (parsed.version === STORE_VERSION && Array.isArray(parsed.sessions)) {
        for (const s of parsed.sessions) {
          if (s && typeof s.token === 'string') this.sessions.set(s.token, s);
        }
      }
    } catch {
      throw new Error(`管理会话文件损坏，无法解析：${this.filePath}`);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    /* 过期条目不落盘（惰性清理） */
    const live = [...this.sessions.values()].filter((s) => new Date(s.refreshExpiresAt).getTime() > this.now());
    writeFileSync(this.filePath, `${JSON.stringify({ version: STORE_VERSION, sessions: live }, null, 2)}\n`, 'utf8');
  }

  /** 登录成功后签发新会话（全新 token 对） */
  issue(userId: string, username: string, role: AdminRole): AdminSession {
    const t = this.now();
    const session: AdminSession = {
      token: `sess-${randomBytes(24).toString('hex')}`,
      refreshToken: `rfr-${randomBytes(24).toString('hex')}`,
      userId,
      username,
      role,
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + SESSION_TTL_MS).toISOString(),
      refreshExpiresAt: new Date(t + REFRESH_TTL_MS).toISOString(),
      lastRefreshAt: null,
    };
    this.sessions.set(session.token, session);
    this.persist();
    return session;
  }

  /** 校验 accessToken → 会话；过期/未知 → null（统一 401） */
  verify(token: string | undefined): AdminSession | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (new Date(s.expiresAt).getTime() <= this.now()) return null;
    return s;
  }

  /**
   * 刷新：refreshToken 有效（会话记录存在且 refresh 未过期）→ 轮换出
   * 全新 token 对并顺延 accessToken 过期；旧对立即作废。
   */
  refresh(refreshToken: string | undefined): AdminSession | null {
    if (!refreshToken) return null;
    const s = [...this.sessions.values()].find((x) => x.refreshToken === refreshToken);
    if (!s) return null;
    if (new Date(s.refreshExpiresAt).getTime() <= this.now()) {
      this.sessions.delete(s.token);
      this.persist();
      return null;
    }
    this.sessions.delete(s.token);
    const fresh = this.issue(s.userId, s.username, s.role);
    fresh.createdAt = s.createdAt;
    fresh.lastRefreshAt = new Date(this.now()).toISOString();
    this.persist();
    return fresh;
  }

  /** 吊销（登出）；幂等 */
  revoke(token: string | undefined): boolean {
    if (!token || !this.sessions.has(token)) return false;
    this.sessions.delete(token);
    this.persist();
    return true;
  }

  /** 吊销某用户全部会话（停用/改密后立即使其下线） */
  revokeUser(userId: string): number {
    let n = 0;
    for (const [token, s] of this.sessions) {
      if (s.userId === userId) {
        this.sessions.delete(token);
        n++;
      }
    }
    if (n > 0) this.persist();
    return n;
  }

  size(): number {
    return this.sessions.size;
  }
}

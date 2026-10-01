/* ============================================================
   本地用户存储（M3.3 · 决策点 3：「本地三档用户 + 文件存储」）
   ------------------------------------------------------------
   · 口令 scrypt 加盐哈希落盘（data/users.json），校验 timingSafeEqual；
   · 首次启动无用户文件时播种三档内置账号（口令与 ADMIN-PERMISSION
     的已实测矩阵一致），控制台显著告警——公开文档里的默认口令，
     运营部署必须立即修改；
   · 完整用户 CRUD / 多租户 / 配额归平台 Phase 2，这里只有最小面：
     创建、改昵称/角色/状态、重置口令、启停；无删除（停用代替）；
   · 末位保护：不允许停用或降级最后一名 active 的 admin（防锁死）。
   ============================================================ */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAdminRole, type AdminRole } from './permissions.ts';

const STORE_VERSION = 1;

export interface AdminUser {
  id: string;
  username: string;
  nickname: string;
  role: AdminRole;
  status: 'active' | 'disabled';
  builtin: boolean;
  remark: string;
  createdAt: string;
  lastLoginAt: string | null;
  /** scrypt 盐（hex） */
  salt: string;
  /** scrypt 哈希（hex） */
  passwordHash: string;
}

export interface PublicUser {
  id: string;
  username: string;
  nickname: string;
  role: AdminRole;
  status: 'active' | 'disabled';
  builtin: boolean;
  remark: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export class UserStoreError extends Error {}

const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const a = Buffer.from(hashPassword(password, salt), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class UserStore {
  private users: AdminUser[] = [];
  private readonly now: () => number;

  constructor(
    private readonly filePath: string,
    now: () => number = () => Date.now(),
  ) {
    this.now = now;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.seedBuiltins();
      return;
    }
    let parsed: { version?: number; users?: AdminUser[] };
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      /* 损坏的用户文件不静默重建——抛出让运维处理 */
      throw new Error(`用户文件损坏，无法解析：${this.filePath}`);
    }
    if (parsed.version === STORE_VERSION && Array.isArray(parsed.users)) {
      this.users = parsed.users;
    }
  }

  /** 首次启动播种三档内置账号（默认口令即公开文档矩阵，控制台显著告警） */
  private seedBuiltins(): void {
    const t = this.now();
    const make = (username: string, password: string, role: AdminRole): AdminUser => {
      const salt = randomBytes(16).toString('hex');
      return {
        id: `usr-${randomBytes(4).toString('hex')}`,
        username,
        nickname: '',
        role,
        status: 'active',
        builtin: true,
        remark: '内置账号',
        createdAt: new Date(t).toISOString(),
        lastLoginAt: null,
        salt,
        passwordHash: hashPassword(password, salt),
      };
    };
    this.users = [
      make('admin', 'admin123', 'admin'),
      make('operator', 'operator123', 'operator'),
      make('viewer', 'viewer123', 'viewer'),
    ];
    this.persist();
    console.error(
      '[admin-users] 已播种内置账号：admin/admin123、operator/operator123、viewer/viewer123' +
        '——这是公开文档中的默认口令，任何非本机部署都必须立即在「系统管理 → 用户」中修改！',
    );
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify({ version: STORE_VERSION, users: this.users }, null, 2)}\n`, 'utf8');
  }

  /** 脱敏投影（绝无 salt/hash） */
  project(u: AdminUser): PublicUser {
    return {
      id: u.id,
      username: u.username,
      nickname: u.nickname,
      role: u.role,
      status: u.status,
      builtin: u.builtin,
      remark: u.remark,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    };
  }

  list(): PublicUser[] {
    return [...this.users]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((u) => this.project(u));
  }

  /** 登录校验：用户名不存在/停用/口令错 → null（统一错误，不泄露存在性） */
  authenticate(username: string, password: string): AdminUser | null {
    const u = this.users.find((x) => x.username === username);
    if (!u || u.status !== 'active') return null;
    if (!verifyPassword(password, u.salt, u.passwordHash)) return null;
    u.lastLoginAt = new Date(this.now()).toISOString();
    this.persist();
    return u;
  }

  getById(id: string): AdminUser | null {
    return this.users.find((x) => x.id === id) ?? null;
  }

  create(opts: { username: string; password: string; nickname?: string; role: AdminRole; remark?: string }): PublicUser {
    const username = opts.username;
    if (!USERNAME_RE.test(username)) {
      throw new UserStoreError('用户名必须是 3-32 位 [A-Za-z0-9_-]');
    }
    if (this.users.some((x) => x.username === username)) {
      throw new UserStoreError(`用户名 '${username}' 已存在`);
    }
    const salt = randomBytes(16).toString('hex');
    const t = this.now();
    const user: AdminUser = {
      id: `usr-${randomBytes(4).toString('hex')}`,
      username,
      nickname: opts.nickname ?? '',
      role: opts.role,
      status: 'active',
      builtin: false,
      remark: opts.remark ?? '',
      createdAt: new Date(t).toISOString(),
      lastLoginAt: null,
      salt,
      passwordHash: hashPassword(opts.password, salt),
    };
    this.users.push(user);
    this.persist();
    return this.project(user);
  }

  /**
   * 更新：昵称/备注/角色/状态/重置口令。
   * 末位保护：停用或把最后一名 active admin 降级 → 抛错。
   */
  update(
    id: string,
    patch: { nickname?: string; remark?: string; role?: AdminRole; status?: 'active' | 'disabled'; password?: string },
  ): PublicUser {
    const u = this.getById(id);
    if (!u) throw new UserStoreError(`用户 '${id}' 不存在`);
    if (u.role === 'admin' && u.status === 'active') {
      const losingAdmin =
        (patch.status === 'disabled') ||
        (patch.role !== undefined && patch.role !== 'admin');
      if (losingAdmin) {
        const otherAdmins = this.users.filter((x) => x.role === 'admin' && x.status === 'active' && x.id !== id);
        if (otherAdmins.length === 0) {
          throw new UserStoreError('末位保护：不能停用或降级最后一名启用的 admin（先创建/启用另一名 admin）');
        }
      }
    }
    if (patch.nickname !== undefined) {
      if (typeof patch.nickname !== 'string' || patch.nickname.length > 32) throw new UserStoreError('昵称必须是 ≤32 字符');
      u.nickname = patch.nickname;
    }
    if (patch.remark !== undefined) {
      if (typeof patch.remark !== 'string' || patch.remark.length > 128) throw new UserStoreError('备注必须是 ≤128 字符');
      u.remark = patch.remark;
    }
    if (patch.role !== undefined) {
      if (!isAdminRole(patch.role)) throw new UserStoreError(`未知角色 '${String(patch.role)}'（可用：admin/operator/viewer）`);
      u.role = patch.role;
    }
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'disabled') throw new UserStoreError("status 只接受 'active' | 'disabled'");
      u.status = patch.status;
    }
    if (patch.password !== undefined) {
      if (typeof patch.password !== 'string' || patch.password.length < 6 || patch.password.length > 64) {
        throw new UserStoreError('口令必须是 6-64 字符');
      }
      u.salt = randomBytes(16).toString('hex');
      u.passwordHash = hashPassword(patch.password, u.salt);
    }
    this.persist();
    return this.project(u);
  }

  static validateNewPassword(password: unknown): asserts password is string {
    if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
      throw new UserStoreError('口令必须是 6-64 字符');
    }
  }
}

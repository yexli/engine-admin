/* ============================================================
   API Key 存储（Phase 1 · 方案 §8 最小可行子集）
   ------------------------------------------------------------
   · 明文密钥只在创建响应中出现一次；落盘只存 SHA-256 哈希 + 展示前缀；
   · 文件 JSON 持久化（Phase 8 迁移 PostgreSQL）；写入走脏标记 + 防抖
     落盘，验证路径零 I/O；
   · supports bootstrap 主密钥（环境变量），保证运维在没有任何
     key 文件时也能进入（不落盘、不在日志出现）。
   ============================================================ */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ApiKeyRecord, PlatformPermission } from '../types.ts';
import { PLATFORM_PERMISSIONS } from '../types.ts';

const STORE_VERSION = 1;
/** 防抖落盘间隔（ms） */
const FLUSH_DEBOUNCE_MS = 2000;

interface KeyStoreFile {
  version: number;
  keys: ApiKeyRecord[];
}

export interface CreateKeyOptions {
  name: string;
  tenantId?: string;
  permissions?: PlatformPermission[];
  /** 归属游戏方（G2）：非空 = 游戏方钥匙；缺省 null = 平台管理钥匙 */
  gameId?: string;
  /** ISO 日期；缺省不过期 */
  expiresAt?: string;
}

export interface CreatedKey {
  record: ApiKeyRecord;
  /** 明文（仅此一次） */
  plaintext: string;
}

/** 缺省最小权限（只读）（P2 卡片3）：未显式声明 permissions 时的安全回退。
 *  最小权限原则——新 Key 拿不到写权限；需要写的调用方必须显式声明 worlds:write。
 *  bootstrap 主密钥不受此影响（仍为全量权限，运维逃生通道）。 */
export const MINIMAL_PERMISSIONS: readonly PlatformPermission[] = ['worlds:read'] as const;

/** 规范权限列表：过滤未知项；空/未声明 → 最小只读回退 */
export function normalizePermissions(input: unknown): PlatformPermission[] {
  if (!Array.isArray(input) || input.length === 0) return [...MINIMAL_PERMISSIONS];
  const out = input.filter(
    (p): p is PlatformPermission =>
      typeof p === 'string' && (PLATFORM_PERMISSIONS as readonly string[]).includes(p),
  );
  return out.length ? out : [...MINIMAL_PERMISSIONS];
}

export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export function newKeyPlaintext(): string {
  return `sk-world-${randomBytes(24).toString('hex')}`;
}

export class KeyStore {
  private keys: ApiKeyRecord[] = [];
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly bootstrapKeyHash: string | null;
  /** 释放进程钩子并同步落盘（测试/优雅退出用；避免钩子累积） */
  dispose!: () => void;

  constructor(
    private readonly filePath: string,
    /** 主密钥（明文，来自环境变量）；不落盘，拥有全量权限 */
    bootstrapKey?: string,
    private readonly now: () => number = () => Date.now(),
    private readonly flushFn: (file: string, data: KeyStoreFile) => void = flushSync,
  ) {
    this.bootstrapKeyHash = bootstrapKey ? hashKey(bootstrapKey) : null;
    this.load();
    /* 崩溃兜底（P2 卡片2）：防抖窗口（2s）内进程退出时，最近 2s 的
       create/remove/revoke 变更不能丢——exit/SIGINT/SIGTERM 同步冲刷。 */
    const exitFlush = (): void => {
      this.flush();
    };
    const onSigint = (): void => {
      exitFlush();
      process.exit(130);
    };
    const onSigterm = (): void => {
      exitFlush();
      process.exit(143);
    };
    process.once('exit', exitFlush);
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    this.dispose = (): void => {
      process.removeListener('exit', exitFlush);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      exitFlush();
    };
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as KeyStoreFile;
      if (parsed.version === STORE_VERSION && Array.isArray(parsed.keys)) {
        this.keys = parsed.keys;
      }
    } catch {
      /* 损坏的 key 文件不静默重建覆盖——抛出让运维处理，避免清空现存密钥 */
      throw new Error(`API key store 损坏，无法解析：${this.filePath}`);
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    /* 允许进程退出前不等待定时器（flushSync 由调用方/测试显式触发亦可） */
    this.timer.unref?.();
  }

  /** 立即落盘（测试与优雅退出用） */
  flush(): void {
    if (!this.dirty) return;
    const file: KeyStoreFile = { version: STORE_VERSION, keys: this.keys };
    this.flushFn(this.filePath, file);
    this.dirty = false;
  }

  /** 创建密钥：返回明文（仅此一次） */
  create(opts: CreateKeyOptions): CreatedKey {
    const plaintext = newKeyPlaintext();
    const record: ApiKeyRecord = {
      id: `key-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      name: opts.name || 'unnamed',
      tenantId: opts.tenantId ?? 'default',
      keyHash: hashKey(plaintext),
      prefix: plaintext.slice(0, 12),
      permissions: normalizePermissions(opts.permissions),
      gameId: opts.gameId ?? null,
      createdAt: new Date().toISOString(),
      expiresAt: opts.expiresAt ?? null,
      lastUsedAt: null,
    };
    this.keys.push(record);
    this.scheduleFlush();
    return { record, plaintext };
  }

  /** 验证明文密钥 → 记录 | null（失效/过期/不存在一律 null，错误码由调用层细分） */
  verify(plaintext: string): ApiKeyRecord | null {
    const h = hashKey(plaintext);
    if (this.bootstrapKeyHash && h === this.bootstrapKeyHash) {
      return {
        id: 'bootstrap',
        name: 'bootstrap-master',
        tenantId: 'default',
        keyHash: '',
        prefix: plaintext.slice(0, 12),
        permissions: [...PLATFORM_PERMISSIONS],
        gameId: null,
        createdAt: new Date(0).toISOString(),
        expiresAt: null,
        lastUsedAt: null,
      };
    }
    const rec = this.keys.find((k) => k.keyHash === h);
    if (!rec) return null;
    if (rec.expiresAt && new Date(rec.expiresAt).getTime() <= this.now()) return null;
    rec.lastUsedAt = new Date().toISOString();
    this.scheduleFlush();
    return rec;
  }

  /**
   * 删除（硬删，0.5.1 起：记录从存储移除，该 Key 的出站请求即 401；
   * 历史用量记录中的 keyId 字符串保留原样）。未知 id → false。
   */
  remove(id: string): boolean {
    const idx = this.keys.findIndex((k) => k.id === id);
    if (idx === -1) return false;
    this.keys.splice(idx, 1);
    this.scheduleFlush();
    return true;
  }

  /** 设置/清除过期时间（管理面用）；ISO 字符串合法性由调用方校验 */
  setExpiresAt(id: string, expiresAt: string | null): boolean {
    const rec = this.keys.find((k) => k.id === id);
    if (!rec) return false;
    rec.expiresAt = expiresAt;
    this.scheduleFlush();
    return true;
  }

  list(): ApiKeyRecord[] {
    return [...this.keys];
  }
}

function flushSync(file: string, data: KeyStoreFile): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

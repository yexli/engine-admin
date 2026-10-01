/* ============================================================
   上游凭证密钥库（Model Control Plane · Task 1）
   ------------------------------------------------------------
   AES-256-GCM 加密落盘的上游凭证存储：
   · 明文只在 put() 入参与 resolve() 返回值中出现，永不进日志/配置/响应；
   · 每次替换生成新 secretId，旧记录保留（追加式）——配置回滚时旧
     引用仍可解析（"加密的上一版本密钥"）；
   · 主密钥来自服务端环境（PLATFORM_SECRET_MASTER_KEY），缺失即拒绝
     构造（受管启动 fail-fast），主密钥不匹配在 resolve 时显式报错；
   · 文件含 KDF 盐，任何实例都能独立解密；损坏文件抛错而非重建。
   ============================================================ */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigCorruptError } from './errors.ts';

const STORE_VERSION = 1;
/** 口令 → 256 位密钥的 KDF 参数（ scrypt，盐存文件头） */
const KDF_KEYLEN = 32;

interface SecretRecord {
  id: string;
  /** base64 IV（GCM 12 字节） */
  iv: string;
  /** base64 密文 */
  ct: string;
  /** base64 GCM tag */
  tag: string;
  createdAt: string;
}

interface SecretFile {
  version: typeof STORE_VERSION;
  /** scrypt 盐（base64）；换主密钥不会自动换盐——密文解不开即显式报错 */
  kdfSalt: string;
  secrets: SecretRecord[];
}

export class SecretStore {
  private records = new Map<string, SecretRecord>();
  private readonly key: Buffer;
  private readonly salt: Buffer;

  constructor(
    private readonly filePath: string,
    /** 主密钥口令（服务端环境提供；空/空白 = 配置缺失 → fail-fast） */
    masterKey: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!masterKey || masterKey.trim().length === 0) {
      throw new ConfigCorruptError('密钥库主密钥缺失：请设置 PLATFORM_SECRET_MASTER_KEY（非空字符串）');
    }
    if (existsSync(filePath)) {
      let parsed: SecretFile;
      try {
        parsed = JSON.parse(readFileSync(filePath, 'utf8')) as SecretFile;
      } catch {
        throw new ConfigCorruptError(`密钥文件损坏，无法解析：${filePath}`);
      }
      if (
        parsed.version !== STORE_VERSION ||
        typeof parsed.kdfSalt !== 'string' ||
        !(parsed.secrets instanceof Array)
      ) {
        throw new ConfigCorruptError(`密钥文件形状不识别（version/kdfSalt/secrets）：${filePath}`);
      }
      this.salt = Buffer.from(parsed.kdfSalt, 'base64');
      for (const r of parsed.secrets) {
        this.records.set(r.id, r);
      }
    } else {
      this.salt = randomBytes(16);
      this.persist();
    }
    this.key = scryptSync(masterKey, this.salt, KDF_KEYLEN);
    restrictPermissions(filePath);
  }

  /** 加密写入新值，返回新 secretId（旧记录保留，供配置回滚） */
  put(value: string): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('凭证值必须是非空字符串');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const record: SecretRecord = {
      id: `sec-${randomBytes(8).toString('hex')}`,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.records.set(record.id, record);
    this.persist();
    return record.id;
  }

  /** 解密取回；未知 id → null；主密钥不匹配/记录损坏 → 显式抛错（不含明文） */
  resolve(secretId: string): string | null {
    const record = this.records.get(secretId);
    if (!record) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      const pt = Buffer.concat([
        decipher.update(Buffer.from(record.ct, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return pt;
    } catch {
      throw new ConfigCorruptError(
        `密钥解密失败（secretId=${secretId}）：主密钥不匹配或记录损坏；修正 PLATFORM_SECRET_MASTER_KEY 或回滚密钥文件`,
      );
    }
  }

  has(secretId: string): boolean {
    return this.records.has(secretId);
  }

  private persist(): void {
    const file: SecretFile = {
      version: STORE_VERSION,
      kdfSalt: this.salt.toString('base64'),
      secrets: [...this.records.values()],
    };
    atomicWrite(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
    restrictPermissions(this.filePath);
  }
}

/** 同目录临时文件 + rename 的原子写（进程崩溃不留下半截文件） */
export function atomicWrite(filePath: string, data: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, filePath);
}

/** 收紧文件权限（POSIX 生效；Windows 无此语义，失败静默忽略） */
export function restrictPermissions(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* Windows/不支持平台：忽略 */
  }
}

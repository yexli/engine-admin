/* ============================================================
   World Platform 配置解析（Phase 1）
   ------------------------------------------------------------
   环境变量 → 运行配置；所有字段有安全缺省（本机端口 + 本地文件）。
   ============================================================ */
import { isAbsolute, resolve } from 'node:path';

export interface PlatformConfig {
  port: number;
  host: string;
  engineBaseUrl: string;
  gatewayBaseUrl: string;
  keysFile: string;
  routerFile: string;
  bootstrapKey: string | null;
  accessLog: boolean;
  corsAllowOrigin: string;
  /* ---------- Model Control Plane（受管模式；Task 1/3） ---------- */
  /** 版本化模型配置文档（providers/models/routes；存 data 目录，非 web 根） */
  modelConfigFile: string;
  /** 加密上游凭证存储 */
  secretsFile: string;
  /** 凭证加密主密钥；受管模式缺失即拒绝启动 */
  secretMasterKey: string | null;
  /** 管理面令牌（服务端注入反代/启动器；绝不进浏览器） */
  adminToken: string | null;
  /** 私有管理监听端口（loopback） */
  adminPort: number;
  /** 管理监听地址（固定 loopback 语义，仍可显式覆盖用于容器内） */
  adminHost: string;
  /** 容器逃生阀：显式允许管理监听绑定非回环地址（如 0.0.0.0）——
   *  供 Docker Compose 等内网隔离部署使用；开启时启动脚本大声告警，
   *  网络隔离责任转移到部署层（compose 内网 / 防火墙）。 */
  adminAllowNonLoopback: boolean;
  /** 出站上游主机允许列表（逗号分隔；空 = 不限主机） */
  upstreamAllowedHosts: string[];
  /** 是否允许环回/私有网段上游（本地推理服务器） */
  upstreamAllowLoopback: boolean;
  /** 出站上游调用超时（毫秒） */
  upstreamTimeoutMs: number;
  /** 受管 Gateway/Platform 对内监听端口（0 = 自动分配） */
  managedGatewayPort: number;
  /** 结构化用量记录（JSONL 追加；M2.2） */
  usageFile: string;
  /** 管线描述文件（只读 + 有界试跑；M2.3） */
  pipelinesFile: string;
  /** 本地用户存储（scrypt 哈希；M3.3） */
  usersFile: string;
  /** 管理会话存储（M3.1） */
  sessionsFile: string;
  /** 系统设置持久化（M3.4） */
  settingsFile: string;
  /** 演化运行账本目录（JSONL，每世界一文件；Phase C） */
  evolutionDir: string;
  /** 演化提案走的能力通道（缺省 reasoning） */
  evolutionCapability: string;
  /** 记忆库服务地址（M5 后特性：嵌入配置鉴权代理的目标） */
  memoryBaseUrl: string;
}

export function resolvePlatformConfig(
  env: Record<string, string | undefined>,
  cwd: string,
): PlatformConfig {
  const dataDir = resolve(cwd, env['PLATFORM_DATA_DIR'] ?? 'data');
  return {
    port: toInt(env['PLATFORM_PORT'], 8790),
    host: env['PLATFORM_HOST'] ?? '127.0.0.1',
    engineBaseUrl: env['ENGINE_BASE_URL'] ?? 'http://127.0.0.1:8787',
    gatewayBaseUrl: env['GATEWAY_BASE_URL'] ?? 'http://127.0.0.1:8788',
    keysFile: resolveFrom(env['PLATFORM_KEYS_FILE'] ?? resolve(dataDir, 'keys.json'), cwd),
    routerFile: resolveFrom(env['PLATFORM_ROUTER_FILE'] ?? resolve(dataDir, 'router.json'), cwd),
    bootstrapKey: env['PLATFORM_BOOTSTRAP_KEY'] ?? null,
    accessLog: env['PLATFORM_ACCESS_LOG'] !== '0',
    corsAllowOrigin: env['PLATFORM_CORS_ORIGIN'] ?? '*',
    modelConfigFile: resolveFrom(env['PLATFORM_MODEL_CONFIG_FILE'] ?? resolve(dataDir, 'model-config.json'), cwd),
    secretsFile: resolveFrom(env['PLATFORM_SECRETS_FILE'] ?? resolve(dataDir, 'secrets.json'), cwd),
    secretMasterKey: env['PLATFORM_SECRET_MASTER_KEY'] ?? null,
    adminToken: env['PLATFORM_ADMIN_TOKEN'] ?? null,
    adminPort: toInt(env['PLATFORM_ADMIN_PORT'], 8791),
    adminHost: env['PLATFORM_ADMIN_HOST'] ?? '127.0.0.1',
    adminAllowNonLoopback: env['PLATFORM_ADMIN_ALLOW_NON_LOOPBACK'] === '1',
    upstreamAllowedHosts: splitList(env['PLATFORM_UPSTREAM_HOST_ALLOWLIST']),
    upstreamAllowLoopback: env['PLATFORM_UPSTREAM_ALLOW_LOOPBACK'] === '1',
    upstreamTimeoutMs: toInt(env['PLATFORM_UPSTREAM_TIMEOUT_MS'], 60_000),
    managedGatewayPort: toInt(env['MANAGED_GATEWAY_PORT'], 0),
    usageFile: resolveFrom(env['PLATFORM_USAGE_FILE'] ?? resolve(dataDir, 'usage.jsonl'), cwd),
    pipelinesFile: resolveFrom(env['PLATFORM_PIPELINES_FILE'] ?? resolve(dataDir, 'pipelines.json'), cwd),
    usersFile: resolveFrom(env['PLATFORM_USERS_FILE'] ?? resolve(dataDir, 'users.json'), cwd),
    sessionsFile: resolveFrom(env['PLATFORM_SESSIONS_FILE'] ?? resolve(dataDir, 'sessions.json'), cwd),
    settingsFile: resolveFrom(env['PLATFORM_SETTINGS_FILE'] ?? resolve(dataDir, 'settings.json'), cwd),
    evolutionDir: resolveFrom(env['PLATFORM_EVOLUTION_DIR'] ?? resolve(dataDir, 'evolution'), cwd),
    evolutionCapability: env['PLATFORM_EVOLUTION_CAPABILITY'] ?? 'reasoning',
    memoryBaseUrl: env['PLATFORM_MEMORY_URL'] ?? 'http://127.0.0.1:8789',
  };
}

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function toInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolveFrom(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

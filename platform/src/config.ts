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
  };
}

function toInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolveFrom(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

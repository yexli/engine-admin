/* ============================================================
   外部引擎开关与端点配置（Phase 9 · 翻默认档后的终局形态）
   ------------------------------------------------------------
   Phase 9 起（方案 §19）：
   · **默认 = 外部会话宿主**（enabled: true, mode: session）——客户端
     只是外部 World Engine 的游戏端；`npm run dev` 前需先
     `npm run host:game`（断线为 §22 停摆语义：停止世界写、自动重连）；
   · 真 off-switch：env `VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE=false`
     （或 localStorage JSON 的 enabled:false）可显式回落本地引擎
     （迁移期开发逃生门；env 显式值 > localStorage 显式值 > 默认）；
   · localStorage 曾以「键存在即开启」判定——保留兼容，但显式
     enabled 布尔优先于存在性。

   本文件属于连接层，不 import 引擎包、不 import 游戏层。
   ============================================================ */

export const EXT_ENGINE_FLAG = 'TIANQIONG_EXTERNAL_WORLD_ENGINE';
export const EXT_ENGINE_LS_KEY = 'tq2_ext_engine_v1';

/** 缺省端点：本机宿主（scripts/world-host.mjs 的缺省端口，见 SDK-GUIDE 惯例 8798） */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8797';
export const DEFAULT_WORLD_ID = 'tianqiong-main';

export interface ExternalEngineConfig {
  enabled: boolean;
  baseUrl: string;
  worldId: string;
  apiKey?: string;
}

/** env 形状：浏览器里是 import.meta.env；测试/Node 侧可传普通对象 */
export type EnvLike = Record<string, string | undefined>;

export function readExternalEngineConfig(env: EnvLike = readViteEnv(), localStorageLike?: Storage): ExternalEngineConfig {
  const envRaw = env[`VITE_${EXT_ENGINE_FLAG}`];
  const ls = safeParse(localStorageLike?.getItem(EXT_ENGINE_LS_KEY)) as Record<string, unknown> | null;

  /* enabled 优先级：env 显式 > localStorage 显式 > 默认开（Phase 9）。
     truthy 之外的任何非空 env 值（'false'/'0'/错拼）一律视为显式关闭——
     逃生门必须比默认值更好按，而不是更难按。 */
  let enabled = DEFAULT_ENABLED;
  if (envRaw !== undefined && envRaw !== '') enabled = truthy(envRaw);
  else if (ls && typeof ls['enabled'] === 'boolean') enabled = ls['enabled'];
  else if (ls) enabled = true; /* 兼容旧判定：键存在即开 */

  let baseUrl = env['VITE_WORLD_ENGINE_URL'] ?? DEFAULT_BASE_URL;
  let worldId = env['VITE_WORLD_ENGINE_WORLD_ID'] ?? DEFAULT_WORLD_ID;
  const apiKey = env['VITE_WORLD_ENGINE_KEY'];

  if (ls) {
    if (typeof ls['baseUrl'] === 'string' && ls['baseUrl']) baseUrl = ls['baseUrl'];
    if (typeof ls['worldId'] === 'string' && ls['worldId']) worldId = ls['worldId'];
  }

  return {
    enabled,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    worldId,
    ...(apiKey ? { apiKey } : {}),
  };
}

/** Phase 9 翻转：外部会话宿主是默认形态 */
export const DEFAULT_ENABLED = true;

function truthy(v: string | undefined): boolean {
  return v === 'true' || v === '1' || v === 'yes';
}

function safeParse(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** 浏览器构建期的 env（vitest/node 侧没有 import.meta.env 时返回空表） */
function readViteEnv(): EnvLike {
  try {
    const env = (import.meta as unknown as { env?: EnvLike }).env;
    return env ?? {};
  } catch {
    return {};
  }
}

/** 当前环境的 localStorage（没有则 undefined——node/SSR 安全） */
export function platformStorage(): Storage | undefined {
  try {
    if (typeof globalThis.localStorage === 'object' && globalThis.localStorage !== null) {
      return globalThis.localStorage;
    }
  } catch {
    /* 部分环境访问 localStorage 直接抛（隐私模式），视为没有 */
  }
  return undefined;
}


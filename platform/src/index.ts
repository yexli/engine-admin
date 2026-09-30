/* ============================================================
   World Platform（Phase 1 · 平台 API 标准化）
   ------------------------------------------------------------
   公共出口。组合方式见 scripts/run-platform.mjs 与 tests/loop.test.ts。
   ============================================================ */
export * from './types.ts';
export { KeyStore, hashKey, newKeyPlaintext, normalizePermissions } from './keys/keystore.ts';
export type { CreateKeyOptions, CreatedKey } from './keys/keystore.ts';
export { authenticate, extractBearer, hasPermission, permissionDenied } from './auth.ts';
export { analyzeTask, KNOWN_CAPABILITIES } from './tasks.ts';
export { ModelRouter, DEFAULT_ROUTES } from './router/modelrouter.ts';
export { createEngineClient } from './upstream/engine.ts';
export { createGatewayClient } from './upstream/gateway.ts';
export type { ChatMessage } from './upstream/gateway.ts';
export { buildWorldContext } from './worldagent/context.ts';
export { runWorldAgent, worldAgentResponse, extractWorldId } from './worldagent/pipeline.ts';
export { WORLD_AGENT_MODEL } from './http/protocol.ts';
export { createWorldPlatform } from './http/protocol.ts';
export { startPlatformServer } from './http/server.ts';
export { resolvePlatformConfig } from './config.ts';
export type { PlatformConfig } from './config.ts';

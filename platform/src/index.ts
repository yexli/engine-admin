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
export * from './evolution/index.ts';
export { WORLD_AGENT_MODEL } from './http/protocol.ts';
export { createWorldPlatform } from './http/protocol.ts';
export { startPlatformServer } from './http/server.ts';
export { createUsageRecorder } from './usage/recorder.ts';
export type { UsageEntry, UsageSink, UsageReader, UsageRecorder, UsageRecorderOptions } from './usage/recorder.ts';
export { queryUsage, PAGE_SIZE_CAP } from './usage/query.ts';
export type { UsageQuery, UsageQueryResult, UsageSummary, UsageGroupRow } from './usage/query.ts';
export { PipelineStore, PipelineStoreError } from './admin/pipelines.ts';
export type { PipelineDoc } from './admin/pipelines.ts';
export { SessionStore, SESSION_TTL_MS, REFRESH_TTL_MS } from './admin/sessions.ts';
export type { AdminSession, Identity } from './admin/sessions.ts';
export { UserStore, UserStoreError, hashPassword, verifyPassword } from './admin/users.ts';
export type { AdminUser, PublicUser } from './admin/users.ts';
export { SettingsStore, SETTING_SPECS } from './admin/settings.ts';
export type { SettingSpec, SettingRow } from './admin/settings.ts';
export {
  ADMIN_ROLES,
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  ROLE_NICKNAME,
  hasPerm,
  isAdminRole,
  permissionsOfRole,
} from './admin/permissions.ts';
export type { AdminRole } from './admin/permissions.ts';
export { resolvePlatformConfig } from './config.ts';
export type { PlatformConfig } from './config.ts';

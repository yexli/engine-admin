/* ============================================================
   @/world-engine —— 外部连接层公共出口（方案 §七）
   ------------------------------------------------------------
   游戏各层只允许从这里 import 外部引擎能力；引擎包本身
   （'world-engine'）只属于 src/world 与 src/events 的机制装配层。

   Phase 10 终局形态：GameSessionClient（游戏会话通道）+
   WorldEngineClient（世界事实通用客户端，SDK/管理面用）。
   ============================================================ */
export { WorldEngineClient, WorldEngineOfflineError, WorldEngineHttpError, intentToCommand, newCommandId, orderByEventId } from './client/WorldEngineClient';
export type { ConnectionStatus, MinimalWebSocket, WebSocketFactory, WorldEngineClientOptions } from './client/WorldEngineClient';
export { GameSessionClient, readSse } from './client/gameSession';
export type { GameSessionOptions, SessionCommandResult, SessionEvent, SessionStatePayload } from './client/gameSession';
export {
  DEFAULT_BASE_URL,
  DEFAULT_ENABLED,
  DEFAULT_WORLD_ID,
  EXT_ENGINE_FLAG,
  EXT_ENGINE_LS_KEY,
  platformStorage,
  readExternalEngineConfig,
} from './config';
export type { ExternalEngineConfig } from './config';

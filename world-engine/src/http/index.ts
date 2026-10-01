/* ============================================================
   world-engine/http · HTTP 传输层子路径出口
   （方案 §64：Library → SDK → HTTP → Cloud；本层只做传输，
     不含业务；核心桶 index.ts 保持环境中性，不导出本目录。）
   ============================================================ */
export { createWorldHttp, apiKeyOf, WORLD_SCOPES } from './protocol.ts';
export type {
  HttpRequest,
  HttpResponse,
  WorldInfo,
  WorldHttpInit,
  WorldAuthInit,
  WorldAuthKey,
} from './protocol.ts';
export { attachEventStream } from './ws.ts';
export type { EventStreamOptions } from './ws.ts';
export { startWorldServer } from './server.ts';
export type { WorldServer, WorldServerOptions } from './server.ts';

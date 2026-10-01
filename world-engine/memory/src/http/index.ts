/* ============================================================
   world-memory · HTTP 出口（M1.1 · G7）
   纯路由协议 + node 薄壳，模式同 world-engine/http。
   只读 + 检索面；写世界的口子依旧不存在（§16）。
   ============================================================ */
export { createMemoryHttp } from './protocol.ts';
export type {
  HttpRequest,
  HttpResponse,
  MemoryHttpInit,
  MemoryStoreInit,
  MemoryRecordRow,
} from './protocol.ts';
export { startMemoryServer } from './server.ts';
export type { MemoryServer, MemoryServerOptions } from './server.ts';

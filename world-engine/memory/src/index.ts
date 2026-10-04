/* ============================================================
   world-memory · 公共出口（V0.8 · 方案 §16）
   独立角色记忆引擎：只读世界事实，绝不直接写世界状态——
   检索结果喂给宿主的 AI，AI 的意图经宿主 Command 通道落地。
   ============================================================ */
export { MemoryEngine, } from './engine.ts';
export {
  DEFAULT_MEMORY_CONFIG,
} from './types.ts';
export type {
  WorldFact,
  MemoryEntry,
  MemorySnapshot,
  MemoryVia,
  RecallOptions,
  MemoryConfig,
  MemorySavePort,
  EmbedHook,
  EmbeddingService,
  MemoryEngineConfigAll,
} from './types.ts';
export { InMemoryMemoryStorage } from './storage.ts';

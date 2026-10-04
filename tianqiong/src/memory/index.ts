/* Memory Engine 公共出口（《Memory Engine 记忆系统设计方案》§42） */
export { memoryEngine, attachMemoryEngine } from './MemoryEngine';
export type { CreateMemoryInput } from './MemoryEngine';
export { validateMemoryProposal } from './MemoryValidator';
export type { MemoryProposal, ProposalVerdict } from './MemoryValidator';
export { buildMemoryContext, memoryContextText } from './context/MemoryContextBuilder';
export type { MemoryContextLine, ProfileName } from './context/MemoryContextBuilder';
export { hybridRetrieve } from './retrieval/HybridRetriever';
export type { ScoredMemory } from './retrieval/HybridRetriever';
export type { MemoryQuery } from './retrieval/StructuredRetriever';
export { structuredFilter, visibleTo } from './retrieval/StructuredRetriever';
export {
  gossipTick,
  propagate,
  propagateFromFaction,
  propagateToFaction,
  spreadAlongNetwork,
} from './propagation/InformationPropagation';
export {
  beliefActionsFor,
  beliefOf,
  beliefsOf,
  believesIn,
  formBeliefs,
  markBeliefActed,
  matchBeliefRules,
  partsOf,
  propositionOf,
} from './belief/BeliefSystem';
export type { BeliefActionHit, BeliefActionRule } from './belief/BeliefSystem';
export {
  compress,
  decayTick,
  LOD_PERIOD,
  memoryDue,
  memoryLodOf,
  memoryTick,
  reinforce,
} from './lifecycle/MemoryLifecycle';
export type { MemoryLod } from './lifecycle/MemoryLifecycle';
export {
  importanceOfLegacyImp,
  memOf,
  migrateLegacyMemories,
  visibilityOfLegacyTier,
} from './LegacyMemory';
export { setEmbeddingProvider, embeddingAvailable, embeddingProvider } from './embedding/EmbeddingProvider';
export type { EmbeddingProvider } from './embedding/EmbeddingProvider';
export {
  VECTOR_PERSIST_BYTES,
  cachedMemoryVec,
  cachedQueryVec,
  clearEmbeddingCache,
  cosine,
  embeddingCacheSize,
  exportVectors,
  persistVectorIndex,
  restoreVectorIndex,
  restoreVectors,
  touchMemoryVec,
  warmMemories,
  warmQuery,
} from './embedding/EmbeddingCache';
export type { WarmItem } from './embedding/EmbeddingCache';
export { InMemoryVectorStore, vectorStore } from './vector/InMemoryVectorStore';
export type { SearchOptions, SearchResult, VectorItem, VectorStore } from './vector/VectorStore';
export { cosine as cosSimilarity } from './vector/Similarity';
export {
  confidenceOf,
  importanceOf,
  decayRateFor,
  strengthOf,
  MEMORY_CAP,
  CONTEXT_TOKENS,
  CHARS_PER_TOKEN,
  RETRIEVAL_PROFILES,
} from './MemoryTypes';
export { memoriesOf, findMemory, memoryCount, nextMemoryId } from './MemoryStore';

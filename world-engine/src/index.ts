/* ============================================================
   AI World Engine · 公共出口
   独立世界运行内核：状态 / 时间 / 事件 / 命令 / 规则 / 运行循环。
   不依赖任何 UI、React、LLM、Memory、具体游戏。
   （相对导入带 .ts 扩展名：构建经 rewriteRelativeImportExtensions
     重写为 .js，dist 可被 node 直接 import——包消费面的硬要求。）
   ============================================================ */

/* 状态信封 */
export type {
  EngineWorldState,
  EntityDynamic,
  PlayerDynamic,
  StatusEffect,
  BagRow,
  RelEdge,
  LogEntry,
  HistoryEntry,
  WorldEventInst,
} from './types.ts';

/* 基础设施 */
export { rng, clamp } from './rng.ts';
export { scheduler } from './scheduler.ts';

/* 世界事件 */
export {
  makeEvent,
  registerEventTables,
  levelOf,
  channelOf,
  eventSeq,
  setEventSeq,
  resetEventSeq,
  nextEventId,
  traceChain,
  ALL_EVENT_TYPES,
  createEventSchema,
  defaultEventSchema,
} from './events/EventSchema.ts';
export type { WorldEvent, EventDraft, EventChannel, WorldEventLevel, EventSchemaInstance } from './events/EventSchema.ts';
export {
  worldBus,
  causality,
  withReasonerOrigin,
  isReasonerOrigin,
  setWorldBusLogger,
  createWorldEventBus,
  defaultWorldEventBusScope,
  MAX_EVENTS_PER_TICK,
  MAX_CHAIN_DEPTH,
  MAX_CRITICAL_PER_TICK,
} from './events/WorldEventBus.ts';
export type { EventDeliveryResult, WorldBusLogger, WorldEventBus, WorldEventBusScope } from './events/WorldEventBus.ts';

/* 时间 */
export { CHEN_PER_DAY, DAYS_PER_YEAR, TICKS_PER_YEAR, START_AGE } from './time/TimeBase.ts';
export { createWorldClock, shichenOf, dayOfTick, periodSeg, TICKS_PER_HOUR } from './time/WorldClock.ts';
export type { CalendarLabels, WorldClock, WorldClockOptions, SceneTime } from './time/WorldClock.ts';

/* 状态 */
export { createWorldContainer, createBaseState, SAVE_THROTTLE_MS } from './state/WorldState.ts';
export type { WorldContainer, WorldContainerOptions, StateHolder, BaseStateSpec } from './state/WorldState.ts';
export { applyDefinition } from './state/WorldDefinition.ts';
export type { WorldDefinition, WorldDefinitionEntity, WorldDefinitionLocation, WorldDefinitionRelation } from './state/WorldDefinition.ts';
export { splitShards, mergeShards, isShardedMain } from './state/Shards.ts';
export type { ShardFieldSpec, ShardSnapshot } from './state/Shards.ts';
export { InMemoryWorldStorage } from './state/storage.ts';
export type { SavePort } from './state/storage.ts';
export type { LocationRecord, RelationRecord } from './types.ts';

/* 受控写入 */
export { createMutate } from './mutate/WorldMutate.ts';
export type { KernelMutate, LogCls, MutateOptions } from './mutate/WorldMutate.ts';

/* 命令 / 规则 / 运行时 */
export type { WorldCommand, CommandResult } from './command/Command.ts';
export { RuleRegistry } from './rules/Rules.ts';
export type { WorldRule, RuleContext, EventEmit } from './rules/Rules.ts';
export { createWorldRuntime } from './runtime/WorldRuntime.ts';
export type { WorldRuntime, WorldRuntimeOptions } from './runtime/WorldRuntime.ts';
export {
  builtinRules,
  moveRule,
  attackRule,
  talkRule,
  advanceTimeRule,
  changeWeatherRule,
  spawnEntityRule,
  setAttitudeRule,
  createEntityRule,
  removeEntityRule,
  updateAttributeRule,
  setRelationRule,
  moveEntityRule,
  coreRules,
  rpgCompatRules,
} from './runtime/BuiltinRules.ts';

/* API */
export { createWorld } from './api/WorldAPI.ts';
export type { WorldHandle, CreateWorldOptions, WorldTimeView } from './api/WorldAPI.ts';
export { createQuery } from './api/WorldQuery.ts';
export type { WorldQuery, QuerySource } from './api/WorldQuery.ts';
export { createWorldRegistry, WorldRegistryError } from './api/WorldRegistry.ts';
export type { WorldRegistry } from './api/WorldRegistry.ts';

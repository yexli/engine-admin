/* ============================================================
   AI World Evolution Runtime（方案 §四-§九的落地模块）
   ------------------------------------------------------------
   World State → Context Builder → AI World Driver → Evolution
   Proposal → Rules（经引擎命令链） → Mutation → Event → 反馈。

   本模块不 import 引擎内核：演化层经 EngineClient（HTTP）与引擎
   对话，进程边界即权限边界——它对世界的全部影响力是「提交命令」，
   与任何游戏客户端同权。
   ============================================================ */
export type {
  IntentKind,
  WorldIntent,
  IntentOutcome,
  Observation,
  EvolutionContext,
  ProposedChange,
  EvolutionProposal,
  ChangeOutcome,
  EvolutionRun,
  EvolutionDriver,
} from './types.ts';
export { EvolutionDriverError } from './types.ts';
export { buildEvolutionContext, renderContextFacts } from './context.ts';
export { CORE_EVOLUTION_ACTIONS, translateChange, type CoreEvolutionAction, type TranslatedChange } from './commands.ts';
export { gatewayDriver, createScriptedDriver, normalizeProposal, extractJson, type GatewayDriverDeps, type ScriptStep, type NormalizeOptions } from './driver.ts';
export { createEvolutionJournal, type FileEvolutionJournalOptions } from './journal.ts';
export { createEvolutionRuntime, type EvolutionRuntime, type EvolutionRuntimeOptions } from './runtime.ts';

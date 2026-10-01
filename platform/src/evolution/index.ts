/* ============================================================
   AI World Evolution Runtime（方案 §四-§九的落地模块；V2 收口）
   ------------------------------------------------------------
   World State → Context Builder → AI World Driver → Evolution
   Proposal → Policy/Whitelist → Rules（经引擎命令链） → Mutation →
   Event → Journal → Trace。

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
  ChangeStatus,
  EvolutionRun,
  EvolutionRunStatus,
  EvolutionPolicy,
  EvolutionCausation,
  TriggerGrade,
  TriggerEventView,
  EvolutionDriver,
} from './types.ts';
export { EvolutionDriverError, EvolutionCooldownError, NPC_EVOLUTION_POLICY } from './types.ts';
export { buildEvolutionContext, renderContextFacts } from './context.ts';
export { CORE_EVOLUTION_ACTIONS, FULL_CORE_POLICY, translateChange, type CoreEvolutionAction, type TranslatedChange } from './commands.ts';
export { DEFAULT_TRIGGER_GRADES, gradeEvents, highEventsOf, shouldAutoTrigger, type TriggerPolicyOptions } from './policy.ts';
export { gatewayDriver, createScriptedDriver, normalizeProposal, extractJson, proposalKey, type GatewayDriverDeps, type ScriptStep, type NormalizeOptions } from './driver.ts';
export { createEventConsumer, type EventConsumerOptions, type WorldEventConsumer } from './consumer.ts';
export { createEvolutionJournal, type FileEvolutionJournalOptions } from './journal.ts';
export { createEvolutionRuntime, type EvolutionRuntime, type EvolutionRuntimeOptions, type TickOptions } from './runtime.ts';

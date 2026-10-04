/* ============================================================
   世界模拟架构装配（《插件化世界模拟架构方案》§20/§29/§33/§45）
   —— 组合根的唯一装配入口。抽成可调用函数而非 main.tsx 内联，
   原因有二：装配顺序是隐式契约（漏一步世界会静默失去能力），
   以及测试需要与生产完全同一条装配路径。
   顺序敏感点：
     1. 感知层（attachPerception）必须先于目击者反应（witness）
        —— 后者依赖感知表里「谁看见了」；
     2. 能力登记（registerCoreSystems）必须先于后果处理器注册
        —— 否则处理器对应的动作进不了 Validator 白名单。
   ============================================================ */
import { attachPerception } from '@/events/Perception';
import { attachWorldEventLog } from '@/events/EventStore';
import { worldBus } from '@/events/EventBus';
import { runLog } from '@/devlog/RunLog';
import type { WorldEvent } from '@/events/EventSchema';
import { log } from '@/systems/character/Gains';
import { core } from '@/world/WorldState';
import { attachMemoryEngine } from '@/memory/MemoryEngine';
import { setReasonerPort, attachReasoner, type ReasonerPort } from '@/ai/WorldReasoner';
import { registerConsequenceHandlers } from './handlers';
import { plugins } from './PluginRegistry';
import { registerCoreSystems } from './systems';
import { registerSystemSubscriptions } from './subscriptions';
import { registerDaySettle } from './daySettle';
import { registerWitnessPlugin } from './witness';

export interface BootstrapOptions {
  /** 推演通道（生产用 makeHybridReasoner 包真实模型；测试可注入桩） */
  reasoner: ReasonerPort;
}

/**
 * §30 死信留痕：超出单 tick 配额或因果链过深的事件会被总线上「截流」，
 * 此前它们静默消失——世界为什么没反应，查无对证。
 * 这里给它们留一条可查的记录（罕见事件，不会刷屏）。
 */
export function attachDeadLetterWatch(): () => void {
  const hook = (e: WorldEvent, why: string): void => {
    /* 观测通道：被截流的世界事件在运行日志里记一条（玩家侧那条只在有世界时写） */
    runLog.warn('event', '被截流：' + why, { type: e.type, id: e.id, level: e.level });
    const s = core.S;
    if (s) log('（世界事件 ' + e.type + ' 未扩散：' + why + '）', 'sys', s);
  };
  worldBus.onDeadLetter(hook);
  /* 死信观察者是单槽：卸载前先确认槽里还是自己那条。
     否则「先装配者后卸载」会把后来者的留痕拆掉，死信又变回静默。 */
  return () => {
    if (worldBus.deadLetterHookOf() === hook) worldBus.onDeadLetter(null);
  };
}

/** 装配世界模拟架构；返回统一卸载函数（HMR / 重置用） */
export function bootstrapWorld(opts: BootstrapOptions): () => void {
  registerCoreSystems();
  /* §21/§34：业务系统的事件订阅（覆盖式重注册，必须在能力登记之后） */
  registerSystemSubscriptions();
  /* 顺序敏感：记忆引擎读感知表拿目击者，必须排在 attachPerception 之后 */
  /* §27 日边界结算：顺序表在 daySettle.ts，时钟只负责发布 new_day（复核对 §19 的收口） */
  const disposers = [registerDaySettle(), attachWorldEventLog(), attachPerception(), attachMemoryEngine()];
  disposers.push(attachDeadLetterWatch());
  registerWitnessPlugin(); // 依赖感知表，必须在 attachPerception 之后
  setReasonerPort(opts.reasoner);
  disposers.push(attachReasoner());
  registerConsequenceHandlers();

  return () => {
    for (const off of disposers) off();
    setReasonerPort(null);
    plugins.clear();
  };
}

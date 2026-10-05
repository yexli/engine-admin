/* ============================================================
   Evolution Observation（P2 卡片9 自 runtime.ts 提取：观察 + 记忆召回）
   ------------------------------------------------------------
   tick 的 1-2.5 步：读世界（状态 + 事件窗口）→ 组装地点作用域上下文
   （P4 预算裁剪）→ 个体决策的记忆召回（P7）→ auto 触发分级依据。

   读失败（世界不可达/暂停）以异常上抛，由 runtime 落 failed 账——
   观察失败 = 本次演化没发生，世界零影响。
   ============================================================ */
import { applyContextMemory, buildEvolutionContext } from './context.ts';
import { highEventsOf } from './policy.ts';
import { focusOf } from './ledger.ts';
import type { ContextBudget, EvolutionContext, TriggerGrade, WakePlan } from './types.ts';
import type { EngineClient } from '../types.ts';

/** 记忆召回钩子（P7 · 方案 §十）：个体决策（恰一个 HIGH 唤醒）时为焦点实体
 *  检索记忆，注入 context.memory（maxMemoryItems 预算内）。失败视作无记忆。 */
export type MemoryRetriever = (
  worldId: string,
  entityId: string,
  query: string,
) => Promise<{ ref: string; summary: string; day?: number; sourceEventId?: string }[]>;

export interface ObservationOptions {
  /** 观察窗口：读取的最近事件数 */
  eventWindow: number;
  /** 唤醒计划（P3 Trigger Engine 的评估结论；进入上下文 trigger 段） */
  wakePlan?: WakePlan;
  /** 上下文预算（P4 · 方案 §七）：传入则按预算裁剪并产出 budgetReport */
  budget?: ContextBudget;
  /** 记忆召回钩子（P7）；世界级 tick 无单一 owner，不检索 */
  memoryRetriever?: MemoryRetriever;
}

export interface ObservationResult {
  context: EvolutionContext;
  /** auto 触发的分级依据（方案 §五：High 事件才值得自动演化） */
  triggerGrade: TriggerGrade;
  /** 焦点实体（个体决策 tick 的唯一 HIGH 唤醒；世界级 tick = ''） */
  focusEntity: string;
  /** 焦点实体观察时的版本戳（P2 卡片8；世界级 tick / 实体无戳 = null） */
  observedVer: number | null;
}

export async function observe(
  engine: EngineClient,
  worldId: string,
  opts: ObservationOptions,
): Promise<ObservationResult> {
  const built = await buildEvolutionContext(engine, worldId, {
    eventCount: opts.eventWindow,
    ...(opts.wakePlan ? { wakePlan: opts.wakePlan } : {}),
    ...(opts.budget ? { budget: opts.budget } : {}),
  });
  if (!built.ok) throw new Error(`世界观察失败（${built.status}）：${built.error}`);
  const context = built.context;

  const focusEntity = focusOf(worldId, opts.wakePlan);
  /* P2 卡片8：观察时记录焦点实体的版本戳（个体决策 tick 专属） */
  const observedVer = focusEntity ? (context.entities[focusEntity]?._ver ?? 0) : null;

  /* 记忆召回：失败 = 无记忆，绝不影响演化闭环——记忆是建议材料，不是事实来源 */
  if (opts.memoryRetriever && focusEntity) {
    try {
      const primary = opts.wakePlan?.primaryEventId
        ? context.events.find((e) => e.id === opts.wakePlan!.primaryEventId)
        : undefined;
      const query = primary
        ? [primary.type, primary.actor, primary.target].filter((x): x is string => !!x).join(' ')
        : focusEntity;
      const memories = await opts.memoryRetriever(worldId, focusEntity, query);
      applyContextMemory(context, memories, opts.budget);
    } catch {
      /* 记忆召回失败：个体决策照常进行（无记忆段），失败不外溢 */
    }
  }

  const highs = highEventsOf(
    context.events.map((e) => ({
      type: e.type,
      ...(e.data?.['witnesses'] !== undefined ? { witnesses: e.data['witnesses'] as string[] } : {}),
      ...(e.actor !== undefined ? { actor: e.actor } : {}),
    })),
  );
  const triggerGrade: TriggerGrade = highs.length ? 'high' : context.events.length ? 'medium' : 'low';

  return { context, triggerGrade, focusEntity, observedVer };
}

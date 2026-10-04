/* ============================================================
   World Executor（《插件化世界模拟架构方案》§17 / §18 / §47）
   只有通过 Rule Validator 的后果才能在此改变世界。
   动作处理器由「注册了对应 Capability 的系统」提供（§20 / §45）：
   执行器本身不认识任何具体系统，新增系统不需要改这里。
   ============================================================ */
import { causality, worldBus } from '@/events/EventBus';
import { validatePlan } from '@/validation/RuleValidator';
import { runLog } from '@/devlog/RunLog';
import type { ActionOutcome, ConsequenceAction, ConsequencePlan, ExecResult } from './PlanSchema';

/** 处理器返回值不被执行器使用：系统可以自由决定是否回报自己的成败细节 */
type ActionHandler = (a: ConsequenceAction, plan: ConsequencePlan) => unknown;

const handlers = new Map<string, ActionHandler>();

/** 记录器 owner 序号：嵌套 execute 时两次订阅必须不同 key，否则内层会被幂等记账跳过 */
let recorderSeq = 0;

export const worldExecutor = {
  /** 系统注册自己的后果处理器（通常与 plugins.register 的 capabilities 同名） */
  registerHandler(action: string, fn: ActionHandler): void {
    handlers.set(action, fn);
  },

  unregisterHandler(action: string): boolean {
    return handlers.delete(action);
  },

  hasHandler(action: string): boolean {
    return handlers.has(action);
  },

  actions(): string[] {
    return [...handlers.keys()];
  },

  /**
   * 执行一份（可能来自 AI 的）后果计划。
   * 验证不过 → 零执行；单条抛错 → 记录失败但不回滚已成功的其他条目（§41 部分失败）。
   * 执行期间由各系统发布的世界事件会被收集进 newEvents（§47 回合闭环）。
   */
  execute(raw: unknown): ExecResult {
    const done = runLog.timer('exec', '执行后果计划');
    const verdict = validatePlan(raw);
    if (!verdict.ok) {
      done({ result: 'rejected' });
      return {
        planId: '(rejected)',
        executed: 0,
        rejected: 0,
        outcomes: [{ action: '-', ok: false, note: verdict.error }],
        newEvents: [],
      };
    }
    const plan = verdict.plan;
    const outcomes: ActionOutcome[] = [];
    const seen: string[] = [];
    /* 记录器用局部订阅：不持有跨调用的全局状态，也不会被 worldBus.reset() 抹掉 */
    const off = worldBus.on('*', (e) => seen.push(e.id), 'executor-recorder-' + ++recorderSeq);
    let executed = 0;
    try {
      /* §29/§44：执行期间各系统发布的事件自动挂到触发事件之下，形成可回溯的因果链；
         嵌套执行会让 §30 的因果深度累加，超过上限的链在总线上被截断。 */
      causality.withParent(plan.triggerEvent, () => {
        for (const a of plan.consequences) {
          const fn = handlers.get(a.action);
          if (!fn) {
            outcomes.push({ action: a.action, ok: false, note: '无处理器：' + a.action });
            continue;
          }
          try {
            fn(a, plan);
            outcomes.push({ action: a.action, ok: true });
            executed++;
          } catch (err) {
            outcomes.push({ action: a.action, ok: false, note: err instanceof Error ? err.message : String(err) });
          }
        }
      });
    } finally {
      off();
    }
    /* 「计划过了验证却没人执行」是白名单与执行器脱节的现场——观测里必须有它 */
    if (runLog.enabled) {
      /* 只在开着的时候做这次扫描：关掉日志时执行器一行额外开销都不该有 */
      const orphans = outcomes.filter((o) => !o.ok && o.note?.startsWith('无处理器')).map((o) => o.action);
      if (orphans.length) runLog.warn('exec', '动作没有执行器（过了验证却没落地）', { actions: orphans });
      runLog.info('exec', '计划执行完成', {
        plan: plan.planId,
        executed,
        rejected: outcomes.length - executed,
        newEvents: seen.length,
      });
    }
    done({ executed, rejected: outcomes.length - executed });
    return { planId: plan.planId, executed, rejected: outcomes.length - executed, outcomes, newEvents: seen };
  },

  clear(): void {
    handlers.clear();
  },
};

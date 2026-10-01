/* ============================================================
   Evolution Runtime（方案 §四：完整闭环的编排者）
   ------------------------------------------------------------
   tick 一次 =
     观察引擎（World State + 最近 Event）
       → Context Builder 组装结构化事实
       → AI World Driver 产出 Evolution Proposal
       → 白名单翻译成 Command（翻译不了的原地拒）
       → 逐条提交引擎 Rules 链（Rules 拒绝 = 变化不存在）
       → 落账 EvolutionRun（观察/上下文/提案/每条裁决/事实 id 全留痕）

   本运行时自己不持有任何状态写入口：对世界的全部操作就是往
   EngineClient 发 Command——与任何游戏方客户端同权，零特权。
   「AI 不得直接修改 World State」在这里不是注释，是依赖形状。

   dispatchIntent：意图处置的隔离闸（方案 §七）——只有 ic_action
   意图被翻译成 Command；ooc / narrative 只留档，永不进引擎。
   ============================================================ */
import { randomUUID } from 'node:crypto';
import type { EngineClient } from '../types.ts';
import { buildEvolutionContext } from './context.ts';
import { translateChange } from './commands.ts';
import { EvolutionDriverError, type ChangeOutcome, type EvolutionContext, type EvolutionDriver, type EvolutionProposal, type EvolutionRun, type IntentOutcome, type WorldIntent } from './types.ts';

export interface EvolutionRuntimeOptions {
  engine: EngineClient;
  driver: EvolutionDriver;
  /** 每次提案允许的变化数硬上限（防御性；驱动提示词同口径，但这里是铁闸） */
  maxChangesPerRun?: number;
  /** 观察窗口：每次读取的最近事件数（缺省 20） */
  observationWindow?: number;
}

export interface EvolutionRuntime {
  /** 跑一次完整演化闭环；返回落账后的 run（含因果链） */
  tick(worldId: string, trigger?: EvolutionRun['trigger']): Promise<EvolutionRun>;
  /** 意图处置：ic_action → 命令链；ooc / narrative → 只回执，永不进引擎 */
  dispatchIntent(worldId: string, intent: WorldIntent): Promise<IntentOutcome>;
  /** 因果链读取（代理 journal；新 → 旧） */
  runs(worldId: string, n?: number): EvolutionRun[];
  run(worldId: string, runId: string): EvolutionRun | null;
  /** 账本里有留痕的世界 */
  knownWorlds(): string[];
}

export function createEvolutionRuntime(
  opts: EvolutionRuntimeOptions,
  journal: {
    append(run: EvolutionRun): void;
    recent(worldId: string, n?: number): EvolutionRun[];
    get(worldId: string, runId: string): EvolutionRun | null;
    knownWorlds?(): string[];
  },
): EvolutionRuntime {
  const maxChanges = Math.max(1, Math.min(16, Math.floor(opts.maxChangesPerRun ?? 6)));
  const eventWindow = Math.max(1, Math.min(200, Math.floor(opts.observationWindow ?? 20)));

  async function tick(worldId: string, trigger: EvolutionRun['trigger'] = 'admin'): Promise<EvolutionRun> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const run: EvolutionRun = {
      id: `evo_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      worldId,
      startedAt,
      status: 'running',
      trigger,
      observationWindow: { eventCount: eventWindow },
      eventIds: [],
    };
    const finish = (patch: Partial<EvolutionRun>): EvolutionRun => {
      Object.assign(run, patch, { finishedAt: new Date().toISOString(), tookMs: Date.now() - t0 });
      journal.append(run);
      return run;
    };

    /* 1-2. 观察 + 组装上下文（读失败 = 本次演化没发生，世界零影响） */
    let context: EvolutionContext;
    try {
      const built = await buildEvolutionContext(opts.engine, worldId, { eventCount: eventWindow });
      if (!built.ok) throw new Error(`世界观察失败（${built.status}）：${built.error}`);
      context = built.context;
    } catch (e) {
      return finish({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
    run.observationWindow.latestEventId = context.events[0]?.id;
    run.context = context;

    /* 3. AI 提案（驱动失败同样零影响；坏提案绝不放行给引擎） */
    let proposal: EvolutionProposal;
    try {
      proposal = await opts.driver.propose(context);
      if (proposal.changes.length > maxChanges) {
        proposal = { ...proposal, changes: proposal.changes.slice(0, maxChanges) };
      }
    } catch (e) {
      const msg =
        e instanceof EvolutionDriverError
          ? `驱动失败[${e.code}]：${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      return finish({ status: 'failed', error: msg, modelUsed: opts.driver.name });
    }
    run.modelUsed = proposal.source.model ?? opts.driver.name;
    run.proposal = proposal;

    /* 4-5. 白名单翻译 → 逐条进引擎 Rules 链。
       单条被拒不影响其余（AI 的一次推演 = 一组独立建议，不是事务）。 */
    const outcomes: ChangeOutcome[] = [];
    for (const change of proposal.changes) {
      const t = translateChange(change);
      if (!t.ok) {
        outcomes.push({ change, accepted: false, rejectedBy: 'translate', reason: t.reason, eventIds: [] });
        continue;
      }
      outcomes.push({ change, command: t.command, accepted: false, rejectedBy: 'rules', reason: '未执行', eventIds: [] });
    }
    /* 引擎逐条执行（串行：提案内部变化可能有时序依赖，如先移动再触发）。
       注意拒绝语义有两层：HTTP 失败（世界不可达/暂停 409）与命令链
       拒绝（HTTP 200 + result.ok=false，Rules 说了算）——后者才是
       「Rules 拒绝了 AI 的建议」，必须如实体现在裁决里。 */
    for (const o of outcomes) {
      if (!o.command) continue;
      const res = await opts.engine.executeCommand(worldId, o.command);
      if (res.ok && res.result.ok) {
        o.accepted = true;
        o.rejectedBy = undefined;
        o.reason = undefined;
        o.eventIds = res.result.events;
        run.eventIds.push(...res.result.events);
      } else if (res.ok) {
        o.rejectedBy = 'rules';
        o.reason = res.result.reason ?? '命令被规则拒绝';
      } else {
        o.rejectedBy = 'rules';
        o.reason = `引擎请求失败（${res.status}）：${res.error}`;
      }
    }

    const acceptedCount = outcomes.filter((o) => o.accepted).length;
    return finish({
      status: 'completed',
      outcomes,
      acceptedCount,
      rejectedCount: outcomes.length - acceptedCount,
    });
  }

  async function dispatchIntent(worldId: string, intent: WorldIntent): Promise<IntentOutcome> {
    /* OOC / Narrative 到此为止：绝不翻译、绝不提交——隔离是返回值的一部分 */
    if (intent.kind !== 'ic_action') return { kind: intent.kind };
    if (!intent.command) return { kind: intent.kind };
    const res = await opts.engine.executeCommand(worldId, intent.command);
    if (res.ok) return { kind: intent.kind, commandResult: res.result };
    return { kind: intent.kind, commandResult: { ok: false, events: [], reason: res.error } };
  }

  return {
    tick,
    dispatchIntent,
    runs: (worldId, n = 20) => journal.recent(worldId, n),
    run: (worldId, runId) => journal.get(worldId, runId),
    knownWorlds: () => journal.knownWorlds?.() ?? [],
  };
}

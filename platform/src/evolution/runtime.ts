/* ============================================================
   Evolution Runtime（方案 §四：完整闭环的编排者；V2 收口）
   ------------------------------------------------------------
   tick 一次 =
     观察引擎（World State + 最近 Event）
       → Context Builder 组装结构化事实（地点作用域）
       → AI World Driver 产出 Evolution Proposal（允许空变化集）
       → 策略围栏 + 白名单翻译成 Command（翻译不了的原地拒）
       → 幂等检查（提案指纹 / 幂等键 / run 内重复 change）
       → 逐条提交引擎 Rules 链（Rules 拒绝 = 变化不存在）
       → 状态机落账（completed / partially_applied / rejected / failed）
       → Evolution Journal（观察/上下文/提案/每条裁决/事实 id 全留痕）

   本运行时自己不持有任何状态写入口：对世界的全部操作就是往
   EngineClient 发 Command——与任何游戏方客户端同权，零特权。
   「AI 不得直接修改 World State」在这里不是注释，是依赖形状。

   V2 收口（方案 §二）：
     · 每条 Change：changeId / commandId / 独立 status / 拒绝环节与原因
     · Proposal 终态：部分成功绝不显示全部成功；全拒 = rejected（非 failed）
     · 幂等：同提案指纹或同幂等键 → 返回既有 run，不重复 Mutation；
       同一 run 内重复 change → duplicate 跳过
     · 冷却：auto/api 触发受 cooldownMs 限制；admin 手动不受限
     · 因果关联以 Journal 为权威：causation（Event → Run → Proposal →
       Change → Command → Rules Result）经 trace 查询还原

   V2.1 封口（P1 验收）：
     · 并发互斥：同一世界并发 tick 串行化，后到者重走幂等/冷却检查
     · running 中间态即落账（append upsert）：崩溃 run 在账本有迹可查
     · 幂等账重启不丢：run 记录 idempotencyKey，按世界从 Journal 惰性重建
       （幂等键 / 提案指纹 / 冷却时刻），重启不能成为重复执行的后门

   dispatchIntent：意图处置的隔离闸（方案 §七）——只有 ic_action
   意图被翻译成 Command；ooc / narrative 只留档，永不进引擎。
   ============================================================ */
import { randomUUID } from 'node:crypto';
import type { EngineClient } from '../types.ts';
import { buildEvolutionContext, applyContextMemory } from './context.ts';
import { translateChange, FULL_CORE_POLICY } from './commands.ts';
import { proposalKey } from './driver.ts';
import { highEventsOf } from './policy.ts';
import {
  EvolutionCooldownError,
  EvolutionDriverError,
  type ChangeOutcome,
  type EvolutionContext,
  type EvolutionDriver,
  type EvolutionPolicy,
  type EvolutionProposal,
  type EvolutionRun,
  type IntentOutcome,
  type WakePlan,
  type WorldIntent,
} from './types.ts';

export interface EvolutionRuntimeOptions {
  engine: EngineClient;
  driver: EvolutionDriver;
  /** 演化策略（缺省 = 内核全集，向后兼容；第一阶段 NPC 演化传 NPC_EVOLUTION_POLICY） */
  policy?: EvolutionPolicy;
  /** 兼容字段：单次提案变化数硬上限（优先级高于 policy.maxChangesPerProposal） */
  maxChangesPerRun?: number;
  /** 观察窗口：每次读取的最近事件数（缺省 20） */
  observationWindow?: number;
  /** 自动触发的冷却（优先级高于 policy.cooldownMs） */
  cooldownMs?: number;
  /** 上下文预算（P4 · 方案 §七）：传入则每次 tick 的上下文按预算裁剪并产出 budgetReport */
  contextBudget?: import('./types.ts').ContextBudget;
  /** 按世界解析演化策略（P14 · 方案 §十七：Extension 层——多游戏差异化围栏）。
   *  返回值优先于 opts.policy；未传或返回 undefined = 用 opts.policy（缺省 NPC_EVOLUTION_POLICY
   *  由装配方决定）。典型用法：商贸世界禁 AI 改库存属性、RPG 世界放行更多动作。 */
  policyFor?: (worldId: string) => EvolutionPolicy | undefined;
  /** 记忆召回（P7 · 方案 §十）：个体决策（恰一个 HIGH 唤醒）时为焦点实体检索记忆，
   *  注入 context.memory（maxMemoryItems 预算内）。失败视作无记忆（记忆是建议材料，
   *  不是事实来源）；世界级 tick 无单一 owner，不检索。 */
  memoryRetriever?: (worldId: string, entityId: string, query: string) => Promise<{ ref: string; summary: string; day?: number; sourceEventId?: string }[]>;
}

export interface TickOptions {
  /** 幂等键：同一 key 重复调用返回既有 run（方案 §二.3） */
  idempotencyKey?: string;
  /** 唤醒计划（P3 Trigger Engine 的评估结论；落账到 run 供追溯与观测） */
  wakePlan?: import('./types.ts').WakePlan;
}

export interface EvolutionRuntime {
  /** 跑一次完整演化闭环；返回落账后的 run（含因果链）。
   *  auto/api 触发受冷却限制（EvolutionCooldownError）；admin 不受限。 */
  tick(worldId: string, trigger?: EvolutionRun['trigger'], opts?: TickOptions): Promise<EvolutionRun>;
  /** 意图处置：ic_action → 命令链；ooc / narrative → 只回执，永不进引擎 */
  dispatchIntent(worldId: string, intent: WorldIntent): Promise<IntentOutcome>;
  /** 因果链读取（代理 journal；新 → 旧） */
  runs(worldId: string, n?: number): EvolutionRun[];
  run(worldId: string, runId: string): EvolutionRun | null;
  /** 反向追溯：Event → EvolutionRun → Proposal → Change → Command（方案 §九） */
  traceEvent(worldId: string, eventId: string): { run: EvolutionRun; changeId: string; causation: { source: 'evolution'; evolutionRunId: string; proposalId: string; changeId: string } } | null;
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
  const defaultPolicy = opts.policy ?? FULL_CORE_POLICY;
  const eventWindow = Math.max(1, Math.min(200, Math.floor(opts.observationWindow ?? 20)));

  /** 按世界解析策略（P14 Extension 层）：policyFor(worldId) → opts.policy → FULL_CORE_POLICY。
   *  硬上限 maxChangesPerRun 仍优先于策略（装配方最后一道闸）。 */
  function resolvePolicy(worldId: string): { policy: EvolutionPolicy; maxChanges: number; maxEntities: number; cooldownMs: number } {
    const policy = opts.policyFor?.(worldId) ?? defaultPolicy;
    return {
      policy,
      maxChanges: Math.max(1, Math.floor(opts.maxChangesPerRun ?? policy.maxChangesPerProposal)),
      maxEntities: Math.max(1, Math.floor(policy.maxEntitiesAffected)),
      cooldownMs: Math.max(0, Math.floor(opts.cooldownMs ?? policy.cooldownMs)),
    };
  }

  /* 幂等账（进程内缓存；权威在 Journal——重启后按世界惰性重建，见 ensureLedger） */
  const runsByKey = new Map<string, string>(); // `${worldId}|${idempotencyKey}` -> runId
  const runsByProposal = new Map<string, string>(); // `${worldId}|${focus}|${proposalKey}` -> runId
  const lastRunAt = new Map<string, number>(); // `${worldId}|${focus}` -> 完成时刻（冷却用）
  const ledgerRebuilt = new Set<string>(); // 已从 Journal 重建过幂等账的世界

  /* 焦点作用域（P5 · 方案 §八：个体决策的隔离键）：
     wakePlan 恰有一个 HIGH 唤醒 = 以该实体的视角做个体决策。
     冷却与提案指纹都按 `world|focus` 分域——同一事件唤醒两个 NPC 时，
     各自的个体决策互不挤兑冷却、互不指纹串挡（世界级 tick 的 focus 为空，
     行为与 P4 前一致）。 */
  function focusOf(worldId: string, wakePlan?: WakePlan): string {
    const high = (wakePlan?.wakes ?? []).filter((w) => w.grade === 'high').map((w) => w.entityId);
    void worldId;
    return high.length === 1 ? high[0]! : '';
  }

  /* 幂等账重建（每世界一次）：进程重启后，Journal 历史里的幂等键 /
     提案指纹 / 冷却时刻仍然生效——重启不能成为重复执行的后门（方案 §二.3）。
     崩溃遗留的 'running' 记录同样登记幂等键：同键重试返回该记录而不是
     重新执行——半程 run 的变化是否已落世界不可知，宁阻塞不重复。 */
  function ensureLedger(worldId: string): void {
    if (ledgerRebuilt.has(worldId)) return;
    ledgerRebuilt.add(worldId);
    for (const run of journal.recent(worldId, Number.MAX_SAFE_INTEGER)) {
      if (run.idempotencyKey) runsByKey.set(`${worldId}|${run.idempotencyKey}`, run.id);
      if (run.proposal) {
        const scope = `${worldId}|${focusOf(worldId, run.wakePlan)}`;
        runsByProposal.set(`${scope}|${proposalKey(worldId, run.proposal)}`, run.id);
      }
      if (run.finishedAt) {
        const t = Date.parse(run.finishedAt);
        const scope = `${worldId}|${focusOf(worldId, run.wakePlan)}`;
        if (Number.isFinite(t) && t > (lastRunAt.get(scope) ?? 0)) lastRunAt.set(scope, t);
      }
    }
  }

  /* 同一世界的并发 tick 串行化：冷却与指纹都在 run 收尾时才登记，
     并发窗口内的两个 tick 会双双通过检查、各自完整执行闭环——重复 Mutation。
     锁保证后到者等先到者落账，再重走幂等/冷却检查（方案 §二.3）。 */
  const inFlight = new Map<string, Promise<EvolutionRun>>();

  function tick(worldId: string, trigger: EvolutionRun['trigger'] = 'admin', tickOpts: TickOptions = {}): Promise<EvolutionRun> {
    const prev = inFlight.get(worldId);
    const exec = (async () => {
      if (prev) {
        try {
          await prev;
        } catch {
          /* 前一 tick 的失败已由它自己落账（failed）；这里照常走检查 */
        }
      }
      return runTick(worldId, trigger, tickOpts);
    })();
    inFlight.set(worldId, exec);
    const cleanup = (): void => {
      if (inFlight.get(worldId) === exec) inFlight.delete(worldId);
    };
    exec.then(cleanup, cleanup); /* 清理挂双臂：拒绝已交给调用方，这里只摘锁 */
    return exec;
  }

  async function runTick(worldId: string, trigger: EvolutionRun['trigger'], tickOpts: TickOptions): Promise<EvolutionRun> {
    ensureLedger(worldId);
    /* P14 Extension 层：围栏按世界解析（多游戏差异化围栏，零共享代码改动） */
    const { policy, maxChanges, maxEntities, cooldownMs } = resolvePolicy(worldId);

    /* 幂等键命中：直接返回既有结果，不再触碰世界（方案 §二.3） */
    if (tickOpts.idempotencyKey) {
      const hit = runsByKey.get(`${worldId}|${tickOpts.idempotencyKey}`);
      if (hit) {
        const existing = journal.get(worldId, hit);
        if (existing) return { ...existing, deduplicated: true };
      }
    }

    /* 冷却：只约束自动/公共触发；admin 手动是运营判断，不受限。
       作用域 = world|focus（P5）：同一事件唤醒的多个 NPC 各有各的冷却，互不挤兑。 */
    const scope = `${worldId}|${focusOf(worldId, tickOpts.wakePlan)}`;
    if (trigger !== 'admin' && cooldownMs > 0) {
      const last = lastRunAt.get(scope);
      if (last !== undefined) {
        const elapsed = Date.now() - last;
        if (elapsed < cooldownMs) {
          const focus = scope.slice(worldId.length + 1);
          throw new EvolutionCooldownError(
            `世界 '${worldId}'${focus ? `（聚焦 ${focus}）` : ''}演化冷却中（${Math.ceil((cooldownMs - elapsed) / 1000)}s 后可再次自动触发）`,
            cooldownMs - elapsed,
          );
        }
      }
    }

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
      ...(tickOpts.idempotencyKey ? { idempotencyKey: tickOpts.idempotencyKey } : {}),
      ...(tickOpts.wakePlan ? { wakePlan: tickOpts.wakePlan } : {}),
    };
    /* running 中间态即落账：观察/驱动阶段进程崩溃，账本里也有迹可查——
       「这个 run 从未发生」不是合法状态（方案 §二：失败必须可见）。
       append 是 upsert：finish 时终态原位覆盖本行。 */
    journal.append(run);
    const finish = (patch: Partial<EvolutionRun>): EvolutionRun => {
      Object.assign(run, patch, { finishedAt: new Date().toISOString(), tookMs: Date.now() - t0 });
      journal.append(run);
      lastRunAt.set(scope, Date.now());
      /* 指纹登记用 setIfAbsent：同一提案重复出现时保留首次（真正执行变化）的 run。
         指纹按 world|focus 分域（P5）：不同 NPC 的相同结论互不串挡。 */
      if (run.proposal) {
        const key = `${scope}|${proposalKey(worldId, run.proposal)}`;
        if (!runsByProposal.has(key)) runsByProposal.set(key, run.id);
      }
      return run;
    };

    /* 1-2. 观察 + 组装上下文（读失败 = 本次演化没发生，世界零影响）。
       P4：wakePlan 产出 trigger 段（当前事件 + 被唤醒者）；budget 按方案 §七裁剪。 */
    let context: EvolutionContext;
    try {
      const built = await buildEvolutionContext(opts.engine, worldId, {
        eventCount: eventWindow,
        ...(tickOpts.wakePlan ? { wakePlan: tickOpts.wakePlan } : {}),
        ...(opts.contextBudget ? { budget: opts.contextBudget } : {}),
      });
      if (!built.ok) throw new Error(`世界观察失败（${built.status}）：${built.error}`);
      context = built.context;
    } catch (e) {
      return finish({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
    run.observationWindow.latestEventId = context.events[0]?.id;
    run.context = context;

    /* 2.5 记忆召回（P7 · 方案 §十）：个体决策聚焦唯一唤醒实体时，
       为它检索相关记忆注入 context.memory（预算内；失败 = 无记忆，
       绝不影响演化闭环——记忆是建议材料，不是事实来源）。 */
    const focusEntity = tickOpts.wakePlan ? focusOf(worldId, tickOpts.wakePlan) : '';
    if (opts.memoryRetriever && focusEntity) {
      try {
        const primary = tickOpts.wakePlan!.primaryEventId ? context.events.find((e) => e.id === tickOpts.wakePlan!.primaryEventId) : undefined;
        const query = primary ? [primary.type, primary.actor, primary.target].filter((x): x is string => !!x).join(' ') : focusEntity;
        const memories = await opts.memoryRetriever(worldId, focusEntity, query);
        applyContextMemory(context, memories, opts.contextBudget);
      } catch {
        /* 记忆召回失败：个体决策照常进行（无记忆段），失败不外溢 */
      }
    }

    /* auto 触发的分级依据（方案 §五：High 事件才值得自动演化） */
    const highs = highEventsOf(context.events.map((e) => ({ type: e.type, ...(e.data?.['witnesses'] !== undefined ? { witnesses: e.data['witnesses'] as string[] } : {}), ...(e.actor !== undefined ? { actor: e.actor } : {}) })));
    run.triggerGrade = highs.length ? 'high' : context.events.length ? 'medium' : 'low';

    /* 3. AI 提案（驱动失败同样零影响；坏提案绝不放行给引擎）。
       超限的变化不静默丢弃——逐条落成 policy 拒绝（方案 §二.2：失败必须可见）。 */
    let proposal: EvolutionProposal;
    try {
      proposal = await opts.driver.propose(context);
    } catch (e) {
      const msg =
        e instanceof EvolutionDriverError
          ? `驱动失败[${e.code}]：${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      /* V2.4-03 · 方案 §七 DEFER 语义：AI/模型不可用 = 决策延后（deferred，
         世界照跑、可稍后重试），与「AI 出错」（failed）区分——两者都绝不伪造世界事实。 */
      const deferred = e instanceof EvolutionDriverError && e.code === 'model_unavailable';
      return finish({ status: deferred ? 'deferred' : 'failed', error: msg, modelUsed: opts.driver.name });
    }
    run.modelUsed = proposal.source.model ?? opts.driver.name;
    run.proposal = proposal;

    /* 幂等：AI 重复提交相同提案 → 直接返回既有结果，绝不重复 Mutation（方案 §二.3）。
       本 run 的观察与模型调用都已发生（running 行已落账），必须落一条终态——
       如实记 completed（零变化，提案已被既有 run 应用），不留孤儿 running 行。
       指纹按 world|focus 分域（P5）：个体决策的「无事发生」不跨 NPC 串挡。 */
    const proposalHit = runsByProposal.get(`${scope}|${proposalKey(worldId, proposal)}`);
    if (proposalHit) {
      const existing = journal.get(worldId, proposalHit);
      if (existing && existing.id !== run.id) {
        finish({ status: 'completed', outcomes: [], acceptedCount: 0, rejectedCount: 0, deduplicated: true });
        return { ...existing, deduplicated: true };
      }
    }

    if (tickOpts.idempotencyKey) runsByKey.set(`${worldId}|${tickOpts.idempotencyKey}`, run.id);

    /* 4-5. 策略围栏 + 白名单翻译 + run 内去重，产出裁决骨架。
       单条被拒不影响其余（AI 的一次推演 = 一组独立建议，不是事务）。
       数量/实体上限的超限项逐条落成 policy 拒绝——绝不静默丢弃。 */
    const outcomes: ChangeOutcome[] = [];
    const seenChanges = new Set<string>();
    const targets = new Set<string>();
    let considered = 0;
    for (const change of proposal.changes) {
      const changeId = change.changeId ?? `chg_${randomUUID().slice(0, 12)}`;
      const normalized: typeof change = { ...change, changeId };
      const dedupeKey = `${change.targetId}|${change.action}|${JSON.stringify(change.payload ?? {})}`;
      const t = translateChange(normalized, policy);
      if (!t.ok) {
        outcomes.push({ change: normalized, changeId, status: 'rejected', accepted: false, rejectedBy: t.rejectedBy, reason: t.reason, eventIds: [] });
        continue;
      }
      if (seenChanges.has(dedupeKey)) {
        outcomes.push({ change: normalized, changeId, status: 'duplicate', accepted: false, rejectedBy: 'duplicate', reason: '同一 run 内重复 change，幂等跳过', eventIds: [] });
        continue;
      }
      if (considered >= maxChanges) {
        outcomes.push({ change: normalized, changeId, status: 'rejected', accepted: false, rejectedBy: 'policy', reason: `超出单次提案变化数上限（${maxChanges}）`, eventIds: [] });
        continue;
      }
      if (targets.size >= maxEntities && !targets.has(change.targetId)) {
        outcomes.push({ change: normalized, changeId, status: 'rejected', accepted: false, rejectedBy: 'policy', reason: `超出单次提案实体数上限（${maxEntities}）`, eventIds: [] });
        continue;
      }
      considered++;
      seenChanges.add(dedupeKey);
      targets.add(change.targetId);
      outcomes.push({
        change: normalized,
        changeId,
        status: 'rejected',
        accepted: false,
        rejectedBy: 'rules',
        reason: '未执行',
        command: t.command,
        commandId: `cmd_${randomUUID().slice(0, 12)}`,
        eventIds: [],
      });
    }

    /* 引擎逐条执行（串行：提案内部变化可能有时序依赖）。
       拒绝语义有两层：HTTP 失败（世界不可达/暂停 409）与命令链
       拒绝（HTTP 200 + result.ok=false，Rules 说了算）——后者才是
       「Rules 拒绝了 AI 的建议」，必须如实体现在裁决里。 */
    for (const o of outcomes) {
      if (!o.command) continue;
      const res = await opts.engine.executeCommand(worldId, o.command);
      if (res.ok && res.result.ok) {
        o.status = 'accepted';
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

    /* 状态机（方案 §二.2：部分成功绝不显示全部成功）。
       duplicate 是幂等跳过，不算拒绝——不算进失败面。 */
    const acceptedCount = outcomes.filter((o) => o.status === 'accepted').length;
    const rejectedCount = outcomes.filter((o) => o.status === 'rejected').length;
    let status: EvolutionRun['status'];
    if (outcomes.length === 0 || rejectedCount === 0) {
      status = 'completed'; // 零变化提案或（放行 + 幂等跳过）：AI 判断成立
    } else if (acceptedCount > 0) {
      status = 'partially_applied';
    } else {
      status = 'rejected'; // 全部被拒，但每条都有原因可查
    }
    /* V2.4-05 · 方案 §九 Decision 语义：act = AI 提出了变化；wait = AI 判断
       此刻不该行动（空提案，合法且常常正确）。不改 Proposal Schema，
       仅作 run 元数据标注（观测/调试可读）。 */
    const decision: 'act' | 'wait' = acceptedCount > 0 ? 'act' : status === 'rejected' ? 'act' : 'wait';
    return finish({
      status,
      decision,
      outcomes,
      acceptedCount,
      rejectedCount,
      entitiesAffected: [...new Set(outcomes.filter((o) => o.status === 'accepted').map((o) => o.change.targetId))],
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

  function traceEvent(worldId: string, eventId: string) {
    for (const run of journal.recent(worldId, 200)) {
      for (const o of run.outcomes ?? []) {
        if (o.eventIds.includes(eventId)) {
          return {
            run,
            changeId: o.changeId,
            causation: { source: 'evolution' as const, evolutionRunId: run.id, proposalId: run.proposal?.id ?? run.id, changeId: o.changeId },
          };
        }
      }
    }
    return null;
  }

  return {
    tick,
    dispatchIntent,
    runs: (worldId, n = 20) => journal.recent(worldId, n),
    run: (worldId, runId) => journal.get(worldId, runId),
    traceEvent,
    knownWorlds: () => journal.knownWorlds?.() ?? [],
  };
}

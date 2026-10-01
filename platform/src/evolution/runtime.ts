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

   dispatchIntent：意图处置的隔离闸（方案 §七）——只有 ic_action
   意图被翻译成 Command；ooc / narrative 只留档，永不进引擎。
   ============================================================ */
import { randomUUID } from 'node:crypto';
import type { EngineClient } from '../types.ts';
import { buildEvolutionContext } from './context.ts';
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
}

export interface TickOptions {
  /** 幂等键：同一 key 重复调用返回既有 run（方案 §二.3） */
  idempotencyKey?: string;
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
  const policy = opts.policy ?? FULL_CORE_POLICY;
  const maxChanges = Math.max(1, Math.floor(opts.maxChangesPerRun ?? policy.maxChangesPerProposal));
  const maxEntities = Math.max(1, Math.floor(policy.maxEntitiesAffected));
  const cooldownMs = Math.max(0, Math.floor(opts.cooldownMs ?? policy.cooldownMs));
  const eventWindow = Math.max(1, Math.min(200, Math.floor(opts.observationWindow ?? 20)));

  /* 幂等账（进程内；重启即失——落账权威在 Journal，重放去重是防抖不是审计） */
  const runsByKey = new Map<string, string>(); // `${worldId}|${idempotencyKey}` -> runId
  const runsByProposal = new Map<string, string>(); // `${worldId}|${proposalKey}` -> runId
  const lastRunAt = new Map<string, number>(); // worldId -> 完成时刻（冷却用）

  async function tick(worldId: string, trigger: EvolutionRun['trigger'] = 'admin', tickOpts: TickOptions = {}): Promise<EvolutionRun> {
    /* 幂等键命中：直接返回既有结果，不再触碰世界（方案 §二.3） */
    if (tickOpts.idempotencyKey) {
      const hit = runsByKey.get(`${worldId}|${tickOpts.idempotencyKey}`);
      if (hit) {
        const existing = journal.get(worldId, hit);
        if (existing) return { ...existing, deduplicated: true };
      }
    }

    /* 冷却：只约束自动/公共触发；admin 手动是运营判断，不受限 */
    if (trigger !== 'admin' && cooldownMs > 0) {
      const last = lastRunAt.get(worldId);
      if (last !== undefined) {
        const elapsed = Date.now() - last;
        if (elapsed < cooldownMs) {
          throw new EvolutionCooldownError(
            `世界 '${worldId}' 演化冷却中（${Math.ceil((cooldownMs - elapsed) / 1000)}s 后可再次自动触发）`,
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
    };
    const finish = (patch: Partial<EvolutionRun>): EvolutionRun => {
      Object.assign(run, patch, { finishedAt: new Date().toISOString(), tookMs: Date.now() - t0 });
      journal.append(run);
      lastRunAt.set(worldId, Date.now());
      if (run.proposal) runsByProposal.set(`${worldId}|${proposalKey(worldId, run.proposal)}`, run.id);
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
      return finish({ status: 'failed', error: msg, modelUsed: opts.driver.name });
    }
    run.modelUsed = proposal.source.model ?? opts.driver.name;
    run.proposal = proposal;

    /* 幂等：AI 重复提交相同提案 → 直接返回既有结果，绝不重复 Mutation（方案 §二.3） */
    const proposalHit = runsByProposal.get(`${worldId}|${proposalKey(worldId, proposal)}`);
    if (proposalHit) {
      const existing = journal.get(worldId, proposalHit);
      if (existing && existing.id !== run.id) {
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
    return finish({
      status,
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

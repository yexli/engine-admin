/* ============================================================
   Evolution Ledger（P2 卡片9 自 runtime.ts 提取：幂等账 + 冷却 + 指纹）
   ------------------------------------------------------------
   进程内缓存，权威在 Journal——重启后按世界惰性重建（ensureRebuilt）。
   管三件事，全部围绕「同一件事只发生一次」：
     · 幂等键：同 key 重试返回既有 run（HTTP 重试安全）
     · 提案指纹：AI 重复提交相同提案 → 返回既有结果，不重复 Mutation
     · 冷却时刻：auto/api 触发的世界级限速（按 world|focus 分域，P5）

   纯记账，无 I/O；「现在几点」由 Date.now() 取自本模块（与原实现一致）。
   ============================================================ */
import { proposalKey } from './driver.ts';
import type { EvolutionProposal, EvolutionRun, WakePlan } from './types.ts';

export interface LedgerJournal {
  recent(worldId: string, n?: number): EvolutionRun[];
  get(worldId: string, runId: string): EvolutionRun | null;
}

export interface EvolutionLedger {
  /** 幂等账重建（每世界一次）：Journal 历史里的幂等键 / 提案指纹 / 冷却时刻
   *  在进程重启后仍然生效——重启不能成为重复执行的后门（方案 §二.3）。
   *  崩溃遗留的 'running' 记录同样登记幂等键：同键重试返回该记录而不是
   *  重新执行——半程 run 的变化是否已落世界不可知，宁阻塞不重复。 */
  ensureRebuilt(worldId: string): void;
  /** 幂等键命中 → 既有 runId；未命中 → null */
  checkIdempotencyKey(worldId: string, key: string): string | null;
  /** 冷却剩余毫秒（0 = 可用）。作用域 = world|focus（P5 个体决策隔离键） */
  checkCooldown(scope: string, cooldownMs: number): number;
  /** 登记幂等键 → runId */
  recordKey(worldId: string, key: string, runId: string): void;
  /** 提案指纹命中 → 既有 runId；未命中 → null */
  proposalHit(worldId: string, scope: string, proposal: EvolutionProposal): string | null;
  /** run 收尾登记：冷却时刻 + 指纹（setIfAbsent——同提案保留首次执行的 run，
   *  指纹按 world|focus 分域（P5）：不同 NPC 的相同结论互不串挡） */
  recordFinish(worldId: string, scope: string, runId: string, proposal: EvolutionProposal | undefined): void;
  /** 焦点作用域（P5 · 方案 §八）：wakePlan 恰有一个 HIGH 唤醒 = 以该实体的
   *  视角做个体决策；世界级 tick 返回 ''（与 P4 前行为一致） */
  focusOf(worldId: string, wakePlan?: WakePlan): string;
}

/** 焦点作用域（P5 · 方案 §八）——纯函数，ledger 实例与 observation 共用 */
export function focusOf(worldId: string, wakePlan?: WakePlan): string {
  const high = (wakePlan?.wakes ?? []).filter((w) => w.grade === 'high').map((w) => w.entityId);
  void worldId;
  return high.length === 1 ? high[0]! : '';
}

export function createLedger(journal: LedgerJournal): EvolutionLedger {
  const runsByKey = new Map<string, string>(); // `${worldId}|${idempotencyKey}` -> runId
  const runsByProposal = new Map<string, string>(); // `${worldId}|${focus}|${proposalKey}` -> runId
  const lastRunAt = new Map<string, number>(); // `${worldId}|${focus}` -> 完成时刻（冷却用）
  const ledgerRebuilt = new Set<string>(); // 已从 Journal 重建过幂等账的世界

  function ensureRebuilt(worldId: string): void {
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

  return {
    ensureRebuilt,
    focusOf,
    checkIdempotencyKey: (worldId, key) => runsByKey.get(`${worldId}|${key}`) ?? null,
    checkCooldown: (scope, cooldownMs) => {
      const last = lastRunAt.get(scope);
      if (last === undefined) return 0;
      const elapsed = Date.now() - last;
      return elapsed < cooldownMs ? cooldownMs - elapsed : 0;
    },
    recordKey: (worldId, key, runId) => {
      runsByKey.set(`${worldId}|${key}`, runId);
    },
    proposalHit: (worldId, scope, proposal) => runsByProposal.get(`${scope}|${proposalKey(worldId, proposal)}`) ?? null,
    recordFinish: (worldId, scope, runId, proposal) => {
      lastRunAt.set(scope, Date.now());
      if (proposal) {
        const key = `${scope}|${proposalKey(worldId, proposal)}`;
        if (!runsByProposal.has(key)) runsByProposal.set(key, runId);
      }
    },
  };
}

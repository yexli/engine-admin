/* ============================================================
   World Runtime：世界驱动器
   ------------------------------------------------------------
   接收 Command → 校验（规则拒绝即失败）→ 执行 Rule → Mutation →
   更新 State → Event → 事件总线。

   它不是 AI Runtime，也不是 NPC Runtime——AI 可以**建议**命令，
   但世界变更只能经这条链落地；本运行时不认识任何模型。
   ============================================================ */
import type { CommandResult, WorldCommand } from '../command/Command.ts';
import { type EventSchemaInstance, type WorldEvent, defaultEventSchema } from '../events/EventSchema.ts';
import { worldBus, type WorldEventBus } from '../events/WorldEventBus.ts';
import type { KernelMutate } from '../mutate/WorldMutate.ts';
import { RuleRegistry, type EventEmit, type RuleContext, type WorldRule } from '../rules/Rules.ts';
import { CHEN_PER_DAY } from '../time/TimeBase.ts';
import type { WorldClock } from '../time/WorldClock.ts';
import type { EngineWorldState } from '../types.ts';
import type { WorldContainer } from '../state/WorldState.ts';

export interface WorldRuntimeOptions<W extends EngineWorldState> {
  container: WorldContainer<W>;
  clock: WorldClock<W>;
  mutate: KernelMutate<W>;
  /** 事件总线（缺省全局缺省作用域；多世界隔离时传本世界实例，V0.9） */
  bus?: WorldEventBus;
  /** 事件模式实例（缺省全局缺省作用域） */
  events?: EventSchemaInstance;
  /** 额外注册的规则（引擎内置规则之外） */
  rules?: WorldRule<W>[];
  /** 命令幂等账初始装载（V2.4 加固：跨重启幂等——介质在组合根读出后传入） */
  initialCommandLedger?: CommandLedgerRow[];
  /** 幂等账变化回调（组合根接介质持久化；账本为插入序，FIFO 上限内全量） */
  onLedgerChange?: (rows: CommandLedgerRow[]) => void;
}

/** 幂等账一行：commandId → 首次执行结果（JSON 可序列化；跨重启恢复用） */
export interface CommandLedgerRow {
  commandId: string;
  result: CommandResult;
}

export interface WorldRuntime<W extends EngineWorldState> {
  /** 提交一条命令：命令链的统一入口 */
  execute(cmd: WorldCommand): CommandResult;
  /** 规则表（游戏在启动时注册自己的规则） */
  readonly rules: RuleRegistry<W>;
  /** 最近命令历史（新 → 旧；环形缓冲观测面，V1.0.1） */
  recentCommands(n?: number): CommandHistoryEntry[];
}

/** 一条命令的执行留痕（观测用；不含状态差异——差异看事件与 state） */
export interface CommandHistoryEntry {
  /** 单调递增序号（本世界作用域内） */
  seq: number;
  /** 挂钟时间（ISO 8601；引擎平时不碰钟，这里只为观测留痕） */
  at: string;
  /** 执行时的世界时刻 */
  tick: number;
  day: number;
  /** 命令快照（深拷贝，后续改动不影响留痕） */
  command: WorldCommand;
  ok: boolean;
  reason?: string;
  /** 产生的事件 id（时序） */
  events: string[];
  /** 执行耗时（毫秒；同步命令链通常 <1ms） */
  tookMs: number;
}

/** 命令历史环形缓冲上限（观测窗口；完整审计归宿主的事件/世界史） */
const COMMAND_RING = 100;

export function createWorldRuntime<W extends EngineWorldState>(opts: WorldRuntimeOptions<W>): WorldRuntime<W> {
  const { container, clock, mutate } = opts;
  const bus = opts.bus ?? worldBus;
  const events = opts.events ?? defaultEventSchema;
  const rules = new RuleRegistry<W>();
  for (const r of opts.rules ?? []) rules.register(r);

  /* 命令历史环形缓冲（观测记账；G5） */
  const commandRing: CommandHistoryEntry[] = [];
  let commandSeq = 0;

  /* V2.4-02 · 方案 §二十一：命令幂等账（commandId → 首次结果，bounded FIFO）。
     同 commandId 重复提交（HTTP 重试/网络重发）返回首次结果——不重复执行、
     不产生重复 Mutation / Event。缺省无 commandId 的命令不受影响。
     V2.4 加固：账本可从介质装载（跨重启幂等）并在变化时回调持久化。 */
  const IDEMPOTENCY_CAP = 500;
  const idempotency = new Map<string, CommandResult>();
  for (const row of opts.initialCommandLedger ?? []) {
    if (typeof row?.commandId !== 'string' || !row.commandId || !row.result || typeof row.result.ok !== 'boolean') continue;
    idempotency.set(row.commandId, row.result);
  }
  while (idempotency.size > IDEMPOTENCY_CAP) {
    const drop = idempotency.keys().next().value;
    if (drop === undefined) break;
    idempotency.delete(drop);
  }
  const ledgerRows = (): CommandLedgerRow[] => [...idempotency].map(([commandId, result]) => ({ commandId, result }));

  function execute(cmd: WorldCommand): CommandResult {
    if (typeof cmd.commandId === 'string' && cmd.commandId.length > 0 && cmd.commandId.length <= 128) {
      const hit = idempotency.get(cmd.commandId);
      if (hit) return { ...hit, duplicate: true };
    }
    const result = executeInner(cmd);
    if (typeof cmd.commandId === 'string' && cmd.commandId.length > 0 && cmd.commandId.length <= 128) {
      idempotency.set(cmd.commandId, result);
      if (idempotency.size > IDEMPOTENCY_CAP) {
        const drop = idempotency.keys().next().value;
        if (drop !== undefined) idempotency.delete(drop);
      }
      opts.onLedgerChange?.(ledgerRows());
    }
    return result;
  }

  function executeInner(cmd: WorldCommand): CommandResult {
    const startedAt = Date.now();
    const s0 = container.core.S;
    const record = (res: CommandResult): CommandResult => {
      const st = container.core.S;
      const entry: CommandHistoryEntry = {
        seq: ++commandSeq,
        at: new Date().toISOString(),
        tick: st?.t ?? s0?.t ?? 0,
        day: st ? Math.floor(st.t / CHEN_PER_DAY) + 1 : 0,
        command: snapshotCommand(cmd),
        ok: res.ok,
        ...(res.reason !== undefined ? { reason: res.reason } : {}),
        events: res.events,
        tookMs: Date.now() - startedAt,
      };
      commandRing.push(entry);
      if (commandRing.length > COMMAND_RING) commandRing.shift();
      return res;
    };

    /* 一条命令 = 一个 tick：重置本 tick 的事件配额（与宿主 dispatch 同纪律） */
    bus.beginTick();

    const matched = rules.forCommand(cmd.type);
    if (!matched.length) {
      return record({ ok: false, events: [], reason: `没有规则处理命令：${cmd.type}` });
    }

    const emitted: WorldEvent[] = [];
    const s = container.need();
    const ctx: RuleContext<W> = {
      state: s,
      command: cmd,
      mutate,
      clock,
      emit(draft: EventEmit): WorldEvent {
        const e = events.makeEvent({
          ...draft,
          worldId: draft.worldId ?? (s.worldId as string | undefined),
          day: draft.day ?? clock.sceneTime(s).day,
          tick: draft.tick ?? s.t,
        });
        bus.emit(e);
        emitted.push(e);
        return e;
      },
    };

    for (const rule of matched) {
      let ok: boolean | void;
      try {
        ok = rule.apply(ctx);
      } catch (err) {
        /* 规则异常不裸奔：命令层给一句可读的拒绝原因 */
        return record({ ok: false, events: emitted.map((e) => e.id), reason: err instanceof Error ? err.message : String(err) });
      }
      if (ok === false) {
        container.sync();
        return record({ ok: false, events: emitted.map((e) => e.id), reason: `规则 ${rule.name} 拒绝了命令 ${cmd.type}` });
      }
    }

    /* 命令链统一落点：任何分支改过状态都必须通知 UI 并（节流）落盘 */
    container.sync();
    return record({ ok: true, events: emitted.map((e) => e.id) });
  }

  return {
    execute,
    rules,
    recentCommands: (n = 20) => commandRing.slice(-Math.max(0, Math.min(n, COMMAND_RING))).reverse(),
  };
}

/** 命令快照：payload 只有一层基本类型（HTTP 契约同款），浅拷贝即可隔离后续改动 */
function snapshotCommand(cmd: WorldCommand): WorldCommand {
  return {
    type: cmd.type,
    ...(cmd.actorId !== undefined ? { actorId: cmd.actorId } : {}),
    ...(cmd.targetId !== undefined ? { targetId: cmd.targetId } : {}),
    ...(cmd.amount !== undefined ? { amount: cmd.amount } : {}),
    ...(cmd.text !== undefined ? { text: cmd.text } : {}),
    ...(cmd.payload ? { payload: { ...cmd.payload } } : {}),
  };
}

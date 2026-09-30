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
}

export interface WorldRuntime<W extends EngineWorldState> {
  /** 提交一条命令：命令链的统一入口 */
  execute(cmd: WorldCommand): CommandResult;
  /** 规则表（游戏在启动时注册自己的规则） */
  readonly rules: RuleRegistry<W>;
}

export function createWorldRuntime<W extends EngineWorldState>(opts: WorldRuntimeOptions<W>): WorldRuntime<W> {
  const { container, clock, mutate } = opts;
  const bus = opts.bus ?? worldBus;
  const events = opts.events ?? defaultEventSchema;
  const rules = new RuleRegistry<W>();
  for (const r of opts.rules ?? []) rules.register(r);

  function execute(cmd: WorldCommand): CommandResult {
    /* 一条命令 = 一个 tick：重置本 tick 的事件配额（与宿主 dispatch 同纪律） */
    bus.beginTick();

    const matched = rules.forCommand(cmd.type);
    if (!matched.length) {
      return { ok: false, events: [], reason: `没有规则处理命令：${cmd.type}` };
    }

    const emitted: WorldEvent[] = [];
    const s = container.need();
    const ctx: RuleContext<W> = {
      state: s,
      command: cmd,
      mutate,
      clock,
      emit(draft: EventEmit): WorldEvent {
        const e = events.makeEvent({ ...draft, day: draft.day ?? clock.sceneTime(s).day, tick: draft.tick ?? s.t });
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
        return { ok: false, events: emitted.map((e) => e.id), reason: err instanceof Error ? err.message : String(err) };
      }
      if (ok === false) {
        container.sync();
        return { ok: false, events: emitted.map((e) => e.id), reason: `规则 ${rule.name} 拒绝了命令 ${cmd.type}` };
      }
    }

    /* 命令链统一落点：任何分支改过状态都必须通知 UI 并（节流）落盘 */
    container.sync();
    return { ok: true, events: emitted.map((e) => e.id) };
  }

  return { execute, rules };
}

/* ============================================================
   世界规则（World Rules）
   ------------------------------------------------------------
   规则解决「世界应该如何运行」：一条命令进来，哪个规则接、
   接了之后改哪些状态、发布哪些事实。规则是引擎最重要的扩展点——
   新游戏经 registerRule 挂自己的规则，不改引擎核心。

   与 Adapter 的区别：Adapter 解决「这个游戏如何接入引擎」
   （数据转换 / 实体映射）；Rule 解决「这个世界如何运转」。
   ============================================================ */
import type { WorldCommand } from '../command/Command.ts';
import type { KernelMutate } from '../mutate/WorldMutate.ts';
import type { WorldClock } from '../time/WorldClock.ts';
import type { EngineWorldState } from '../types.ts';
import type { EventDraft, WorldEvent } from '../events/EventSchema.ts';

/** 规则执行上下文：规则经它读写状态、推进时间、发布事实——拿不到绕过写入层的口子 */
export interface RuleContext<W extends EngineWorldState> {
  state: W;
  command: WorldCommand;
  mutate: KernelMutate<W>;
  clock: WorldClock<W>;
  /** 发布一条世界事实（进事件总线，同时计入本次命令的事件清单）。
      day / tick 缺省按当前世界时间自动补全。 */
  emit(draft: EventEmit): WorldEvent;
}

/** 规则发事件时的草稿：day / tick 可省（运行时按当前世界时间补全） */
export type EventEmit = Omit<EventDraft, 'day' | 'tick'> & { day?: number; tick?: number };

export interface WorldRule<W extends EngineWorldState> {
  /** 规则名（观测 / 调试用） */
  name: string;
  /** 处理的命令类型 */
  for: string | readonly string[];
  /**
   * 应用规则。返回 false = 拒绝（调用方据此回 ok: false）；
   * 返回 true / undefined = 接受。状态改写必须经 ctx.mutate / ctx.clock。
   */
  apply(ctx: RuleContext<W>): boolean | void;
}

export class RuleRegistry<W extends EngineWorldState> {
  private rules: WorldRule<W>[] = [];

  register(rule: WorldRule<W>): void {
    this.rules.push(rule);
  }

  /** 按命令类型取规则（先注册先接；同名命令多条规则时按序全部执行） */
  forCommand(type: string): WorldRule<W>[] {
    return this.rules.filter((r) => (typeof r.for === 'string' ? r.for === type : r.for.includes(type)));
  }

  all(): readonly WorldRule<W>[] {
    return this.rules;
  }

  clear(): void {
    this.rules = [];
  }
}

/* ============================================================
   World Event Consumer（V2 · 方案 §三/§五：游戏方消费事件的公共件）
   ------------------------------------------------------------
   天穹宿主等游戏侧消费世界事实的最小公共件：
     · 幂等去重（方案 §二.3 / §七.11）：同一 Event 重复投递（断线
       重连 replay / 轮询重叠窗口）只消费一次——消费侧 seen 集合，
       不依赖引擎进程内存；
     · 分级（方案 §五）：消费时顺手分级，High 事件才值得触发演化；
     · 只读：消费者拿到的是已经发生的事实，翻不出来路。

   与引擎 G3 事件流的关系：本件不管传输（WS / 轮询都行），只管
   「哪些是新事实、值不值得演化」。
   ============================================================ */
import { gradeEvents, highEventsOf, shouldAutoTrigger, type TriggerPolicyOptions } from './policy.ts';
import type { TriggerGrade, TriggerEventView } from './types.ts';

export interface EventConsumerOptions extends TriggerPolicyOptions {
  /** 消费者 id（多消费者各持各的 seen 集，互不干扰） */
  consumerId: string;
  /** seen 集合容量上限（防无限增长；超出淘汰最旧） */
  seenCap?: number;
  /** 每条新事实的回调（已去重） */
  onEvent?: (event: TriggerEventView & { id?: string; grade: TriggerGrade }) => void;
}

export interface WorldEventConsumer {
  readonly consumerId: string;
  /** 投递一批事件（可重复、可乱序、可含已见过的）；返回其中真正的新事实 */
  feed(events: (TriggerEventView & { id?: string })[]): (TriggerEventView & { id?: string; grade: TriggerGrade })[];
  /** 当前窗口内是否值得自动触发演化（存在 High 事实） */
  shouldAutoTrigger(): boolean;
  /** 窗口内 High 事件清单（自动触发的依据留痕） */
  highEvents(): (TriggerEventView & { grade: TriggerGrade })[];
  /** 已见事件 id 数（观测） */
  seenCount(): number;
}

export function createEventConsumer(opts: EventConsumerOptions): WorldEventConsumer {
  const cap = Math.max(100, Math.floor(opts.seenCap ?? 2000));
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  const recent: (TriggerEventView & { grade: TriggerGrade })[] = [];
  const RECENT_CAP = 200;

  function markSeen(id: string): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > cap) {
      const drop = seenOrder.splice(0, seenOrder.length - cap);
      for (const d of drop) seen.delete(d);
    }
    return true;
  }

  return {
    consumerId: opts.consumerId,

    feed(events) {
      const fresh: (TriggerEventView & { id?: string; grade: TriggerGrade })[] = [];
      for (const e of events) {
        if (e.id !== undefined) {
          if (!markSeen(e.id)) continue; // 幂等：重复投递只消费一次
        }
        const graded = { ...e, grade: gradeEvents([e], opts) };
        fresh.push(graded);
        recent.push(graded);
        if (recent.length > RECENT_CAP) recent.shift();
        opts.onEvent?.(graded);
      }
      return fresh;
    },

    shouldAutoTrigger() {
      return shouldAutoTrigger(recent, opts);
    },

    highEvents() {
      return highEventsOf(recent, opts).map((e) => ({ ...e, grade: gradeEvents([e], opts) as TriggerGrade }));
    },

    seenCount() {
      return seen.size;
    },
  };
}

/* ============================================================
   世界事件总线（V0.9 · 方案 §65/§66；§42 Multi-World 兑现）
   ------------------------------------------------------------
   系统 ↔ 系统 的世界事实传播通道：可追溯 / 可推演 / 可防环。
   铁律：系统之间不点对点通知，只发事件让相关方自行决定是否响应。

   V0.9 实例隔离（DR-001 兑现）：总线从模块级单例重构为
   **createWorldEventBus() 工厂**——每个世界作用域一条总线；
   模块级 `worldBus` 常量 = **全局缺省作用域**（既有宿主与全部
   既有导入面零改动）。日志经 setLogger 注入（引擎不认识宿主日志）。

   内建纪律（宿主线上行为，逐行保留）：
   · 单 tick 配额与 critical 独立熔断（防事件风暴 / 防成环刷屏）
   · semantic 超限**延后重投**（原 id + 原深度，副作用靠幂等挡住）
   · 同一事件同一处理器只消费一次（processedBy 幂等）
   · 因果上下文：后果执行期间发布的自动挂到父事件（为什么链）
   · 死信队列（超限 / 链过深 / 队列满），可挂观察者
   ============================================================ */
import { channelOf, type EventChannel, type WorldEvent } from './EventSchema.ts';

/** 引擎日志钩子：宿主（如宿主的 RunLog）在组合根注入；缺省静默 */
export interface WorldBusLogger {
  info(msg: string, data?: Record<string, unknown>): void;
}

type WorldHandler = (e: WorldEvent) => void;

interface Sub {
  /** 订阅唯一键（type#owner）：同一处理器不重复消费同一事件（幂等） */
  key: string;
  fn: WorldHandler;
}

/** 限流：单 tick 最大事件数 / 因果链最大深度（全实例同规） */
export const MAX_EVENTS_PER_TICK = 64;
export const MAX_CHAIN_DEPTH = 6;
export const MAX_CRITICAL_PER_TICK = 16;
const MAX_CRITICAL_DEPTH = MAX_CHAIN_DEPTH;
const MAX_DEFERRED = 256;
const MAX_DEFER_ATTEMPTS = 8;
const RETRY_BUDGET = Math.max(1, Math.floor(MAX_EVENTS_PER_TICK / 2));

/** 一次投递的结果。不只是 boolean——日志要能回答「为什么没执行」。 */
export interface EventDeliveryResult {
  accepted: boolean;
  status: 'dispatched' | 'queued' | 'deferred' | 'dropped' | 'duplicate' | 'dead_letter';
  eventId: string;
  channel: EventChannel;
  reason?: string;
  retryAt?: number;
}

export interface WorldEventBus {
  on(type: string, fn: WorldHandler, owner?: string): () => void;
  emit(e: WorldEvent, opts?: { chainDepth?: number }): EventDeliveryResult;
  schedule(e: WorldEvent, delayDays: number): void;
  due(day: number): WorldEvent[];
  beginTick(): { emitted: number; deferred: number; retried: number };
  deadLetters(): WorldEvent[];
  deferredEvents(): WorldEvent[];
  /** 定时未到期事件（只读观测；V1.0.1，HTTP 观测面用） */
  scheduledEvents(): { dueDay: number; event: WorldEvent }[];
  clearDeadLetters(): void;
  onDeadLetter(fn: ((e: WorldEvent, why: string) => void) | null): void;
  deadLetterHookOf(): ((e: WorldEvent, why: string) => void) | null;
  stats(): { subscribers: number; scheduled: number; deadLetters: number; tickEmitted: number; deferred: number };
  reset(): void;
}

export interface WorldEventBusScope {
  bus: WorldEventBus;
  causality: {
    withParent<T>(parentId: string, fn: () => T): T;
    depth(): number;
    reset(): void;
  };
  withReasonerOrigin<T>(fn: () => T): T;
  isReasonerOrigin(): boolean;
  setLogger(logger: WorldBusLogger | null): void;
}

const WORLD_WILDCARD = '*';

/** 创建一条独立的世界事件总线作用域（每世界一条；模块缺省作用域见文件尾） */
export function createWorldEventBus(): WorldEventBusScope {
  const worldHandlers = new Map<string, Sub[]>();
  let subSeq = 0;
  let logger: WorldBusLogger | null = null;

  let tickEmitted = 0;
  let tickNo = 0;
  let criticalEmitted = 0;
  const dispatchedThisTick = new Set<string>();
  const deferredQueue: { event: WorldEvent; depth: number; attempts: number }[] = [];
  const scheduled: { dueDay: number; event: WorldEvent }[] = [];
  const deadLetters: WorldEvent[] = [];
  let deadLetterHook: ((e: WorldEvent, why: string) => void) | null = null;

  let causalParent: string | undefined;
  let causalDepth = 0;
  let reasonerDepth = 0;

  function deadLetter(e: WorldEvent, channel: EventChannel, why: string): EventDeliveryResult {
    deadLetters.push(e);
    deadLetterHook?.(e, why);
    return { accepted: false, status: 'dead_letter', eventId: e.id, channel, reason: why };
  }

  function deliver(e: WorldEvent, depth: number, isRetry: boolean): EventDeliveryResult {
    const channel = channelOf(e);

    if (!isRetry && dispatchedThisTick.has(e.id)) {
      return { accepted: false, status: 'duplicate', eventId: e.id, channel, reason: '本 tick 已派发过同一事件' };
    }
    if (!isRetry) dispatchedThisTick.add(e.id);

    if (!e.parentId && causalParent) e.parentId = causalParent;

    const depthMax = channel === 'critical' ? MAX_CRITICAL_DEPTH : MAX_CHAIN_DEPTH;
    if (depth > depthMax) return deadLetter(e, channel, 'causal chain too deep');

    if (channel === 'critical') {
      if (criticalEmitted >= MAX_CRITICAL_PER_TICK) {
        return deadLetter(e, channel, 'critical per-tick cap exceeded（疑似成环）');
      }
      criticalEmitted++;
    } else if (tickEmitted >= MAX_EVENTS_PER_TICK) {
      if (channel === 'semantic') {
        if (deferredQueue.length >= MAX_DEFERRED) {
          const oldest = deferredQueue.shift();
          if (oldest) deadLetter(oldest.event, 'semantic', 'deferred queue full：挤掉最旧一条（新事实优先）');
        }
        deferredQueue.push({ event: e, depth, attempts: 0 });
        logger?.info('语义事件延后到下个 tick 重投', { type: e.type, id: e.id, retryAt: tickNo + 1 });
        return { accepted: false, status: 'deferred', eventId: e.id, channel, reason: 'single tick cap exceeded', retryAt: tickNo + 1 };
      }
      return deadLetter(e, channel, 'single tick event cap exceeded');
    } else {
      tickEmitted++;
    }

    /* 派发顺序契约：通配订阅者（感知 / 世界史 / 审计这类横切关注点）先于具体类型订阅者 */
    const subs = [...(worldHandlers.get(WORLD_WILDCARD) ?? []), ...(worldHandlers.get(e.type) ?? [])];
    let invoked = 0;
    for (const s of subs) {
      if (e.processedBy?.includes(s.key)) continue;
      if (!e.processedBy) e.processedBy = [];
      e.processedBy.push(s.key);
      s.fn({ ...e, processedBy: [...e.processedBy] });
      invoked++;
    }
    if (invoked === 0 && subs.length > 0) {
      return { accepted: false, status: 'duplicate', eventId: e.id, channel, reason: '所有订阅者都已消费过该事件' };
    }
    return { accepted: true, status: 'dispatched', eventId: e.id, channel };
  }

  const bus: WorldEventBus = {
    on(type: string, fn: WorldHandler, owner?: string): () => void {
      const key = type + '#' + (owner ?? 'sub' + ++subSeq);
      const list = worldHandlers.get(type) ?? [];
      const sub: Sub = { key, fn };
      list.push(sub);
      worldHandlers.set(type, list);
      return () => {
        const cur = worldHandlers.get(type);
        if (!cur) return;
        const i = cur.indexOf(sub);
        if (i >= 0) cur.splice(i, 1);
      };
    },

    emit(e: WorldEvent, emitOpts: { chainDepth?: number } = {}): EventDeliveryResult {
      /* 刻意不复制事件对象：processedBy 记录正是幂等的凭据（一次性载荷纪律） */
      return deliver(e, emitOpts.chainDepth ?? causalDepth, false);
    },

    schedule(e: WorldEvent, delayDays: number): void {
      scheduled.push({ dueDay: e.day + Math.max(0, delayDays), event: e });
    },

    due(day: number): WorldEvent[] {
      const hit: WorldEvent[] = [];
      for (let i = scheduled.length - 1; i >= 0; i--) {
        if (scheduled[i].dueDay <= day) {
          hit.unshift(scheduled[i].event);
          scheduled.splice(i, 1);
        }
      }
      return hit;
    },

    beginTick(): { emitted: number; deferred: number; retried: number } {
      const prev = tickEmitted;
      const prevDeferred = deferredQueue.length;
      tickEmitted = 0;
      criticalEmitted = 0;
      dispatchedThisTick.clear();
      tickNo++;
      const pending = deferredQueue.splice(0, deferredQueue.length);
      let retried = 0;
      for (const entry of pending) {
        if (tickEmitted >= RETRY_BUDGET) {
          entry.attempts++;
          if (entry.attempts < MAX_DEFER_ATTEMPTS) deferredQueue.push(entry);
          else deadLetter(entry.event, 'semantic', '延后次数超限：等太久，时效已失');
          continue;
        }
        const res = deliver(entry.event, entry.depth, true);
        if (res.status === 'dispatched') retried++;
        else if (res.status === 'deferred') {
          entry.attempts++;
          if (entry.attempts < MAX_DEFER_ATTEMPTS && deferredQueue.length < MAX_DEFERRED) deferredQueue.push(entry);
          else deadLetter(entry.event, 'semantic', '延后次数超限或队列已满：语义事件在此不再保证送达');
        }
      }
      return { emitted: prev, deferred: prevDeferred, retried };
    },

    deadLetters(): WorldEvent[] {
      return [...deadLetters];
    },

    deferredEvents(): WorldEvent[] {
      return deferredQueue.map((d) => d.event);
    },

    scheduledEvents(): { dueDay: number; event: WorldEvent }[] {
      return scheduled.map((s) => ({ dueDay: s.dueDay, event: s.event }));
    },

    clearDeadLetters(): void {
      deadLetters.length = 0;
    },

    onDeadLetter(fn: ((e: WorldEvent, why: string) => void) | null): void {
      deadLetterHook = fn;
    },

    deadLetterHookOf(): ((e: WorldEvent, why: string) => void) | null {
      return deadLetterHook;
    },

    stats(): { subscribers: number; scheduled: number; deadLetters: number; tickEmitted: number; deferred: number } {
      let subs = 0;
      for (const l of worldHandlers.values()) subs += l.length;
      return { subscribers: subs, scheduled: scheduled.length, deadLetters: deadLetters.length, tickEmitted, deferred: deferredQueue.length };
    },

    reset(): void {
      worldHandlers.clear();
      scheduled.length = 0;
      deadLetters.length = 0;
      tickEmitted = 0;
      criticalEmitted = 0;
      tickNo = 0;
      dispatchedThisTick.clear();
      deferredQueue.length = 0;
      deadLetterHook = null;
      causalParent = undefined;
      causalDepth = 0;
    },
  };

  return {
    bus,
    causality: {
      withParent<T>(parentId: string, fn: () => T): T {
        const prevParent = causalParent;
        const prevDepth = causalDepth;
        causalParent = parentId;
        causalDepth = prevDepth + 1;
        try {
          return fn();
        } finally {
          causalParent = prevParent;
          causalDepth = prevDepth;
        }
      },
      depth(): number {
        return causalDepth;
      },
      reset(): void {
        causalParent = undefined;
        causalDepth = 0;
      },
    },
    withReasonerOrigin<T>(fn: () => T): T {
      reasonerDepth++;
      try {
        return fn();
      } finally {
        reasonerDepth--;
      }
    },
    isReasonerOrigin(): boolean {
      return reasonerDepth > 0;
    },
    setLogger(l: WorldBusLogger | null): void {
      logger = l;
    },
  };
}

/* ============================================================
   全局缺省作用域：既有宿主（宿主）与全部既有导入面的稳定绑定。
   多世界隔离走 createWorldEventBus()（见 WorldRegistry / DR-001）。
   ============================================================ */
const defaultScope = createWorldEventBus();

/** 全局缺省作用域（既有宿主的稳定绑定；多世界隔离请用 createWorldEventBus()） */
export const defaultWorldEventBusScope: WorldEventBusScope = defaultScope;

export const worldBus: WorldEventBus = defaultScope.bus;
export const causality = defaultScope.causality;
export const withReasonerOrigin: <T>(fn: () => T) => T = defaultScope.withReasonerOrigin;
export const isReasonerOrigin: () => boolean = defaultScope.isReasonerOrigin;
export function setWorldBusLogger(l: WorldBusLogger | null): void {
  defaultScope.setLogger(l);
}

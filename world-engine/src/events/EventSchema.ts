/* ============================================================
   世界事件标准结构（自宿主 EventSchema 抽取）
   ------------------------------------------------------------
   WorldEvent 是「世界已经发生的事实」，与「给界面看的信号」严格区分。
   铁律：Action ≠ Event。意图进系统校验，事实才进事件总线。

   与宿主版本的唯一差别：分级表（level）/ 通道表（channel）从硬编码
   字面量改为**可注册**——分级是游戏的世界观（什么算大事），结构是
   引擎的（事实长什么样）。未注册的类型按 Level 1 / ambient 处理。
   ============================================================ */

export type WorldEventLevel = 0 | 1 | 2 | 3;

export interface WorldEvent {
  /** 全局唯一：同一事件被多个处理器消费也只能记账一次 */
  id: string;
  /** 事件类型（snake_case 事实名，如 character_died） */
  type: string;
  /** 世界日（世界时钟刻度） */
  day: number;
  /** 场景时刻（同一天内的刻度） */
  tick: number;
  /** 分级：0 内部 / 1 局部 / 2 跨系统 / 3 复杂世界 */
  level: WorldEventLevel;
  /** 谁做的 / 对谁做的 / 在哪做的 / 因何而起 */
  actor?: string;
  target?: string;
  location?: string;
  cause?: string;
  /** 感知边界：World Truth ≠ NPC Knowledge，只有列名者「看见」了这件事 */
  witnesses?: string[];
  /** 事件载荷（骰子结果、数值、来源系统等） */
  data?: Record<string, unknown>;
  /** 因果链：直接父事件与源头事件，用于「为什么」的向上追溯 */
  parentId?: string;
  sourceId?: string;
  /** 已消费该事件的处理器（幂等：同一处理器不重复处理同一事件） */
  processedBy?: string[];
  /**
   * 事实来源标记：`reasoner` = 这条事实是**世界推演自己造出来的**。
   * 判定必须落在「安排事件的那一刻」而不是「发布的那一刻」——
   * 延迟事件隔天到期时，推演作用域早就不在了。
   */
  origin?: 'reasoner';
}

/** 事件通道：把「投递保证」从「是否进世界史」里独立出来 */
export type EventChannel = 'critical' | 'semantic' | 'ambient';

/* ---------------- 可注册的世界观表 + 事件工厂与序号（V0.9 作用域化） ---------------- */

/**
 * 事件模式实例：分级表 / 通道表 / 事件 id 序号的**独立作用域**。
 * 模块级导出（文件尾）绑定全局缺省实例——既有宿主与全部既有导入面零改动；
 * 多世界隔离经 createEventSchema()（WorldRegistry / DR-001）。
 */
export interface EventSchemaInstance {
  makeEvent(draft: EventDraft): WorldEvent;
  levelOf(type: string): WorldEventLevel;
  channelOf(e: WorldEvent): EventChannel;
  eventSeq(): number;
  setEventSeq(n: number): void;
  resetEventSeq(): void;
  nextEventId(day: number): string;
  registerEventTables(levels: Record<string, WorldEventLevel>, channels?: Record<string, EventChannel>): void;
  traceChain(events: WorldEvent[], leafId: string, maxDepth?: number): WorldEvent[];
  allEventTypes(): readonly string[];
}

export function createEventSchema(): EventSchemaInstance {
  let seq = 0;
  const LEVEL_TABLE: Record<string, WorldEventLevel> = {};
  const CHANNEL_TABLE: Record<string, EventChannel> = {};
  const allTypes: string[] = [];

  const api: EventSchemaInstance = {
    registerEventTables(levels, channels) {
      for (const [k, v] of Object.entries(levels)) {
        if (LEVEL_TABLE[k] === undefined) allTypes.push(k);
        LEVEL_TABLE[k] = v;
      }
      for (const [k, v] of Object.entries(channels ?? {})) CHANNEL_TABLE[k] = v;
    },
    levelOf(type: string): WorldEventLevel {
      return LEVEL_TABLE[type] ?? 1;
    },
    channelOf(e: WorldEvent): EventChannel {
      return CHANNEL_TABLE[e.type] ?? (e.level >= 2 ? 'semantic' : 'ambient');
    },
    nextEventId(day: number): string {
      seq += 1;
      return 'evt_' + day + '_' + seq;
    },
    eventSeq(): number {
      return seq;
    },
    setEventSeq(n: number): void {
      seq = Math.max(0, Math.floor(n));
    },
    resetEventSeq(): void {
      seq = 0;
    },
    makeEvent(draft: EventDraft): WorldEvent {
      return {
        id: api.nextEventId(draft.day),
        type: draft.type,
        day: draft.day,
        tick: draft.tick ?? 0,
        level: draft.level ?? api.levelOf(draft.type),
        actor: draft.actor,
        target: draft.target,
        location: draft.location,
        cause: draft.cause,
        witnesses: draft.witnesses,
        data: draft.data,
        parentId: draft.parentId,
        sourceId: draft.sourceId,
        origin: draft.origin,
        processedBy: [],
      };
    },
    traceChain(events: WorldEvent[], leafId: string, maxDepth = 12): WorldEvent[] {
      const byId = new Map(events.map((e) => [e.id, e]));
      const chain: WorldEvent[] = [];
      const seen = new Set<string>();
      let cur: WorldEvent | undefined = byId.get(leafId);
      while (cur && !seen.has(cur.id) && chain.length < maxDepth) {
        chain.push(cur);
        seen.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return chain;
    },
    allEventTypes(): readonly string[] {
      return allTypes; // 活引用：registerEventTables 原地维护，绑定方自动跟上
    },
  };
  return api;
}

/* ---------------- 全局缺省作用域（既有导入面的稳定绑定） ---------------- */

const defaultSchema = createEventSchema();

/** 全局缺省实例（既有宿主的稳定绑定；多世界隔离请用 createEventSchema()） */
export const defaultEventSchema: EventSchemaInstance = defaultSchema;

export const makeEvent: (draft: EventDraft) => WorldEvent = defaultSchema.makeEvent;
export const levelOf: (type: string) => WorldEventLevel = defaultSchema.levelOf;
export const channelOf: (e: WorldEvent) => EventChannel = defaultSchema.channelOf;
export const eventSeq: () => number = defaultSchema.eventSeq;
export const setEventSeq: (n: number) => void = defaultSchema.setEventSeq;
export const resetEventSeq: () => void = defaultSchema.resetEventSeq;
export const nextEventId: (day: number) => string = defaultSchema.nextEventId;
export const registerEventTables: (
  levels: Record<string, WorldEventLevel>,
  channels?: Record<string, EventChannel>,
) => void = defaultSchema.registerEventTables;
export const traceChain: typeof defaultSchema.traceChain = defaultSchema.traceChain;
/** 已登记的全部事件类型（观测用；活引用——注册后自动跟上） */
export const ALL_EVENT_TYPES: readonly string[] = defaultSchema.allEventTypes();

export interface EventDraft {
  type: string;
  day: number;
  tick?: number;
  level?: WorldEventLevel;
  actor?: string;
  target?: string;
  location?: string;
  cause?: string;
  witnesses?: string[];
  data?: Record<string, unknown>;
  parentId?: string;
  sourceId?: string;
  origin?: 'reasoner';
}

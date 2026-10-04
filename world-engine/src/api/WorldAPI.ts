/* ============================================================
   World API：所有客户端进入 World Engine 的统一入口
   ------------------------------------------------------------
   最小 API 目标（本阶段为本地 Library 形态，未来可原样升级为
   SDK / HTTP——§20 演进路线）：

     const world = createWorld({ worldId: 'demo' });
     world.getState();
     world.executeCommand({ type: 'move', targetId: 'forest' });
     world.getEvents();

   依赖方向：API → Runtime → Rules → Mutation → State → Time/Event。
   引擎不认识任何具体游戏、任何模型、任何 UI。
   ============================================================ */
import type { CommandResult, WorldCommand } from '../command/Command.ts';
import { createEventSchema, defaultEventSchema, type EventSchemaInstance, type WorldEvent } from '../events/EventSchema.ts';
import { createWorldEventBus, worldBus, type WorldEventBus } from '../events/WorldEventBus.ts';
import { createMutate, type KernelMutate } from '../mutate/WorldMutate.ts';
import type { EventEmit, WorldRule } from '../rules/Rules.ts';
import { builtinRules } from '../runtime/BuiltinRules.ts';
import { createWorldRuntime, type WorldRuntime } from '../runtime/WorldRuntime.ts';
import { createBaseState, createWorldContainer, type WorldContainer } from '../state/WorldState.ts';
import { applyDefinition, type WorldDefinition } from '../state/WorldDefinition.ts';
import type { SavePort } from '../state/storage.ts';
import { CHEN_PER_DAY } from '../time/TimeBase.ts';
import { createWorldClock, type CalendarLabels, type WorldClock } from '../time/WorldClock.ts';
import type { EngineWorldState } from '../types.ts';
import { createQuery, type WorldQuery } from './WorldQuery.ts';

/** 事件环形缓冲上限（观测用；世界事实的持久化归宿主的 SavePort / 世界史） */
const EVENT_RING = 200;

export interface CreateWorldOptions<W extends EngineWorldState> {
  /** 世界标识（未来多世界 / 多用户的键） */
  worldId?: string;
  /** 历法标签（月名 / 时辰名 / 纪年起点；缺省中性历法） */
  labels?: CalendarLabels;
  /** 玩家名 / 开局地点 */
  playerName?: string;
  startLoc?: string;
  /** 初始天气 */
  weather?: string;
  /** 存档端口（缺省无介质：运行态保存在内存） */
  savePort?: SavePort<W>;
  /** 追加规则；不传时只装引擎内置规则 */
  rules?: WorldRule<W>[];
  /** 关掉引擎内置规则（游戏自带全套规则时用） */
  noBuiltinRules?: boolean;
  /**
   * V0.9 · 作用域隔离：true 时本世界持有独立的事件总线与事件 id 序号
   * （与其它世界互不可见；WorldRegistry 强制开启）。缺省 false = 全局缺省
   * 作用域——既有宿主（单世界）零改动；rng/scheduler 为进程级共享（DR-001 语义）。
   */
  isolated?: boolean;
  /**
   * V1.0 · World Definition（方案 §八）：应用在创建时注入世界——
   * 实体 / 地点 / 关系 / 变量 / 元数据。内核只知道 id/type/attributes，
   * 不知道它们叫什么名字、来自哪个故事。
   */
  definition?: WorldDefinition;
}

/** 世界时钟读数（实现与宿主共用：WorldQuery） */
export type { WorldTimeView } from './WorldQuery';

/** 世界事件史过滤（V2.4-01：getByEntity / getByTime / getByCausation） */
export interface WorldEventFilter {
  id?: string;
  type?: string;
  actor?: string;
  target?: string;
  location?: string;
  /** 世界日区间（含端点） */
  dayFrom?: number;
  dayTo?: number;
  /** 因果：parentId 或 sourceId 命中即返回（getByCausation） */
  causedBy?: string;
}

export interface WorldHandle<W extends EngineWorldState> {
  readonly worldId: string;
  /** 当前世界状态（只读面；改写必须走命令 / mutate） */
  getState(): W | null;
  /** 常用查询（只读；通用子集与宿主共用 createQuery 实现） */
  query: WorldQuery<W>;
  /** 唯一的状态改写入口（命令链） */
  executeCommand(cmd: WorldCommand): CommandResult;
  /** 推进时间（等价 executeCommand({ type: 'advance_time', amount })） */
  advanceTime(ticks: number): CommandResult;
  /** 最近的世界事实（新 → 旧） */
  getEvents(n?: number): WorldEvent[];
  /** 世界事件史查询（V2.4-01：可按实体/类型/时间/因果过滤全量历史；缺省 = 全量，新 → 旧） */
  queryEvents?(filter?: WorldEventFilter): WorldEvent[];
  /** 注册游戏规则 */
  registerRule(rule: WorldRule<W>): void;
  /** 发布一条系统级世界事实（不经命令链；day / tick 按当前世界时间补全） */
  emitEvent(draft: EventEmit): WorldEvent;
  /** 挂存档介质 */
  setSavePort(port: SavePort<W>): void;
  /** 受控写入原语（系统级代码用；游戏玩法逻辑请走命令） */
  mutate: KernelMutate<W>;
  /** 世界时钟 */
  clock: WorldClock<W>;
  /** 运行时（命令链本体） */
  runtime: WorldRuntime<W>;
  /** 状态容器（组合根用） */
  container: WorldContainer<W>;
  /** 本世界的事件总线（isolated 模式 = 独立实例；缺省 = 全局缺省作用域） */
  readonly bus: WorldEventBus;
  /** 本世界的事件模式实例（id 序号随作用域隔离） */
  readonly events: EventSchemaInstance;
  /** 注入 World Definition（幂等：重复 id 跳过） */
  applyDefinition(def: WorldDefinition): void;
}

export { createQuery } from './WorldQuery.ts';
export type { WorldQuery, QuerySource } from './WorldQuery.ts';

export function createWorld<W extends EngineWorldState = EngineWorldState>(opts: CreateWorldOptions<W> = {}): WorldHandle<W> {
  let savePort: SavePort<W> | null = opts.savePort ?? null;
  const container = createWorldContainer<W>({ getSavePort: () => savePort });

  /* V0.9 作用域：isolated = 每世界独立的事件总线与事件 id 序号（多世界隔离）；
     缺省 = 全局缺省作用域——既有宿主（单世界）与全部既有导入面零改动（DR-001 兑现）。
     rng / scheduler 为进程级共享设施，语义见 DR-001。 */
  const isolated = opts.isolated === true;
  const bus: WorldEventBus = isolated ? createWorldEventBus().bus : worldBus;
  const events: EventSchemaInstance = isolated ? createEventSchema() : defaultEventSchema;

  /* 引擎自建最小合法状态：应用可经 definition 注入世界数据（§八 World Definition） */
  container.core.S = createBaseState({
    worldId: opts.worldId,
    playerName: opts.playerName,
    startLoc: opts.startLoc,
    weather: opts.weather,
  }) as W;
  if (opts.definition) applyDefinition(container.core.S as EngineWorldState, opts.definition);

  const clock = createWorldClock<W>({ need: container.need, labels: opts.labels, bus, events });
  const mutate = createMutate<W>(container.need);
  const runtime = createWorldRuntime<W>({
    container,
    clock,
    mutate,
    bus,
    events,
    rules: opts.noBuiltinRules ? (opts.rules ?? []) : [...builtinRules<W>(), ...(opts.rules ?? [])],
  });

  /* ---------- 世界事件史（V2.4-01 Event Persistence · append-only）----------
     事件从「运行时消息」升级为「世界历史事实」：装配了世界史通道的 SavePort 时——
       · 启动恢复：loadWorldLog → 同 id 保末次去重 → 完整事件史（顺序稳定）；
       · 追加：每个新事实按 id 唯一追加（重复写入不制造重复事实）；
       · 持久化：saveWorldLog 整档快照（FileSavePort 防抖合并写；增量追加介质属 V2.5）；
       · 环形窗口恢复：重启后 ring 回填最近窗口，getEvents / WS replay 语义不变。
     未装配通道（缺省）= 内存往返，行为与此前完全一致。 */
  const worldLog: WorldEvent[] = [];
  const worldLogIds = new Set<string>();
  const hasWorldLog = (): boolean => typeof savePort?.loadWorldLog === 'function';
  if (hasWorldLog()) {
    const rows = savePort?.loadWorldLog?.() ?? null;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const e = row as WorldEvent;
        if (!e || typeof e.id !== 'string' || typeof e.type !== 'string') continue;
        if (worldLogIds.has(e.id)) {
          const idx = worldLog.findIndex((x) => x.id === e.id);
          worldLog[idx] = e; /* 同 id 保末次（幂等恢复） */
          continue;
        }
        worldLogIds.add(e.id);
        worldLog.push(e);
      }
    }
  }

  /* 事件环形缓冲：世界事实的近期窗口（订阅本世界作用域的总线） */
  const ring: WorldEvent[] = [];
  for (const e of worldLog.slice(-EVENT_RING)) ring.push(e); /* 重启恢复：历史窗口回填 */
  bus.on('*', (e) => {
    if (!container.core.S) return;
    ring.push(e);
    if (ring.length > EVENT_RING) ring.shift();
    /* 事件史追加（幂等：同 id 不重复成事实；介质侧防抖合并写） */
    if (hasWorldLog() && !worldLogIds.has(e.id)) {
      worldLogIds.add(e.id);
      worldLog.push(e);
      savePort?.saveWorldLog?.(worldLog as unknown[]);
    }
  });

  const handle: WorldHandle<W> = {
    worldId: opts.worldId ?? 'world',
    getState: () => container.core.S,

    query: createQuery<W>({ getState: () => container.core.S, clock }),

    executeCommand: (cmd: WorldCommand) => runtime.execute(cmd),
    advanceTime: (ticks: number) => runtime.execute({ type: 'advance_time', amount: ticks }),
    getEvents: (n = 20) => ring.slice(-n).reverse(),
    queryEvents: (f: WorldEventFilter = {}) => {
      const match = (e: WorldEvent): boolean =>
        (f.id === undefined || e.id === f.id) &&
        (f.type === undefined || e.type === f.type) &&
        (f.actor === undefined || e.actor === f.actor) &&
        (f.target === undefined || e.target === f.target) &&
        (f.location === undefined || e.location === f.location) &&
        (f.dayFrom === undefined || e.day >= f.dayFrom) &&
        (f.dayTo === undefined || e.day <= f.dayTo) &&
        (f.causedBy === undefined || e.parentId === f.causedBy || e.sourceId === f.causedBy);
      return worldLog.filter(match).reverse(); /* 新 → 旧，与 getEvents 同序 */
    },
    registerRule: (rule: WorldRule<W>) => runtime.rules.register(rule),
    emitEvent: (draft: EventEmit) => {
      const s = container.need();
      const ev = events.makeEvent({ ...draft, day: draft.day ?? Math.floor(s.t / CHEN_PER_DAY) + 1, tick: draft.tick ?? s.t });
      /* 总线通配订阅已记账入环——这里不再直推（曾导致环内双份，M4.3 修复） */
      bus.emit(ev);
      return ev;
    },
    setSavePort: (port: SavePort<W>) => {
      savePort = port;
    },
    mutate,
    clock,
    runtime,
    container,
    bus,
    events,
    applyDefinition: (def: WorldDefinition) => applyDefinition(container.core.S as EngineWorldState, def),
  };

  return handle;
}

export type { SavePort };

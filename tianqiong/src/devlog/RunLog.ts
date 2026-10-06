/* ============================================================
   运行日志（开发阶段观测）
   —— 记录「应用启动之后世界实际发生了什么」：事件、推演、校验、执行、存档、报错。
   与玩家可见的 s.log 完全是两回事：那是叙事，这是观测数据。

   装配顺序：它在 main.tsx 里**先于 bootstrapWorld** 接入，因此是世界事件总线上的
   第一个通配订阅者——这样启动装配本身也能被记下来。代价是它排在感知/世界史/记忆
   之前，所以它只读事件对象本身，绝不查任何派生表（否则会读到还没写入的旧值）。
   它出任何问题都不许冒泡：push 整段兜底，宁可少一条日志，也不能连累派发链。

   设计约束（不碰引擎的任何一条铁律）：
     · 只读观察：本模块不写 WorldState，不参与任何判定；
     · 零依赖：不 import 引擎/UI/存储，世界日与刻由外部注入（setRunLogSnapshot）；
     · O(1) 写入：环形缓冲 + 无 I/O，关掉时几乎无成本（enabled 为 false 直接返回）；
     · 不入档：日志是运行态数据，不进存档、不进事件总线，只在本会话里可查可导出。
   ============================================================ */

export type RunChan =
  | 'boot'
  | 'event'
  | 'combat'
  | 'ai'
  | 'memory'
  | 'exec'
  | 'valid'
  | 'save'
  | 'perf'
  | 'error'
  | 'ui'
  | 'extsync';
export type RunLvl = 'debug' | 'info' | 'warn' | 'error';

export const RUN_CHANNELS: RunChan[] = ['boot', 'event', 'combat', 'ai', 'memory', 'exec', 'valid', 'save', 'perf', 'error', 'ui', 'extsync'];

/** 通道中文名（面板与导出都用它，避免界面里散落英文缩写） */
export const RUN_CHAN_LABEL: Record<RunChan, string> = {
  boot: '装配',
  event: '世界事件',
  combat: '战斗',
  ai: '推演',
  memory: '记忆',
  exec: '执行',
  valid: '校验',
  save: '存档',
  perf: '耗时',
  error: '错误',
  ui: '界面',
  extsync: '外擎同步',
};

export interface RunEntry {
  /** 单调递增序号（面板用它做 key，也是「暂停后从哪继续」的游标） */
  seq: number;
  /** 相对启动的毫秒数 */
  at: number;
  /** 绝对时间（导出后对齐外部日志用） */
  wall: number;
  chan: RunChan;
  lvl: RunLvl;
  msg: string;
  /** 结构化载荷（尽量放可 JSON 化的标量，避免把整个对象塞进来） */
  data?: Record<string, unknown>;
  /** 快照：写入时的世界日与刻（没有世界时为空） */
  day?: number;
  tick?: number;
}

/** 环形容量：面板只渲染尾部若干条，超限丢最旧并计入 dropped */
const CAP = 1000;
/** 强制开关（DEV 默认开；想在打包版本里观测就把它置 1） */
const FLAG_KEY = 'tq2_devlog';

const now = (): number => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const startedAt = now();

let enabled = false;
let seq = 0;
let dropped = 0;
const buffer: RunEntry[] = [];
const listeners = new Set<(e: RunEntry | null) => void>();
const chanCount: Partial<Record<RunChan, number>> = {};
const lvlCount: Partial<Record<RunLvl, number>> = {};

/** 世界快照注入点：本模块不依赖引擎，日/刻由装配方喂进来 */
let snapshot: () => { day: number; tick: number } | null = () => null;
export function setRunLogSnapshot(fn: () => { day: number; tick: number } | null): void {
  snapshot = fn;
}

function readFlag(): boolean | null {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(FLAG_KEY) : null;
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

/** 默认开关：开发构建默认开；否则看显式标记（'1' 开 / '0' 关） */
function defaultEnabled(): boolean {
  const dev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
  const flag = readFlag();
  if (flag !== null) return flag;
  return dev;
}

function push(chan: RunChan, lvl: RunLvl, msg: string, data?: Record<string, unknown>): void {
  /* 整段兜底：这是总线派发链上的第一环，观测通道自己出任何问题都不许冒泡——
     一次日志失败连累感知/记忆/推演被跳过，是本末倒置。 */
  try {
    pushUnsafe(chan, lvl, msg, data);
  } catch {
    /* 观测失败就是观测失败，世界照常运行 */
  }
}

function pushUnsafe(chan: RunChan, lvl: RunLvl, msg: string, data?: Record<string, unknown>): void {
  const snap = snapshot();
  seq++;
  const entry: RunEntry = { seq, at: Math.round(now() - startedAt), wall: Date.now(), chan, lvl, msg };
  /* 深一层浅拷贝：调用方事后改自己的对象，不该追溯改写已经记下的历史 */
  if (data && Object.keys(data).length) entry.data = { ...data };
  if (snap) {
    entry.day = snap.day;
    entry.tick = snap.tick;
  }
  buffer.push(entry);
  if (buffer.length > CAP) {
    buffer.shift();
    dropped++;
  }
  chanCount[chan] = (chanCount[chan] ?? 0) + 1;
  lvlCount[lvl] = (lvlCount[lvl] ?? 0) + 1;
  notify(entry);
}

/** 通知订阅者。观察者的异常一律吞掉——日志是总线派发链上的第一环，它冒泡会连累感知/记忆/推演 */
function notify(entry: RunEntry | null): void {
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* 同上 */
    }
  }
}

export const runLog = {
  get enabled(): boolean {
    return enabled;
  },

  /** 手动开关（写进 localStorage，下次启动仍生效） */
  enable(on = true): void {
    enabled = on;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(FLAG_KEY, on ? '1' : '0');
    } catch {
      /* 无存储环境（测试/SSR）：只影响本会话 */
    }
  },

  write(chan: RunChan, lvl: RunLvl, msg: string, data?: Record<string, unknown>): void {
    if (!enabled) return;
    push(chan, lvl, msg, data);
  },

  debug(chan: RunChan, msg: string, data?: Record<string, unknown>): void {
    if (!enabled) return;
    push(chan, 'debug', msg, data);
  },
  info(chan: RunChan, msg: string, data?: Record<string, unknown>): void {
    if (!enabled) return;
    push(chan, 'info', msg, data);
  },
  warn(chan: RunChan, msg: string, data?: Record<string, unknown>): void {
    if (!enabled) return;
    push(chan, 'warn', msg, data);
  },
  error(chan: RunChan, msg: string, data?: Record<string, unknown>): void {
    if (!enabled) return;
    push(chan, 'error', msg, data);
  },

  /** 阶段标记（装配、切换场景这类一次性节点） */
  mark(label: string, data?: Record<string, unknown>): void {
    if (!enabled) return;
    push('boot', 'info', label, data);
  },

  /**
   * 计时器：返回的函数调用后写入一条 perf（带耗时）。
   * 只在启用时真的计时，关闭时返回空函数。
   */
  timer(chan: RunChan, label: string): (extra?: Record<string, unknown>) => number {
    if (!enabled) return () => 0;
    const t0 = now();
    return (extra?: Record<string, unknown>) => {
      const ms = Math.round(now() - t0);
      /* 计时器可能活过 await：创建之后关掉日志时，收尾这一步也不该再写 */
      if (!enabled) return ms;
      push('perf', ms >= 1000 ? 'warn' : 'debug', label, { ms, chan, ...(extra ?? {}) });
      return ms;
    };
  },

  /** 全部条目（副本：调用方改不动缓冲） */
  entries(): RunEntry[] {
    return buffer.slice();
  },

  /**
   * 序号大于 cursor 的条目（增量取用）。
   * **不补偿缺口**：缓冲被 CAP 截断时，掉出去的那些不会在这里出现；
   * 想知道「丢了多少」，看 stats().dropped。clear() 之后 seq 继续递增，
   * 所以持有旧游标的调用方不会静默停摆。
   */
  since(cursor: number): RunEntry[] {
    return buffer.filter((e) => e.seq > cursor);
  },

  /** 尾部 n 条 */
  tail(n = 300): RunEntry[] {
    return buffer.slice(Math.max(0, buffer.length - n));
  },

  /** total 是**本次会话累计写入**（不因 clear 归零）；kept 是当前缓冲条数 */
  stats(): {
    enabled: boolean;
    total: number;
    kept: number;
    dropped: number;
    uptimeMs: number;
    byChan: Partial<Record<RunChan, number>>;
    byLvl: Partial<Record<RunLvl, number>>;
    cap: number;
  } {
    return {
      enabled,
      total: seq,
      kept: buffer.length,
      dropped,
      uptimeMs: Math.round(now() - startedAt),
      byChan: { ...chanCount },
      byLvl: { ...lvlCount },
      cap: CAP,
    };
  },

  /** 清空缓冲。seq 不归零（否则增量消费者会静默停摆），并通知订阅者（传 null） */
  clear(): void {
    buffer.length = 0;
    dropped = 0;
    for (const k of Object.keys(chanCount)) delete chanCount[k as RunChan];
    for (const k of Object.keys(lvlCount)) delete lvlCount[k as RunLvl];
    notify(null);
  },

  /** 导出成 JSON 文本（面板的「导出」按钮与一键复制都用它） */
  exportJson(): string {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        uptimeMs: Math.round(now() - startedAt),
        stats: runLog.stats(),
        entries: buffer,
      },
      null,
      1,
    );
  },

  /** 订阅（面板用）：新条目回调，`null` 表示日志被清空。返回退订函数；观察者抛错不影响世界。 */
  subscribe(fn: (e: RunEntry | null) => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

enabled = defaultEnabled();

/**
 * 把模块恢复到冷启动状态：缓冲、序号、丢弃计数、通道计数、快照注入全部复位。
 * 与 `clear()` 的分工：clear 是用户在面板上按「清空」（只清视图，seq 继续递增，
 * 增量消费者不受影响）；reset 是测试/重新装配用的完全重置。
 */
export function resetRunLog(): void {
  buffer.length = 0;
  seq = 0;
  dropped = 0;
  for (const k of Object.keys(chanCount)) delete chanCount[k as RunChan];
  for (const k of Object.keys(lvlCount)) delete lvlCount[k as RunLvl];
  snapshot = () => null;
  notify(null);
}

/* ============================================================
   世界时钟（推进循环自宿主 WorldClock 原样抽取）
   ------------------------------------------------------------
   职责只有两件事：**推进时间** + **发布事实**（跨时辰 / 新的一天 /
   到期的计划事件）。时钟不调业务系统——谁响应、按什么顺序，
   由订阅者自己决定；宿主确需「时辰边界上的同步钩子」（如宿主的
   World Director 扫触发）经 onHourTick 注入，派发顺序与宿主一致：
   先广播事实，再跑钩子。

   历法标签（月名 / 时辰名 / 时段名 / 纪年起点）是游戏的世界观，
   经 CalendarLabels 注入；不给就用引擎的默认中性历法。
   ============================================================ */
import type { EngineWorldState, StatusEffect } from '../types.ts';
import { CHEN_PER_DAY, DAYS_PER_YEAR } from './TimeBase.ts';
import { defaultEventSchema, type EventSchemaInstance } from '../events/EventSchema.ts';
import { worldBus, type WorldEventBus } from '../events/WorldEventBus.ts';

/** 每时辰几刻。shichenOf 与「第 N 刻」都从这一处取。 */
export const TICKS_PER_HOUR = 4;

/** 该 tick 落在第几个时辰（0–11） */
export const shichenOf = (t: number) => Math.floor((t % CHEN_PER_DAY) / TICKS_PER_HOUR);

/** tick → 世界日（1 起算，与世界事件的 day 同一口径）。
    日历换算只此一处：各处自己写 `Math.floor(t / CHEN_PER_DAY) + 1` 迟早会漂移。 */
export const dayOfTick = (t: number): number => Math.floor(t / CHEN_PER_DAY) + 1;

/** 历法标签：月名 / 时辰名 / 时段名 / 纪年起点。缺省用中性占位。 */
export interface CalendarLabels {
  /** 12 个月名（缺省 '1月'..'12月'） */
  months?: readonly string[];
  /** 12 个时辰名（缺省 '时辰0'..'时辰11'） */
  shichen?: readonly string[];
  /** 时辰 → 时段名（场景展示用） */
  periodOf?: readonly string[];
  /** 开局纪年（缺省 1） */
  baseYear?: number;
  /** 每月几日（缺省 30，12 月一轮回） */
  daysPerMonth?: number;
}

const DEFAULT_MONTHS = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
const DEFAULT_SHICHEN = Array.from({ length: 12 }, (_, i) => `${i}`);
const DEFAULT_PERIODS = ['晨', '昼', '夜'];

/** 时钟依赖的世界最小面：状态信封的 t 与状态效果槽 */
export type ClockWorld = EngineWorldState;

/** 时辰边界上的同步钩子（宿主注入；宿主在此挂 World Director） */
export type HourTickHook<W extends ClockWorld> = (s: W) => void;

export interface WorldClockOptions<W extends ClockWorld> {
  /** 取当前世界状态（未开局时抛错） */
  need(): W;
  /** 历法标签（缺省中性历法） */
  labels?: CalendarLabels;
  /** 时辰边界钩子（先广播 hour_advanced，后调用——顺序与宿主一致） */
  onHourTick?: HourTickHook<W>;
  /** 事件总线（缺省全局缺省作用域；多世界隔离时传入本世界实例，V0.9） */
  bus?: WorldEventBus;
  /** 事件模式实例（缺省全局缺省作用域；id 序号随实例隔离） */
  events?: EventSchemaInstance;
}

export interface WorldClock<W extends ClockWorld> {
  /** 推进 n 刻：逐刻走衰减、日边界、时辰边界 */
  advance(n: number): void;
  /** 睡到天亮（下一个 morningShichen），至少推进 1 刻 */
  tillMorning(): void;
  /** 场景时间读数（day / month / date / hour / period / year） */
  sceneTime(s?: W): SceneTime;
  /** 时间戳（「X月X日·Y时」，见闻录条目用） */
  timeStr(s?: W): string;
  /** 季节名（月序 → 四季，12 月一轮回） */
  seasonName(s?: W): string;
  /** 本时钟生效的常量（换算只此一处） */
  readonly CHEN_PER_DAY: number;
  readonly DAYS_PER_YEAR: number;
}

export interface SceneTime {
  h: number;
  day: number;
  month: string;
  monthIndex: number;
  date: number;
  period: string;
  year: number;
}

/**
 * 一日三段（0 晨 / 1 昼 / 2 暮夜）：玩法上的时段分组，纯函数单一实现。
 * 与「渲染用四档时段」是两回事——它不是历法概念，不该与玩法分组互相牵制。
 */
export const periodSeg = (h: number): 0 | 1 | 2 => (h >= 2 && h <= 5 ? 0 : h >= 6 && h <= 8 ? 1 : 2);

/**
 * 世界级状态效果按时钟衰减。只递减带 left 的条目：
 * left 缺省 = 永久，直到被显式移除，这是 StatusEffect 的既有语义。
 */
function decayEffects(arr?: StatusEffect[]): void {
  if (!arr || !arr.length) return;
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    if (e.left === undefined) continue;
    e.left--;
    if (e.left <= 0) arr.splice(i, 1);
  }
}

function tickEffects(s: ClockWorld): void {
  decayEffects(s.player.effects);
  for (const dy of Object.values(s.npcs || {})) {
    if (dy.effects?.length) decayEffects(dy.effects);
  }
}

export function createWorldClock<W extends ClockWorld>(opts: WorldClockOptions<W>): WorldClock<W> {
  const need = opts.need;
  /* 缺省 = 全局缺省作用域（既有宿主零改动）；多世界隔离由 createWorld 传入本世界实例 */
  const bus = opts.bus ?? worldBus;
  const events = opts.events ?? defaultEventSchema;
  const months = opts.labels?.months ?? DEFAULT_MONTHS;
  const shichen = opts.labels?.shichen ?? DEFAULT_SHICHEN;
  const periods = opts.labels?.periodOf ?? DEFAULT_PERIODS;
  const baseYear = opts.labels?.baseYear ?? 1;
  const daysPerMonth = opts.labels?.daysPerMonth ?? 30;

  function sceneTime(s?: W): SceneTime {
    const state = s ?? need();
    const day = dayOfTick(state.t) - 1;
    const mi = Math.floor(day / daysPerMonth) % 12;
    const h = shichenOf(state.t);
    return {
      h,
      day: day + 1,
      month: months[mi],
      monthIndex: mi,
      date: (day % daysPerMonth) + 1,
      period: periods[h] ?? periods[periods.length - 1],
      year: baseYear + Math.floor(day / DAYS_PER_YEAR),
    };
  }

  function timeStr(s?: W): string {
    const t = sceneTime(s);
    return t.month + t.date + '日·' + (shichen[t.h] ?? String(t.h)) + '时';
  }

  function seasonName(s?: W): string {
    const state = s ?? need();
    /* 季节与月份同源取模，第 361 天起不再被兜成"永远是春" */
    return ['春', '春', '春', '夏', '夏', '夏', '秋', '秋', '秋', '冬', '冬', '冬'][
      Math.floor(Math.floor(state.t / CHEN_PER_DAY) / daysPerMonth) % 12
    ];
  }

  /* 日边界：时钟只发布「新的一天」这条事实并结算到期计划事件，
     日结算的顺序由订阅者（宿主的 daySettle 类插件）决定。 */
  function newDay() {
    const s = need();
    bus.beginTick(); // 日结算引发的事件风暴要计在当天，而不是上一天的尾巴
    bus.emit(events.makeEvent({ type: 'new_day', day: sceneTime(s).day, tick: s.t, level: events.levelOf('new_day') }));
    /* 到期计划事件：「2 小时后商会发现商人失踪」这类延迟后果在此落地。
       （新 tick 已开启，因此日结算的事件风暴计在当天。） */
    for (const pending of bus.due(sceneTime(s).day)) bus.emit(pending);
  }

  function advance(n: number) {
    for (let i = 0; i < n; i++) {
      const s = need();
      const hPrev = shichenOf(s.t);
      s.t++;
      tickEffects(s);
      if (s.t % CHEN_PER_DAY === 0) {
        newDay();
      } else if (shichenOf(s.t) !== hPrev) {
        /* 跨时辰的刷新走事件——时钟不直接调业务系统，只负责「推进时间 + 发布事实」。
           保留发布是刻意的：发布端不该因为此刻没人听就停止广播。
           派发是同步的，所以宿主钩子依旧排在这条广播之后执行。 */
        bus.emit(events.makeEvent({ type: 'hour_advanced', day: sceneTime(s).day, tick: s.t, level: events.levelOf('hour_advanced') }));
        opts.onHourTick?.(s);
      }
    }
  }

  function tillMorning(morningShichen = 3) {
    const s = need();
    let g = 0;
    while (shichenOf(s.t) !== morningShichen && g < CHEN_PER_DAY) {
      advance(1);
      g++;
    }
    /* 已在窗口内时上面一步都不推进——「睡到天亮」就成了零时间成本的全额恢复
       （可无限刷）。至少推进 1 刻：把这次歇脚的时间成本补上。 */
    if (g === 0) advance(1);
  }

  return {
    advance,
    tillMorning,
    sceneTime,
    timeStr,
    seasonName,
    CHEN_PER_DAY,
    DAYS_PER_YEAR,
  };
}

/* ============================================================
   时间系统（原型 §三：48 刻=1 日、12 月历法、季节与每日天气）

   ── 与世界书 §76 的有意偏离（阶段 K · 卡 T2，D3 已裁决）──
   世界书：1 日 = 12 时辰 × 8 刻 = 96 刻。
   本作：1 日 = 12 时辰 × 4 刻 = 48 刻。
   取 48 是发布期的既定数值（全部时耗、旅费天数、课程刻数按它标定），
   改 96 会让时耗整体翻倍并触发存档迁移，收益不足以抵消风险 → 维持 48。
   所有「一日」换算一律引用 CHEN_PER_DAY，禁止再写字面量 48。

   ──【World Engine 抽取】──
   **推进循环**（advance / tillMorning / 日边界 / 时辰边界 / 状态效果衰减 /
   计划事件结算）已抽入独立引擎；日结算只发布 new_day 事实、由
   plugins/daySettle 的订阅者按序响应的 §21 纪律原样保留在引擎里。
   留在这里的是**天穹的历法世界观**（月名 / 时辰名 / 时段名 / 纪年 612）
   与「时辰边界跑 World Director」的宿主钩子（onHourTick 注入，
   派发顺序不变：先广播 hour_advanced，后跑钩子）。
   ============================================================ */
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { need } from '@/world/WorldState';
import { directorTick } from '@/events/EventProcessor';
import { createWorldClock } from 'world-engine';

/* 刻/日/年的数值在 TimeBase（零依赖），此处转发——换算函数仍以本文件为唯一实现点。 */
export { CHEN_PER_DAY, DAYS_PER_YEAR, TICKS_PER_YEAR, START_AGE } from '@/world/TimeBase';
/* 时辰换算与日历换算的纯函数：唯一实现在引擎，这里保持既有导入路径 */
export { shichenOf, dayOfTick } from 'world-engine';

/** 每时辰几刻。shichenOf 与 UI 的「第 N 刻」都从这一处取——别再写第二个 4。 */
export const TICKS_PER_HOUR = 4;

/**
 * 一日三段：晨（破晓·拂晓·清晨·早晨，h=2..5）/ 昼（正午·午后，h=6..8）/ 暮夜（黄昏起，h=9..11,0,1）。
 * 引擎的取景句与 UI 的场景光色共用这一处分组——两处各写一套迟早分叉，
 * 表现就是「文字在说清晨、画面却是夜」。
 */
export const periodSeg = (h: number): 0 | 1 | 2 => (h >= 2 && h <= 5 ? 0 : h >= 6 && h <= 8 ? 1 : 2);

/**
 * 渲染用的四档时段（绘卷的光线随它变）。
 * 12 时辰归成 清晨/正午/黄昏/夜 四档——它不是历法概念，而是「画面上该是什么光」，
 * 所以刻意与 periodSeg（玩法上的三段）分开：两者将来各自演化，不该互相牵制。
 */
export type TimeOfDay = 'dawn' | 'noon' | 'dusk' | 'night';

export const timeOfDayOf = (h: number): TimeOfDay =>
  h >= 3 && h <= 4 ? 'dawn' : h >= 5 && h <= 7 ? 'noon' : h >= 8 && h <= 9 ? 'dusk' : 'night';

/* 世界时钟：推进循环来自引擎，历法标签与 Director 钩子是天穹的注入。
   模块加载即创建；need 在真正推进时才被调用（未开局照旧抛错）。 */
const clock = createWorldClock<WorldState>({
  need,
  labels: {
    months: WB.months,
    shichen: WB.shichen,
    periodOf: WB.periodOf,
    baseYear: 612,
    daysPerMonth: 30,
  },
  onHourTick: (s) => directorTick(s), // 卡 D4：World Director 扫触发（含因果链级联）
});

export function sceneTime(s: WorldState = need()) {
  return clock.sceneTime(s);
}

export function seasonName(s: WorldState = need()): string {
  return clock.seasonName(s);
}

export function timeStr(s: WorldState = need()): string {
  return clock.timeStr(s);
}

/** 原地等待 / 自动流逝的推进入口（§21：时钟只推进时间 + 发布事实） */
export function advance(n: number) {
  clock.advance(n);
}

export function tillMorning() {
  clock.tillMorning();
}

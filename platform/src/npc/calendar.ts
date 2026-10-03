/* ============================================================
   NPC Runtime · Calendar（P6 · 方案 §九：World Time 统一口径）
   ------------------------------------------------------------
   平台侧历法常量的唯一出处（此前 context / schedule 各自复制
   「1 日 = 48 刻」，漂移风险——审计遗留项 #12 的平台内收口）。

   与引擎的从属关系：时间是引擎的权威（TimeBase / WorldClock），
   平台经 HTTP 只读；跨包一致性由测试钉住（advance 48 刻 → 引擎
   日边界 new_day + day+1，见 tests/scheduler.test.ts）——不为此
   引入 platform → world-engine 的包依赖（平台与引擎保持进程边界）。
   ============================================================ */

/** 每日刻数（与引擎 TimeBase.CHEN_PER_DAY 同源同值；测试钉住） */
export const CHEN_PER_DAY = 48;

/** 日内刻：t → [0, 48) */
export function tickOfDay(t: number): number {
  return ((Math.floor(t) % CHEN_PER_DAY) + CHEN_PER_DAY) % CHEN_PER_DAY;
}

/** 天序号：t → 从 1 计 */
export function dayOfTick(t: number): number {
  return Math.floor(Math.floor(t) / CHEN_PER_DAY) + 1;
}

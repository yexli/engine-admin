/* ============================================================
   检定系统（原型 check()：d20 + 属性调整 + 雨天 -1，20 大成功）
   骰子计算委托 dice/DiceEngine 的 resolveCheck（§9/§10 统一随机入口）；
   本模块只负责「把结果演给玩家」——事件驱动检定卡 + 演出收束回调。
   判定式刻意保持原样（total >= dc || 自然 20 必成）：DiceEngine 的
   critical_failure 语义留给未来的调用方，不在本次接线中改变既有手感。
   ============================================================ */
import { bus, scheduler } from '@/events/EventBus';
import { resolveCheck } from './DiceEngine';
import { mod, stat } from '@/systems/character/Derived';
import { need } from '@/world/WorldState';
import { dayOfTick } from '@/world/WorldClock';
import type { StatName } from '@/types/world';

export interface CheckResult {
  ok: boolean;
  roll: number;
  total: number;
}

/** 检定序号（F-19）：并发检定下只有最新一次的收束可以关掉浮层 */
let checkSeq = 0;

/**
 * 已经掷过多少次骰（单调，跨档也不回退）。
 * 叙事编织用它判断「这一轮有没有掷骰」——掷骰轮的收益是 1450ms 后异步写回的，
 * 必须等一个窗口；没掷骰的操作当场就能织。
 * **不能用 s.checks.length**：那是环形缓冲，到 CHECK_TRACE_CAP 就封顶不再增长，
 * 到顶之后所有命令都会被判成「没掷骰」。
 */
export function checksRolled(): number {
  return checkSeq;
}

/** 检定留痕的上限（§44）：只保留最近若干次，别让存档被骰值撑大 */
const CHECK_TRACE_CAP = 30;

export function check(label: string, statName: StatName, dc: number, cb?: (r: CheckResult) => void, note?: string) {
  const s = need();
  const seq = ++checkSeq;
  const m = mod(statName, s);
  const r = resolveCheck({ type: label, attribute: stat(statName, s), difficulty: dc, modifier: m, weather: s.weather });
  /* 保留原型判定：自然 20 必成，其余按总值比难度 */
  const ok = r.total >= dc || r.roll === 20;
  /* §44：骰值是可追溯的事实之一——此前只发给 UI 的检定卡，查不回来。
     留痕走环形缓冲（只保留最近若干次），存档里因此答得出「这一下是怎么判的」。 */
  const rec = { label, stat: statName, mod: m, dc, roll: r.roll, total: r.total, ok, crit: r.roll === 20, day: dayOfTick(s.t), tick: s.t };
  s.checks = [...(s.checks ?? []), rec].slice(-CHECK_TRACE_CAP);
  bus.emit({
    type: 'check',
    desc: { label, statName, mod: m, dc, roll: r.roll, total: r.total, ok, crit: r.roll === 20, note },
  });
  scheduler.after(1450, () => {
    /* 演出收束：晚到的旧检定不得关掉新检定的浮层（回调各自执行，状态正确） */
    if (seq === checkSeq) bus.emit({ type: 'check', desc: null });
    cb?.({ ok, roll: r.roll, total: r.total });
  });
}

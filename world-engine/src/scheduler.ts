/* ============================================================
   定时器抽象（自宿主 EventBus 原样抽出，零行为偏差）
   检定演出 / 延迟落盘 / 计划回调用；测试可注入同步调度器。
   引擎不触碰 DOM——这里只用 setTimeout 这一个平台原语。
   ============================================================ */

type Timer = ReturnType<typeof setTimeout>;
const timers = new Set<Timer>();
let _scheduler: (ms: number, fn: () => void) => Timer = (ms, fn) => {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
  return t;
};

export const scheduler = {
  after: (ms: number, fn: () => void) => _scheduler(ms, fn),
  /** 注入立即执行的调度器（测试用，返回还原函数） */
  inject(fn: (ms: number, fn: () => void) => Timer) {
    const old = _scheduler;
    _scheduler = fn;
    return () => {
      _scheduler = old;
    };
  },
  cancelAll() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  },
};

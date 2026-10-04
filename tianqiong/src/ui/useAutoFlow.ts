/* ============================================================
   自动流逝（E2 原型的同款开关：每 1.6 秒推进 1 刻）
   ------------------------------------------------------------
   三条边界，缺一不可：
   1) 忙碌时不提交——检定卡、对话/商店浮层、战斗、意图解析与叙事编织期间推进时间，
      会把玩家正在读的那一屏从底下换掉（与原型同一处守卫，
      也与 GameShell 的横滑手势用同一套判据）；
   2) 走命令链而不是直接推时钟——见 WorldRuntime 的 wait 分支：
      dispatch 入口重置 §31 的事件风暴配额、出口统一 sync()，
      绕过它会让事件跨 tick 累积且界面不刷新；
   3) 离开游戏屏即清定时器——不留无主定时器（与 F-25 同规矩）。
   ============================================================ */
import { useEffect } from 'react';
import { core } from '@/world';
import { useGame } from '@/store/useGame';

/** 原型 outputs/中栏原型-E2日晷.html 的节奏：1.6 秒 = 1 刻（一日 48 刻 ≈ 77 秒） */
export const AUTO_FLOW_MS = 1600;

export function useAutoFlow() {
  const autoFlow = useGame((s) => s.autoFlow);
  const screen = useGame((s) => s.screen);
  const running = autoFlow && screen === 'game' && !!core.S;

  /* 离开游戏屏（回扉页 / 重置世界）自动归零——与原型每次 start() 都把开关复位一致。
     挂在 screen 上而不是绑在「重置世界」按钮的 onClick 上：
     那颗按钮只弹二次确认，点「取消」不该把表停掉。 */
  useEffect(() => {
    if (autoFlow && screen !== 'game') useGame.getState().setAutoFlow(false);
  }, [autoFlow, screen]);

  useEffect(() => {
    if (!running) return;
    let id: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      const st = useGame.getState();
      /* weaveFrom 也要停（BUG-004 · 2026-09-29 实测）：编织是一次完整的 LLM 往返，
         常跑好几秒。守卫漏了它，被拒的行动（「无法直接前往」零消耗）也会在
         润色期间白走 6 刻——「我只是转身就走，怎么天都快黑了」。 */
      if (st.check || st.sheet || st.combatOpen || st.freeBusy || st.weaveFrom !== null) return;
      st.cmd({ type: 'wait', ticks: 1 });
    };
    const start = () => {
      if (id === null) id = setInterval(tick, AUTO_FLOW_MS);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };

    /* 文档不可见 = 玩家没在看，此时真停表而不是空转。
       原实现里时间只在玩家操作时推进，所以最小化窗口不该让世界自己走——
       实测切走 5.2 秒会白走 3 刻，跨日还连带触发一次日结算（5 条 history + 6 条 log）。
       浏览器 tab 有节流兜底，但 Tauri 的 WebView2 不保证，所以按可见性自己管。
       切回来从头计时，不补算隐藏期间该走的刻数——那些时间玩家并不在场。 */
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [running]);
}

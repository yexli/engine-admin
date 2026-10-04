import { useEffect, useRef, useState, type MouseEvent as RMouseEvent, type TouchEvent as RTouchEvent } from 'react';
import { world } from '@/world';
import { useGame, type PanelTab } from '@/store/useGame';

/* 移动端底部标签栏（原型 #tabbar 1:1；任务角标=有可复命任务）
   卡 P1 增量：长按 500ms → tooltip（useLongPress）+ :active 缩放反馈（见 fx.css §4）。
   TABS 同时导出给 GameShell 做横滑手势的**唯一面板顺序源**，避免两处硬编码。

   卡 P2：这里从前与 GameShell 的 SR_TABS **各写一份**，于是集合漂移——
   桌面有「纪闻/档案」而移动端两个都没有，手机玩家根本看不到它们。
   现在七个页面只声明一次，两处按标记取子集。 */
export interface PanelTabDef {
  id: PanelTab;
  ic: string;
  lb: string;
  hint: string;
  /** 移动端底部标签栏是否显示 */
  mobile: boolean;
  /**
   * 桌面顶栏导航是否显示。
   * 落盘改名：此前叫 desk，语义是「桌面右侧栏」——面板从常驻右栏改成导航点开的浮层之后，
   * 右侧栏不存在了，这个标记实际管的是顶栏，留着旧名会让下一个读代码的人误判。
   */
  nav: boolean;
}

export const PANEL_TABS: PanelTabDef[] = [
  /* 落盘（甲·刻度）：世界从「只在移动端有」改成顶栏也有一项——
     它不是新增的页，是原本就有的 main，此前桌面靠点空白/ESC 回来，现在有了固定入口。 */
  { id: 'main', ic: '◈', lb: '世界', hint: '世界 · 场景叙事与行动坞', mobile: true, nav: true },
  /* desk 的含义在面板改成浮层之后变了：从前指"桌面右侧栏是否显示"，
     现在顶栏按它取项——所以 main / char 都已改为 true。 */
  { id: 'char', ic: '☯', lb: '角色', hint: '角色 · 属性 / 技能 / 背包', mobile: true, nav: true },
  { id: 'quest', ic: '卍', lb: '任务', hint: '任务 · 委托进度与复命', mobile: true, nav: true },
  { id: 'news', ic: '✉', lb: '纪闻', hint: '纪闻 · 事件余波与势力外交', mobile: true, nav: true },
  { id: 'chronicle', ic: '❖', lb: '档案', hint: '档案 · 世界史与大事记', mobile: true, nav: true },
  { id: 'map', ic: '⌖', lb: '地图', hint: '地图 · 已探地点与远行', mobile: true, nav: true },
  { id: 'sys', ic: '✦', lb: '系统', hint: '系统 · 存档 / 导入导出 / AI 网关', mobile: true, nav: true },
];

/** 移动端底部标签栏的页面（顺序即横滑手势的顺序） */
export const TABS: [PanelTab, string, string, string][] = PANEL_TABS.filter((t) => t.mobile).map((t) => [t.id, t.ic, t.lb, t.hint]);
/* DESK_TABS 已随「桌面右侧栏」一起退役：面板由顶栏导航点开，
   导航项直接按 nav 标记从 PANEL_TABS 取（见 ui/TopBar.tsx），不再有第二份集合。 */

/* ============================================================
   useLongPress —— 移动端手感共享原语（卡 P1）
   · 按下满 500ms 在触点上方弹出 tooltip，1.8s 后自动收起；
   · 触摸/鼠标通用；移动、抬起、取消、离开只撤销"未满 500ms 的按压判定"（防误触），
     已弹出的 tooltip 仍按自己的 1.8s 计时收起（两套计时互不干扰）；
   · consume() 让调用方在长按后吞掉紧随其后的 click，
     避免"长按看说明"顺手把面板也切了；
   · 定义在 TabBar 内是本卡约束下的取舍：只允许新建 styles/fx.css，
     不能新增 ts 文件，而 TopBar / TabBar 需要同一份实现（无循环依赖）。
   ============================================================ */
export function useLongPress(ms = 500) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const press = useRef<number | null>(null); // 长按判定计时
  const hide = useRef<number | null>(null); // tooltip 自动收起计时（**独立**于按压判定）
  const fired = useRef(false);
  /* 只撤销"还没满 500ms 的按压"——不能连自动收起一起撤销，
     否则松手时会把隐藏在 1.8s 后的定时器清掉，tooltip 永久留在屏上。 */
  const cancelPress = () => {
    if (press.current !== null) {
      clearTimeout(press.current);
      press.current = null;
    }
  };
  const closeTip = () => {
    if (hide.current !== null) {
      clearTimeout(hide.current);
      hide.current = null;
    }
    setTip(null);
  };
  useEffect(
    () => () => {
      cancelPress();
      if (hide.current !== null) clearTimeout(hide.current);
    },
    [],
  );
  const start = (x: number, y: number, text: string) => {
    cancelPress();
    closeTip(); // 新的一次按压先收掉上一次的 tooltip
    press.current = window.setTimeout(() => {
      press.current = null;
      fired.current = true;
      setTip({ x, y: y - 10, text });
      if (typeof navigator.vibrate === 'function') navigator.vibrate(10);
      hide.current = window.setTimeout(() => {
        hide.current = null;
        setTip(null);
      }, 1800);
    }, ms);
  };
  /** 长按是否刚刚触发（消费一次）——用于吞掉长按尾随的 click */
  const consume = () => {
    const v = fired.current;
    fired.current = false;
    return v;
  };
  const bind = (text: string) => ({
    onTouchStart: (e: RTouchEvent) => {
      const t = e.touches[0];
      if (t) start(t.clientX, t.clientY, text);
    },
    onTouchEnd: cancelPress,
    onTouchMove: cancelPress,
    onTouchCancel: cancelPress,
    onMouseDown: (e: RMouseEvent) => start(e.clientX, e.clientY, text),
    onMouseUp: cancelPress,
    onMouseLeave: cancelPress,
    onContextMenu: (e: RMouseEvent) => e.preventDefault(),
  });
  return { tip, bind, consume };
}

export function TabBar() {
  const curTab = useGame((s) => s.curTab);
  const setTab = useGame((s) => s.setTab);
  const S = world.query.get_world_state()!;
  const hasDone = Object.values(S.player.quests).some((q) => q.stage === 'done');
  const { tip, bind, consume } = useLongPress();
  return (
    <nav id="tabbar" role="tablist" aria-label="主面板">
      {TABS.map(([t, ic, lb, hint]) => (
        <button
          key={t}
          role="tab"
          aria-selected={curTab === t}
          className={curTab === t ? 'on' : ''}
          onClick={() => {
            if (consume()) return; // 长按只在看 tooltip，不切面板
            setTab(t);
          }}
          {...bind(hint)}
        >
          <span className="ic">{ic}</span>
          <span className="lb">{lb}</span>
          {t === 'quest' && <span className="bdg" style={{ display: hasDone ? '' : 'none' }} />}
        </button>
      ))}
      {tip && (
        <span className="fx-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </span>
      )}
    </nav>
  );
}

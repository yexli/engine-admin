import { useEffect, useRef, type TouchEvent as RTouchEvent } from 'react';
import { useGame } from '@/store/useGame';
import { TopBar } from './TopBar';
import { TABS, TabBar } from './TabBar';
import { SceneView } from './SceneView';
import { SceneStage } from './SceneStage';
import { HudCard } from './HudCard';
import { ActionDock } from './ActionDock';
import { Composer } from './Composer';
import { PanelOverlay } from './PanelOverlay';
import { useDesk } from './useDesk';
import { BagOverlay } from './overlays/BagOverlay';

/* ============================================================
   游戏主界面骨架（方案 B「雾港」1:1）
   ------------------------------------------------------------
   版式契约（三行 flex，不用绝对定位承托正文）：
     [顶栏]  [主体：HUD 列 | 叙事]  [动作坞]  [输入条]  [移动端标签栏]
   绘卷（SceneStage）铺满整个屏当背景，以上全部浮在画上。

   两处结构变更，都是 B 的定义：
   ① 面板不再是常驻的右栏，而是导航点开的浮层（PanelOverlay）——
      B 只有两栏。桌面与移动端因此收敛成同一套行为，不再有双路径。
   ② 动作坞与输入条从叙事流里摘出、固定到底部——它们是玩家最常碰的两处，
      不该跟着正文滚出屏幕。

   卡 P1 横滑切面板保留：只调用与 TabBar 点击同一条 setTab，不另开逻辑。
   ============================================================ */
export function GameShell() {
  const desk = useDesk();
  const curTab = useGame((s) => s.curTab);
  const setTab = useGame((s) => s.setTab);
  const combatOpen = useGame((s) => s.combatOpen);
  const bagOpen = useGame((s) => s.bagOpen);
  const sheet = useGame((s) => s.sheet);

  /* 底部固定区（动作坞 + 输入条 + 标签栏）的总高写进 --bot-h。
     运行日志悬浮按钮（.rl-fab）原先按"标签栏 52px"硬编码让位；底部栏变成三层之后，
     它正好落在自由行动的提交键上——430 / 900 / 1000 三种视口实测重叠，点提交会打开日志面板。
     高度是内容决定的（动作坞会换行、战斗时整条收起），所以只能量出来再让。 */
  useEffect(() => {
    const root = document.documentElement;
    const measure = () => {
      let h = 0;
      for (const id of ['dock', 'composer', 'tabbar']) {
        const el = document.getElementById(id);
        if (el) h += el.getBoundingClientRect().height;
      }
      root.style.setProperty('--bot-h', Math.round(h) + 'px');
      /* 顶栏高度同理：面板层从它下沿开始铺开（落盘第 1 片），
         而它是内容决定的——导航换行、时辰戳变长都会改高度，量出来再让。 */
      const top = document.getElementById('top-b');
      if (top) root.style.setProperty('--top-h', Math.round(top.getBoundingClientRect().height) + 'px');
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const id of ['dock', 'composer', 'tabbar', 'top-b']) {
      const el = document.getElementById(id);
      if (el) ro.observe(el);
    }
    window.addEventListener('resize', measure);
    /* 字体落地会改变文字高度，而字体加载不触发 resize */
    document.fonts?.ready.then(measure).catch(() => {});
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [curTab, combatOpen]);

  /* 视图标记（落盘第 0 片）：面板打开时把「世界那一层」整体让出去。
     面板从居中窄窗改成铺满之后，去掉 blur 就会让 HUD 与叙事列直接透上来与页面叠着
     （实测见 outputs/整合稿-落盘分析.md）。用 display 而不是卸载——
     叙事滚动位置与 HUD 状态原样留着，切回世界接着看。规则在 shell.css。 */
  useEffect(() => {
    /* 行囊是浮层不是页（curTab 仍是 main），但世界那一层同样要让位——
       它是半透明压暗，不让位就会看到输入条与叙事从行囊底下透出来（实测踩到）。 */
    document.body.dataset.view = bagOpen ? 'bag' : curTab;
  }, [curTab, bagOpen]);

  /* sheet（对话 / 商店 / 抉择 / 各菜单）的遮罩只有 65% 黑，且它从任意一页都能打开：
     底下若还立着那一页，两个页头两套内容会叠着读。单独给它一个标记，
     只让面板让位——世界层不能动，对话本来就该浮在绘卷上。 */
  useEffect(() => {
    document.body.dataset.sheet = sheet ? '1' : '';
  }, [sheet]);

  /* 换页收行囊已收编进 setTab（store）：任何换页意图——含点当前页的导航——
     都会在那一处关掉行囊。这里只管角色页的两个子面板（培养学院 / 万神殿）：
     它们是全局状态，会把整页换掉——进去之后切走、再切回角色，看到的还是那个
     子面板，而它里面没有别的入口，于是"页面切不过去"（实测复现）。换页就收掉。 */
  const prevTab = useRef(curTab);
  useEffect(() => {
    if (prevTab.current === curTab) return;
    prevTab.current = curTab;
    const st = useGame.getState();
    if (st.h6Panel) st.setH6Panel(null);
  }, [curTab]);

  const swipe = useRef<{ x: number; y: number; ok: boolean } | null>(null);
  const SWIPE_X = 60;
  const SWIPE_Y = 40;
  const onTouchStart = (e: RTouchEvent<HTMLElement>) => {
    const t = e.touches[0];
    if (!t) return;
    const el = e.target as HTMLElement | null;
    const st = useGame.getState();
    const busy = !!st.sheet || !!st.check || st.combatOpen || st.bagOpen;
    const blocked = !!el?.closest('.dip-scroll,input,textarea,select');
    swipe.current = { x: t.clientX, y: t.clientY, ok: !busy && !blocked };
  };
  const onTouchEnd = (e: RTouchEvent<HTMLElement>) => {
    const s0 = swipe.current;
    swipe.current = null;
    if (!s0 || !s0.ok || desk) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - s0.x;
    const dy = t.clientY - s0.y;
    if (Math.abs(dx) < SWIPE_X || Math.abs(dy) >= SWIPE_Y || Math.abs(dx) <= Math.abs(dy) * 2) return;
    const order = TABS.map(([name]) => name);
    const next = order[order.indexOf(curTab) + (dx < 0 ? 1 : -1)];
    if (!next) return;
    setTab(next);
    if (typeof navigator.vibrate === 'function') navigator.vibrate(8);
  };

  return (
    <>
      {/* 全幅绘卷：所有内容浮在它上面 */}
      <SceneStage />
      <TopBar />
      <div id="wrap">
        <HudCard />
        <main id="story" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div id="view-inner">
            <SceneView />
          </div>
        </main>
      </div>

      {/* 固定底部：能做的事与能写的话，永远在触手可及的位置。
          战斗中整条收起——战斗面板自带操作台，那时露出的「星符·入星枢 / 百年神选」
          既是噪声也会被误点（实测战斗浮层并不盖住底部，那些按钮仍是 enabled）。
          宽屏时这里什么都不渲染（动作在左栏的 .side 里），只有窄屏才落到底部横排。 */}
      <ActionDock show={curTab === 'main'} variant="dock" />
      {!combatOpen && <Composer />}
      <TabBar />

      {/* 面板浮层（B 的 sheet）：非「世界」页时铺上来 */}
      <PanelOverlay />

      {/* 行囊浮层（方案 A）：常挂在外壳上，由 store 的 bagOpen 控制显隐 */}
      <BagOverlay />
    </>
  );
}

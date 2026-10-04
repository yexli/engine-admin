import { useEffect, type ReactNode } from 'react';
import { useGame, type PanelTab } from '@/store/useGame';
import { CharPanel } from './panels/CharPanel';
import { QuestPanel } from './panels/QuestPanel';
import { MapPanel } from './panels/MapPanel';
import { NewsPanel } from './panels/NewsPanel';
import { ChroniclePanel } from './panels/ChroniclePanel';
import { SysPanel } from './panels/SysPanel';
import { AcademyPanel, useH6Panel } from './panels/AcademyPanel';
import { DeityPanel } from './panels/DeityPanel';

/* ============================================================
   面板浮层（方案 B：面板是"导航点开的一张纸"，不是常驻的第三栏）
   ------------------------------------------------------------
   原型 B 只有两栏——HUD 与叙事——其余面板都由顶栏导航开浮层。
   落地沿用：桌面与移动端因此收敛成同一套行为，不再有"桌面塞进右栏、
   移动端切成 Tab"的双路径（那正是卡 P2 修复的集合漂移的温床）。

   「页 id → 组件」的映射在这里，且只在这里（原在 GameShell）。
   键写成显式字符串而不是落进 else 兜底：兜底会让新增一页"悄悄有归宿"，
   而卡 P3 那条护栏要的正是"每一页都真的被指派过"。
   ============================================================ */
const TITLE: Record<string, [string, string]> = {
  char: ['角色', '属性 / 技能 / 装备'],
  quest: ['委托', '任务进度与复命'],
  news: ['纪闻', '事件余波与势力外交'],
  chronicle: ['档案', '世界史与大事记'],
  map: ['行止', '已探地点与远行'],
  sys: ['系统', '存档 / 导入导出 / AI 网关'],
};

export function PanelOverlay() {
  const curTab = useGame((s) => s.curTab);
  const setTab = useGame((s) => s.setTab);
  const sheet = useGame((s) => s.sheet);
  const bagOpen = useGame((s) => s.bagOpen);
  const h6 = useH6Panel();
  /* 换页是「一天几十次」级的高频动作，规格只做最轻的一档：180ms 淡入、不动位置。
     用 WAAPI 而不是 CSS 类——同一个元素上的"挂载动画"与"换页动画"若都写在 CSS 里，
     要么同名不重放、要么异名时互相顶掉（实测会连播两次淡入，中间那截半透明窗口
     还把底下的画面透上来）。WAAPI 是命令式的，播一次就是一次。
     起点从 .55 起：半透明留得越久，底下的绘卷越会"花"上来。
     顺带把正文滚回顶部——否则从长页切到短页会停在上一次的滚动位置上。 */
  useEffect(() => {
    if (curTab === 'main') return;
    const body = document.querySelector('.pnl-body');
    if (body) body.scrollTop = 0;
    const el = document.querySelector<HTMLElement>('#pnl-ovl .sheet');
    el?.animate?.([{ opacity: 0.55 }, { opacity: 1 }], {
      duration: 180,
      easing: 'cubic-bezier(.22,1,.36,1)',
    });
  }, [curTab]);

  /* ESC 关面板。要避开更高层的浮层：对话 / 行囊 / 战斗各自处理自己的 ESC，
     面板不能抢——否则按下关掉的是下面那一层，玩家只会觉得"没反应"。
     另外关闭入口只剩这一个加顶栏：点空白那条在原实现里依赖 .sheet 不铺满，
     现在它铺满整屏了，那条路径已经自然失效。 */
  useEffect(() => {
    /* 有更高层浮层时干脆不挂监听：一次 ESC 只该关一层。
       若改成"在处理器里判断"，同一次按键会先关掉 sheet、紧接着处理器里的
       getState() 已经看不到它，于是面板也一起关了（实测踩到）。 */
    if (curTab === 'main' || sheet || bagOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setTab('main');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [curTab, setTab, sheet, bagOpen]);

  if (curTab === 'main') return null;

  /* 卡 H6：学院 / 万神殿是**角色页的子面板**——入口卡挂在角色页，
     渲染槽就必须在同一页，否则点了没反应。 */
  const charSlot: ReactNode =
    h6 === 'academy' ? <AcademyPanel /> : h6 === 'deity' ? <DeityPanel /> : <CharPanel />;

  const PANEL_OF: Record<string, () => ReactNode> = {
    'char': () => charSlot,
    'quest': () => <QuestPanel />,
    'news': () => <NewsPanel />,
    'chronicle': () => <ChroniclePanel />,
    'map': () => <MapPanel />,
    'sys': () => <SysPanel />,
  };

  const render = PANEL_OF[curTab];
  if (!render) return null;
  const [title, sub] = TITLE[curTab as PanelTab] ?? ['面板', ''];

  return (
    <div id="pnl-ovl" onClick={(e) => e.target === e.currentTarget && setTab('main')}>
      <div className="sheet" role="dialog" aria-label={title}>
        <div className="sh-head">
          <div className="sh-t">
            <b>{title}</b>
            <span>{sub}</span>
          </div>
          {/* 2026-09-29：补一个明确的关闭钮。回程入口（顶栏「世界」/窄屏底栏/ESC）
              一直都在，但移动端没有 ESC，首次打开面板的玩家找不到"怎么退出去"
              （实测卡在角色页）。与 NPC 对话浮层的 ✕ 同款语义，六页共用。 */}
          <button
            type="button"
            className="sh-close"
            aria-label="关闭面板"
            onClick={() => setTab('main')}
          >
            ✕
          </button>
        </div>
        <div className="pnl-body">{render()}</div>
      </div>
    </div>
  );
}

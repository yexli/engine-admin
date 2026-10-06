import { WB } from '@/data/worldBook';
import { sceneTime, world } from '@/world';
import { TICKS_PER_HOUR } from '@/world/WorldClock';
import { PANEL_TABS } from './TabBar';
import { useGame } from '@/store/useGame';

/* ============================================================
   顶栏（方案 B 定稿 · DOM 与类名逐字对齐原型 #top-b）
   ------------------------------------------------------------
   [品牌] [时辰戳] [地名居中撑满] [导航胶囊]。
   日晷盘、状态胶囊、资源条全部移入左列 HUD——B 把「我是什么状态」收进左列，
   顶栏只回答「我在哪、什么时候」。金币也不在这里，它在 HUD 的 badges 里。

   读面切换（脱离内置引擎方案 Phase 2）：外部引擎开关打开、连接在线且
   镜像水位就绪时，「现在几点、我在哪」读**引擎镜像**（数值由引擎裁定，
   Cache ≠ Truth，同步桥保证收敛）；时辰名/地名文案仍是天穹的表现资产
   （方案 §12 的边界：数值归引擎，显示归客户端）。开关关闭或水位未就绪
   = 与现状逐字节相同。

   导航 = PANEL_TABS 一处声明、两处排布（顶栏 + 移动端标签栏）：
   项目在卡 P2 吃过集合漂移的亏（桌面有「纪闻/档案」而移动端没有），
   所以不在这里另写一份面板清单。
   ============================================================ */
export function TopBar() {
  const S = world.query.get_world_state()!;
  const ext = useGame((s) => s.extWorld);
  const extReady = ext.enabled && ext.status === 'online' && ext.tick !== null && ext.playerLoc !== null;
  const t = extReady ? { day: ext.day ?? 1, h: Math.floor(((ext.tick ?? 0) % 48) / TICKS_PER_HOUR) } : sceneTime(S);
  const locId = extReady && WB.locations[ext.playerLoc!] ? ext.playerLoc! : S.player.loc;
  const L = WB.locations[locId];
  const curTab = useGame((s) => s.curTab);
  const setTab = useGame((s) => s.setTab);
  const setBag = useGame((s) => s.setBag);
  const bagOpen = useGame((s) => s.bagOpen);

  const tickInHour = (extReady ? (ext.tick ?? 0) : S.t) % TICKS_PER_HOUR;
  const shichen = WB.shichen[t.h];

  return (
    <header id="top-b">
      <span className="brand">天穹纪元</span>
      <span className="stamp">
        第 {t.day} 日 · {shichen}时 {tickInHour + 1}刻
      </span>
      <div className="loc">
        <span className="nm">{L.name}</span>
        <small>{L.area}</small>
      </div>
      <nav className="nav">
        {/* 落盘（甲·刻度）：导航项不再在组件里手写过滤，一律按 PANEL_TABS 的 desk 标记取——
            行囊是浮层不是页（它靠 bagOpen 开关），所以单独插在「角色」之后，
            窄屏只留它一个的规则见 shell.css 的 820px 段。 */}
        {PANEL_TABS.filter((x) => x.nav).flatMap((x) => {
          /* 行囊开着时，页面的高亮要让出去：它是个盖在页面上的浮层，
             底下那一项仍亮着金线，会让人以为"我在角色页"而没注意行囊已经开了。 */
          const btn = (
            <button
              key={x.id}
              className={curTab === x.id && !bagOpen ? 'on' : ''}
              onClick={() => setTab(x.id)}
            >
              {x.lb}
            </button>
          );
          return x.id === 'char'
            ? [
                btn,
                /* 行囊是浮层不是页，所以它有自己的一条开关逻辑：
                   打开时给自己上「当前」标记，再点一次收起（点开的东西点一下就关，
                   这是玩家对同一枚按钮的直觉）。 */
                <button
                  key="bag"
                  className={'bag' + (bagOpen ? ' on' : '')}
                  onClick={() => setBag(!bagOpen)}
                >
                  行囊
                </button>,
              ]
            : [btn];
        })}
      </nav>
    </header>
  );
}

import { core } from '@/world';
import { useGame } from '@/store/useGame';
import { StarField } from './ui/StarField';
import { TitleScreen } from './ui/TitleScreen';
import { CreateScreen } from './ui/CreateScreen';
import { GameShell } from './ui/GameShell';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { SheetHost } from './ui/overlays/SheetHost';
import { CheckOverlay } from './ui/overlays/CheckOverlay';
import { CombatOverlay } from './ui/overlays/CombatOverlay';
import { DungeonOverlay } from './ui/overlays/DungeonOverlay';
import { ToastHost } from './ui/overlays/ToastHost';
import { RunLogPanel } from './ui/overlays/RunLogPanel';
import { ExtWorldBadge } from './ui/overlays/ExtWorldBadge';
import { useAutoFlow } from './ui/useAutoFlow';

export default function App() {
  const screen = useGame((s) => s.screen);
  useGame((s) => s.rev); // WorldState 变更 → 全树重渲染（原型 renderAll 等价）
  /* 自动流逝挂在这里而不是 GameShell：它要感知 screen 变化，
     离开游戏屏就得停表，而 GameShell 那时已经卸载了。 */
  useAutoFlow();
  const inGame = screen === 'game' && !!core.S;
  return (
    /* F-22：全站错误边界——任一面板抛错显示兜底页（导出/重置），不再白屏 */
    <ErrorBoundary>
      <StarField />
      <div id="app">
        <section className={'scr' + (screen === 'title' ? ' on' : '')} id="scr-title">
          {/* F-24：标题页改条件渲染——原实现常驻挂载，每次都随 rev 重渲染并整份 JSON.parse 存档 */}
          {screen === 'title' && <TitleScreen />}
        </section>
        <section className={'scr' + (screen === 'create' ? ' on' : '')} id="scr-create">
          {screen === 'create' && <CreateScreen />}
        </section>
        <section className={'scr' + (inGame ? ' on' : '')} id="scr-game">
          {inGame && <GameShell />}
        </section>
      </div>
      <SheetHost />
      <CheckOverlay />
      <CombatOverlay />
      <DungeonOverlay />
      <ToastHost />
      {/* 外部 World Engine 连接指示器（开关打开时才渲染，见 ExtWorldBadge） */}
      <ExtWorldBadge />
      {/* 开发观测面板：默认收起，Ctrl+Shift+L 打开；未启用运行日志时不渲染 */}
      <RunLogPanel />
    </ErrorBoundary>
  );
}

/* ============================================================
   切屏复位（F-16 的补漏）
   ------------------------------------------------------------
   回归现场：在系统页点「重置世界（回到扉页）」→ 点「开启新的旅程」→
   新世界一进来就顶着设置面板。原因是 screen 事件复位了 sheet / combatOpen /
   h6Panel / bagOpen 一长串，唯独漏了 curTab —— 而 curTab 恰恰是浮层的开关。
   这一份把它钉住：换档/换屏必须回到主视图。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus } from '@/world';
import { attachCoreBridge, useGame } from '@/store/useGame';

let off: (() => void) | null = null;
beforeEach(() => {
  off = attachCoreBridge();
});
afterEach(() => {
  off?.();
  off = null;
});

describe('切屏即复位（F-16）', () => {
  it('从设置页重置再开新档：浮层不能跟着跨档', () => {
    useGame.setState({
      curTab: 'sys',
      srTab: 'chronicle',
      h6Panel: 'academy',
      bagOpen: true,
      combatOpen: true,
      sheet: { kind: 'talk', npc: 'lita' } as never,
    });

    bus.emit({ type: 'screen', to: 'title' });   // 重置世界 → 扉页
    expect(useGame.getState().curTab, '回扉页后不该还停在设置页').toBe('main');
    expect(useGame.getState().srTab).toBe('quest');
    expect(useGame.getState().h6Panel).toBeNull();
    expect(useGame.getState().bagOpen).toBe(false);
    expect(useGame.getState().combatOpen).toBe(false);
    expect(useGame.getState().sheet).toBeNull();

    bus.emit({ type: 'screen', to: 'game' });    // 开启新的旅程 → 新世界
    expect(useGame.getState().curTab, '新世界必须落在主视图').toBe('main');
  });

  it('游戏内切页签不经 screen 事件，切屏不会误伤', () => {
    bus.emit({ type: 'screen', to: 'game' });
    useGame.getState().setTab('map');
    expect(useGame.getState().curTab).toBe('map');
  });

  it('行囊开着时的换页意图（含点当前页）一律收行囊', () => {
    /* 回归现场：行囊开着时 data-view='bag' 的让位规则把 #pnl-ovl 整个 display:none，
       旧的"换页才收"逻辑以 curTab 变化为前提——点**当前页**的导航时它早退，
       行囊卡死在屏上，view 停在 'bag'，看起来就是"页面切不过去"。 */
    bus.emit({ type: 'screen', to: 'game' });
    useGame.setState({ curTab: 'main', bagOpen: true });
    useGame.getState().setTab('main'); // 同页导航：必须也收
    expect(useGame.getState().bagOpen, '同页导航也要收行囊').toBe(false);

    useGame.setState({ curTab: 'char', bagOpen: true });
    useGame.getState().setTab('quest'); // 跨页导航：收囊 + 换页
    expect(useGame.getState().bagOpen).toBe(false);
    expect(useGame.getState().curTab).toBe('quest');
  });
});

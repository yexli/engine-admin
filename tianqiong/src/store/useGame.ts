/* ============================================================
   Zustand UI 层（§5）：只做「客户端 UI 状态 + WorldState 快照信号」。
   权威状态永远在 GameCore 的 WorldState —— UI 通过 rev 重渲染、
   通过 cmd() 发 GameCommand，绝不直接改 S。
   ============================================================ */
import { create } from 'zustand';
import { bus, core, world } from '@/world';
import type { ExtWorldReport } from '@/plugins/extSession';
import type { CheckDesc, GameCommand, SheetDesc, ToastDesc } from '@/types/uispec';

export type ScreenName = 'title' | 'create' | 'game';

/** AI 流式草稿（core 的 aidraft 事件）：channel 决定它该显示在哪儿 */
export interface AiDraft {
  channel: string | null;
  /** chat / greet 通道的草稿属于哪个 NPC */
  npcId?: string;
  text: string;
}

/**
 * 全部面板页（卡 P2）。
 * 从前这里是**两份不同的集合**：移动端 TabName 有 main/char 没有 news/chronicle，
 * 桌面 SrTabName 反过来——于是手机玩家根本看不到「纪闻」与「档案」。
 * 现在一页只有一个 id，两处排布按 PANEL_TABS 的标记取子集（见 ui/TabBar.tsx）。
 */
export type PanelTab = 'main' | 'char' | 'quest' | 'news' | 'chronicle' | 'map' | 'sys';
export type TabName = PanelTab;
export type SrTabName = PanelTab;

interface GameState {
  rev: number; // WorldState 变更计数（驱动重渲染）
  /** 日志条目累计数镜像（F-42）：主视图不再直接读 core 的模块级变量，
      从而不依赖"App 订阅 rev 导致全树重渲染"这一隐式前提 */
  logSeq: number;
  screen: ScreenName;
  curTab: TabName;
  srTab: SrTabName;
  cSel: { race: string; cls: string };
  sheet: SheetDesc | null;
  check: CheckDesc | null;
  combatOpen: boolean;
  combatRev: number;
  /** LLM 场景叙事缓存（key = loc:day；text=null 表示生成中） */
  aiNarr: { key: string; text: string | null };
  /** 自由行动意图解析中（F-14：由 core 的 freeBusy 事件驱动） */
  freeBusy: boolean;
  /** 自由输入攀谈：对方正在斟酌回话（null = 没有人在沉吟 / 回话已落地）。
      只喂输入框的占位提示，不是状态——台词由 chatAsync 返回值落地。 */
  npcMusing: string | null;
  /** 叙事编织进行中的起始 seq（null=没有待润色的批次）。
      润色期间这一批见闻**先不显示**，等 AI 织成小说段再出现；
      没配模型时 core 根本不发这个事件，原文照常即时显示。 */
  weaveFrom: number | null;
  /**
   * AI 流式草稿（只在「流式输出」开启时出现）：模型此刻吐到哪儿了。
   * 它只喂「正在书写 / 沉吟着」那一处显示——**不是状态**，不参与任何判定；
   * 最终正文仍由各通道返回值经 mutate 落地，草稿丢了最多少个逐字效果。
   * 关掉流式时它恒为 null，行为与这个功能不存在时一样。
   */
  aiDraft: AiDraft | null;
  /** 自动流逝开关（E2 原型同款）：开着时每 1.6 秒提交一条 wait 命令 */
  autoFlow: boolean;
  /** 卡 H6 系统槽位子面板（F-16：并进 store——原模块级微状态是 store 之外的第二事实源） */
  h6Panel: 'academy' | 'deity' | null;
  /**
   * 行囊浮层开关（方案 A 落地）。
   * 为什么是独立状态而不是 SheetDesc 的一种 kind：sheet 是 **core 发出的事件描述符**
   * （对话/商店/抉择都由 core 决定何时弹出），行囊是纯 UI 面板——它不改变世界状态、
   * 也不需要 core 参与判定。同类先例是 h6Panel（学院/万神殿子面板）。
   */
  bagOpen: boolean;
  toasts: (ToastDesc & { fade: boolean })[];
  /**
   * 外部 World Engine 连接态（脱离内置引擎方案 Phase 2 接入点）。
   * enabled=开关（TIANQIONG_EXTERNAL_WORLD_ENGINE）打开；其余是连接状态机
   * 与引擎镜像水位的镜像（Cache ≠ Truth，只喂显示与重连提示）。
   * 断线时 UI 据此进入重连态——绝不回落本地引擎（方案 §22）。
   */
  extWorld: ExtWorldReport;
  setScreen: (s: ScreenName) => void;
  setTab: (t: TabName) => void;
  setSrTab: (t: SrTabName) => void;
  setCSel: (patch: Partial<GameState['cSel']>) => void;
  setAiNarr: (v: GameState['aiNarr']) => void;
  setH6Panel: (p: GameState['h6Panel']) => void;
  setAutoFlow: (v: boolean) => void;
  setBag: (v: boolean) => void;
  cmd: (c: GameCommand) => void;
}

let toastId = 0;

export const useGame = create<GameState>((set, get) => ({
  rev: 0,
  logSeq: 0,
  screen: 'title',
  curTab: 'main',
  srTab: 'quest',
  cSel: { race: 'human', cls: 'warrior' },
  sheet: null,
  check: null,
  combatOpen: false,
  combatRev: 0,
  aiNarr: { key: '', text: null },
  freeBusy: false,
  npcMusing: null,
  weaveFrom: null,
  aiDraft: null,
  autoFlow: false,
  h6Panel: null,
  bagOpen: false,
  toasts: [],
  extWorld: { enabled: false, status: 'off', worldId: null, baseUrl: '', day: null, tick: null, timeView: null, playerLoc: null, lastError: null },
  setScreen: (s) => set({ screen: s }),
  /* 换页意图一律收行囊（含点当前页）：行囊开着时 data-view='bag' 的让位规则
     把 #pnl-ovl 整个 display:none 盖着，若只在 curTab **变化**时才收（旧实现，
     收在 GameShell 的换页 effect 里），点当前页的导航就成了"点了没反应"——
     view 停在 'bag'，新页面渲染了也被挡着（实测复现）。收编到这里，
     顶栏/底栏/横滑/HUD 快捷按钮/ESC 所有换页入口一处生效。 */
  setTab: (t) => set({ curTab: t, bagOpen: false }),
  setSrTab: (t) => set({ srTab: t }),
  setCSel: (patch) => set({ cSel: { ...get().cSel, ...patch } }),
  setAiNarr: (v) => set({ aiNarr: v }),
  setH6Panel: (p) => set({ h6Panel: p }),
  setAutoFlow: (v) => set({ autoFlow: v }),
  setBag: (v) => set({ bagOpen: v }),
  cmd: (c) => world.command(c),
}));

/* ---------------- 订阅 Core 事件总线（组合根调用一次） ---------------- */

/** toast 计时器集中归口（F-25）：切屏/重置/卸载时统一清除，不留无主定时器 */
const toastTimers = new Set<ReturnType<typeof setTimeout>>();

function clearToasts() {
  for (const t of toastTimers) clearTimeout(t);
  toastTimers.clear();
  useGame.setState({ toasts: [] });
}

export function attachCoreBridge(): () => void {
  /* changed 合帧（性能收口）：sync() 在一条命令链中途会被调多次，逐次立即
     setState 会让「点一下」变成 2~4 次全树渲染。把同一任务内的多次 changed
     攒成一次写入：微任务在整条命令链同步跑完后才触发，React 的自动批处理
     又会把它与同任务内的 sheet/check/toast 更新合成一帧。权威状态取自
     core.S（§7），晚一拍渲染不读旧值，只是不再画中间帧。 */
  let changedPending = false;
  const flushChanged = () => {
    if (!changedPending) return;
    changedPending = false;
    useGame.setState((s) => ({ rev: s.rev + 1, logSeq: core.S?.logSeq ?? 0 }));
  };
  const off = bus.on((e) => {
    const st = useGame.getState();
    switch (e.type) {
      case 'changed':
        changedPending = true;
        queueMicrotask(flushChanged);
        break;
      case 'screen':
        /* 切屏即复位浮层、H6 子面板与当前页签（F-16：resetWorld/newGame 都经此事件，跨档不再残留），
           同时清空残留 toast 与其计时器（F-25）。
           curTab 必须一起复位：它就是**浮层的开关**（PanelOverlay 靠 curTab !== 'main' 决定渲染）。
           漏掉它就会出现「在设置页点重置 → 回扉页 → 开新档 → 新世界一进去顶着设置面板」。
           只有换档/换屏会发这个事件（游戏内切页签走 setTab，不经此处），所以复位不打断玩法。 */
        clearToasts();
        useGame.setState({ screen: e.to, curTab: 'main', srTab: 'quest', sheet: null, combatOpen: false, h6Panel: null, bagOpen: false, freeBusy: false, npcMusing: null, weaveFrom: null, aiDraft: null, logSeq: core.S?.logSeq ?? 0 });
        break;
      case 'sheet':
        useGame.setState({ sheet: e.desc });
        break;
      case 'check':
        useGame.setState({ check: e.desc });
        break;
      case 'combat':
        useGame.setState({ combatOpen: e.open });
        break;
      case 'combatChanged':
        useGame.setState({ combatRev: st.combatRev + 1 });
        break;
      case 'toast': {
        const id = ++toastId;
        const t: ToastDesc & { fade: boolean } = { id, text: e.text, cls: e.cls, fade: false };
        useGame.setState({ toasts: [...st.toasts, t] });
        const fadeTimer = setTimeout(() => {
          toastTimers.delete(fadeTimer);
          useGame.setState({ toasts: useGame.getState().toasts.map((x) => (x.id === id ? { ...x, fade: true } : x)) });
        }, 2300);
        const dropTimer = setTimeout(() => {
          toastTimers.delete(dropTimer);
          useGame.setState({ toasts: useGame.getState().toasts.filter((x) => x.id !== id) });
        }, 2800);
        toastTimers.add(fadeTimer);
        toastTimers.add(dropTimer);
        break;
      }
      case 'freeBusy':
        useGame.setState({ freeBusy: e.busy });
        break;
      case 'npcMusing':
        useGame.setState({ npcMusing: e.name });
        break;
      case 'weave':
        /* 这一批织完，草稿也随之作废：正文才是最终形态 */
        useGame.setState({ weaveFrom: e.from, ...(e.from === null ? { aiDraft: null } : {}) });
        break;
      case 'aidraft':
        useGame.setState({ aiDraft: e.done || !e.text ? null : { channel: e.channel, npcId: e.npcId, text: e.text } });
        break;
      case 'foeHit':
        break; // CombatOverlay 组件级订阅（动画 nonce）
    }
  });
  /* F-25：返回 dispose——HMR 重跑组合根 / 卸载时解除订阅并清掉计时器 */
  return () => {
    off();
    clearToasts();
  };
}

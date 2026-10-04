import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
/* 正文宋体：自带资产（思源宋体 · SIL OFL 免费商用）。@font-face 与本机同名安装字体
   冲突时以文档内的 @font-face 优先——玩家机器装没装、装的什么版本都不再影响渲染；
   101 个 unicode-range 分片只加载用到的字形。600 供 <b>/标题的实重使用。 */
import '@fontsource/noto-serif-sc/400.css';
import '@fontsource/noto-serif-sc/600.css';
import './styles/app.css';
import './styles/chat.css';
import './styles/comm.css';
import './styles/dialog.css';
import './styles/fx.css';
import './styles/inventory.css';
/* 外壳（方案 B「雾港」）：只新增选择器 + 同名令牌覆盖，不改 app.css 任何规则。
   顺序必须在最后——同名令牌以最后加载者为准。 */
import './styles/shell.css';
/* 系统面板（方案 D「印玺权柄」）：全新 .sysd- 前缀类，不与上面任何文件冲突 */
import './styles/sysseal.css';
/* 跨面板交互统一层：全局键盘焦点 + 行式按钮衬底。必须最后——
   它在既有规则「没写过的属性」上做增量，又依赖末位同权重接管 */
import './styles/interact.css';
import { gateway } from '@/ai/gateway'; // 组合根：注册 AI 适配器（配置驱动：真实模型 or rule-sim）
import { bus, core, combat, dispatch, flushSave, setSavePort, world } from '@/world';
import { hydrate } from '@/world/WorldState';
import type { WorldState } from '@/types/world';
import type { SavePort } from '@/plugins/PluginInterface';
import { LocalSaveRepository } from '@/repo';
import { attachCoreBridge, useGame } from '@/store/useGame';
import { loadPersonLore } from '@/data/lore';
import { bootstrapWorld } from '@/plugins/bootstrap';
import { makeHybridReasoner } from '@/ai/llmReasoner';
import { restoreVectorIndex } from '@/memory';
import { attachRunLog } from '@/plugins/runlog';
import { runLog } from '@/devlog/RunLog';

/* 组合根装配：Tauri 壳内走 SQLite Repository，浏览器走 localStorage。
   两者同为 SavePort 实现——GameCore 对存储介质零感知（§9）。 */
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/* 运行日志（开发阶段观测）：放在最前面，才能把整个启动装配过程记下来。
   DEV 构建默认开启；打包版本用 localStorage 的 tq2_devlog=1 打开（面板 Ctrl+Shift+L）。 */
const disposeRunLog = attachRunLog();
runLog.mark('组合根开始装配', { tauri: inTauri });

/* 订阅必须先于存档装配：否则 F-21 的介质回落提示会在无人订阅时丢掉 */
const disposeBridge = attachCoreBridge();

/* 世界模拟架构装配（顺序敏感，见 plugins/bootstrap.ts）：
   有真实模型走模型、否则/失败退回规则推演——世界不会因未配置 Key 而停摆 */
const disposeWorld = bootstrapWorld({ reasoner: makeHybridReasoner((system, user) => gateway.ask(system, user)) });

let repo: SavePort;
if (inTauri) {
  const { SqliteRepository } = await import('@/repo/sqlite');
  try {
    repo = await SqliteRepository.open();
  } catch {
    /* F-21：回落必须让玩家看见——静默换介质会让两份档各自演进、体感"存档消失" */
    repo = new LocalSaveRepository();
    bus.emit({ type: 'toast', text: '⚠ SQLite 存档不可用，本次改用浏览器本地存档', cls: 'bad' });
  }
} else {
  repo = new LocalSaveRepository();
}
/* F-20/F-23：落盘失败统一通道——写失败却静默，等于骗玩家"已保存" */
repo.onError = (m) => {
  runLog.warn('save', '存档写入失败', { m }); // 观测通道：写失败的现场要留得下来
  bus.emit({ type: 'toast', text: '存档写入失败：' + m, cls: 'bad' });
};
setSavePort(repo);
runLog.mark('存档介质就绪', { medium: repo.medium ?? (inTauri ? 'sqlite' : 'localStorage') });
/* 向量索引走存档介质的独立通道（§13：事实与向量分开存）——
   放在 setSavePort 之后，否则恢复时拿不到介质 */
restoreVectorIndex();

/* 开发期续档：vite 的整页重载（改源码 / 手动 F5）会把内存里的世界清空、页面退回
   标题屏——改一次代码就得重开一次档，刷新看得到更新却丢了进度。这里在卸载前把
   世界暂存进 sessionStorage，重载后自动接上。只在 DEV 生效：生产包没有 HMR，也就没有这段。 */
if (import.meta.env.DEV) {
  const SNAP = 'tq2_dev_snapshot';
  window.addEventListener('beforeunload', () => {
    try {
      if (core.S) sessionStorage.setItem(SNAP, JSON.stringify(core.S));
    } catch {
      /* 配额满 / 隐私模式：续不上就算了，不该连累正常退出 */
    }
  });
  try {
    const raw = sessionStorage.getItem(SNAP);
    if (raw && !core.S) {
      sessionStorage.removeItem(SNAP); // 只续一次，之后走正常存档
      core.S = hydrate(JSON.parse(raw) as WorldState);
      bus.emit({ type: 'screen', to: 'game' });
      runLog.mark('开发期续档', { from: 'sessionStorage', tick: core.S.t });
    }
  } catch {
    sessionStorage.removeItem(SNAP);
  }
}

/** 关闭/退出前的落盘：清掉 sync 的尾节流并把写穿队列排空 */
const flushAll = async () => {
  flushSave();
  await (repo as { flush?: () => Promise<void> }).flush?.();
};
window.addEventListener('beforeunload', () => {
  void flushAll();
});
/* 页面隐藏即冲盘（性能收口的可靠性配套）：落盘节流放宽到 1s 后，切走 / 锁屏那一刻
   最多还有 1s 的进度只在内存。hidden 立即冲一次，把丢档窗口归零；冲盘的同步
   stringify 发生在页面已不可见时，主线程停顿无人察觉。 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && core.S) void flushAll();
});
if (inTauri) {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.onCloseRequested(async (e) => {
      e.preventDefault();
      await flushAll();
      await win.destroy();
    });
  } catch {
    /* 非 Tauri 运行时：beforeunload 已兜底 */
  }
}

/* F-25：HMR 重跑组合根时必须先解除旧订阅，否则 rev 双递增、toast 双份。
   顺带把「开发服务器断连」显式说出来：连接一断，页面就冻结在断开那一刻的模块上，
   之后再改的源码不再送达——表现是「点什么都没反应」而且不报错，最难自查。 */
type HotCtx = { dispose: (cb: () => void) => void; on: (ev: string, cb: () => void) => void };
const hot = (import.meta as { hot?: HotCtx }).hot;
if (hot) {
  hot.dispose(disposeBridge);
  hot.dispose(disposeWorld);
  hot.dispose(disposeRunLog);
  hot.on('vite:ws:disconnect', () => {
    bus.emit({ type: 'toast', text: '⚠ 与开发服务器的连接已断开——按 Ctrl+F5 刷新以载入最新代码', cls: 'bad' });
  });
}
void loadPersonLore(); // 人物 canon 懒加载：不阻塞首帧，喂 AI 叙事/NPC persona 上下文

/* DEV 调试桥（截图/自检脚本用，不进入生产包） */
if (import.meta.env.DEV) {
  /* runLog 也挂上去：控制台里直接 runLog.exportJson() / runLog.stats() 就能取观测数据 */
  /* store 也挂上去：自检脚本要能读到 UI 侧真正持有的那份状态。
     直接 await import('@/store/useGame') 会拿到另一个模块实例（dev 下模块 URL 带 HMR 时间戳），
     读出来永远是初始值，把「桥接真的断了」和「读到别的实例」混成一件事。 */
  /* world 门面也挂上去：验证脚本要能读只读查询（世界史 / 检定留痕 / 因果链），
     否则脚本只能靠 DOM 文本反推，断言会脆。门面除了 command() 之外不含写入口。 */
  (window as unknown as Record<string, unknown>).__tq = { core, dispatch, combat, bus, runLog, store: useGame, world };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

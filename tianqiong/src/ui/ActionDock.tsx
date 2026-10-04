import { Fragment, useEffect, useRef, useState } from 'react';
import { world } from '@/world';
import { useGame } from '@/store/useGame';
import { actsForScene, type Act } from './SceneView';
import { loadLlmConfig, onLlmConfig } from '@/ai/llmConfig';

/* ============================================================
   动作坞（丁 · 竖排边注 · 1:1 落地）
   ------------------------------------------------------------
   源：outputs/底部栏-丁-竖排边注-落地方案.html
   两态，同一份数据、同一份快捷键：

     宽屏（≥821px）—— 竖排边注：动作挂在左栏下缘，一行一件，主标签左 / 副标题右，
                      悬停时左侧长出一条 1px 金线（书页批注的引线）。底部只剩自由行动。
     窄屏（<821px）—— 底部横排：动作回到屏幕底部，输入条与标签栏依次往下。

   为什么用 JS 断点而不是渲染两份靠 CSS 藏起来：Alt+1..9 绑在 window 上，
   两份 DOM 会让每个快捷键触发两次动作。这里由 useWide 决定谁渲染。

   分组是**声明**而不是**猜测**（SceneView 的 Act.g），仍然保留"匹配不到就落回【行动】"
   这条护栏：新增动作键不会静默消失。
   ============================================================ */
const GROUP_ORDER: { id: string; name: string; cls?: string }[] = [
  { id: 'quick', name: '快捷', cls: 'quick' },
  { id: 'act', name: '行动' },
  { id: 'talk', name: '交涉' },
  { id: 'lore', name: '秘录' },
  { id: 'risk', name: '凶险', cls: 'battle' },
];

const WIDE = '(min-width: 821px)';

/** 宽窄断点（与 shell.css 的 @media(max-width:820px) 同一处口径） */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => (typeof window === 'undefined' ? true : window.matchMedia(WIDE).matches));
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

interface Group {
  id: string;
  name: string;
  cls?: string;
  items: Act[];
}

/** 把一份行动清单按声明归组（纯函数，导出给测试） */
export function groupActs(acts: Act[]): Group[] {
  const bucket: Record<string, Act[]> = { act: [], talk: [], lore: [], risk: [] };
  for (const a of acts) bucket[a.dg ? 'risk' : a.g ?? 'act'].push(a);
  return GROUP_ORDER.filter((g) => g.id !== 'quick' && bucket[g.id]?.length)
    .map((g) => ({ id: g.id, name: g.name, cls: g.cls, items: bucket[g.id] }));
}

/** 坞里的一颗按钮：场景动作与玩家预设的快捷句在这里同形，两种排布共用 */
interface DockBtn {
  key: string;
  group: string;
  label: string;
  sub: string;
  danger?: boolean;
  title: string;
  run: () => void;
}

/**
 * show：场景是否正在显示（判据由外壳给出）。
 * variant：'side' = 左栏竖排（宽屏）/ 'dock' = 底部横排（窄屏）。各自只在自己那一侧渲染。
 */
export function ActionDock({ show, variant = 'dock' }: { show: boolean; variant?: 'side' | 'dock' }) {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  /* 自由行动解析中（F-14）：core 侧有权威去重，但按钮必须看起来真的停了 */
  const lock = useGame((s) => s.freeBusy);
  /* 剧情推进选项来自系统面板的提示词卡：保存后经 onLlmConfig 广播 */
  const [cfg, setCfg] = useState(() => loadLlmConfig());
  useEffect(() => onLlmConfig(setCfg), []);

  const btns: DockBtn[] = [];
  if (show) {
    for (const o of cfg.prompts?.options || []) {
      if (!o.label.trim() || !o.text.trim()) continue;
      btns.push({
        key: 'q' + o.id,
        group: 'quick',
        label: o.label,
        sub: o.text.length > 12 ? o.text.slice(0, 12) + '…' : o.text,
        title: o.text,
        run: () => cmd({ type: 'freeText', text: o.text }),
      });
    }
    for (const g of groupActs(actsForScene(S, S.player.loc))) {
      for (const a of g.items) {
        btns.push({
          key: a.k,
          group: g.id,
          label: a.l,
          sub: a.s,
          danger: a.dg,
          title: a.l + ' · ' + a.s,
          run: () => cmd({ type: 'sceneAction', k: a.k }),
        });
      }
    }
  }
  /* 名次（Alt+N）就是排布顺序；title 里如实标出来 */
  btns.forEach((b, i) => {
    if (i < 9) b.title += '（Alt+' + (i + 1) + '）';
  });

  const btnsRef = useRef<DockBtn[]>(btns);
  btnsRef.current = btns;
  const lockRef = useRef(lock);
  lockRef.current = lock;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.key.length !== 1) return;
      const n = e.key.charCodeAt(0) - 48;
      if (n < 1 || n > 9) return;
      const b = btnsRef.current[n - 1];
      if (!b) return;
      e.preventDefault();
      if (!lockRef.current) b.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const wide = useWide();
  const combat = useGame((s) => s.combatOpen);
  const mine = variant === 'side' ? wide : !wide;
  /* 战斗中不收起的只有输入条，动作两态都停 */
  if (!show || combat || !mine) return null;

  const shown = GROUP_ORDER.map((g) => ({ ...g, items: btns.filter((b) => b.group === g.id) })).filter(
    (g) => g.items.length > 0,
  );
  const noOf = (b: DockBtn) => btns.indexOf(b) + 1;

  /* ---- 竖排边注：一行一件，主标签左 / 副标题右，悬停长出金线 ---- */
  if (variant === 'side') {
    return (
      <nav className="side" aria-label="可执行行动" aria-busy={lock}>
        {shown.map((g, gi) => (
          <Fragment key={g.id}>
            <h6 className={gi > 0 ? 'mt' : ''}>{g.name}</h6>
            {g.items.map((b) => {
              const n = noOf(b);
              return (
                <button
                  key={b.key}
                  className={'sa' + (b.danger ? ' dg' : '')}
                  disabled={lock}
                  title={b.title}
                  onClick={b.run}
                >
                  {b.label}
                  <small>{b.sub}</small>
                  {n <= 9 && <span className="key">{n}</span>}
                </button>
              );
            })}
          </Fragment>
        ))}
      </nav>
    );
  }

  /* ---- 底部横排（窄屏回落）：与样稿 .mini-bot 同构 ---- */
  return (
    <nav id="dock" aria-label="可执行行动" aria-busy={lock}>
      <div className="dock-row">
        {shown.map((g) => (
          <div className={'dock-g' + (g.cls ? ' ' + g.cls : '')} key={g.id}>
            <span className="lb">{g.name}</span>
            <div className="dock-btns">
              {g.items.map((b) => (
                <button key={b.key} className={'act' + (b.danger ? ' danger' : '')} title={b.title} disabled={lock} onClick={b.run}>
                  <span className="l">{b.label}</span>
                  <small>{b.sub}</small>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );
}

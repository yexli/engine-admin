import { useEffect, useMemo, useRef, useState } from 'react';
import { RUN_CHANNELS, RUN_CHAN_LABEL, runLog, type RunChan, type RunEntry, type RunLvl } from '@/devlog/RunLog';
import { RUN_LVL_ORDER, filterRunEntries, fmtRunData } from '@/devlog/RunLogFilter';

/* ============================================================
   运行日志面板（开发观测）
   —— 默认收起，Ctrl+Shift+L 开关；只在运行日志启用时渲染。
   设计取向：能「看着世界跑」而不是查表——实时流 + 通道/级别过滤 + 关键字搜索，
   暂停时冻结视图（不丢数据），随时把当前缓冲导出成 JSON。
   ============================================================ */

const LVL_COLOR: Record<RunLvl, string> = {
  debug: 'rgba(255,255,255,.38)',
  info: 'var(--jade, #57c08a)',
  warn: 'var(--gold, #d9a84e)',
  error: 'var(--crimson, #e0605a)',
};
const CHAN_COLOR: Record<RunChan, string> = {
  boot: '#8fb6d9',
  event: '#49c5d6',
  combat: '#e08a5a',
  ai: '#a184dd',
  memory: '#6fc9a8',
  exec: '#57c08a',
  valid: '#d9a84e',
  save: '#c9a0dc',
  perf: '#7c8896',
  error: '#e0605a',
  ui: '#93a1b1',
  extsync: '#d9b45f',
};
/** 面板一次渲染的尾部条数（缓冲本身有 1000 条上限，这里再收一道保证滚动流畅） */
const VIEW_MAX = 400;

function fmtAt(at: number): string {
  const s = at / 1000;
  if (s < 60) return s.toFixed(2) + 's';
  return Math.floor(s / 60) + 'm' + String(Math.floor(s % 60)).padStart(2, '0') + 's';
}

const chip = (on: boolean): React.CSSProperties => ({
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid ' + (on ? 'var(--gold)' : 'rgba(255,255,255,.14)'),
  background: on ? 'rgba(217,168,78,.14)' : 'transparent',
  color: on ? 'var(--gold)' : 'rgba(255,255,255,.62)',
  fontSize: 11,
  cursor: 'pointer',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'nowrap',
});

const btn: React.CSSProperties = {
  padding: '3px 10px',
  borderRadius: 7,
  border: '1px solid rgba(255,255,255,.16)',
  background: 'rgba(255,255,255,.04)',
  color: 'rgba(255,255,255,.8)',
  fontSize: 11.5,
  cursor: 'pointer',
};

/** 支持 ?runlog=1 直接展开（分享观测现场 / 无键盘环境下的调试入口） */
function openedByUrl(): boolean {
  return typeof location !== 'undefined' && /[?&]runlog=1(?:&|$)/.test(location.search);
}

export function RunLogPanel() {
  const [open, setOpen] = useState(openedByUrl);
  const [rows, setRows] = useState<RunEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [chans, setChans] = useState<Set<RunChan>>(new Set());
  const [minLvl, setMinLvl] = useState<RunLvl>('debug');
  const [q, setQ] = useState('');
  const [stat, setStat] = useState(() => runLog.stats());
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const pausedRef = useRef(false);
  const rafRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  pausedRef.current = paused;

  /* 快捷键常驻：面板关着也能一键打开（Ctrl+Shift+L，与浏览器快捷键不冲突） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* 只在面板打开时订阅与刷新：关着的时候不产生任何渲染成本 */
  useEffect(() => {
    if (!open) return;
    setRows(runLog.tail(VIEW_MAX));
    setStat(runLog.stats());
    /* 写入可能很密集（一次推演十几条）：合并到一帧里取一次，别让每条日志都触发一轮渲染 */
    const off = runLog.subscribe((e) => {
      if (e === null) {
        setRows([]);
        return;
      }
      if (pausedRef.current) return; // 暂停 = 冻结视图，缓冲照收
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        setRows(runLog.tail(VIEW_MAX));
      });
    });
    const iv = setInterval(() => setStat(runLog.stats()), 1000);
    return () => {
      off();
      clearInterval(iv);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [open]);

  /* 过滤规则在 devlog/RunLogFilter.ts 里（纯函数，可单测）；面板只负责渲染 */
  const view = useMemo(() => filterRunEntries(rows, { chans, minLvl, q }), [rows, chans, minLvl, q]);

  /* 贴着底看：暂停或用户手动上滚时不再自动跳 */
  useEffect(() => {
    if (!follow || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [view, follow]);

  if (!runLog.enabled) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="运行日志（Ctrl+Shift+L）"
        className="rl-fab"
      >
        ⌘
      </button>
    );
  }

  const toggleChan = (c: RunChan): void =>
    setChans((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([runLog.exportJson()], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tianqiong-runlog-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    a.click();
    /* 立刻 revoke 会在部分浏览器上抢在下载开始之前，延迟释放 */
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const copy = (): void => {
    const text = runLog.exportJson();
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => setCopied(false));
  };

  return (
    <div
      style={{
        position: 'fixed',
        right: 14,
        bottom: 14,
        zIndex: 70,
        width: 'min(94vw, 900px)',
        height: '62vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(8,12,17,.94)',
        border: '1px solid rgba(255,255,255,.14)',
        borderRadius: 12,
        boxShadow: '0 18px 50px rgba(0,0,0,.55)',
        backdropFilter: 'blur(6px)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11.5,
        color: 'rgba(255,255,255,.86)',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.1)' }}>
        <span style={{ color: 'var(--gold, #d9a84e)', letterSpacing: '.04em' }}>运行日志</span>
        <span style={{ color: 'rgba(255,255,255,.4)' }}>
          {fmtAt(stat.uptimeMs)} · 收 {stat.total} · 留 {stat.kept}
          {stat.dropped ? ' · 丢 ' + stat.dropped : ''}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" style={btn} onClick={() => setPaused((p) => !p)}>
            {paused ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button type="button" style={btn} onClick={() => setFollow((f) => !f)}>
            {follow ? '↓ 跟随' : '↕ 自由'}
          </button>
          <button type="button" style={btn} onClick={download}>
            导出
          </button>
          <button type="button" style={btn} onClick={copy}>
            {copied ? '✓ 已复制' : '复制'}
          </button>
          <button
            type="button"
            style={btn}
            onClick={() => {
              runLog.clear();
              setRows([]);
            }}
          >
            清空
          </button>
          <button type="button" style={btn} onClick={() => setOpen(false)}>
            收起
          </button>
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderBottom: '1px solid rgba(255,255,255,.08)', flexWrap: 'wrap' }}>
        <button type="button" style={chip(chans.size === 0)} onClick={() => setChans(new Set())}>
          全部
        </button>
        {RUN_CHANNELS.map((c) => (
          <button key={c} type="button" style={chip(chans.has(c))} onClick={() => toggleChan(c)}>
            {RUN_CHAN_LABEL[c]}
            {stat.byChan[c] ? ' ' + stat.byChan[c] : ''}
          </button>
        ))}
        <select
          value={minLvl}
          onChange={(e) => setMinLvl(e.target.value as RunLvl)}
          style={{ ...btn, padding: '3px 6px' }}
        >
          {RUN_LVL_ORDER.map((l) => (
            <option key={l} value={l}>
              {l} 以上
            </option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索消息 / 载荷…"
          style={{ flex: 1, minWidth: 140, padding: '3px 8px', borderRadius: 7, border: '1px solid rgba(255,255,255,.16)', background: 'rgba(255,255,255,.04)', color: 'inherit', font: 'inherit' }}
        />
        <span style={{ color: 'rgba(255,255,255,.38)' }}>{view.length} 条</span>
      </div>

      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (!atBottom && follow) setFollow(false);
        }}
        style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}
      >
        {view.map((r) => (
          /* 窄屏行布局（2026-09-29）：四列前缀 minWidth 合计 214px，430px 面板里正文
             只剩 ~180px，中文一列一列竖着挤。改为 wrap：宽屏同行排开，窄屏正文
             自动换到下一行吃满整行——前缀保持一行读得懂，正文横着读。 */
          <div key={r.seq} style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', padding: '2px 12px', lineHeight: 1.55 }}>
            <span style={{ color: 'rgba(255,255,255,.3)', minWidth: 54, textAlign: 'right' }}>{fmtAt(r.at)}</span>
            <span style={{ color: CHAN_COLOR[r.chan], minWidth: 52 }}>{RUN_CHAN_LABEL[r.chan]}</span>
            <span style={{ color: LVL_COLOR[r.lvl], minWidth: 42 }}>{r.lvl}</span>
            {r.day !== undefined ? (
              <span style={{ color: 'rgba(255,255,255,.3)', minWidth: 66 }}>
                D{r.day}·{r.tick}
              </span>
            ) : null}
            <span style={{ color: 'rgba(255,255,255,.9)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: '1 1 220px' }}>{r.msg}</span>
            {r.data ? <span style={{ color: 'rgba(255,255,255,.45)', flex: '1 1 100%' }}>{fmtRunData(r.data)}</span> : null}
          </div>
        ))}
        {!view.length ? (
          <div style={{ padding: '18px 12px', color: 'rgba(255,255,255,.35)' }}>（暂无日志——世界还没动，或过滤条件把都筛掉了）</div>
        ) : null}
      </div>
    </div>
  );
}

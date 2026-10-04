import { codexView, world } from '@/world';
import { useGame } from '@/store/useGame';

/* 卡 I5 · 星枢藏书（图鉴浮层内容）
   —— 纯数据渲染：分类 tab / 进度 / 已解锁正文 / 未解锁线索；React 不摸 WorldState 的写路径。 */
const MAX_ROWS = 30;

export function CodexPanel({ cat }: { cat: string }) {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  const v = codexView(cat, S);
  /* 已解锁优先、其余按序号：一屏先看到"我读过什么"，再看到"还差什么" */
  const rows = [...v.rows].sort((a, b) => Number(b.unlocked) - Number(a.unlocked) || a.num - b.num).slice(0, MAX_ROWS);
  const tab = (on: boolean): React.CSSProperties => ({
    padding: '2px 9px',
    borderRadius: 12,
    fontSize: 11.5,
    border: '1px solid ' + (on ? 'var(--star)' : 'rgba(255,255,255,.16)'),
    background: on ? 'rgba(90,120,220,.28)' : 'transparent',
    color: 'inherit',
  });
  return (
    <>
      <div className="sh-h">
        <div className="sv" style={{ background: '#3b4a70' }}>
          藏
        </div>
        <div className="tt">
          <b>星枢藏书</b>
          <span>
            已收录 {v.unlocked} / {v.total}（{Math.round(v.pct * 100)}%）
          </span>
        </div>
        <button className="x" onClick={() => cmd({ type: 'ui', a: 'close', p: {} })}>
          ✕
        </button>
      </div>
      <div className="sh-b">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
          <button style={tab(!cat)} onClick={() => cmd({ type: 'ui', a: 'codex_open', p: {} })}>
            全部
          </button>
          {v.cats.map((c) => (
            <button key={c.id} style={tab(cat === c.id)} onClick={() => cmd({ type: 'ui', a: 'codex_open', p: { k: c.id } })}>
              {c.id} {c.have}/{c.total}
            </button>
          ))}
        </div>
        {rows.map((r) => (
          <div className="shop-row" key={r.id} style={{ alignItems: 'flex-start' }}>
            <div className="inf">
              <b style={{ opacity: r.unlocked ? 1 : 0.55 }}>
                {r.unlocked ? r.name : '？？？'}
                <span style={{ fontSize: 11, opacity: 0.6, marginLeft: 6 }}>{r.cat}</span>
              </b>
              <span style={{ opacity: 0.74, whiteSpace: 'pre-wrap' }}>
                {r.unlocked ? r.text.slice(0, 180) : '线索：' + r.hint}
              </span>
            </div>
          </div>
        ))}
        {v.rows.length > MAX_ROWS && (
          <div className="sh-gold" style={{ opacity: 0.7 }}>
            （本类共 {v.rows.length} 条，按分类可继续翻查）
          </div>
        )}
      </div>
    </>
  );
}

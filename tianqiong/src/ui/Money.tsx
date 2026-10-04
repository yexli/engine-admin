import type { CSSProperties } from 'react';
import { moneyParts, type MoneyUnit } from '@/systems/economy/Money';

/* 沉浸式货币：用配色令牌 + 数字呈现（§58）。内联样式，避免改 app.css 冻结规则。 */
const TOKEN: Record<MoneyUnit, { sym: string; label: string; bg: string; fg: string }> = {
  plat: { sym: '❖', label: '白金币', bg: 'linear-gradient(145deg,#bff3ea,#6fb8ac)', fg: '#0c3b36' },
  gold: { sym: '◉', label: '金币', bg: 'linear-gradient(145deg,#f4d671,#c9962e)', fg: '#4a3208' },
  silver: { sym: '○', label: '银币', bg: 'linear-gradient(145deg,#eef2f6,#9fb0c0)', fg: '#3a4655' },
  copper: { sym: '·', label: '铜币', bg: 'linear-gradient(145deg,#d79a5c,#8a5a24)', fg: '#3a1e07' },
};
const ORDER: MoneyUnit[] = ['plat', 'gold', 'silver', 'copper'];

function tokenStyle(bg: string, fg: string): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '1.05em', height: '1.05em', borderRadius: '50%',
    background: bg, color: fg, fontSize: '0.82em', fontWeight: 700, lineHeight: 1,
    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.28)', verticalAlign: '-0.16em',
  };
}

export function Money({ n, title }: { n: number; title?: string }) {
  const p = moneyParts(n);
  const shown = ORDER.filter((u) => p[u] > 0);
  if (shown.length === 0) shown.push('copper');
  return (
    <span className="money" title={title ?? shown.map((u) => p[u] + ' ' + TOKEN[u].label).join(' ')} style={{ whiteSpace: 'nowrap' }}>
      {shown.map((u, i) => (
        <span key={u} style={{ marginRight: i < shown.length - 1 ? '0.42em' : 0 }}>
          <span style={tokenStyle(TOKEN[u].bg, TOKEN[u].fg)}>{TOKEN[u].sym}</span>
          <b style={{ margin: '0 0 0 0.18em' }}>{p[u]}</b>
        </span>
      ))}
    </span>
  );
}

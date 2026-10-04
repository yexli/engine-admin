import { world, dungeonView } from '@/world';
import { useGame } from '@/store/useGame';
import { useEffect, useState } from 'react';

/* ============================================================
   卡 H4 · 地下城爬层 HUD（overlays/DungeonOverlay）
   - 仅在「正在层中且不在战斗/检定演出中」时出现，不遮挡主视图
   - 只读 core 的纯数据视图 dungeonView()；一切改动走 GameCommand（§42 铁律）
   - 层主题用五档色调区分：浅=青苔 / 中=青铜 / 深=赤熔 / 最深=星辉 / 深渊=暗紫
   ============================================================ */

const THEME_TONE: Record<string, { c: string; bg: string; label: string }> = {
  shallow: { c: '#7fd6b0', bg: 'rgba(30,70,58,.62)', label: '浅层' },
  mid: { c: '#c9a227', bg: 'rgba(74,60,22,.62)', label: '中层' },
  deep: { c: '#e0714f', bg: 'rgba(84,34,22,.62)', label: '深层' },
  deepest: { c: '#8fb6d6', bg: 'rgba(30,50,78,.62)', label: '最深' },
  abyss: { c: '#b48cd6', bg: 'rgba(52,26,74,.68)', label: '深渊' },
};

export function DungeonOverlay() {
  const rev = useGame((s) => s.rev);
  const combatOpen = useGame((s) => s.combatOpen);
  const checkOpen = useGame((s) => !!s.check);
  const cmd = useGame((s) => s.cmd);
  const [fade, setFade] = useState(false);
  const floor = world.query.get_world_state()?.dungeon?.floor ?? 0;

  /* 换层时做一次淡入（层数变化 = 一次推进） */
  useEffect(() => {
    if (!floor) return;
    setFade(true);
    const t = setTimeout(() => setFade(false), 260);
    return () => clearTimeout(t);
  }, [floor]);

  void rev;
  /* 标题/创角界面没有 WorldState：必须早退，否则 need() 抛错（本组件挂在 GameShell 之外） */
  if (!world.query.get_world_state()) return null;
  const v = dungeonView();
  if (!(v.inRun && !combatOpen && !checkOpen)) return null;

  const tone = THEME_TONE[v.themeId] ?? THEME_TONE.shallow;
  const pct = Math.round((v.floor / 100) * 100);

  return (
    /* F-15：移动端底部让开 #tabbar（约 52px + 安全区），否则进层期间五个标签被盖住且点击被吞 */
    <div id="dungeon-hud" style={{ position: 'fixed', left: 0, right: 0, zIndex: 40, pointerEvents: 'none' }}>
      <div
        style={{
          pointerEvents: 'auto',
          margin: '0 auto 10px',
          maxWidth: 620,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '9px 12px',
          borderRadius: 10,
          border: '1px solid ' + tone.c + '55',
          background: tone.bg,
          backdropFilter: 'blur(7px)',
          boxShadow: '0 6px 24px rgba(0,0,0,.45)',
          transform: fade ? 'translateY(8px)' : 'translateY(0)',
          opacity: fade ? 0.35 : 1,
          transition: 'transform .24s ease-out, opacity .24s ease-out',
        }}
      >
        <div
          style={{
            minWidth: 46,
            height: 46,
            borderRadius: 8,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid ' + tone.c + '88',
            color: tone.c,
            lineHeight: 1.05,
          }}
        >
          <span style={{ fontSize: 17, fontWeight: 700 }}>{v.floor}</span>
          <span style={{ fontSize: 8, letterSpacing: '.14em', opacity: 0.8 }}>FLOOR</span>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ color: tone.c, letterSpacing: '.06em' }}>{v.floorName}</span>
            <span style={{ fontSize: 9, opacity: 0.72, letterSpacing: '.14em' }}>
              {tone.label} · 深度档 {v.tier}
            </span>
            {v.isBoss && (
              <span style={{ fontSize: 9, color: '#e0714f', border: '1px solid #e0714f66', borderRadius: 4, padding: '0 4px' }}>
                BOSS 层
              </span>
            )}
            {v.corrupted && (
              <span style={{ fontSize: 9, color: '#b48cd6', letterSpacing: '.1em' }}>魔气侵蚀</span>
            )}
          </div>
          <div style={{ marginTop: 5, height: 3, borderRadius: 2, background: 'rgba(255,255,255,.1)' }}>
            <div style={{ width: pct + '%', height: '100%', borderRadius: 2, background: tone.c, transition: 'width .3s ease-out' }} />
          </div>
          <div style={{ marginTop: 4, fontSize: 9, opacity: 0.62, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            历史最深 {v.best} 层 · 撤退 {v.escapes} 次 · 下一层 {v.next}
          </div>
        </div>

        <button
          onClick={() => cmd({ type: 'ui', a: 'dungeon_next', p: {} })}
          style={{
            padding: '8px 14px',
            borderRadius: 7,
            border: '1px solid ' + tone.c + '99',
            background: tone.c + '22',
            color: tone.c,
            fontSize: 12,
            letterSpacing: '.06em',
            cursor: 'pointer',
          }}
        >
          下潜 ↓
        </button>
        <button
          onClick={() => cmd({ type: 'ui', a: 'dungeon_retreat', p: {} })}
          style={{
            padding: '8px 12px',
            borderRadius: 7,
            border: '1px solid rgba(255,255,255,.18)',
            background: 'transparent',
            color: 'var(--ink3, #9aa4b8)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          撤退
        </button>
      </div>
    </div>
  );
}

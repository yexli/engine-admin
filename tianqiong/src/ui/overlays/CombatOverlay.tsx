import { useEffect, useRef, useState } from 'react';
import { WB } from '@/data/worldBook';
import { bus, world, esc, maxHp, maxMp } from '@/world';
import { statusName } from '@/systems/character/Status';
import type { StatusInst } from '@/types/world';
import { useGame } from '@/store/useGame';
import { artPath, ArtImage } from '../art/ArtImage';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/* 卡 I3 · 状态徽章（纯静态，无动画 → 天然满足 prefers-reduced-motion） */
const ST_BG: Record<string, string> = {
  burn: 'rgba(255,120,60,.24)',
  bleed: 'rgba(200,40,60,.24)',
  freeze: 'rgba(110,190,255,.24)',
  stun: 'rgba(255,220,90,.24)',
  slow: 'rgba(150,130,255,.24)',
  vuln: 'rgba(255,90,90,.2)',
};
function StatusRow({ arr }: { arr?: StatusInst[] }) {
  if (!arr || !arr.length) return null;
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
      {arr.map((s, i) => (
        <span
          key={i}
          title={statusName(s.id) + ' · 剩 ' + s.dur + ' 回合'}
          style={{
            fontSize: 10,
            lineHeight: 1.5,
            padding: '0 5px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,.22)',
            background: ST_BG[s.id] || 'rgba(255,255,255,.07)',
            whiteSpace: 'nowrap',
          }}
        >
          {statusName(s.id)}
          {s.stack > 1 ? '×' + s.stack : ''}
          <b style={{ marginLeft: 3, opacity: 0.72 }}>{s.dur}</b>
        </span>
      ))}
    </div>
  );
}

interface CombatAct {
  k: 'atk' | 'skill';
  key?: string;
  n: string;
  c: string;
  dis: boolean;
}

/* 战斗日志里的伤害数字 → 可着色的 <span>（卡 P1 演出增强）。
   日志文本是受信来源（世界书数据 + 引擎拼装），此处只包一层标记，不改写内容。 */
function markDmg(text: string, heavy: boolean): string {
  return esc(text).replace(
    /（-(\d+)）/g,
    (_m, n: string) =>
      '<span class="dmg' +
      (heavy ? ' heavy' : '') +
      '" title="' +
      (heavy ? '重击：单次伤害 ≥ 目标生命上限的 1/3' : '伤害') +
      '">-' +
      n +
      '</span>',
  );
}

/* ============================================================
   战斗全屏（原型 #cbt renderCbt 1:1）
   数值渲染全部来自战斗态查询；按钮直调战斗引擎。
   卡 P1 增强（全部在 styles/fx.css）：
   · fxShake200 / fxHurtBlink  受击震动 200ms + 闪白（接 bus 的 foeHit）
   · fxCastBloom / fxCastRing  技能光效（纯 CSS animation）
   · .foe .fh i 与 .cbt-me .bar i 的 width transition → 0.3s
   · .dmg.heavy                 重击（暴击表现）数字放大 + 金色
   ============================================================ */
export function CombatOverlay() {
  const open = useGame((s) => s.combatOpen);
  if (!open || !world.query.get_combat()) return <div id="cbt" />;
  return <CombatInner />;
}

function CombatInner() {
  const CB = world.query.get_combat()!;
  const S = world.query.get_world_state()!;
  const rev = useGame((s) => s.combatRev);
  const cmd = useGame((s) => s.cmd);
  /* F-18：动作 busy 锁——520ms 演出窗口内连点不得叠加结算 */
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<Record<number, number>>({});
  const [cast, setCast] = useState(0); // 技能光效 nonce：key 变化 → 重放 CSS 动画
  /* 重击（暴击表现）的日志条目集合：按条目对象身份记录，天然抵抗 CB.log.shift()。
     core 侧 CombatState 无 crit 字段、d20 点数不出口（types 冻结，本卡不改类型文件），
     故以「单次伤害 ≥ 目标生命上限 1/3」作保守近似——纯表现层，不回写任何状态。 */
  const heavyRef = useRef<WeakSet<object>>(new WeakSet());
  const logRef = useRef<HTMLDivElement>(null);
  /* F-36：受击动画的 rAF 与 420ms 定时器句柄归 ref，卸载时一并取消 */
  const hitRafRef = useRef<number | null>(null);
  const hitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* 受击抖动（原型 foeHit class 420ms → 卡 P1 收紧为 200ms，见 fx.css fxShake200）。
     同一目标连续受击必须重启 CSS 动画：先摘类，下一帧再戴回。 */
  useEffect(() => {
    const off = bus.on((e) => {
      if (e.type !== 'foeHit') return;
      const idx = e.index;
      const C = world.query.get_combat();
      const line = C ? C.log[C.log.length - 1] : undefined;
      const foe = C ? C.foes[idx] : undefined;
      const m = line ? /（-(\d+)）/.exec(line.text) : null;
      if (line && foe && m && Number(m[1]) * 3 >= foe.mhp) heavyRef.current.add(line);
      const stamp = Date.now();
      setHits((h) => {
        if (!(idx in h)) return h; // 未在抖动中：无需先摘类
        const n = { ...h };
        delete n[idx];
        return n;
      });
      if (hitRafRef.current !== null) cancelAnimationFrame(hitRafRef.current);
      hitRafRef.current = requestAnimationFrame(() => setHits((h) => ({ ...h, [idx]: stamp })));
      if (hitTimerRef.current !== null) clearTimeout(hitTimerRef.current);
      hitTimerRef.current = setTimeout(() => {
        hitTimerRef.current = null;
        setHits((h) => {
          if (h[idx] !== stamp) return h; // 已有更新的受击，交给它收尾
          const n = { ...h };
          delete n[idx];
          return n;
        });
      }, 420);
    });
    return () => {
      off();
      if (hitRafRef.current !== null) cancelAnimationFrame(hitRafRef.current);
      if (hitTimerRef.current !== null) clearTimeout(hitTimerRef.current);
    };
  }, []);

  /* 战斗日志滚到底（原型 renderCbt 末尾） */
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rev, CB.log.length]);

  /* 结算推进（combatRev 变化）即解除 busy；再加兜底超时，避免被拒绝的动作把按钮锁死 */
  useEffect(() => {
    if (!busy) return;
    setBusy(false);
  }, [rev]);
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(false), 1500);
    return () => clearTimeout(t);
  }, [busy]);

  const acts = ([{ k: 'atk', n: '攻击', c: '', dis: false }] as CombatAct[]).concat(
    S.player.skills.map((key) => {
      const sk = WB.skills[key];
      return {
        k: 'skill' as const,
        key,
        n: sk.name,
        c: (sk.mp ? 'MP' + sk.mp : '') + (CB.cds[key] > 0 ? ' ·' + CB.cds[key] : ''),
        dis: CB.cds[key] > 0 || S.player.mp < sk.mp,
      };
    }),
  );

  const act = (a: CombatAct) => {
    if (busy) return;
    setBusy(true);
    /* F-18：一律经命令通道（engine.combatCommand）——直调战斗引擎会丢掉 flee 的 closeSheet 等副作用 */
    if (a.k === 'atk') {
      cmd({ type: 'combat', k: 'atk' });
      return;
    }
    setCast(Date.now()); // 技能光效：与技能结算同帧触发，纯表现
    cmd({ type: 'combat', k: 'skill', key: a.key });
  };

  return (
    <div id="cbt" className="on">
      {cast > 0 && <div className="fx-cast" key={cast} />}
      <div className="cbt-h">
        <span className="tt">— 战 斗 —</span>
        <span className="rd">第 {CB.round} 回合</span>
      </div>
      <div className="foes">
        {CB.foes.map((e, i) => (
          <div key={i} className={'foe' + (e.dead ? ' dead' : '') + (hits[i] ? ' hit fx-hit' : '')}>
            <div className="sv" style={{ background: e.color }}>
              <ArtImage src={artPath('mob', e.mid)} fg={e.sv} />
            </div>
            <b>{e.name}</b>
            <div className="fh">
              <i style={{ width: (Math.max(0, e.hp) / e.mhp) * 100 + '%' }} />
            </div>
            <StatusRow arr={e.status} />
          </div>
        ))}
      </div>
      <div className="cbt-log" ref={logRef}>
        {CB.log.map((e, i) => (
          <div
            key={e.id ?? i}
            className={'e ' + (e.cls || 'sys') + (e.crit ? ' crit' : '')}
            dangerouslySetInnerHTML={{ __html: markDmg(e.text, heavyRef.current.has(e) || !!e.crit) }}
          />
        ))}
      </div>
      <div className="cbt-me">
        <div className="me-r">
          <span className="nm">{S.player.name}</span>
          <div className="bars" style={{ flex: 1 }}>
            <div className="bar hp">
              <i style={{ width: clamp((S.player.hp / maxHp(S)) * 100, 0, 100) + '%' }} />
            </div>
            <div className="bar mp">
              <i style={{ width: clamp((S.player.mp / maxMp(S)) * 100, 0, 100) + '%' }} />
            </div>
          </div>
          <span>
            {Math.max(0, S.player.hp)}/{maxHp(S)}
          </span>
        </div>
        <StatusRow arr={CB.status} />
      </div>
      <div className="cbt-acts">
        {acts.map((a, i) => (
          <button key={i} disabled={a.dis || busy} onClick={() => act(a)}>
            {a.n}
            <span className="ct">{a.c}</span>
          </button>
        ))}
        <button disabled={busy} onClick={() => cmd({ type: 'combat', k: 'item' })}>
          道具
        </button>
        <button disabled={busy} onClick={() => cmd({ type: 'combat', k: 'flee' })}>
          逃跑
        </button>
      </div>
    </div>
  );
}

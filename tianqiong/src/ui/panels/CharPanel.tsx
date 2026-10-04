import { STAT_NAMES, WB } from '@/data/worldBook';
import {
  clsName,
  world,
  crimeGrade,
  crimeName,
  deityView,
  gradeLabel,
  hasIllegalStr,
  intelTier,
  maxHp,
  maxMp,
  militaryTier,
  playerStanding,
  repAxis,
  raceName,
  rankName,
  theoselectView,
  titleView,
  xpNeed,
} from '@/world';
import { useGame } from '@/store/useGame';
/* 卡 P2：学院与万神殿的渲染槽已迁到本页（按钮与渲染槽必须在同一页），故这里引它的开关 */
import { openH6Panel } from './AcademyPanel';
import { lifeLine } from '@/systems/timeslip/Lifespan';

/* 角色面板（原型 panelChar 1:1） */
export function CharPanel() {
  const S = world.query.get_world_state()!;
  const p = S.player;
  const cmd = useGame((s) => s.cmd);
  const setBag = useGame((s) => s.setBag);
  return (
    <>
      <div className="pnl-sec" data-w={1}>
        <h5>
          身份<span className="rt">{WB.locations[p.loc].name}</span>
        </h5>
        <div className="kv"><span>姓名</span><span>{p.name}</span></div>
        <div className="kv"><span>种族 · 职业</span><span>{raceName(S)} · {clsName(S)}</span></div>
        <div className="kv"><span>境界</span><span>{rankName(S)}（Lv.{p.level}）</span></div>
        <div className="kv"><span>经验</span><span>{p.exp} / {p.level < 6 ? xpNeed(S) : '—'}</span></div>
        <div className="kv">
          <span>生命 / 法力</span>
          <span>
            {Math.max(0, p.hp)} / {maxHp(S)}　·　{p.mp} / {maxMp(S)}
          </span>
        </div>
        {WB.classes[p.cls].lineage && <div className="kv"><span>流派</span><span>{WB.classes[p.cls].lineage} 系 · {clsName(S)}</span></div>}
        {(() => {
          const ts = theoselectView(S);
          if (!ts.enrolled) return null;
          return (
            <div className="kv">
              <span>百年神选</span>
              <span>
                {ts.templeName} · {ts.rank ? '第 ' + ts.rank + ' 名' : ts.stage}（评分 {ts.score}）
              </span>
            </div>
          );
        })()}
        {(() => {
          /* 卡 H6 · §37 信仰职业：取偏好最高的那位神明，展示其神殿与当前信仰阶位 */
          const rows = deityView(S).rows.filter((r) => r.favor > 0).sort((a, b) => b.favor - a.favor);
          if (!rows.length) return null;
          const top = rows[0];
          return (
            <div className="kv">
              <span>信仰</span>
              <span>
                {top.temple} · {top.rank}（{top.name} {top.favor}）
              </span>
            </div>
          );
        })()}
        {WB.classes[p.cls].path && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
            {WB.classes[p.cls].path!.map((t, i) => (
              <span
                key={i}
                title={i + 1 === p.level ? '当前境界' : i + 1 < p.level ? '已渡过' : '尚未臻至'}
                style={{
                  padding: '2px 8px',
                  borderRadius: '12px',
                  fontSize: '12px',
                  border: '1px solid rgba(255,255,255,.14)',
                  background: i === p.level - 1 ? 'rgba(84,112,220,.42)' : 'transparent',
                  color: i < p.level ? 'inherit' : 'rgba(255,255,255,.42)',
                  fontWeight: i === p.level - 1 ? 700 : 400,
                }}
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="pnl-sec" data-w={1}>
        <h5>属性</h5>
        {STAT_NAMES.map((n) => {
          const st = p.stats[n];
          return (
            <div className="st-row" key={n}>
              <b>{n}</b>
              <span className="v">{st}</span>
              <span className={'m ' + (st - 10 > 0 ? 'up' : st - 10 < 0 ? 'dn' : '')}>
                {st - 10 > 0 ? '+' : ''}
                {st - 10}
              </span>
            </div>
          );
        })}
      </div>
      <div className="pnl-sec" data-w={1}>
        <h5>技能</h5>
        {p.skills.map((k) => {
          const sk = WB.skills[k];
          return (
            <div className="kv" key={k}>
              <span>{sk.name}</span>
              <span>{sk.mp ? 'MP' + sk.mp : '—'}
                {sk.heal ? '·治疗' : '·×' + sk.mult}</span>
            </div>
          );
        })}
      </div>
      {/* 行囊（方案 A 落地 · outputs/行囊界面-桌面版5方案/方案A-全屏台账.html）
          这里从前是两张卡：「装备」与「行囊」——它们展示的是同一批数据（武器/护甲/防御等级/
          暴击率各写了一遍）。现在装备与物品合并进一个浮层，本页只留入口。
          视图模型（分类 / 计数 / 估值 / 动作推导）在 panels/inventoryView.ts，浮层在
          overlays/BagOverlay.tsx；本页不再参与这两件事。 */}
      <AxisPrivs />
      <TitleWall />
      <div className="pnl-sec" data-w={3}>
        <h5>
          势力外交<span className="rt">声望 · 六维关系</span>
        </h5>
        <Diplomacy />
      </div>
      <div className="pnl-sec" data-w={1}>
        <h5>法律状态</h5>
        <div className="kv"><span>通缉等级</span><span>{p.wanted ? p.wanted + ' 级（城内会被盘查）' : '清白'}</span></div>
        <div className="kv"><span>犯罪记录</span><span>{p.crimes} 次</span></div>
        <div className="kv"><span>持有违禁品</span><span>{hasIllegalStr(S)}</span></div>
        {S.legal && S.legal.charges.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>待审讯案底</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {S.legal.charges.map((cid, i) => {
                const g = crimeGrade(cid);
                return (
                  <span
                    key={i}
                    style={{
                      fontSize: 11.5,
                      padding: '2px 8px',
                      borderRadius: 10,
                      border: '1px solid rgba(255,255,255,.16)',
                      color: g === 'S' || g === 'A' ? 'var(--crimson)' : g === 'B' ? 'var(--gold2)' : 'inherit',
                    }}
                  >
                    {crimeName(cid)}
                    {g && <b style={{ marginLeft: 4, opacity: 0.75 }}>{gradeLabel(g)}</b>}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {/* ============================================================
          卡 P2 · 从「系统」页迁来的三张卡
          「系统」页此前是个分类垃圾桶：身世（寿数/婚丧）、培养、知识、世界全塞在里面，
          归置依据是"什么时候加的"而不是"属于哪一类"。角色页收的是**这个人自己**的事——
          寿数、婚姻、成长路径都在此列。
          ============================================================ */}
      {/* 身世与成长：从前是三张卡（寿数 / 婚丧 / 信仰），它们回答的是同一个问题——
          "这个人从哪来、往哪去"。合成一块，区块名代替卡名，按钮收成行式。 */}
      <div className="pnl-sec" data-w={1}>
        <h5>身世与成长</h5>
        <div className="kv">
          <span>寿数（§80）</span>
          <span style={{ fontSize: 10 }}>{lifeLine(S)}</span>
        </div>
        <button className="pnl-act" onClick={() => cmd({ type: 'ui', a: 'rt_menu', p: {} })}>
          婚丧嫁娶
          <b>此地婚俗 · 身后事 · 遗产</b>
        </button>
        <button className="pnl-act" onClick={() => openH6Panel('academy')}>
          培养学院
          <b>学籍 / 课程 / 毕业</b>
        </button>
        <button className="pnl-act" onClick={() => openH6Panel('deity')}>
          万神殿
          <b>祈祷 / 偏好 / 神迹</b>
        </button>
        <button className="pnl-act" onClick={() => cmd({ type: 'ui', a: 'growth_menu', p: {} })}>
          四条路
          <b>师徒 / 神殿 / 自学</b>
        </button>
      </div>
      {/* 行囊：它是"我的东西"，排在本人信息之后；本页只留入口，内容在浮层里 */}
      <div className="pnl-sec" data-w={1}>
        <h5>
          行囊
          <span className="rt">{p.bag.reduce((a, x) => a + x.qty, 0)} 件 · 装备同页</span>
        </h5>
        <button className="sysbtn" onClick={() => setBag(true)}>
          打开行囊（装备 · 物品 · 排序）
        </button>
      </div>
    </>
  );
}

/* 卡 D3/E5 演出（方案 D）：声望 + 六维合并总表——行=势力，列=态度/信任/敌意/通商/军事/信仰/情报；
   态度列内嵌居中微条，数值按语义着色（敌意反向），跨势力逐列对齐、可横向滚动。全量展示，不折叠。 */
const DIPLO_AXES = [
  { k: 'trust', label: '信任', good: true },
  { k: 'hostility', label: '敌意', good: false },
  { k: 'trade', label: '通商', good: true },
  { k: 'military', label: '军事', good: true },
  { k: 'religion', label: '信仰', good: true },
  { k: 'intelligence', label: '情报', good: true },
] as const;

const valColor = (v: number, good: boolean) => (v === 0 ? 'var(--ink3)' : (v > 0) === good ? 'var(--jade)' : 'var(--crimson)');

/* 卡 I6 · 称号墙：主称号 / 已获得（可花钱隐藏负面称号）/ 未获得给条件线索 */
function TitleWall() {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  const v = titleView(S);
  const got = v.rows.filter((r) => r.got);
  const rest = v.rows.filter((r) => !r.got);
  return (
    <div className="pnl-sec" data-w={1}>
      <h5>
        称号
        <span className="rt">
          {got.length} / {v.rows.length}
          {v.score !== 0 ? ' · 声名 ' + v.score : ''}
        </span>
      </h5>
      {v.primary && (
        <div className="kv">
          <span>世人称你</span>
          <span style={{ color: 'var(--gold2)' }}>{v.primary}</span>
        </div>
      )}
      {got.map((r) => (
        <div className="inv-row" key={r.id}>
          <div className="nm">
            <b style={r.negative ? { color: 'var(--crimson)' } : { color: 'var(--gold2)' }}>
              {r.name}
              {r.hidden && <span style={{ opacity: 0.6, fontSize: 11 }}>（已花钱抹去，历史仍在）</span>}
            </b>
            <small>{r.react}</small>
          </div>
          <div className="ops">
            {r.negative && !r.hidden && (
              <button onClick={() => cmd({ type: 'ui', a: 'title_hide', p: { id: r.id } })}>花钱隐藏</button>
            )}
          </div>
        </div>
      ))}
      {rest.slice(0, 6).map((r) => (
        <div className="kv" key={r.id} style={{ opacity: 0.5 }}>
          <span>？？？</span>
          <span>{r.desc}</span>
        </div>
      ))}
      {!got.length && <div className="empty">还没有人这样称呼你</div>}
    </div>
  );
}

/* 卡 I4 · 军事 / 情报双轴特权：此前两轴"UI 已展示、玩法无来源"，此卡把来源与四档特权显式化。
   判定全在 core（diplomacy.ts），此处只读——UI 不写轴。 */
const MIL_PRIVS: [number, string][] = [
  [30, '军功抵罪 · 审判从轻'],
  [50, '征召 · 战时召两名城卫'],
  [70, '军职 · 城门税免 + 盘查减半'],
  [90, '私兵 · 私兵投效（后置）'],
];
const INTEL_PRIVS: [number, string][] = [
  [25, '观察揭示 · 额外线索'],
  [40, '预知 · 提前一日知事'],
  [60, '识破 · 分辨假情报'],
  [80, '情报网 · 远程问人问价'],
];

function AxisPrivs() {
  const S = world.query.get_world_state()!;
  const rows: { fac: string; axis: 'military' | 'intelligence'; label: string; privs: [number, string][] }[] = [
    { fac: 'empire', axis: 'military', label: '军事 · 帝国', privs: MIL_PRIVS },
    { fac: 'guild', axis: 'intelligence', label: '情报 · 公会', privs: INTEL_PRIVS },
  ];
  return (
    <div className="pnl-sec" data-w={2}>
      <h5>
        军事与情报<span className="rt">卡 I4 · 双轴特权</span>
      </h5>
      {rows.map((r) => {
        const v = repAxis(r.fac, r.axis, S);
        const tier = r.axis === 'military' ? militaryTier(S) : intelTier(S);
        return (
          <div className="pnl-col" key={r.fac} style={{ marginBottom: 10 }}>
            <div className="kv">
              <span>{r.label}</span>
              <span>
                {v} / 100　·　{tier}/3 档　·　已解锁 {r.privs.filter((p) => v >= p[0]).length}/4
              </span>
            </div>
            {r.privs.map((p) => (
              <div key={p[1]} style={{ fontSize: 11, opacity: v >= p[0] ? 1 : 0.42, lineHeight: 1.7 }}>
                {v >= p[0] ? '◆' : '◇'} {p[1]}
                <span style={{ opacity: 0.6 }}>（需 {p[0]}）</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Diplomacy() {
  const S = world.query.get_world_state()!;
  const fs = Object.keys(WB.factions);
  const th: React.CSSProperties = { background: 'var(--bg3)', color: 'var(--ink3)', fontWeight: 500, fontSize: 10, letterSpacing: '.04em', padding: '6px 5px', textAlign: 'right', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '5px 5px', textAlign: 'right', borderTop: '1px solid var(--line)', fontFamily: 'var(--serif)', fontSize: 11 };
  return (
    <div className="dip-scroll" style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 380 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>势力</th>
            <th style={th}>态度</th>
            {DIPLO_AXES.map((a) => (
              <th key={a.k} style={th}>{a.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fs.map((f, ri) => {
            const st = playerStanding(f, S);
            const att = st.attitude;
            const w = Math.min(50, Math.abs(att) / 2);
            return (
              <tr key={f} style={{ background: ri % 2 ? 'rgba(255,255,255,.02)' : 'transparent' }}>
                <td style={{ ...td, textAlign: 'left', fontFamily: 'var(--sans)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>{WB.factions[f]}</td>
                <td style={td}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
                    <span style={{ width: 30, height: 5, background: '#00000055', borderRadius: 3, position: 'relative', display: 'inline-block', overflow: 'hidden', flex: 'none' }}>
                      <span style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--line2)' }} />
                      <i style={{ position: 'absolute', top: 0, bottom: 0, borderRadius: 3, ...(att >= 0 ? { left: '50%', width: w + '%', background: 'var(--jade)' } : { right: '50%', width: w + '%', background: 'var(--crimson)' }) }} />
                    </span>
                    <b style={{ color: att >= 15 ? 'var(--jade)' : att > -15 ? 'var(--ink3)' : 'var(--crimson)', fontWeight: 600 }}>
                      {att > 0 ? '+' : ''}
                      {att}
                    </b>
                  </span>
                </td>
                {DIPLO_AXES.map((a) => {
                  const v = st[a.k];
                  return (
                    <td key={a.k} style={{ ...td, color: valColor(v, a.good) }}>
                      {v > 0 ? '+' : ''}
                      {v}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

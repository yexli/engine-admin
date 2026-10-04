import { world, deityView } from '@/world'; // 约束 §2：UI 只经 @/core 索引进引擎
import { useGame } from '@/store/useGame';
import { openH6Panel } from './AcademyPanel';

/* ============================================================
   卡 H6 · 万神殿面板（只读 core 快照 + 发 GameCommand）
   神名/神号/阶位/神迹阈值一律来自 data/world/deities.json（deityView 提供），
   本组件不含任何 canon 文案硬编码。
   ============================================================ */

export function DeityPanel() {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  const v = deityView(S);

  return (
    <>
      <div className="card">
        <h5>
          万神殿
          <span className="rt">
            今日祈祷 {v.prayUsed} / {v.dailyCap}
          </span>
        </h5>
        <div style={{ fontSize: '10.5px', color: 'var(--ink3)', lineHeight: 1.85 }}>{v.attitudesCommon}</div>
      </div>

      {v.rows.map((r) => (
        <div className="card" key={r.id}>
          <h5>
            {r.name}
            <span className="rt">
              {r.title} · {r.temple}
            </span>
          </h5>
          <div className="kv">
            <span>神职领域</span>
            <span style={{ fontSize: 11 }}>{r.domains.join('／')}</span>
          </div>
          <div className="kv">
            <span>信仰阶位</span>
            <span>
              {r.rank}
              {r.faithDisabled ? '' : '（' + r.templeGrade + '）'}
            </span>
          </div>
          <div className="kv">
            <span>偏好</span>
            <span>
              {r.favor} / {v.favorCap}
              {r.nextRank ? '　下一阶 ' + r.nextRank + '（' + r.nextAt + '）' : ''}
            </span>
          </div>
          <div className="kv">
            <span>神迹</span>
            <span>
              {r.intervened} 次{r.cooldownLeft ? '　冷却 ' + r.cooldownLeft + ' 日' : ''}
            </span>
          </div>
          {r.faithClasses.length > 0 && (
            <div className="kv">
              <span>信仰路线</span>
              <span style={{ fontSize: 10.5 }}>{r.faithClasses.join(' → ')}</span>
            </div>
          )}
          {r.ultimate && (
            <div className="kv">
              <span>终极</span>
              <span style={{ fontSize: 11 }}>
                {r.ultimate.name}（{r.ultimate.ability}·{r.ultimate.effect}）
              </span>
            </div>
          )}
          {r.templeSchool && (
            <div className="kv">
              <span>神殿培养</span>
              <span style={{ fontSize: 11 }}>
                {r.templeSchool.direction} · {r.templeSchool.years} · 入门 {r.templeSchool.entry}
              </span>
            </div>
          )}
          <div className="kv">
            <span>神系态度</span>
            <span style={{ fontSize: 10.5, textAlign: 'right' }}>{r.attitude}</span>
          </div>
          {r.faithDisabled && (
            <div style={{ fontSize: '10.5px', color: 'var(--ink3)', lineHeight: 1.8, marginTop: 6 }}>{v.noFaithNote}</div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              className="sysbtn"
              style={{ marginBottom: 0, flex: 1 }}
              disabled={v.prayLeft <= 0}
              onClick={() => cmd({ type: 'ui', a: 'de_pray', p: { id: r.id } })}
            >
              祈祷（余 {v.prayLeft} 次 · {v.favorMin}–{v.favorMax}）
            </button>
            <button
              className="sysbtn"
              style={{ marginBottom: 0, flex: 1 }}
              disabled={!r.canIntervene}
              onClick={() => cmd({ type: 'ui', a: 'de_intervene', p: { id: r.id } })}
            >
              祈求神迹（需 {r.needFavor} · 耗 {r.costFavor}）
            </button>
          </div>
        </div>
      ))}

      <div className="card">
        <h5>
          神界职位层级<span className="rt">s3 canon</span>
        </h5>
        {v.rankDetail.map((d) => (
          <div className="kv" key={d.name}>
            <span>
              {d.tier} · {d.name}（{d.headcount}）
            </span>
            <span style={{ fontSize: 10.5, textAlign: 'right' }}>
              {d.duty}
              <br />
              {d.source}
            </span>
          </div>
        ))}
        <div style={{ fontSize: '10.5px', color: 'var(--ink3)', lineHeight: 1.85, marginTop: 8 }}>
          新神晋升路径：{v.promotionPath.map((p) => p.from + '→' + p.to + '（' + p.need + '）').join('　')}
        </div>
        <div style={{ fontSize: '10.5px', color: 'var(--ink3)', lineHeight: 1.85, marginTop: 4 }}>
          神迹消耗的偏好可再经祈祷累积；{v.favorMin}–{v.favorMax} / 次，日限 {v.dailyCap} 次，上限 {v.favorCap}。
        </div>
      </div>

      <div className="card">
        <h5>神殿事务</h5>
        <button className="sysbtn" onClick={() => cmd({ type: 'ui', a: 'de_menu', p: {} })}>
          打开万神殿菜单（祈祷 / 神迹）
        </button>
        <button className="sysbtn" onClick={() => openH6Panel(null)}>
          返回角色
        </button>
        <div style={{ fontSize: '10.5px', color: 'var(--ink3)', lineHeight: 1.85, marginTop: 8 }}>
          神迹后果全部由规则引擎落地：文本取自数据层 seed，关掉 AI 也照常成立。
        </div>
      </div>
    </>
  );
}

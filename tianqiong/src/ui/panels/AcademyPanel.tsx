import { formatMoney } from '@/systems/economy/Money';
import { academyView, world } from '@/world'; // 约束 §2：UI 只经 @/core 索引进引擎
import { useGame } from '@/store/useGame';

/* ============================================================
   卡 H6 · 培养学院面板（只读 core 快照 + 发 GameCommand）
   —— 面板切换：状态并入 useGame（F-16）。原模块级微状态在 resetWorld /
      开新档后不会复位，会成为 store 之外的第二事实源（打开学院→重置世界→
      点"系统"直接进学院，存档与 AI 网关三张卡全部不可见）。
   ============================================================ */

export type H6Panel = 'academy' | 'deity' | null;

/** 面板开关（SysPanel 入口卡调用；切屏时由 core 的 screen 事件统一复位） */
export function openH6Panel(p: H6Panel) {
  useGame.getState().setH6Panel(p);
}
/** GameShell / SysPanel 共用的面板开关 */
export function useH6Panel(): H6Panel {
  return useGame((s) => s.h6Panel);
}

export function AcademyPanel() {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  const v = academyView(S);
  const money = (n: number) => formatMoney(n);

  return (
    <>
      <div className="card">
        <h5>
          培养学院
          <span className="rt">{v.enrolledId ? v.path : '四大路径 · 学院制'}</span>
        </h5>
        {v.enrolledId ? (
          <>
            <div className="kv">
              <span>学籍</span>
              <span>
                {v.name}（{v.continent}·{v.city}）
              </span>
            </div>
            <div className="kv">
              <span>路径 · 专长</span>
              <span>
                {v.path} · {v.specialty}
              </span>
            </div>
            <div className="kv">
              <span>学制 · 学期</span>
              <span>
                {v.years} 年 · 第 {v.term} / {v.termsTotal} 学期
              </span>
            </div>
            <div className="kv">
              <span>已修刻数</span>
              <span>
                {v.elapsedTicks} / {v.minTicks}
              </span>
            </div>
            <div className="kv">
              <span>课程</span>
              <span>
                {v.completedCount} / {v.totalCount} 结业{v.failed ? '　挂科 ' + v.failed + ' 次' : ''}
              </span>
            </div>
            <div className="kv">
              <span>学位</span>
              <span>
                {v.degree || '—'}
                {v.degreeEquiv ? '（相当于' + v.degreeEquiv + '）' : ''}
              </span>
            </div>
            {v.titles.length > 0 && (
              <div className="kv">
                <span>已获称号</span>
                <span>{v.titles.join('、')}</span>
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: '10.5px', color: 'var(--ink3)', lineHeight: 1.85 }}>
            {v.enrollNote || '四大培养路径：师徒制／学院制／神殿制／自学·野路。本处为学院制。'}
          </div>
        )}
      </div>

      {v.enrolledId && v.currentCourseId && (
        <div className="card">
          <h5>
            当前课程<span className="rt">{v.completedCount} / {v.totalCount}</span>
          </h5>
          <div className="kv">
            <span>课程</span>
            <span>{v.currentCourseName}</span>
          </div>
          <div className="kv">
            <span>修业进度</span>
            <span>
              {v.progress} / {v.courses.find((c) => c.courseId === v.currentCourseId)?.duration || 0} 刻
            </span>
          </div>
          <div className="bar" style={{ height: 6, margin: '8px 0 12px' }}>
            <i
              style={{
                width:
                  Math.min(
                    100,
                    Math.round(
                      (v.progress / (v.courses.find((c) => c.courseId === v.currentCourseId)?.duration || 1)) * 100,
                    ),
                  ) + '%',
                background: 'linear-gradient(90deg,#d4b26a,#b3934e)',
              }}
            />
          </div>
          <button className="sysbtn" onClick={() => cmd({ type: 'ui', a: 'ac_study', p: { id: v.currentCourseId! } })}>
            修业一学期（{v.studyTicks} 刻 · 一学期制）
          </button>
        </div>
      )}

      {v.enrolledId && (
        <div className="card">
          <h5>
            课程表<span className="rt">{v.termsNote}</span>
          </h5>
          {v.courses.map((c) => (
            <div className={'q-card' + (c.done ? ' done' : '')} key={c.courseId}>
              <h4>
                {c.name}
                <span className={'st ' + (c.done ? 'done' : c.current ? 'go' : 'fin')}>
                  {c.done ? '已结业' : c.current ? '在读' : '未修'}
                </span>
              </h4>
              <p>
                第 {c.year} 年 · {c.duration} 刻 · 考核 {c.stat} DC {c.dc} · 修业费 {money(c.goldCost)}
                {c.skillNames.length ? ' · 授予 ' + c.skillNames.join('、') : ''}
              </p>
              {c.current && (
                <div className="pg">
                  进度 {c.progress} / {c.duration} 刻
                </div>
              )}
            </div>
          ))}
          <button
            className="sysbtn"
            disabled={!v.canGraduateNow}
            onClick={() => cmd({ type: 'ui', a: 'ac_graduate', p: {} })}
          >
            申请毕业{v.canGraduateNow ? '' : '（' + v.graduateReason + '）'}
          </button>
        </div>
      )}

      {!v.enrolledId && (
        <div className="card">
          <h5>
            学院名录<span className="rt">{v.catalog.length} 所</span>
          </h5>
          {v.catalog.map((a) => (
            <div className="shop-row" key={a.id}>
              <div className="inf">
                <b>
                  {a.name}（{a.years} 年制）
                </b>
                <span>
                  {a.continent}·{a.city} · {a.path} · 专长 {a.specialty}
                </span>
                <span>
                  年费 {a.tuition ? money(a.scholarship ? a.due : a.tuition) : '免费'}
                  {a.scholarship ? '（s101 奖学金 30%）' : ''} · 门槛 境界「{a.rankReq}」
                  {a.raceName ? ' · 仅' + a.raceName : ''}
                </span>
                <span style={{ color: 'var(--ink3)' }}>
                  导师 {a.mentor ? a.mentor.name + '（' + a.mentor.role + '）' : '—'}
                </span>
                {!a.canEnroll && a.reason && <span className="no">{a.reason}</span>}
              </div>
              <button
                disabled={!a.canEnroll}
                onClick={() => cmd({ type: 'ui', a: 'ac_enroll', p: { id: a.id } })}
              >
                {a.graduated ? '已毕业' : '报名'}
              </button>
            </div>
          ))}
        </div>
      )}

      {v.mentor && (
        <div className="card">
          <h5>
            学院导师<span className="rt">{v.mentor.role}</span>
          </h5>
          <div className="kv">
            <span>导师</span>
            <span>
              {v.mentor.name} · {v.mentor.race}
            </span>
          </div>
          <div className="kv">
            <span>目标</span>
            <span style={{ fontSize: 11, textAlign: 'right' }}>{v.mentor.goal}</span>
          </div>
          <div className="kv">
            <span>关切</span>
            <span style={{ fontSize: 11, textAlign: 'right' }}>{v.mentor.interest}</span>
          </div>
          <div className="kv">
            <span>底线</span>
            <span style={{ fontSize: 11, textAlign: 'right', color: 'var(--crimson)' }}>{v.mentor.bottomLine}</span>
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--ink3)', lineHeight: 1.85, marginTop: 8 }}>
            「{v.mentor.greet?.neutral ?? '（这位导师尚未落笔成文——学院侧暂无口吻样本。）'}」
          </div>
        </div>
      )}

      <div className="card">
        <h5>学院事务</h5>
        <button className="sysbtn" onClick={() => cmd({ type: 'ui', a: 'ac_menu', p: {} })}>
          打开学院菜单（报名 / 修业 / 毕业）
        </button>
        <button className="sysbtn" onClick={() => cmd({ type: 'ui', a: 'ac_courses', p: {} })}>
          课程表速览（ConfirmSheet）
        </button>
        <button className="sysbtn" onClick={() => openH6Panel(null)}>
          返回角色
        </button>
      </div>
    </>
  );
}

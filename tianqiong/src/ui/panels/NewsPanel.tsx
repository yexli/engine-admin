import { WB } from '@/data/worldBook';
import {
  abyssOpen,
  attOf,
  attWord,
  world,
  eventAftermath,
  eventMeta,
  foresightTitles,
  intelForesight,
  intelNetwork,
  leakLevel,
  leakName,
  npcCurLoc,
  priceOf,
  sceneTime,
  standingBetween,
  theoselectView,
} from '@/world';

/** 见闻正文带内联标记（rich() 产出），纪年是摘要，去掉标签只留字 */
const stripTags = (html: string): string => (html || '').replace(/<[^>]*>/g, '');

/* ============================================================
   纪闻面板（原型 panelNews 1:1 + 卡 D3/D4 演出：事件余波 + 势力外交矩阵）

   落盘（丁·照影）：从前是八张卡纵向堆叠，现在是三列网格里的一组区块。
   条件块（预知 / 情报网 / 神选 / 星渊监视）仍按原逻辑 return null——
   网格开了 dense，少一块后面自动补位，不会留下空洞。
   外交矩阵占整行：它是矩阵，列宽固定，塞进单列会被压扁。
   ============================================================ */

const heat = (v: number): string => {
  // 态度 -100..100 → 冷(敌意)～暖(友好)，中性灰
  if (v >= 40) return 'rgba(60,180,120,.55)';
  if (v >= 12) return 'rgba(60,180,120,.28)';
  if (v > -12) return 'rgba(255,255,255,.06)';
  if (v > -40) return 'rgba(200,80,80,.30)';
  return 'rgba(200,80,80,.55)';
};

/** 通用区块壳：新增视图只写内容，不重复布局约定 */
function Sec({
  title,
  hint,
  w,
  children,
}: {
  title: string;
  hint?: string;
  w?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="pnl-sec" data-w={w ?? 1}>
      <h6>
        {title}
        {hint ? <em>{hint}</em> : null}
      </h6>
      {children}
    </section>
  );
}

function DiplomacyGrid() {
  const S = world.query.get_world_state()!;
  const fs = Object.keys(WB.factions);
  return (
    <Sec title="势力外交" w={3} hint="谁与谁交好 / 交恶">
      {/* 横向滚动容器里**不能**用 margin:0 auto 居中表格：表格比容器宽时，
          auto 边距会把左边缘推出可视区，滚动条也滚不回来——窄屏右侧被裁的根因。
          表头补 nowrap，免得两个字被挤成竖排。 */}
      <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 3, fontSize: 11, margin: 0 }}>
          <thead>
            <tr>
              <th />
              {fs.map((c) => (
                <th key={c} style={{ color: 'var(--ink3)', fontWeight: 600, padding: '2px 3px', whiteSpace: 'nowrap' }} title={WB.factions[c]}>
                  {(WB.factions[c] || c).slice(0, 2)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fs.map((r) => (
              <tr key={r}>
                <td style={{ color: 'var(--ink3)', fontWeight: 600, whiteSpace: 'nowrap' }}>{(WB.factions[r] || r).slice(0, 2)}</td>
                {fs.map((c) => {
                  if (r === c)
                    return (
                      <td key={c} style={{ textAlign: 'center', opacity: 0.35 }}>
                        ·
                      </td>
                    );
                  const v = standingBetween(r, c, 'attitude', S);
                  return (
                    <td
                      key={c}
                      title={`${WB.factions[r]} → ${WB.factions[c]}：态度 ${v}`}
                      style={{ width: 30, height: 22, borderRadius: 5, background: heat(v), color: '#fff', textAlign: 'center', lineHeight: '22px', fontWeight: 700 }}
                    >
                      {v > 0 ? '+' : ''}
                      {v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Sec>
  );
}

/* 卡 H5 · 百年神选（lore §4）：倒计时 + 当前阶段 + 评分盘前十 */
function TheoselectCard() {
  const S = world.query.get_world_state()!;
  const v = theoselectView(S);
  if (!v.open) return null;
  const stageLoc =
    v.stageLocName ||
    ({ star5: '星枢五塔 · 星斗台', dungeon_deep: '地下城深层·地渊', plaza: '圣辉城·中央广场' } as Record<string, string>)[v.stageLoc] ||
    '地点不详';
  return (
    <Sec title="百年神选" w={2} hint={`卡 H5 · 第 ${v.cycle} 届`}>
      <div className="pnl-row">
        <span>阶段</span>
        <b style={{ color: 'var(--star)' }}>
          {v.stage}（取前 {v.quota}）{v.daysLeft >= 0 ? `　·　余 ${v.daysLeft} 日` : '　·　已定局'}
        </b>
      </div>
      <div className="pnl-row">
        <span>地点</span>
        <b>{stageLoc}</b>
      </div>
      {v.enrolled ? (
        <>
          <div className="pnl-row">
            <span>你的名册</span>
            <b>
              {v.templeName}　评分 {v.score}
              {v.rank ? `　第 ${v.rank} 名` : ''}
            </b>
          </div>
          {v.rewards && (
            <div className="pnl-row">
              <span>胜出所得</span>
              <b style={{ color: 'var(--gold2)' }}>
                {v.rewards.label}（寿元 +{v.rewards.lifespan} 年）
              </b>
            </div>
          )}
        </>
      ) : (
        <div className="pnl-row note">
          <b>{v.disqualified ? '本届已出局——须沉淀至下一届方可再战。' : '你尚未报名（神殿设坛处可报名）。'}</b>
        </div>
      )}
      {v.top.length > 0 && (
        <div className="pnl-sub">
          <div className="lb">评分盘 · 前十</div>
          {v.top.map((x) => (
            <div key={x.rank} style={{ display: 'flex', gap: 8, fontSize: 11.5, padding: '2px 0', opacity: x.you ? 1 : 0.82 }}>
              <span style={{ width: 16, opacity: 0.6 }}>{x.rank}</span>
              <span style={{ flex: 1, color: x.you ? 'var(--gold2)' : 'inherit' }}>{x.name}</span>
              <span style={{ opacity: 0.55 }}>{x.temple}</span>
              <span style={{ width: 38, textAlign: 'right', fontFamily: 'var(--mono)' }}>{x.score}</span>
            </div>
          ))}
        </div>
      )}
    </Sec>
  );
}

/* 卡 I4 · 预知（情报≥40）：提前一日列出明日将命中的日历事件——**只泄漏标题，不泄漏效果** */
function ForesightCard() {
  const S = world.query.get_world_state()!;
  if (!intelForesight(S)) return null;
  const list = foresightTitles(S);
  return (
    <Sec title="预知 · 明日" hint="卡 I4 · 情报 40">
      {list.length ? (
        list.map((e) => (
          <div className="pnl-row" key={e.id}>
            <span>明日</span>
            <b>{e.name}</b>
          </div>
        ))
      ) : (
        <div className="pnl-row note">
          <b>风向平静 · 明日无事可先闻。</b>
        </div>
      )}
    </Sec>
  );
}

/* 卡 I4 · 情报网（情报≥80）：不必亲至，也能问到人与价（远程查人物志 / 问价） */
function IntelWebCard() {
  const S = world.query.get_world_state()!;
  if (!intelNetwork(S)) return null;
  const who = Object.keys(WB.npcs)
    .map((id) => ({ id, n: WB.npcs[id], loc: npcCurLoc(id, S) }))
    .filter((r) => !!r.loc)
    .slice(0, 8);
  const asks = ['bread', 'herb_paste', 'moonherb'].filter((i) => WB.items[i]);
  return (
    <Sec title="情报网 · 远程查询" w={2} hint="卡 I4 · 情报 80">
      <div className="pnl-sub">
        <div className="lb">人物志（此刻所在）</div>
        {who.map((r) => (
          <div className="pnl-row" key={r.id}>
            <span>{r.n.name}</span>
            <b>
              {WB.locations[r.loc!]?.name || r.loc}　{attWord(attOf(r.id, S))}
            </b>
          </div>
        ))}
      </div>
      <div className="pnl-sub">
        <div className="lb">问价（东市行情）</div>
        {asks.map((i) => (
          <div className="pnl-row" key={i}>
            <span>{WB.items[i].name}</span>
            <b>{priceOf(i, 'market', S)} 铜</b>
          </div>
        ))}
      </div>
    </Sec>
  );
}

/* 今日纪年（2026-09 自左栏迁入）：当日最近四条见闻，旧→新，最后一条即「现在」。
   左栏只留"我是谁 / 我在哪 / 此刻能做什么"，"发生过什么"归到这里读。 */
function JinianCard() {
  const S = world.query.get_world_state()!;
  const t = sceneTime(S);
  const all = S.log || [];
  const today = all.filter((e) => (e.t || '').indexOf(t.month + '月' + t.date + '日') === 0);
  const chron = (today.length ? today : all).slice(-4);
  const nowId = chron.length ? chron[chron.length - 1].id : -1;
  return (
    <Sec title="今日纪年" hint="这一天发生过什么">
      {chron.length ? (
        chron.map((e) => (
          <div className={'pnl-row' + (e.id === nowId ? ' now' : '')} key={e.id}>
            <span>{e.t}</span>
            <b>{stripTags(e.text).slice(0, 26)}</b>
          </div>
        ))
      ) : (
        <div className="pnl-row note">
          <b>今天还没有值得记下的事。</b>
        </div>
      )}
    </Sec>
  );
}

export function NewsPanel() {
  const S = world.query.get_world_state()!;
  const lv = leakLevel(S);
  return (
    <>
      <JinianCard />
      <Sec title="进行中的世界事件" w={2} hint={S.events.length ? `${S.events.length} 件` : undefined}>
        {S.events.length ? (
          S.events.map((e) => {
            const meta = eventMeta(e.id);
            const after = meta ? eventAftermath(meta) : '';
            const caused = meta?.trigger.afterEvent ? eventMeta(meta.trigger.afterEvent)?.name : '';
            return (
              <div key={e.id}>
                <div className="pnl-row">
                  <span>第{e.day}日</span>
                  <b>{e.name}</b>
                </div>
                {caused && (
                  <div className="pnl-row note">
                    <span>⟵ 因果</span>
                    <b>{caused}</b>
                  </div>
                )}
                {after && (
                  <div className="pnl-row note">
                    <span>余波</span>
                    <b style={{ color: 'var(--gold2)' }}>{after}</b>
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="pnl-row note">
            <b>世界暂时平静。</b>
          </div>
        )}
      </Sec>
      <ForesightCard />
      <TheoselectCard />
      {abyssOpen(S) && (
        <Sec title="星渊监视" hint="卡 H2 暗线">
          <div style={{ display: 'flex', gap: 4, margin: '4px 0 10px' }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: 6,
                  borderRadius: 3,
                  background: i <= lv ? (lv >= 3 ? '#d0685f' : '#8a6abf') : '#ffffff12',
                  boxShadow: i <= lv && lv >= 3 ? '0 0 8px #d0685f88' : 'none',
                  transition: 'background .4s',
                }}
              />
            ))}
          </div>
          <div className="pnl-row">
            <span>魔气浓度</span>
            <b style={{ color: lv >= 3 ? 'var(--crimson)' : 'var(--star)' }}>
              {leakName(lv)}（{lv}/5）
            </b>
          </div>
          {S.abyss && S.abyss.sealed > 0 && (
            <div className="pnl-row">
              <span>历史封印</span>
              <b>{S.abyss.sealed} 次</b>
            </div>
          )}
          {lv >= 3 && (
            <div className="pnl-row note">
              <b style={{ color: 'var(--crimson)' }}>裂隙临界——封魔符可暂压地脉。</b>
            </div>
          )}
        </Sec>
      )}
      <IntelWebCard />
      <DiplomacyGrid />
      <Sec title="世界历史" w={3} hint="因果存档">
        {S.history.length ? (
          S.history.map((e, i) => (
            <div key={i}>
              <div className="pnl-row">
                <span>{e.d}</span>
                <b>{e.c}</b>
              </div>
              {e.r && (
                <div className="pnl-row note">
                  <b>{e.r}</b>
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="pnl-row note">
            <b>历史尚未开始书写。</b>
          </div>
        )}
      </Sec>
    </>
  );
}

/* ============================================================
   地图面板（旅人朱印 · 雾玻璃 —— 方案四适配版定稿）
   样稿：outputs/地图页-5方案/方案四-司务-雾玻璃适配.html
   ------------------------------------------------------------
   四层横滑钻取退役，改三块玻璃浮岛：大陆与地区（左）｜地点列表（中）｜地点情报（右）。
   玻璃材质与 SheetHost 浮层同源（#151e32 渐变 + blur18 + 饱和度提升 + 内高光），
   规则集中在 shell.css 的「地图页 · 旅人朱印」段；地图页的压暗层单独放轻一档——
   玻璃要有东西可磨。

   与旧版（E2 四层轨）的逻辑一一对应，一行没少：
     分层来自 data/regions.ts，可达性来自 systems/travel/Travel.ts，内容全读 geo.json。
     travel 三态走 reach()（这里 / 直达 / 需中转 / 到不了）：中转**可点**，且
     「前往」只走第一段——go() 每一跳都要结算夜间遇袭与城卫盘查，自动连跳会吞掉。
     加一块大陆或地区 = 改 JSON，本文件一行不动。

   状态：cont / area / loc 三个选中值**同屏可见**（不再有"层"与横滑轨）。
     进页与换址都默认落在「我在的地方」——详情栏打开就是脚下这一站；
     顶部圆点钻取与「点一行进下一层」的提示语随之退役。
   ============================================================ */
import { useEffect, useRef, useState } from 'react';
import { WB } from '@/data/worldBook';
import {
  allEntries,
  canDepart,
  canEnter,
  continentLockReason,
  sceneTime,
  world,
  DUNGEON_MAX_FLOOR,
  entryLockReason,
  entryUnlocked,
  reach,
  routeTo,
  theoselectView,
} from '@/world';
import { abilitiesOf, areaKind, areasIn, continentOf, orderedContinents, shopsAt, sitesIn } from '@/data/regions';
import { presentNPCs } from '@/systems/npc/Npcs';
import { formatMoney } from '@/systems/economy/Money';
import { useGame } from '@/store/useGame';

/** 能力标签 → 给人看的话。取值域由 regions.ts 的 LOCATION_ABILITIES 守卫。 */
const ABIL_TEXT: Record<string, string> = {
  urban: '城内',
  patrolled: '城卫巡逻',
  rest_lodging: '可过夜',
  rest_camping: '可露宿',
  drink: '可饮酒',
  pray: '可祈祷',
  shop: '有商铺',
  explore_wild: '野外探索',
  wilderness: '无遮蔽',
  explore_cave: '洞窟探索',
  backstreet: '暗巷',
  sacred: '圣地',
};

const locName = (id: string): string => WB.locations[id]?.name ?? id;

/** 三态可达性 → 一句话。中转要说清「经哪、共几刻」，不能笼统说「需经别处」。 */
function reachText(from: string, to: string): string {
  const r = reach(from, to);
  if (r.kind === 'here') return '你在这里';
  if (r.kind === 'direct') return `行程约 ${r.cost} 刻`;
  if (r.kind === 'via') return `经 ${locName(r.path[1])} · 共 ${r.cost} 刻`;
  return '尚无通路';
}

export function MapPanel() {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  const setTab = useGame((s) => s.setTab);
  const t = sceneTime(S);

  /* 三个选中值。惰性初始化直接落在「我在的地方」：
     旧版为此写过一条注释——若默认给空、等挂载后的 effect 再改，
     面板头 40ms 会显示错误的层。三栏同屏后同理，默认值必须在 useState 里就位。 */
  const home = (): { cont: string; area: string; loc: string } => {
    const h = WB.locations[S.player.loc];
    if (h) return { cont: h.continent ?? '中央大陆', area: h.area, loc: S.player.loc };
    const c0 = orderedContinents()[0];
    const a0 = areasIn(c0)[0] ?? '';
    return { cont: c0, area: a0, loc: sitesIn(c0, a0)[0] ?? '' };
  };
  const [sel, setSel] = useState(home);

  /* 玩家换了地方 → 选中值回不回「我在的地方」要看玩家自己选了哪：
     选的是脚下（默认态）就跟从换址回脚下；选的是别处（多半是在赶路——
     选中了目的地一路点「走到下一站」）就**保持他的选择**，让他连点即可，
     不必每走一段都重新点一遍目的地（2026-09-29 实测的连走摩擦）。 */
  const prevLoc = useRef(S.player.loc);
  useEffect(() => {
    if (prevLoc.current === S.player.loc) return;
    const followed = sel.loc === prevLoc.current;
    prevLoc.current = S.player.loc;
    if (followed) setSel(home());
    /* sel 刻意不入依赖：这里只响应「玩家所在地变了」这一件事，
       sel 读的是触发时刻的选中值（本配置 eslint 未启用 exhaustive-deps 规则）。 */
  }, [S.player.loc]);

  const { cont, area, loc } = sel;
  const here = WB.locations[S.player.loc];
  const ts = theoselectView(S);
  const conts = orderedContinents();
  const sites = sitesIn(cont, area);

  const pickCont = (c: string) => {
    const a0 = areasIn(c)[0] ?? '';
    setSel({ cont: c, area: a0, loc: sitesIn(c, a0)[0] ?? '' });
  };
  const pickArea = (a: string) => {
    setSel((s) => ({ ...s, area: a, loc: sitesIn(s.cont, a)[0] ?? '' }));
  };

  /* ── 左栏 · 大陆与地区 ── */
  const gutter = (
    <nav className="m3-pane m3-gut" aria-label="大陆与地区">
      <div className="m3-g">大 陆</div>
      {conts.map((c) => {
        const def = WB.continents.items[c];
        const why = continentLockReason(c);
        const hub = def?.hub;
        /* 远行入口只挂在「锁着但有通路」的界上（与旧版一致）：这是去枢纽港的船票 */
        const route = hub && why ? routeTo(hub) : null;
        const chk = route ? canDepart(route.id) : null;
        const nAreas = areasIn(c).length;
        const nLocs = Object.keys(WB.locations).filter((id) => continentOf(id) === c).length;
        return (
          <button
            key={c}
            className={'m3-rl' + (c === cont ? ' on' : '') + (why ? ' lk' : '')}
            title={why ?? undefined}
            onClick={() => pickCont(c)}
          >
            <span className="n">
              {c}
              {c === here?.continent && <em className="now">当前</em>}
            </span>
            <span className="meta">{why ? '未解锁' : `${nAreas} 地区 · ${nLocs} 地点`}</span>
            {route && (
              <span
                className="m3-go-stamp"
                onClick={(e) => {
                  e.stopPropagation();
                  if (chk?.ok) cmd({ type: 'ui', a: 'depart', p: { id: route.id } });
                }}
                style={{ opacity: chk?.ok ? 1 : 0.5 }}
                title={chk?.ok ? '乘船远行至' + locName(hub) : '尚无通路'}
              >
                {chk?.ok ? `远行 ${formatMoney(route.cost)}` : '尚无通路'}
              </span>
            )}
          </button>
        );
      })}
      {ts.open && (
        <button className="m3-special" onClick={() => cmd({ type: 'sceneAction', k: 'theoselect_menu' })}>
          <span className="seal2" style={{ background: '#8a6abf' }}>
            斗
          </span>
          <span className="tx">
            <b>星枢五塔 · 星斗台</b>
            <span className="k">
              百年神选 · 第 {ts.cycle} 届 · {ts.stage}
              {ts.daysLeft >= 0 ? `　余 ${ts.daysLeft} 日` : '　已定局'}
            </span>
            <span className="k3">{ts.rank ? `你列第 ${ts.rank} 名` : '查看赛程与排名'}</span>
          </span>
        </button>
      )}

      <div className="m3-g">地 区 · {cont}</div>
      {areasIn(cont).map((a) => {
        const ids = sitesIn(cont, a);
        const danger = Math.max(...ids.map((id) => WB.locations[id].danger || 0));
        return (
          <button key={a} className={'m3-rl' + (a === area ? ' on' : '')} onClick={() => pickArea(a)}>
            <span className="n">
              {a}
              {a === here?.area && <em className="now">当前</em>}
            </span>
            <span className="meta">
              {areaKind(cont, a)} · {ids.length} 个地点
            </span>
            <span className={'m3-stamp' + (danger ? ' dg' : '')}>{danger ? '★' + danger : '安'}</span>
          </button>
        );
      })}
    </nav>
  );

  /* ── 中栏 · 地点列表 ── */
  const rows = (
    <div className="m3-pane m3-rows">
      <div className="m3-seg">
        <b>{area}</b>
        <span className="k">
          {areaKind(cont, area)} · {sites.length} 个地点
        </span>
        <span className="zhu">★ 为危险度</span>
      </div>
      {sites.map((id) => {
        const L = WB.locations[id];
        const r = reach(S.player.loc, id);
        const enters = allEntries().some((e) => e.locId === id);
        return (
          <button key={id} className={'m3-rg' + (id === loc ? ' on' : '')} onClick={() => setSel((s) => ({ ...s, loc: id }))}>
            <span className="seal2" style={{ background: L.color }}>
              {L.sv}
            </span>
            <span className="tx">
              <span className="nm">{L.name}</span>
              <span className="mt">
                {/* 右上 stamp 在「你在这里」时也写同一句，副行换话——
                    否则可访问名里「你在这里」连读两遍（读屏/测试定位都会撞）。 */}
                {r.kind === 'here' ? '当前所在' : reachText(S.player.loc, id)}
                {enters ? ' · 有地下城入口' : ''}
              </span>
            </span>
            <span className={'m3-stamp' + (r.kind === 'here' ? ' now' : L.danger ? ' dg' : '')}>
              {r.kind === 'here' ? '你在这里' : L.danger ? '★'.repeat(L.danger) : '安全'}
            </span>
          </button>
        );
      })}
      {!sites.length && <div className="m3-empty">这一带还没有探明的地点</div>}
    </div>
  );

  /* ── 右栏 · 地点情报（选中地点的详情）── */
  const mark = (() => {
    if (!loc || !WB.locations[loc]) return <div className="m3-empty">还没有选中地点</div>;
    const L = WB.locations[loc];
    const r = reach(S.player.loc, loc);
    const shops = shopsAt(loc);
    const npcs = presentNPCs(loc, S).slice(0, 6);
    const abils = abilitiesOf(loc).map((a) => ABIL_TEXT[a]).filter(Boolean);
    const entries = allEntries().filter((e) => e.locId === loc);
    const best = S.dungeon?.best || 0;
    const desc = L.desc?.[0];
    const blocked = !canEnter(loc, S)
      ? (continentLockReason(continentOf(loc), S) ?? '那块大陆尚未开放')
      : '这里没有可走的路线';

    return (
      <aside className="m3-pane m3-mark">
        <div className="m3-h">
          <span className="seal2" style={{ background: L.color }}>
            {L.sv}
          </span>
          <span className="t">
            <b>{L.name}</b>
            <span>
              {cont} › {area}
            </span>
          </span>
        </div>
        {desc && <div className="m3-body">{desc}</div>}
        <div className="m3-kv">
          <span>危</span>
          <b className="star">{'★'.repeat(L.danger || 0) || '无'}</b>
        </div>
        <div className="m3-kv">
          <span>程</span>
          <b className={r.kind === 'here' ? 'now' : r.kind === 'via' ? 'via' : ''}>{reachText(S.player.loc, loc)}</b>
        </div>

        {r.kind === 'via' && (
          <>
            <div className="m3-sec">怎么走 · 共 {r.cost} 刻 · {r.path.length - 1} 段</div>
            <div className="m3-route">
              {r.path.map((id, i) => (
                <span className="seg" key={id + i}>
                  {i > 0 && <em>→</em>}
                  <b className={i === 0 ? 'now' : i === r.path.length - 1 ? 'end' : ''}>{locName(id)}</b>
                </span>
              ))}
            </div>
            {/* 2026-09-29 实测：中转地点只有「走到下一站」，没有一句话解释为什么不能直达，
                首次使用的玩家会在这里迷路（选了地方、找不到出发的按钮）。 */}
            <div className="m3-body" style={{ opacity: 0.75, marginTop: 6 }}>
              中间隔着别处，一步只能走一段——点「走到下一站」先到邻近街区，到了再继续。
            </div>
          </>
        )}

        {abils.length > 0 && (
          <>
            <div className="m3-sec">能做的事</div>
            <div className="m3-chips">
              {abils.map((a) => (
                <span key={a} className="m3-chip">
                  {a}
                </span>
              ))}
            </div>
          </>
        )}

        {shops.length > 0 && (
          <>
            <div className="m3-sec">这里的铺面</div>
            <div className="m3-list">
              {shops.map((sh) => (
                <div className="m3-row" key={sh.id}>
                  <span className="dot" style={{ background: '#3f7d5f' }} />
                  <span className="nm">{sh.name}</span>
                  <span className="mt">可交易</span>
                </div>
              ))}
            </div>
          </>
        )}

        {npcs.length > 0 && (
          <>
            <div className="m3-sec">此刻在场</div>
            <div className="m3-list">
              {/* 这份名单可直接开口（与左栏同一个 npcTalk 命令，零新通道） */}
              {npcs.map((n) => (
                <button
                  className="m3-row clickable"
                  key={n.id}
                  title={'与' + n.name + '交谈'}
                  onClick={() => cmd({ type: 'npcTalk', id: n.id })}
                >
                  <span className="dot" style={{ background: 'var(--star)' }} />
                  <span className="nm">{n.name}</span>
                  <span className="mt">{n.title ?? ''}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {entries.length > 0 && (
          <>
            <div className="m3-sec">地下城网络（{DUNGEON_MAX_FLOOR} 层）</div>
            <div className="m3-list">
              {entries.map((e) => {
                const ok = entryUnlocked(e, S);
                const why = entryLockReason(e, S);
                return (
                  <div className="m3-row" key={e.id} style={{ opacity: ok ? 1 : 0.6 }}>
                    <span className="dot" style={{ background: ok ? '#4a3d5c' : '#3a3a44' }} />
                    <span className="nm">
                      {e.name}
                      <em>
                        　自第 {e.startFloor} 层切入 · 层志最深 第 {best} 层
                      </em>
                      {!ok && why ? <em className="warn"> · {why}</em> : null}
                    </span>
                    <button
                      className="go"
                      disabled={!ok || r.kind !== 'here'}
                      onClick={() => cmd({ type: 'sceneAction', k: 'enter_dungeon' })}
                    >
                      {!ok ? '未开放' : r.kind === 'here' ? '下潜' : '需抵达'}
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="m3-cta">
          {r.kind === 'here' && (
            <>
              <button className="m3-go" disabled>
                你正在此处
              </button>
              <button className="m3-go ghost" onClick={() => cmd({ type: 'sceneAction', k: 'observe' })}>
                观察环境
              </button>
            </>
          )}
          {r.kind === 'direct' && (
            <button
              className="m3-go"
              onClick={() => {
                cmd({ type: 'travel', loc });
                /* 直达即收图（可玩性实测 P3）：go() 同步结算，返回时地点已变即为抵达，
                   玩家的导航意图到此完结，不再让整屏的面板挡着输入条。
                   中转跳（走到下一站）刻意不收——连走是它存在的意义；
                   被未解锁/盘查/狼袭打断时地点没变，同样不收，先读反馈。 */
                if (world.query.get_world_state()!.player.loc === loc) setTab('main');
              }}
            >
              前往（{r.cost} 刻）
            </button>
          )}
          {r.kind === 'via' && (
            <button className="m3-go" onClick={() => cmd({ type: 'travel', loc: r.path[1] })}>
              走到下一站：{locName(r.path[1])}（{WB.travel[S.player.loc][r.path[1]]} 刻）
            </button>
          )}
          {r.kind === 'unreachable' && (
            <button className="m3-go" disabled>
              去不了 · {blocked}
            </button>
          )}
        </div>
      </aside>
    );
  })();

  return (
    <div className="m3">
      {/* 朱印落款条：页题在 sh-head（行止 / 已探地点与远行），这里只盖旅印与年月 */}
      <div className="m3-mast">
        <span className="m3-seal">旅</span>
        <span className="m3-count">
          已探明 <b className="num">{Object.keys(WB.locations).length}</b> 处地点
        </span>
        <span className="m3-docn num">
          {t.year} 年 · {t.month}
          <br />
          冒险者公会 · {here?.area ?? area}
        </span>
      </div>

      <div className="m3-ledger">
        {gutter}
        {rows}
        {mark}
      </div>

      {/* ============================================================
          卡 P2 · 从「系统」页迁来的两张卡，收进通栏：
          四方（通讯/时之缝隙/风土/冒险账本）关乎"外面有什么"，
          七塔分置关乎"塔在哪座城"——都要看着地图读。
          ============================================================ */}
      <footer className="m3-foot">
        <button onClick={() => cmd({ type: 'ui', a: 'cm_menu', p: {} })}>
          <b>通讯</b>
          <span>八种手段 · 距费时效</span>
        </button>
        <button onClick={() => cmd({ type: 'ui', a: 'tl_menu', p: {} })}>
          <b>时之缝隙</b>
          <span>内外流速 · 闭关计价</span>
        </button>
        <button onClick={() => cmd({ type: 'ui', a: 'cu_menu', p: {} })}>
          <b>风土</b>
          <span>吃食服饰与禁忌</span>
        </button>
        <button onClick={() => cmd({ type: 'ui', a: 'ad_menu', p: {} })}>
          <b>冒险账本</b>
          <span>投入产出 · 财富分布</span>
        </button>
        <button onClick={() => cmd({ type: 'ui', a: 'net_towers', p: {} })}>
          <b>星枢七塔</b>
          <span>连名星符通行</span>
        </button>
      </footer>
    </div>
  );
}

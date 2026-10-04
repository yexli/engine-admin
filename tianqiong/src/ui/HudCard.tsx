import { WB } from '@/data/worldBook';
import { attColor, attOf, attWord, maxHp, maxMp, npcActNow, presentNPCs, rankName, sceneTime, world, xpNeed } from '@/world';
import { statusName } from '@/systems/character/Status';
import { formatMoney } from '@/systems/economy/Money';
import type { StatusId } from '@/types/world';
import { Fragment, useState } from 'react';
import { useGame } from '@/store/useGame';
import { useDesk } from './useDesk';
import { ActionDock } from './ActionDock';

/* ============================================================
   左列 HUD（方案 B 定稿 · DOM 与类名逐字对齐原型 #hud-col）
   ------------------------------------------------------------
   .hud-card = 印章 + 三条状态轨 + 胶囊 + 四个快捷按钮
   .chronicle = 今日纪年时间轴

   一处必须偏离原型的地方：原型第三条轨写的是「体力饱食」，
   那是我在原型里编的占位——core 的 PlayerState 没有这个字段
   （逐条核过 types/world.ts）。落地改成**经验**：同样是第三条轨、
   同样是真实数据，不造一个没有写入者的属性。

   类名 .who/.seal/.ring 改成 .hud-who/.hud-seal/.hud-ring：
   它们分别是 chat.css / app.css 标题屏 / app.css 日晷环占用的名字。
   ============================================================ */
const RING_CLS = ['hp', 'mp', 'sp'] as const;

/* 此刻在场（2026-09 自叙事列末尾迁入）——
   它属于"此刻"，和动作区同一组信息；放在叙事流尾巴上会被滚走，
   左栏常驻反而更合它"知道谁在"的用途。态度用名字的颜色表示，当前动作放进 title。 */
/* 在场名单上限：实测酒馆在 10-11 时可同时站 16–20 人（63 名无日程者 hours=[0,12] 全天在岗），
   全量列出来是噪音而不是信息。超出部分折成一行「另有 N 人」——
   想知道还有谁、想直接开口，去地图页的「此刻在场」（那里同样可点）。 */
const CAST_MAX = 6;
function CastNow() {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  const all = presentNPCs(S.player.loc);
  if (!all.length) return null;
  const ps = all.slice(0, CAST_MAX);
  const rest = all.length - ps.length;
  return (
    <div className="cast-side">
      <h6>此 刻 在 场</h6>
      <div className="row">
        {ps.map((n, i) => {
          const act = npcActNow(n.id, S);
          const att = attWord(attOf(n.id, S));
          /* 分隔符挂在名字**之后**（悬挂标点）：挂在前面时换行会把「· 德伦」
             整个甩到行首，一行以分隔符开头。行尾的「·」没有这个问题。 */
          const tail = i < ps.length - 1 || rest > 0;
          return (
            <Fragment key={n.id}>
              <button
                className="who"
                style={{ color: attColor(attOf(n.id, S)) }}
                title={att + (act ? ' · 正在' + act : '')}
                onClick={() => cmd({ type: 'npcTalk', id: n.id })}
              >
                {n.name}
              </button>
              {tail && <span className="sep">·</span>}
            </Fragment>
          );
        })}
        {rest > 0 && <span className="more">另有 {rest} 人</span>}
      </div>
    </div>
  );
}

export function HudCard() {
  const S = world.query.get_world_state()!;
  const t = sceneTime(S);
  const setTab = useGame((s) => s.setTab);
  const setBag = useGame((s) => s.setBag);
  const desk = useDesk();
  /* 窄屏角色卡折叠的开关（⌄）：CSS 一直有这套折叠设计（.hud-card.open），
     但组件从来没切过这个类——折叠等于没做（2026-09 补上）。
     窄屏点身份行 = 展开/收起；桌面点击仍是跳转角色页（窄屏跳角色页走
     底部标签栏与展开后的「属性技能」，入口没有少）。 */
  const [open, setOpen] = useState(false);
  const whoActivate = () => (desk ? setTab('char') : setOpen((o) => !o));

  const hp = Math.max(0, S.player.hp);
  const mhp = maxHp(S);
  const mp = Math.max(0, S.player.mp);
  const mmp = maxMp(S);
  const need = xpNeed(S);
  const pct = (v: number, m: number) => Math.round(Math.max(0, Math.min(1, m ? v / m : 0)) * 100) + '%';

  /* 身份行：职业 · 境界 · 等级。职业链首阶的称号与职业名同字（战士 →「战士」），
     直接拼会印出「战士 · 战士」——重复没有信息量，同名时省掉境界那一段。 */
  const cls = WB.classes[S.player.cls]?.name ?? S.player.cls;
  const rank = rankName(S);
  const ident = rank && rank !== cls ? cls + ' · ' + rank + ' · Lv.' + S.player.level : cls + ' · Lv.' + S.player.level;

  const rings = [
    { k: '生命', v: hp, m: mhp },
    { k: '法力', v: mp, m: mmp },
    { k: '经验', v: S.player.exp, m: Number.isFinite(need) ? need : 0 },
  ];

  /* 任务数的是待办而非接单史：Quests.turnIn 只把 stage 改成 fin、从不删条目 */
  const quests = Object.entries(S.player.quests || {}).filter(
    ([id, st]) => st.stage !== 'fin' && WB.quests[id],
  ).length;

  /* 今日纪年已搬到「纪闻」页（右栏面板）：左栏只留"我是谁 / 我在哪 / 此刻能做什么"，
     时间轴那类"发生过什么"归到面板里读——见 panels/NewsPanel.tsx 的 JinianCard。 */

  return (
    <aside id="hud-col">
      <div className={'hud-card' + (open ? ' open' : '')}>
        <div
          className="hud-who"
          role="button"
          tabIndex={0}
          title={desk ? '查看角色详情' : '展开 / 收起'}
          onClick={whoActivate}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              whoActivate();
            }
          }}
        >
          <span className="hud-seal">
            <i>{(S.player.name || '无').charAt(0)}</i>
          </span>
          <span className="hud-tx">
            <b>{S.player.name}</b>
            <span>{ident}</span>
          </span>
        </div>

        {rings.map((r, i) => (
          <div className="hud-ring" key={r.k} style={i === rings.length - 1 ? { marginBottom: 0 } : undefined}>
            <div className="lb">
              <span>{r.k}</span>
              <b>
                {r.v} / {r.m || '—'}
              </b>
            </div>
            <div className={'rbar ' + RING_CLS[i]}>
              <i style={{ width: r.m ? pct(r.v, r.m) : '0%' }} />
            </div>
          </div>
        ))}

        <div className="badges">
          <span className="g">{formatMoney(S.player.gold)}</span>
          <span>{S.weather}</span>
          <span>{t.period}</span>
          {S.player.wanted > 0 && <span className="r">通缉 {S.player.wanted}</span>}
          {quests > 0 && <span className="g">任务 {quests}</span>}
          {(S.player.effects ?? []).map((e) => (
            <span className="j" key={e.id} title={'剩余 ' + (e.left ?? '永久') + ' 刻'}>
              {statusName(e.id as StatusId)}
            </span>
          ))}
        </div>

        <div className="hud-acts">
          <button onClick={() => setTab('char')}>属性技能</button>
          <button onClick={() => setTab('map')}>行止地图</button>
          <button onClick={() => setBag(true)}>行囊</button>
          <button onClick={() => setTab('quest')}>委托</button>
        </div>
      </div>

      <CastNow />

      {/* 丁 · 竖排边注：动作区接在"此刻在场"之后，占满这一列剩下的高度。
          窄屏时它自己在底部渲染成横排——两态由 useWide 决定谁出现，同一份快捷键不会绑两次。 */}
      <ActionDock show variant="side" />
    </aside>
  );
}


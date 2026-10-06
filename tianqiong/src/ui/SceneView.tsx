import { bus, periodSeg, rich, sceneTime, stationAt, stationGate, world } from '@/world';
/* 与 MapPanel 同一来源：能力表属数据层，UI 直接读数据（引擎才走 @/world） */
import { abilitiesOf } from '@/data/regions';
import { formatMoney } from '@/systems/economy/Money';
import { gateway } from '@/ai/gateway';
import { applyWeaveOverride } from '@/plugins/sessionWeave';
import { useGame } from '@/store/useGame';
import type { WorldState } from '@/types/world';
import { Fragment, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { LogEntry } from '@/types/world';

/** 动作坞的组（谁声明谁归组：组名不该由 UI 反猜 key） */
export type ActGroup = 'act' | 'talk' | 'lore';

export interface Act {
  l: string;
  k: string;
  s: string;
  dg?: boolean;
  /** 归属组；缺省 = 'act'（「行动」）。新增动作只在这里写一次，UI 不必跟着改。 */
  g?: ActGroup;
}

/** 回显行的折叠阈值（UX-001 · 2026-09-29 实测）：520 字的测试输入铺满整个首屏，
    移动端更甚。超过就收成前 60 字 + 字数角标，点按展开/收起——原话锚点还在
    （未知轮吞输入的回归依赖它可见），只是不再占据一整屏。 */
const ECHO_FOLD = 60;

function EchoLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const body = text.slice(1).trim();
  if (body.length <= ECHO_FOLD) {
    return <p className="nar-p say" dangerouslySetInnerHTML={{ __html: rich(text) }} />;
  }
  return (
    <p
      className="nar-p say echo"
      onClick={() => setOpen((v) => !v)}
      role="button"
      aria-expanded={open}
      title={open ? '收起原话' : '展开原话'}
    >
      {open ? (
        <span dangerouslySetInnerHTML={{ __html: rich(text) }} />
      ) : (
        <>
          <span dangerouslySetInnerHTML={{ __html: rich('＞ ' + body.slice(0, ECHO_FOLD) + '……') }} />
          <button className="echo-more">（{body.length}字 · 展开）</button>
        </>
      )}
    </p>
  );
}

/**
 * 一条见闻按类型排版（小说式布局的三类非叙事消息规范，见样稿）：
 *   叙事 / 对白 / AI —— 正文段落，首行缩进两格，连排；
 *   收获 / 损失 —— 无底色的单行小字（可能连着好几条，做成块会把书页切成碎片）；
 *   系统提示 —— 退到最外层：斜体灰字 + 左线。
 */
function renderLogEntry(e: LogEntry) {
  const cls = e.cls || 'nar';
  const html = { __html: rich(e.text) };
  if (cls === 'gain' || cls === 'bad') return <p className={'nar-p flag ' + cls} key={e.id} dangerouslySetInnerHTML={html} />;
  if (cls === 'sys') return <p className="nar-p sys" key={e.id} dangerouslySetInnerHTML={html} />;
  if (cls === 'ai')
    return (
      <p className="nar-p ai" key={e.id}>
        <span dangerouslySetInnerHTML={html} />
        <span className="ai-tag">✦ AI</span>
      </p>
    );
  /* 玩家回显行（「＞ …」say）：超长折叠（UX-001），其余照旧 */
  if (cls === 'say' && e.text.startsWith('＞')) return <EchoLine key={e.id} text={e.text} />;
  return <p className={'nar-p' + (cls === 'say' ? ' say' : '')} key={e.id} dangerouslySetInnerHTML={html} />;
}

/* ============================================================
   卡 P3 · 行动坞的数据驱动（能力 → 按钮）
   LocationDef.abilities 的注释早就写过：这些 if (loc === '…') 每加一个地区都要回来改，
   地区的机制因此不可复用；规整后新增地点 = 在 geo.json 标好 abilities。
   ============================================================ */
interface ActDef {
  k: string;
  l: string;
  s: string;
  g?: ActGroup;
  gold?: number;
  goldPerWanted?: number;
  wantedOnly?: boolean;
  dg?: boolean;
}

/* 分组口径（三组，见 ActGroup）：
     行动 = 对**这个地方**做的事（观察 / 搜索 / 住宿 / 探索 / 动手）；
     交涉 = 与**人、店、神殿**打交道（打听 / 买卖 / 祈祷 / 治疗 / 兑换）；
     秘录 = 与当前地点无关的**常驻入口**（藏书 / 星枢 / 神选）——它们原先被
            PARLEY_KEYS 一并按"交涉"分发，于是"翻阅藏书"坐在"打听消息"旁边。 */
const ACTS_OF_ABILITY: Record<string, ActDef[]> = {
  gossip: [{ k: 'gather_intel', l: '打听消息', s: '感知检定 · 情报 +1', g: 'talk' }],
  rest_lodging: [{ k: 'rest_inn', l: '住宿', s: '睡到天亮·全恢复', gold: 20 }],
  drink: [{ k: 'drink', l: '喝一杯', s: '听邻桌的闲话', gold: 5 }],
  shop: [{ k: 'shop_grocer', l: '逛杂货摊', s: '买药与补给', g: 'talk' }],
  pray: [{ k: 'pray', l: '祈祷', s: '恢复法力', g: 'talk' }],
  heal: [{ k: 'heal_svc', l: '治疗', s: '恢复全部生命', gold: 100, g: 'talk' }],
  theoselect: [{ k: 'theoselect_menu', l: '百年神选', s: '报名 · 五殿设坛', g: 'lore' }],
  starnet: [{ k: 'starnet', l: '星符 · 入星枢', s: '意识投影·无伤比斗·星市', g: 'lore' }],
  explore_wild: [
    { k: 'explore_wild', l: '探索旷野', s: '遇敌·拾获·采集' },
    { k: 'gather', l: '采集药草', s: '寻找月见草' },
  ],
  rest_camping: [{ k: 'rest_wild', l: '打盹', s: '恢复一半·有风险' }],
  explore_cave: [
    { k: 'explore_cave', l: '深入探索', s: '魔物·宝藏·危险' },
    { k: 'enter_dungeon', l: '下潜地下城', s: '100 层 · 五主题分层' },
  ],
  pickpocket: [{ k: 'steal', l: '顺手牵羊', s: '敏捷检定·失败即被捕', dg: true }],
  pay_fine: [{ k: 'payfine_go', l: '缴罚金', s: '销案', goldPerWanted: 300, wantedOnly: true }],
  exchange: [{ k: 'exchange_go', l: '星枢兑换所', s: '星币 ⇄ 铜 · 一大陆一家', g: 'talk' }],
};

/** 某地点按能力派生出的一组行动（纯函数，供叙事区与测试共用） */
export function actsOfLocation(loc: string, wanted: number): Act[] {
  const out: Act[] = [];
  for (const ab of abilitiesOf(loc)) {
    for (const d of ACTS_OF_ABILITY[ab] ?? []) {
      if (d.wantedOnly && wanted <= 0) continue;
      const price = d.goldPerWanted ? d.goldPerWanted * wanted : d.gold;
      out.push({ l: price ? d.l + ' · ' + formatMoney(price) : d.l, k: d.k, s: d.s, dg: d.dg, g: d.g });
    }
  }
  return out;
}

/** 完整行动清单（纯函数）。底部动作坞与叙事区共用一份，避免两处各自漂移。 */
export function actsForScene(S: WorldState, loc: string): Act[] {
  const acts: Act[] = [
    { l: '观察环境', k: 'observe', s: '感知检定·发现异常' },
    { l: '调查搜索', k: 'search', s: '翻找线索与遗留物' },
  ];
  acts.push(...actsOfLocation(loc, S.player.wanted));
  const st = stationAt(loc);
  if (st && stationGate(st, S).open) acts.push({ l: '进工坊 · ' + st.name, k: 'craft', s: '锻造 / 炼金 / 铭刻' });
  /* 「翻阅藏书」已并入「档案」页（书架入口在那里，走同一条 codex_open 命令）——
     底部/左栏的动作区只留"此刻在场景里能做的事"。 */
  return acts;
}

/* 时辰光罩：让场景插画随一日呼吸——晨青、昼薄、暮金、夜深。
   透明度刻意压在 .06–.46：插画是美术资产，这层只该调色温，不该盖住画。
   返回纯色而非渐变，因为渐变在 CSS 里不可插值，换时段会硬跳。 */
export function tintOf(h: number): string {
  if (h === 2 || h === 3) return 'rgba(84,108,170,.44)';      /* 破晓 · 拂晓 */
  if (h === 4 || h === 5) return 'rgba(168,196,226,.28)';     /* 清晨 · 早晨 */
  if (h >= 6 && h <= 8) return 'rgba(255,248,232,.06)';       /* 正午 · 午后 */
  if (h === 9 || h === 10) return 'rgba(232,146,66,.28)';     /* 黄昏 · 入夜 */
  /* 剩下的 h = 11 / 0 / 1 走夜色。不能写成 h >= 9——时辰取模，
     子时是 0 而不是 12，写成区间会把半夜判成白昼。 */
  return 'rgba(38,56,124,.46)';
}

/* ============================================================
   主视图 · 叙事流（方案 B 定稿）
   ------------------------------------------------------------
   两处与旧版相反的取舍，都是 B 的定义，写在这里以防被"顺手改回去"：

   ① 顺序：见闻录改为**正序**（旧→新，最新在下）。B 的叙事是一条向下生长的流，
      不是一条倒序的日志——新发生的事出现在刚读过的那段下方，视线不需要跳。
      代价：这推翻了 §9#6 那条"倒序 + sticky-bottom + ↓N 条新见闻"的旧结论，
      那条结论成立的前提正是倒序（倒序下"滚到底"=停在最老的历史上）。

   ② 滚动：新条目到达即跟到最新。因为顺序已改正序，"跟到最新"就是"跟到刚发生的事"，
      不再有旧实现那个"行动后跳到最老历史"的问题。
   ============================================================ */
export function SceneView() {
  const S = world.query.get_world_state()!;

  /* 世界一变就重渲染（最短路径，不依赖镜像链是否完好） */
  const seenSeqRef = useRef<number | undefined>(S.logSeq);
  const [, bumpLogView] = useReducer((n: number) => n + 1, 0);
  useEffect(
    () =>
      bus.on((e) => {
        if (e.type !== 'changed') return;
        const n = world.query.get_world_state()?.logSeq;
        if (n !== seenSeqRef.current) {
          seenSeqRef.current = n;
          bumpLogView();
        }
      }),
    [],
  );

  const loc = S.player.loc;
  const t = sceneTime(S);

  /* 进入场景叙事：LLM 通道可用则异步生成（带角标），否则规则文本 */
  const aiNarr = useGame((s) => s.aiNarr);
  const setAiNarr = useGame((s) => s.setAiNarr);
  const seg = periodSeg(t.h);
  const narrKey = loc + ':' + t.day + ':' + seg;
  useEffect(() => {
    const p = gateway.active();
    if (!gateway.hasLlm() || !p.narrativeAsync) return;
    if (useGame.getState().aiNarr.key === narrKey) return;
    setAiNarr({ key: narrKey, text: null });
    p.narrativeAsync('enter', { loc }).then((txt) => {
      if (txt && useGame.getState().aiNarr.key === narrKey) setAiNarr({ key: narrKey, text: txt });
    });
  }, [narrKey]);
  const llmNar = aiNarr.key === narrKey ? aiNarr.text : null;
  const nar = useMemo(() => llmNar ?? gateway.active().narrative('enter', { loc }), [llmNar, loc, t.day, seg]);

  /* ---- 滚动：正序 + 跟到最新 + 翻历史时不打扰 ----
     旧实现是「倒序 + sticky-bottom + ↓N 条新见闻角标」，来源是 §9#6 那条
     用户实测反馈「行动后跳底影响体验」。但那条抱怨成立的前提是**倒序**——
     倒序下"滚到底"等于滚到最老的一条，于是跟进=把人拽回远古。
     顺序改正之后这个前提消失了：滚到底就是滚到刚发生的事。

     保留下来的是它另一半价值——用户主动上翻读历史时，新消息不该把他拽走。
     判据用 stickRef：贴底才跟，离底就不跟；玩家自己发起的行动（Composer /
     动作坞）走 act() → 日志变长，此时强制跟底，因为那正是他要看的结果。 */
  const logLen = useGame((s) => s.logSeq);
  const prevLenRef = useRef(logLen);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = document.getElementById('story');
    if (!el) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  /* 换地点是玩家主动发起的位移：新地点的那段叙事必须被看到，
     所以强制贴底一次。这一条要排在下面的 logLen 效应之前——
     两者在同一次 commit 里跑，顺序决定 stickRef 读到的值。 */
  const prevLocRef = useRef(loc);
  useEffect(() => {
    if (prevLocRef.current === loc) return;
    prevLocRef.current = loc;
    stickRef.current = true;
  }, [loc]);

  useEffect(() => {
    const delta = logLen - prevLenRef.current;
    prevLenRef.current = logLen;
    if (delta <= 0) return;
    const el = document.getElementById('story');
    if (!el) return;
    if (!stickRef.current) return; // 正在翻历史，不打扰
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [logLen]);

  /* 见闻录按「时刻」分段：一个时刻一批条目，每条按自己的类型排版（叙事 / 对白 / 系统 / 收获）。
     时刻标记只在**时刻变化时**出现一次，同日只显示时辰——原先每条消息都带一遍完整时刻戳，
     同刻连发就重复三四遍，叙事被切成清单而不是文章。 */  const weaveFrom = useGame((s) => s.weaveFrom);
  /* 流式草稿：模型正在吐的那半截正文（只在「流式输出」开着时才有值）。
     它顶掉的是「✦ 正在书写……」这行占位——逐字长出来的句子本身就是进度。 */
  const aiDraft = useGame((s) => s.aiDraft);
  /* 只认「写进见闻录的正文」两类草稿：台词归聊天浮层，入场描写归它自己那句角标 */
  const draft = aiDraft && (aiDraft.channel === 'weave' || aiDraft.channel === 'recap') ? aiDraft.text : '';
  /* 润色期间这一批**先不显示**：等 AI 把它织成小说段再一起出现。
     否则玩家会先看到系统回执、一两秒后被替换，读起来是闪的。
     没配模型时 core 根本不发 weave 事件，weaveFrom 恒为 null，原文即时显示。 */
  const visibleLog = useMemo(
    () =>
      (S.log || []).flatMap((e) => {
        /* meta = 内部标记（意图解析结果之类）：不是给玩家读的，也不参与叙事 */
        if (e.cls === 'meta') return [];
        if (weaveFrom !== null && (e.id ?? 0) > weaveFrom) return [];
        /* session 档的客户端编织覆盖（§30 表现层）：织后正文替换原条目、
           被吸收的条目隐藏。覆盖表为空（本地/bridge 档）= 原样通过。 */
        const w = applyWeaveOverride(e as never) as (typeof e) | null;
        return w ? [w] : [];
      }),
    [S.log, logLen, weaveFrom],
  );
  const logGroups = useMemo(() => {
    const out: { key: string; t: string; label: string; items: LogEntry[] }[] = [];
    let lastDay = '';
    for (const e of visibleLog) {
      const t = e.t || '';
      const [day, shichen] = t.split('·');
      const last = out[out.length - 1];
      if (last && last.t === t) last.items.push(e);
      else {
        /* 旧档的 log 条目可能没有 id（F-33 之前的档），退化时用时刻+序号兜底，
           否则同刻多组会撞同一个 key */
        out.push({ key: 'g' + (e.id ?? t + '#' + out.length), t, label: day === lastDay ? shichen || t : t, items: [e] });
        lastDay = day;
      }
    }
    return out;
    /* 依赖必须带 logLen（store 的 logSeq）：mutate.pushLog 是**原地 push**，
       S.log 的数组引用永远不变——只依赖它，memo 永不重算，交互后的消息就只能在
       刷新后才出现（已踩过一次）。logSeq 是单调计数器，是这类增量的正确信号。 */
  }, [visibleLog, logLen]);

  return (
    <>
      {/* 场景胶囊（2026-09 去重）：地名与时辰顶栏已经说了，左栏徽章里有天气——
          这里只留「天气 · 时段」给叙事列定调（时段光线恢复后，这行字与画面是同一时刻），
          地名 triple 重复（顶栏 + 胶囊 + 台词）读起来是清单。 */}
      <div className="sc-tag">
        ◈ {S.weather} · {t.period}
      </div>

      <div id="view-log" className="novel">
        {/* 场景入场叙事：换地点/换时段的一段印象。它不是"发生过的事"、不进 log，
            所以固定留在流的顶端；见闻录在它下面继续生长。 */}
        <p className={'nar-p opening' + (llmNar ? ' ai' : '')}>
          {nar}
          {llmNar && <span className="ai-tag">✦ AI 叙事</span>}
          {aiNarr.key === narrKey && !llmNar && gateway.hasLlm() && <span className="ai-tag">✦ AI 生成中…</span>}
        </p>

        {/* 见闻录：正序，最新在下。时刻标记 → 该时刻的各条消息（各按自己的类型排版） */}
        {logGroups.map((g) => (
          <Fragment key={g.key}>
            <div className="beat">{g.label}</div>
            {g.items.map((e) => renderLogEntry(e))}
          </Fragment>
        ))}

        {/* 写作占位：这一批原文已从界面撤下，必须有东西告诉玩家系统在工作，
            否则点完操作屏幕毫无变化，像是没生效 */}
        {weaveFrom !== null && (
          <p className={'nar-p writing' + (draft ? ' drafting' : '')}>
            {draft || '✦ 正在书写……'}
            {draft ? <i className="draft-caret" aria-hidden="true" /> : null}
          </p>
        )}
      </div>

      {/* 在场人物（.npc-chips）2026-09 迁到左栏：它属于"此刻"，与动作区同一组信息，
          放在叙事流的尾巴上会被滚走——左栏常驻反而更合它"知道谁在"的用途。 */}
      {/* 自由行动输入框（Composer）与动作坞（ActionDock）已固定在外壳底部——
          它们原先是叙事流的成员，会跟着正文滚出屏幕，而那是玩家最常碰的两处。
          原型的 .choices（"此刻你可以"）未移植：core 没有"当前可选剧情分支"这个数据源，
          造几条假选项来填满版式，比留白更糟。 */}
    </>
  );
}

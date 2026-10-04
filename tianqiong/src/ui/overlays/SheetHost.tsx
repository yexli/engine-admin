import { WB } from '@/data/worldBook';
import { memOf } from '@/memory';
import { attColor, attWord, bondOf, world, craftView, factionName, npcActNow, qualityColor, vendorCoin } from '@/world';
import { Money } from '../Money';
import { formatMoney } from '@/systems/economy/Money';
import type { OptDesc } from '@/types/uispec';
import { useGame } from '@/store/useGame';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../useFocusTrap';
import { artPath, ArtImage } from '../art/ArtImage';
import { CodexPanel } from '../panels/CodexPanel';
import { talkOf } from '@/data/talk';
import { topicGateOk } from '@/systems/npc/Talk';
import type { WorldState } from '@/types/world';

/* ============================================================
   SheetHost —— 原型 #ovl/.sheet 的 React 化：
   dialog（NPC 对话/立绘头图）、shop（买卖）、confirm（抉择）、
   combatItems（战斗道具）。全部由 core 发出的描述符驱动。
   ============================================================ */
export function SheetHost() {
  const sheet = useGame((s) => s.sheet);
  const cmd = useGame((s) => s.cmd);
  const sheetRef = useRef<HTMLDivElement>(null);
  /* Tab 焦点陷阱 + 焦点移入/归还：与行囊浮层共用同一份实现（ui/useFocusTrap） */
  useFocusTrap(sheetRef, !!sheet);
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cmd({ type: 'ui', a: 'close', p: {} });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet, cmd]);
  if (!sheet) return <div id="ovl" />;
  return (
    <div
      id="ovl"
      /* 对话是「进入一个场景」而不是「弹一张卡」：手机端满屏、桌面端窄高竖幅，
         纵横比贴近立绘（这是星穹剧场成立的物理前提）。 */
      /* 卡 N1：战斗道具面板必须压在战斗层（#cbt z-index 60）之上。
         此前 #ovl 是 50，面板渲染了、文字看得见，但指针事件全被战斗层吃掉——
         按钮点不动。层叠与 dialog.css 同一原则：显式声明，不靠 DOM 顺序碰运气。 */
      className={'on' + (sheet.kind === 'dialog' ? ' dlg' : '') + (sheet.kind === 'combatItems' ? ' ovl-cbt' : '')}
      ref={sheetRef}
      role="dialog"
      aria-modal="true"
      aria-label="交互浮层"
      onClick={(e) => {
        if (e.target === e.currentTarget) cmd({ type: 'ui', a: 'close', p: {} });
      }}
    >
      <div className={'sheet' + (sheet.kind === 'dialog' ? ' dlg-sheet' : '')} id="sheet">
        {sheet.kind === 'dialog' && <DialogBody desc={sheet} />}
        {sheet.kind === 'confirm' && (
          <>
            <div className="sh-h">
              <div className="sv" style={{ background: 'var(--star2)' }}>?</div>
              <div className="tt">
                <b>{sheet.title}</b>
              </div>
              <button className="x" onClick={() => cmd({ type: 'ui', a: 'close', p: {} })}>✕</button>
            </div>
            <div className="sh-b">
              <div className="dlg-t" dangerouslySetInnerHTML={{ __html: sheet.text }} />
              <div className="opts">
                {sheet.btns.map((b, i) => (
                  <button key={i} className={'opt' + (b.dg ? ' dg' : '')} onClick={() => cmd({ type: 'ui', a: b.a, p: { id: b.id, n: b.n, uid: b.uid } })}>
                    {b.l}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        {sheet.kind === 'shop' && <ShopBody shopId={sheet.shopId} />}
        {sheet.kind === 'combatItems' && <CombatItemsBody />}
        {sheet.kind === 'chat' && <ChatBody desc={sheet} />}
        {sheet.kind === 'craft' && <CraftBody station={sheet.station} />}
        {sheet.kind === 'codex' && <CodexPanel cat={sheet.cat} />}
        {sheet.kind === 'comm' && <CommBody desc={sheet} />}
      </div>
    </div>
  );
}

/* ---------------- 卡 K3-UI · 通讯·写信（BUG-001：写信界面此前从未存在） ---------------- */

import type { CommSheet } from '@/types/uispec';
function CommBody({ desc }: { desc: CommSheet }) {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  const [text, setText] = useState('');
  const poor = S.player.gold < desc.cost;
  const send = () => {
    if (poor) return;
    cmd({ type: 'ui', a: 'cm_send_ok', p: { id: desc.toLoc, t: text } });
  };
  return (
    <>
      <div className="sh-h">
        <div className="sv" style={{ background: 'var(--star2)' }}>信</div>
        <div className="tt">
          <b>写信 · 寄往{desc.toName}</b>
          <span>
            {desc.wayName} · {formatMoney(desc.cost)} ·{' '}
            {desc.days === 0 ? '即达' : '约 ' + desc.days + ' 日后送达'}
          </span>
        </div>
        <button className="x" onClick={() => cmd({ type: 'ui', a: 'close', p: {} })}>✕</button>
      </div>
      <div className="sh-b">
        <div className="comm-in">
          <textarea
            value={text}
            maxLength={60}
            rows={3}
            placeholder="想捎什么话？（留空就只捎一句口信）"
            aria-label="信件正文"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
            }}
          />
          <div className="sh-gold" style={{ marginTop: 6 }}>
            持有 <Money n={S.player.gold} />
            <span style={{ opacity: 0.82 }}> · 讯费 {formatMoney(desc.cost)}</span>
            {poor && <span style={{ color: 'var(--crimson)' }}> · 钱不够，付不起这笔讯费</span>}
          </div>
          <div className="opts">
            <button className="opt" disabled={poor} onClick={send}>
              封好寄出（{formatMoney(desc.cost)}）
            </button>
            <button className="opt" onClick={() => cmd({ type: 'ui', a: 'close', p: {} })}>
              再想想
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------------- 聊天窗口（第四通道 · 卡片7） ---------------- */

import type { ChatSheet } from '@/types/uispec';
function ChatBody({ desc }: { desc: ChatSheet }) {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  const n = WB.npcs[desc.npcId];
  const att = S.npcs[desc.npcId]?.att || 0;
  const [text, setText] = useState('');
  /* 眼前这一位正在吐的那半截台词（流式开启时才有）：顶上「沉吟着……」 */
  const aiDraft = useGame((s) => s.aiDraft);
  const draft = aiDraft?.channel === 'chat' && aiDraft.npcId === desc.npcId ? aiDraft.text : '';
  const listRef = useRef<HTMLDivElement>(null);
  /* F-34：scrollIntoView 会滚动整条可滚祖先链（含 #view），被 SceneView 的 sticky-bottom
     监听误判成"用户滚到底"，静默清掉「↓N 条新见闻」角标——改为只动窗口自身的 scrollTop。 */
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [desc.turns.length, desc.busy]);
  const send = (t: string) => {
    const v = t.trim();
    if (!v || desc.busy) return;
    setText('');
    cmd({ type: 'chatSend', id: desc.npcId, text: v });
  };
  return (
    <>
      <div className="sh-h">
        <div className="sv" style={{ background: n.color }}>
          <ArtImage src={artPath('npc', desc.npcId)} fg={n.sv} />
        </div>
        <div className="tt">
          <b>{n.name}</b>
          <span>
            {n.title} · <span style={{ color: attColor(att) }}>{attWord(att)}</span>
            {n.faction ? ' · ' + factionName(n.faction) : ''}
          </span>
        </div>
        <button className="x" onClick={() => cmd({ type: 'dialogChoice', n: desc.npcId, a: 'dback' })}>✕</button>
      </div>
      <div className="sh-b chat-b">
        <div className="chat-turns" ref={listRef}>
          {desc.turns.map((t, i) => (
            <Fragment key={t.id ?? i}>
              {(i === 0 || desc.turns[i - 1].day !== t.day) && <div className="ct-day">—— 第 {t.day} 日 ——</div>}
              <div className={'ct ' + (t.who === 'p' ? 'ct-p' : 'ct-n')}>
                <span className="who">{t.who === 'p' ? '你' : n.name}</span>
                <span className="bub">{t.text}</span>
              </div>
            </Fragment>
          ))}
          {desc.busy && (
            <div className="ct ct-n ct-busy">
              <span className="who">{n.name}</span>
              <span className="bub">{draft || '沉吟着……'}</span>
            </div>
          )}
        </div>
        {!desc.busy && desc.chips.length > 0 && (
          <div className="chat-chips">
            {desc.chips.map((c) => (
              <button key={c} onClick={() => send(c)}>
                {c}
              </button>
            ))}
          </div>
        )}
        <div className="chat-in">
          <input
            value={text}
            maxLength={40}
            placeholder="说点什么……"
            disabled={desc.busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send(text)}
          />
          <button onClick={() => send(text)} disabled={desc.busy}>
            ➤
          </button>
        </div>
      </div>
    </>
  );
}

/* ---------------- 对白情绪 tag 推导（卡 P1 · 保守推导） ----------------
   DialogSheet 没有情绪字段（src/types/uispec.ts 属冻结类型层，本卡不改），
   情绪只能从**既有字段**保守推导，两段式：
     ① 先扫正文可见文本里的强情绪词（命中即用，优先级 怒>惊>喜>疑>冷）；
     ② 未命中再回落到既有 att 好感度档。
   宁可落回中性的「疑」，也不虚构剧本没写的情绪；若主线后续在 DialogSheet
   补 `mood` 字段，这里应改为直读字段、删除本段推导。 */
type MoodKey = 'nu' | 'xi' | 'jing' | 'yi' | 'leng';
const MOODS: Record<MoodKey, { ch: string; title: string }> = {
  nu: { ch: '怒', title: '情绪：怒（正文含怒意措辞 · 推导）' },
  xi: { ch: '喜', title: '情绪：喜（正文含喜色措辞 · 推导）' },
  jing: { ch: '惊', title: '情绪：惊（正文含惊讶措辞 · 推导）' },
  yi: { ch: '疑', title: '情绪：疑（正文含迟疑措辞 · 推导）' },
  leng: { ch: '冷', title: '情绪：冷（正文含冷淡措辞 · 推导）' },
};
const MOOD_WORDS: [MoodKey, RegExp][] = [
  ['nu', /(滚开|找死|别烦|混账|混帐|怒|威胁|咬牙|拍案|闭嘴|少来|凶狠|恶狠狠)/],
  ['jing', /(惊呼|吃惊|惊|竟|想不到|没料到|瞪大|愕然|什么？)/],
  ['xi', /(笑|高兴|欢喜|欢迎|多谢|谢了|愉快|乐意|哈哈|颔首)/],
  ['yi', /(疑|打量|皱眉|犹豫|或许|未必|不好说|沉吟|端详|盯)/],
  ['leng', /(冷淡|淡漠|面无表情|不屑|嗤|沉默|冷冷|无所谓|别过脸)/],
];
/* 卡 I3：core 显式情绪（DialogSheet.mood）优先；缺省才走上面这套关键词推导（降级路径） */
const MOOD_BY_CH: Record<string, MoodKey> = { 怒: 'nu', 喜: 'xi', 惊: 'jing', 疑: 'yi', 冷: 'leng' };

function moodOf(text: string, att: number): MoodKey {
  const plain = text.replace(/<[^>]*>/g, '');
  for (const [k, re] of MOOD_WORDS) if (re.test(plain)) return k;
  if (att >= 60) return 'xi';
  if (att <= -45) return 'nu';
  if (att < -20) return 'leng';
  return 'yi';
}

/* ---------------- 对话 ---------------- */

import type { DialogSheet } from '@/types/uispec';
function DialogBody({ desc }: { desc: DialogSheet }) {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  const n = WB.npcs[desc.npcId];
  const att = S.npcs[desc.npcId]?.att || 0;
  const word = att >= 45 ? '亲近' : att >= 20 ? '友好' : att > -20 ? '普通' : att > -45 ? '冷淡' : '敌意';
  const color = att >= 20 ? 'var(--jade)' : att > -20 ? 'var(--gold)' : 'var(--crimson)';
  /* 情绪推导要把舞台指示算进去：线索（「打铁声重了几分」）常写在括号里 */
  const mood = (desc.mood && MOOD_BY_CH[desc.mood]) || moodOf((desc.stage || '') + desc.text, att);
  const moodSrc = desc.mood ? 'core 判定' : '正文推导';
  const act = npcActNow(desc.npcId, S); // 此刻在做什么（schedule act）——浮层与深谈页都要用
  /* 双页（星穹剧场）：page 由 core 给，UI 只负责画，以及把翻页意图发回去。
     兜底：深谈页**一件可看的东西都没有**时一律落回「此刻」——
     任何状态错位都不该把玩家留在空白页上。 */
  const wantTl = (desc.page || 'now') === 'timeline';
  const tlHasContent = !!desc.text || !!desc.stage || (desc.turns || []).length > 0;
  const page = wantTl && tlHasContent ? 'timeline' : 'now';
  /* 深谈页的输入：说下一句。走 chatSend 命令，回复由 Chat 回流到这一页（不弹浮层）。 */
  const [say, setSay] = useState('');
  useEffect(() => setSay(''), [desc.npcId]); // 换人清空草稿
  /* 时间线要跟着最新一条走。两个 ref 分工：
     tlRef —— 滚动容器本身（**只动它自己的 scrollTop**，不能用 scrollIntoView：
              那会把整条可滚祖先链一起滚，SceneView 的 sticky-bottom 会误判成"玩家滚到底"，F-34）；
     atBottom —— 玩家是不是正贴着底部看。不是的话（他在翻旧消息）就别把视口拽走。 */
  const tlRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  useEffect(() => {
    const el = tlRef.current;
    if (!el) return;
    const onScroll = () => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [page]);
  const turnCount = (desc.turns || []).length;
  useEffect(() => {
    const el = tlRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [turnCount, desc.busy, page]);
  const sendSay = (t: string) => {
    const v = t.trim();
    if (!v || desc.busy) return;
    setSay('');
    atBottomRef.current = true; // 自己发的这句一定要看得见，哪怕刚才在翻旧消息
    cmd({ type: 'chatSend', id: desc.npcId, text: v });
  };
  const go = (p: 'now' | 'timeline') => cmd({ type: 'ui', a: 'dlgPage', p: { page: p } });
  const onOpt = (o: OptDesc) => {
    if (o.a === 'dreq' && o.i != null) cmd({ type: 'dialogReq', n: desc.npcId, i: o.i });
    else cmd({ type: 'dialogChoice', n: o.n || desc.npcId, a: o.a, t: o.t });
  };
  return (
    <>
      {/* 头部浮在立绘之上（.dlg-h 绝对定位）：立绘因此能从浮层最顶端开始铺满 */}
      <div className="dlg-h">
      <div className="sh-h">
        <div className="sv fx-art-av" style={{ background: n.color }}>
          <ArtImage src={artPath('npc', desc.npcId)} fg={n.sv} />
        </div>
        <div className="tt">
          <b>
            {n.name}
            <span className={'fx-emo ' + mood} title={'情绪：' + MOODS[mood].ch + '（' + moodSrc + '）'}>
              {MOODS[mood].ch}
            </span>
          </b>
          <span>
            {n.title} · {n.race} · 态度：
            <span style={{ color }}>{word}</span>
            {bondOf(desc.npcId).title && <span style={{ color: 'var(--gold2)' }}> · {bondOf(desc.npcId).title}</span>}
            {bondOf(desc.npcId).grudge && <span style={{ color: 'var(--crimson)' }}> · 记恨</span>}
          </span>
        </div>
        <button
          className="dlg-switch"
          onClick={() => go(page === 'now' ? 'timeline' : 'now')}
          title={page === 'now' ? '看看你们聊过什么' : '回到此刻'}
        >
          {page === 'now' ? '深谈' : '此刻'}
        </button>
        <button className="x" onClick={() => cmd({ type: 'ui', a: 'close', p: {} })}>✕</button>
      </div>
      </div>
      <div className={'dlg-views' + (page === 'timeline' ? ' tl' : '')}>
      <div className="dlg-view dlg-now">
        {/* 立绘铺满整页（满屏出血）：key=npcId 让换人时重新播放淡入 */}
        <div className="dlg-art fx-art" key={desc.npcId}>
          <ArtImage src={artPath('npc', desc.npcId)} fg={n.sv} />
        </div>
        {/* 浮在画面上的那一叠：名字 → 处境 → 这一句 → 一级动作 → 上滑坞 */}
        <div className="dlg-cards">
          {desc.extra && <div className="dlg-extra" dangerouslySetInnerHTML={{ __html: desc.extra }} />}
          <div className="dlg-name">
            {n.name}
            <small>
              {n.title} · {n.race}
            </small>
          </div>
          <div className="dlg-sub">
            态度 <i style={{ color }}>{word}</i> · 好感 {att}
            {act ? ' · 此刻在' + act : ''}
            {bondOf(desc.npcId).title && <span style={{ color: 'var(--gold2)' }}> · {bondOf(desc.npcId).title}</span>}
            {bondOf(desc.npcId).grudge && <span style={{ color: 'var(--crimson)' }}> · 记恨</span>}
          </div>
          {/* 说话者即这一页的主角：名字已经大字写在上面，正文不再重复「XX：」 */}
          <div className={'dlg-line' + (desc.dropCap ? ' dc' : '')}>
            {desc.busy ? (
              /* 开场白 AI 化：模型回来前只给中性等待态，不预填固定台词 */
              <span className="dlg-wait">……</span>
            ) : (
              <>
                {/* 舞台指示不是台词：小字另起一行，不参与首字下沉 */}
                {desc.stage && <span className="dlg-stage">{desc.stage}</span>}
                <span dangerouslySetInnerHTML={{ __html: desc.text }} />
              </>
            )}
          </div>
          {/* 一级动作收成 chips：一屏读完，不再被四五个全宽按钮顶下去 */}
          <div className="dlg-chips">
            {desc.opts.map((o, i) => (
              <button
                key={i}
                className={'opt chip' + (o.cls ? ' ' + o.cls : '')}
                disabled={o.dis}
                title={o.h || undefined}
                onClick={() => onOpt(o)}
              >
                {o.l}
              </button>
            ))}
          </div>
          <button className="dlg-more" onClick={() => go('timeline')}>你们聊过的，都还在</button>
          {/* C 卡：人物志此前只挂在深谈页最底部——玩家在「此刻」这一页根本不知道它有得看。
              同一个组件两页都放：入口的问题从来不是「有没有」，而是「看不看得见」。 */}
          <NpcDossier npcId={desc.npcId} />
        </div>
      </div>
      <div className="dlg-view dlg-tl">
        {/* 深谈页的上下文行：此刻他在做什么 + 好感条（时间线讲「聊过什么」，这行讲「现在」） */}
        <div className="tl-head">
          <span>{act ? '正在' + act : '此刻不在此处'}</span>
          <span className="tl-att">
            <i style={{ width: Math.max(0, Math.min(100, att)) + '%' }} />
          </span>
          <span className="tl-attnum">好感 {att}</span>
          <span className="tl-know">{knowLine(desc.npcId, S)}</span>
        </div>
        <div className="tl-b" ref={tlRef}>
          {(desc.turns || []).length === 0 && !desc.busy && (
            <div className="tl-empty">你们还没深谈过。想聊什么，可以直接说。</div>
          )}
          {(desc.turns || []).map((t, i) => (
            <Fragment key={t.id ?? i}>
              {(i === 0 || (desc.turns || [])[i - 1].day !== t.day) && <div className="tl-day">—— 第 {t.day} 日 ——</div>}
              <div className={'tl-ct' + (t.who === 'p' ? ' p' : ' n')}>
                <span className="tl-who">{t.who === 'p' ? '你' : n.name}</span>
                <span className="tl-bub">{t.text}</span>
              </div>
            </Fragment>
          ))}
          {desc.busy && (
            <div className="tl-ct n tl-wait"><span className="tl-who">{n.name}</span><span className="tl-bub">沉吟中……</span></div>
          )}
        </div>
        <div className="tl-f">
          {(desc.chips || []).length > 0 && (
            <>
              <div className="tl-hint">继续追问</div>
              <div className="tl-chips">
                {(desc.chips || []).map((c) => (
                  /* 只发话，不开新浮层：回复同样回流到这一页，全程留在同一个界面里 */
                  <button key={c} className="tl-chip" onClick={() => sendSay(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </>
          )}
          {/* 聊天式的输入行：就在时间线下方接着说，不再跳去别的页面 */}
          <div className="tl-in">
            <input
              value={say}
              maxLength={40}
              placeholder="说点什么……"
              disabled={desc.busy}
              onChange={(e) => setSay(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendSay(say);
              }}
            />
            <button onClick={() => sendSay(say)} disabled={desc.busy || !say.trim()}>
              ➤
            </button>
          </div>
          <button className="tl-back" onClick={() => go('now')}>回到此刻</button>
          {/* 人物志放在深谈页：它是「了解这个人」的地方，不该挤在当下的对话里 */}
          <NpcDossier npcId={desc.npcId} />
        </div>
      </div>
      </div>
      {/* 边框：完整的一圈金线（四条边连成闭合）+ 内衬细线 + 内侧羽化。
          纯视觉层，不接任何指针事件。 */}
      <div className="dlg-frame" aria-hidden />
    </>
  );
}

/* ---------------- C 卡 · 知情度 ----------------
   深谈页此前只有「好感 xx」一个数字，玩家不知道「谈到哪了、还差什么」——
   把已谈透的话题数与下一个卡住的门摆出来，关系才从感觉变成可追求的目标。
   判据直接复用 systems/npc/Talk.topicGateOk（与执行侧同一份），不在这里另写一套。 */
function knowLine(id: string, s: WorldState): string {
  const cards = talkOf(id);
  if (!cards.length) return '';
  const att = s.npcs[id]?.att ?? 0;
  const deep = (s.npcs[id]?.talkDeep ?? []).length;
  const questOk = (q?: string) => !q || ['done', 'fin'].includes(s.player.quests[q]?.stage ?? '');
  const flagOk = (f?: string) => !f || !!s.player.flags[f];
  const locked = cards.filter(
    (c) => c.core && !topicGateOk(c, { att, intimacy: bondOf(id, s).intimacy, questOk: questOk(c.gate?.quest), flagOk: flagOk(c.gate?.flag) }),
  );
  const head = '已谈透 ' + deep + ' / ' + cards.length + ' 个话题';
  if (!locked.length) return head + ' · 他没有再瞒着的了';
  const g = locked[0].gate;
  const want = g?.att ? '再熟一些（好感 ' + att + '/' + g.att + '）' : g?.intimacy ? '交情再深一档' : '时机未到';
  return head + ' · 还有 ' + locked.length + ' 个留着一手：' + want;
}

/* ---------------- 人物志（卡 D1/D2 演出：目标 + 关系网 + 记忆，只读） ---------------- */

function NpcDossier({ npcId }: { npcId: string }) {
  const S = world.query.get_world_state()!;
  const n = WB.npcs[npcId];
  const bv = bondOf(npcId);
  const act = npcActNow(npcId, S);
  const rels = n.rels ? Object.entries(n.rels) : [];
  /* 记忆只有一个来源（memory 的投影）：老表 npcs[id].mem 已退役，只在旧档迁移时被读一次 */
  const mem = memOf(npcId, S).slice(-4).reverse();
  const lo = n.lore;
  const hasLore = !!(lo && (lo.identity || lo.appearance || lo.personality || lo.abilities || lo.past || lo.flaw || lo.belongings));
  if (!act && !n.goal && !n.bottomLine && !hasLore && !rels.length && !mem.length && !bv.title && !bv.grudge && !bv.giftKnown.length) return null;
  const word = (v: number) => (v >= 20 ? '交好' : v > -20 ? '往来' : v > -45 ? '不睦' : '敌对');
  return (
    <details style={{ margin: '10px 0', fontSize: 12, border: '1px solid rgba(255,255,255,.12)', borderRadius: 10, padding: '6px 10px' }}>
      <summary style={{ cursor: 'pointer', opacity: 0.82, letterSpacing: '.04em' }}>关于 {n.name} · 人物志</summary>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {act && (
          <div>
            <span style={{ opacity: 0.6 }}>此刻</span> 正在{act}
          </div>
        )}
        {/* P1：lore 七项此前只进 personaBlock（AI 侧），玩家这一侧一个字都不露。
            同源、同序（立体五要素：谁 → 从哪来 → 裂口 → 其余），两边一起看齐——
            人设锚喂给模型的东西，玩家在人物志里也读得到，才不会出现
            "AI 说得出、玩家查不到"的两套事实。 */}
        {lo?.identity && (
          <div>
            <span style={{ opacity: 0.6 }}>身份</span> {lo.identity}
          </div>
        )}
        {lo?.past && (
          <div>
            <span style={{ opacity: 0.6 }}>过往</span> {lo.past}
          </div>
        )}
        {lo?.flaw && (
          <div>
            <span style={{ opacity: 0.6 }}>弱点</span> <span style={{ color: 'var(--crimson)' }}>{lo.flaw}</span>
          </div>
        )}
        {lo?.appearance && (
          <div>
            <span style={{ opacity: 0.6 }}>外貌</span> {lo.appearance}
          </div>
        )}
        {lo?.personality && (
          <div>
            <span style={{ opacity: 0.6 }}>性格</span> {lo.personality}
          </div>
        )}
        {lo?.abilities && (
          <div>
            <span style={{ opacity: 0.6 }}>能力</span> {lo.abilities}
          </div>
        )}
        {lo?.belongings && (
          <div>
            <span style={{ opacity: 0.6 }}>持有物</span> {lo.belongings}
          </div>
        )}
        {(bv.title || bv.grudge || bv.giftKnown.length > 0) && (
          <div>
            <span style={{ opacity: 0.6 }}>羁绊</span>{' '}
            {bv.title && <b style={{ color: 'var(--gold2)' }}>{bv.title}</b>}
            {bv.grudge && <b style={{ color: 'var(--crimson)', marginLeft: bv.title ? 8 : 0 }}>记恨：{bv.grudge.why}（{bv.grudge.sev} 级）</b>}
            {bv.giftKnown.length > 0 && <span style={{ marginLeft: 8, opacity: 0.85 }}>喜恶：{bv.giftKnown.join('、')}</span>}
          </div>
        )}
        {n.goal && (
          <div>
            <span style={{ opacity: 0.6 }}>志向</span> {n.goal}
          </div>
        )}
        {n.bottomLine && (
          <div>
            <span style={{ opacity: 0.6 }}>底线</span> <span style={{ color: 'var(--crimson)' }}>{n.bottomLine}</span>
          </div>
        )}
        {rels.length > 0 && (
          <div>
            <span style={{ opacity: 0.6 }}>人脉</span>{' '}
            {rels.map(([oid, r]) => (
              <span key={oid} style={{ marginRight: 8 }}>
                {WB.npcs[oid]?.name ?? oid}
                <b style={{ marginLeft: 3, color: r.val >= 0 ? 'var(--jade)' : 'var(--crimson)' }}>{word(r.val)}</b>
              </span>
            ))}
          </div>
        )}
        {mem.length > 0 && (
          <div>
            <span style={{ opacity: 0.6 }}>记得</span>
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {mem.map((m, i) => (
                <li key={i} style={{ opacity: 0.86 }}>
                  {m.event}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

/* ---------------- 商店 ---------------- */

import { sellRows, shopRows } from '@/world';
function ShopBody({ shopId }: { shopId: string }) {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  const sh = WB.shops[shopId];
  const v = sh.vendor ? WB.npcs[sh.vendor] : null;
  const rows = shopRows(shopId);
  const sells = sellRows(shopId);
  return (
    <>
      <div className="sh-h">
        <div className="sv" style={{ background: v ? v.color : '#3f7d5f' }}>{v ? v.sv : '市'}</div>
        <div className="tt">
          <b>{sh.name}</b>
          <span>{v ? v.title : '东市杂货摊贩'}</span>
        </div>
        <button className="x" onClick={() => cmd({ type: 'ui', a: 'close', p: {} })}>✕</button>
      </div>
      <div className="sh-b">
        <div className="sh-gold">
          持有 <Money n={S.player.gold} />
          {sh.herb && S.econ.herb > 1 && (
            <span style={{ color: 'var(--crimson)' }}> · 药材因商队被袭涨价{Math.round((S.econ.herb - 1) * 100)}%</span>
          )}
        </div>
        <div className="sh-gold" style={{ marginTop: -4, opacity: 0.82 }}>
          商人收购资金 <Money n={vendorCoin(shopId, S)} />
          <span style={{ fontSize: 11, opacity: 0.7, marginLeft: 6 }}>（钱袋有限，收购力见底时收不了货）</span>
        </div>
        {rows.map((o) => (
          <div className="shop-row" key={o.iid}>
            <div className="inf">
              <b>{o.item.name}</b>
              <span>{o.item.desc}</span>
            </div>
            <div className={'pr' + (o.price > o.base ? ' sg' : '')}><Money n={o.price} /></div>
            <button disabled={!o.affordable} onClick={() => cmd({ type: 'shopBuy', id: o.iid, p: o.price })}>
              购买
            </button>
          </div>
        ))}
        {sells.length > 0 && (
          <>
            <div className="sh-gold" style={{ margin: '16px 0 10px' }}>— 杂货收购（{Math.round(sh.sell * 100)}% 价） —</div>
            {sells.map((x) => (
              /* 卡 I1：实例行按 uid 分行（同 base 多实例各占一行），普通件仍按 id 聚合 */
              <div className="shop-row" key={x.uid || x.iid}>
                <div className="inf">
                  <b style={x.uid ? { color: qualityColor(x.q) } : undefined}>
                    {x.name || x.item.name} {x.uid ? '' : '×' + x.qty}
                  </b>
                </div>
                <div className="pr"><Money n={x.price} /></div>
                <button onClick={() => cmd({ type: 'shopSell', id: x.iid, uid: x.uid })}>卖出</button>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

/* ---------------- 卡 I2 · 技艺工坊 ---------------- */

function CraftBody({ station }: { station: string }) {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  const v = craftView(station, S);
  return (
    <>
      <div className="sh-h">
        <div className="sv" style={{ background: '#5b452c' }}>匠</div>
        <div className="tt">
          <b>{v.name}</b>
          <span>
            {v.locName} · 技艺等级 {v.lv}
          </span>
        </div>
        <button className="x" onClick={() => cmd({ type: 'ui', a: 'craft_back', p: {} })}>✕</button>
      </div>
      <div className="sh-b">
        <div className="sh-gold" style={{ opacity: 0.85 }}>
          {v.desc}
        </div>
        {!v.open && (
          <div className="sh-gold" style={{ color: 'var(--crimson)' }}>
            ✖ {v.why}
          </div>
        )}
        {v.rows.map((r) => (
          <div className="shop-row" key={r.id}>
            <div className="inf">
              <b style={r.illegal ? { color: 'var(--crimson)' } : undefined}>
                {r.name}
                <span style={{ fontSize: 11, opacity: 0.66, marginLeft: 6 }}>
                  T{r.tier} · {r.ticks} 刻 · 成率 {r.pct}%{r.illegal ? ' · 违禁' : ''}
                </span>
              </b>
              <span>
                需 {r.need.map((n) => n.name + ' ' + n.have + '/' + n.need).join('、')}
                {r.gold > 0 ? ' · ' : ''}
                {r.gold > 0 && <Money n={r.gold} />}
              </span>
              <span style={{ opacity: 0.75 }}>产出：{r.outText}</span>
              {!r.ok && <span style={{ color: 'var(--crimson)' }}>{r.why}</span>}
            </div>
            <button disabled={!r.ok} onClick={() => cmd({ type: 'ui', a: 'craft_do', p: { id: r.id } })}>
              制作
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------------- 战斗道具 ---------------- */

function CombatItemsBody() {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  /* 卡 N1：可战用 = 有 heal 或有 eff。新的符箓/增益药没有 heal 字段，
     沿用旧口径筛就会在面板里隐形——东西在包里，按钮却点不到。 */
  const us = S.player.bag.filter((x) => {
    const it = WB.items[x.id];
    return it.type === 'use' && ((it.heal || 0) > 0 || (it.eff?.length ?? 0) > 0);
  });
  return (
    <>
      <div className="sh-h">
        <div className="tt" style={{ marginLeft: 6 }}>
          <b>使用道具</b>
        </div>
        <button className="x" onClick={() => cmd({ type: 'ui', a: 'close', p: {} })}>✕</button>
      </div>
      <div className="sh-b">
        {us.map((x) => (
          <div className="shop-row" key={x.id}>
            <div className="inf">
              <b>
                {WB.items[x.id].name} ×{x.qty}
              </b>
            </div>
            <button onClick={() => cmd({ type: 'combat', k: 'useitem', id: x.id })}>使用</button>
          </div>
        ))}
      </div>
    </>
  );
}

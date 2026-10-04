/* ============================================================
   对话引擎（原型 §对话：openDlg/renderDlg/dlgOpts/reqMenu/runReq/dlgAct）
   呈现改为 DialogSheet 描述符（text/extra 保留原型的内联富文本），
   状态改写全部留在 core —— AI 只出判定与台词（§40）。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { buildMemoryContext } from '@/memory';
import { lodOfNpc } from '@/systems/npc/Lod';
import { resolveBudget } from '@/systems/npc/ContextProfile';
import type { DialogSheet, OptDesc } from '@/types/uispec';
import { rng, scheduler, worldBus } from '@/events/EventBus';
import { levelOf, makeEvent } from '@/events/EventSchema';
import { check } from '@/dice/CheckResolver';
import { gainGold, log, removeItem, itemCount, addRep, addItem } from '@/systems/character/Gains';
import { formatMoney } from '@/systems/economy/Money';
import { guardStop } from '@/actions/ActionExecutor';
import { commitCrime, payFine } from '@/systems/law/Law';
import { addMem, adjAtt, attColor, attOf, attWord, npcActNow } from '@/systems/npc/Npcs';
import { academyMenu } from '@/systems/academy/Academy';
import { clsName, maxHp } from '@/systems/character/Derived';
import { ai } from '@/plugins/PluginInterface';
import type { NpcCtx, NpcVerdict } from '@/plugins/PluginInterface';
import { chatChips, ensureTalk, openChat, pushTurn, quoteSay, setDeepTalkRenderer } from '@/systems/npc/Chat';
import { bondOf, giftPicker, apologize, grudgeCheck } from '@/systems/relationship/Bond';
import { canTurnIn, giveQuest, turnIn } from '@/systems/quest/Quests';
import { closeSheet, currentDialogId, openDialog } from '@/systems/character/Sheet';
import { openShop } from '@/systems/economy/Shop';
import { craftMenu, stationGate, stationOfNpc } from '@/systems/inventory/Craft';
import { titleWord } from '@/systems/reputation/Title';
import { need, sync } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { advance, sceneTime } from '@/world/WorldClock';
import { healSvc, restAt } from '@/actions/ActionExecutor';

/* ---------- 打开与渲染 ---------- */

/** 开场白的最长等待（毫秒）：到点先落回数据台词，不让玩家对着等待态干等 */
export const GREET_TIMEOUT_MS = 5000;

export function openDlg(id: string) {
  /* P2：话题卡在这里拉——对话浮层的 chips（本文件下方 chatChips(id)）走的是这条入口，
     而 npcTalk 命令并不经过 Chat.openChat。挂错地方就永远拿不到追问钩子（实测踩过）。 */
  ensureTalk(id);
  const s = need();
  const n = WB.npcs[id];
  if (!s.npcs[id]) s.npcs[id] = { att: 0, mem: [], met: false };
  const firstMeet = !s.npcs[id].met;
  resetDlgPage(); // 每次重新开口都从「此刻」开始，不从上次翻到的深谈页续
  mutate.npcMet(id);
  grudgeCheck(id); // 卡 11：att 恶化兜底（≤-60 未结仇则补记）
  const att = attOf(id);
  const tier = att >= 20 ? 'warm' : att > -20 ? 'neutral' : 'cold';
  /* 卡 I6：世界怎么称呼你（称号前缀；无称号时不加任何字） */
  const tw = titleWord(s);
  const prefix = tw ? '（' + tw + '）' : '';
  const samples = n.greet as { cold: string; neutral: string; warm: string };
  const dataLine = prefix + samples[tier].replaceAll('{name}', s.player.name);
  const mood = firstMeet ? '惊' : undefined;
  const p = ai();
  /* 无模型：数据台词直接上屏（它是这条路的唯一来源，也是降级铁律的落点） */
  if (!p.greetAsync) {
    pushTurn(id, 'n', dataLine); // 开场白入流：深谈页的时间线从这句开始
    renderDlg(id, dataLine, '', undefined, mood);
    return;
  }
  /* 有模型：**不预填固定台词**——先闪一句数据台词再被替换，比等一下更伤体验。
     等待态由 busy 占位承担，模型落笔后才写正文；只有模型不给话才回落到数据台词。
     越权判据两条（与 F-17 同源）：期间没有别的渲染（dlgSeq），窗还开着且还是这个人。 */
  renderDlg(id, '', '', undefined, mood, true);
  const mySeq = dlgSeq;
  const alive = () => dlgSeq === mySeq && currentDialogId() === id;
  /* 软超时：玩家在等，不能等满适配器的重试链（最坏 2×7 秒）。
     到点先落回数据台词；迟到的模型回包会在这一场 race 里自然作废。 */
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), GREET_TIMEOUT_MS));
  Promise.race([p.greetAsync({
    npcId: id,
    att,
    attWord: attWord(att),
    tier,
    samples,
    location: WB.locations[s.player.loc]?.name || '',
    act: npcActNow(id, s),
    firstMeet,
    playerName: s.player.name,
    playerTitle: tw,
    /* 记得：上次对话的尾巴带给开场白。会话流入档（s.chats），开得了口就该接得上 */
    lastChat: (s.chats?.[id] || []).length
      ? (s.chats![id] as { text: string }[]).at(-1)!.text.slice(0, 20)
      : undefined,
  }), timeout])
    .then((text) => {
      if (!alive()) return;
      const line = text ? prefix + text : dataLine;
      pushTurn(id, 'n', line);
      renderDlg(id, line, '', undefined, mood);
    })
    .catch(() => {
      /* 端点挂了：把话还给数据台词，人必须开得了口 */
      if (!alive()) return;
      pushTurn(id, 'n', dataLine);
      renderDlg(id, dataLine, '', undefined, mood);
    });
}

/* ---------- 卡 I3 · 情绪 tag（补 H 缺口 2） ----------
   显式数据优先：由 core 按羁绊/仇怨/好感判定，UI 只在缺省时回落"正文关键词推导"。
   判定与渲染分离——AI 只产出文本，情绪不由模型决定。 */
export type DialogMood = NonNullable<DialogSheet['mood']>;

export function npcMood(id: string): DialogMood {
  const dyn = need().npcs[id];
  const b = bondOf(id);
  if (b.grudge) return '怒';
  if (dyn && !dyn.met) return '惊';
  const att = attOf(id);
  if (b.intimacy && b.intimacy >= 2) return '喜';
  if (att >= 60) return '喜';
  if (att <= -20) return '冷';
  return '疑';
}

/* 对话渲染世代：每次 renderDlg 自增。开场白的异步回包据此判断
   「这一刻之后有没有人再渲染过」——玩家点了选项、换人、重开，旧回包一律作废。 */
let dlgSeq = 0;

/* —— 双页（星穹剧场）：'now' 此刻 / 'timeline' 深谈。
   页是**渲染状态**而不是世界状态：不入档、不参与判定，只决定这一次怎么画。
   放在模块级而不是 UI 里，是为了让异步回包（开场白替换）也知道玩家此刻在哪一页。 */
let dlgPage: 'now' | 'timeline' = 'now';
/** 这一页**属于哪段对话**。模块级状态一旦残留到下一次对话，玩家会被直接扔进
    一个还没建立时间线的深谈页——那正是"整块界面空白"的来源，所以在源头掐掉。 */
let dlgPageOwner: string | null = null;

/** 当前该给谁画哪一页：换了人一律从「此刻」起 */
function pageOf(id: string): 'now' | 'timeline' {
  return dlgPageOwner === id ? dlgPage : 'now';
}
/** 最近一次渲染的完整参数——切页要原样重绘，不能只换个 page 就把正文与选项丢了 */
let lastDlg: { id: string; text: string; extra: string; opts?: OptDesc[]; mood?: DialogMood; busy: boolean } | null =
  null;

/** 深谈页最多回看的轮数（浮层里放不下一整部对话史） */
const DLG_TURNS = 12;

/**
 * 句首舞台指示与台词分离（星穹剧场排版）。
 *
 * 数据里大量台词长这样：「（打铁声重了几分）……自己看，别乱摸。」——
 * 括号里那句**不是台词**，是动作提示。同字号同颜色排在一起读着是混的，
 * 而且首字下沉会把「（」当首字放大（实测踩到）。
 *
 * 规则保守到近乎笨：只认开头第一段**完整配对**的括号；嵌套靠深度计数；
 * 未闭合一律当普通文本，不拆也不猜——宁可少拆一句，不做错误切分。
 */
export function splitStage(raw: string): { stage: string; line: string } {
  const t = (raw || '').trim();
  if (!/^[（(]/.test(t)) return { stage: '', line: t };
  const open = t[0];
  const close = open === '（' ? '）' : ')';
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === open) depth++;
    else if (c === close) depth--;
    if (depth === 0) {
      const line = t.slice(i + 1).trim();
      /* 括号段之后**没有台词** → 不拆，整句留在正文。
         不这么判，text 会变成空串：界面上"话就没了"，只剩一行小字动作提示
         （AI 生成开场白时最常见——整句只有动作描写，实测复现到）。 */
      if (!line) return { stage: '', line: t };
      return { stage: t.slice(0, i + 1), line };
    }
  }
  return { stage: '', line: t }; // 未闭合：原样
}

/** 首字能否做下沉字：只认汉字。标点／引号／字母数字一律不下沉（下沉标点比不下沉丑得多） */
export function canDropCap(s: string): boolean {
  const c = (s || '').trim()[0];
  return !!c && /[\u4e00-\u9fa5]/.test(c);
}

/** 本 NPC 的会话流（旧→新；旧档没有 chats 时为空数组） */
export function dlgTurns(id: string): { who: 'p' | 'n'; text: string; day: number; id?: string }[] {
  const s = need();
  return (s.chats?.[id] || []).slice(-DLG_TURNS).map((t) => ({ who: t.who, text: t.text, day: t.day, id: t.id }));
}

/**
 * 内部绘制。`bump` 决定这次画算不算「换了内容」：
 *   · 换正文 / 换人 / 点选项 → true，推进世代号（在途的开场白回包随之作废）
 *   · 翻页重绘 → false（玩家只是换了个视角看同一句话，回包不该被丢掉）
 * 判据分开写，是因为「渲染次数」与「对话内容是否已变」本来就不是一回事。
 */
/** 描述符组装（paint 与深谈页回流共用，避免两处各写一遍漏字段） */
function descriptorOf(
  id: string,
  text: string,
  extra: string,
  opts: OptDesc[] | undefined,
  mood: DialogMood | undefined,
  busy: boolean,
) {
  /* 舞台指示与台词分开给 UI：前者小字另起一行，后者才参与首字下沉 */
  const { stage, line } = splitStage(text);
  return {
    npcId: id,
    text: line,
    stage: stage || undefined,
    dropCap: canDropCap(line),
    extra,
    opts: opts || dlgOpts(id),
    mood: mood ?? npcMood(id),
    busy,
    page: pageOf(id),
    turns: dlgTurns(id),
    chips: busy ? [] : chatChips(id),
  };
}

function paint(
  id: string,
  text: string,
  extra: string,
  opts: OptDesc[] | undefined,
  mood: DialogMood | undefined,
  busy: boolean,
  bump: boolean,
) {
  if (bump) dlgSeq++;
  lastDlg = { id, text, extra, opts, mood, busy };
  openDialog(descriptorOf(id, text, extra, opts, mood, busy));
}

/**
 * 深谈页回流（由 Chat 在「深谈页正开着」时回调）：气泡留在对话框里，不弹聊天浮层。
 *
 * 正文与选项取自当前对话；**busy 由聊天通道给，且不写回 lastDlg**——
 * 对话自己的「开场白等待」和聊天的「沉吟」是两回事，混在一个字段里，
 * 切页重绘就会带上错误的等待态。
 */
export function repaintDeepTalk(id: string, busy: boolean) {
  const d = lastDlg;
  if (!d || d.id !== id) return;
  openDialog(descriptorOf(d.id, d.text, d.extra, d.opts, d.mood, busy));
}

/* 把深谈页的接管权交给 Chat：它决定回复落在哪一页。
   放在模块顶层执行——Dialogue 是 Chat 的消费者，加载顺序上必然在 Chat 之后。 */
setDeepTalkRenderer((id, busy) => repaintDeepTalk(id, busy));

export function renderDlg(id: string, text: string, extra = '', opts?: OptDesc[], mood?: DialogMood, busy = false) {
  paint(id, text, extra, opts, mood, busy, true);
}

/** 翻页（此刻 ⇄ 深谈）：只重绘当前正文，不碰任何世界状态 */
export function setDlgPage(page: 'now' | 'timeline') {
  if (page === dlgPage && dlgPageOwner === lastDlg?.id) return;
  dlgPage = page;
  const d = lastDlg;
  /* 浮层已经不在（被关掉或被人顶了）→ 只记页号，不重开窗（F-17 同源） */
  if (!d || currentDialogId() !== d.id) return;
  dlgPageOwner = d.id; // 页号从此绑定到这一段对话
  paint(d.id, d.text, d.extra, d.opts, d.mood, d.busy, false); // 翻页不算换内容
}

/** 回到「此刻」（新开一次对话时复位；供 openDlg 调用） */
export function resetDlgPage() {
  dlgPage = 'now';
  dlgPageOwner = null;
}

/* ---------- 选项生成（原型 dlgOpts 全量转写） ---------- */

export function dlgOpts(id: string): OptDesc[] {
  const s = need();
  const o: OptDesc[] = [];
  const q = s.player.quests;
  const day = sceneTime(s).day;
  const add = (l: string, a: string, h?: string, cls?: string) => o.push({ l, a, n: id, h, cls });
  switch (id) {
    case 'lita':
      if (!q.q_debt) add('「有什么我能帮忙的吗？」', 'q_debt', undefined, 'q');
      if (q.q_debt && q.q_debt.stage === 'done') add('（复命）老乔的账收回来了', 'q_debt_in', undefined, 'q');
      add('住宿（' + formatMoney(20) + '·睡到天亮）', 'inn');
      add('提出请求', 'dreq');
      break;
    case 'galon':
      add('「公会有什么委托？」', 'q_guild');
      if (q.q_rabbit && canTurnIn('q_rabbit')) add('（复命）角兔已猎杀', 'q_rabbit_in', undefined, 'q');
      add('提出请求', 'dreq');
      break;
    case 'selina':
      add('听一支歌（免费）', 'song');
      add('买一条情报（' + formatMoney(200) + '）', 'info_buy');
      if (q.q_letter && q.q_letter.stage === 'go') add('（递交）米露的信', 'q_letter_in', undefined, 'q');
      add('提出请求', 'dreq');
      break;
    case 'brendan':
      add('看看铁器（购物）', 'shop_iron');
      if (!q.q_theft && day >= 2) add('「您的脸色不太好？」', 'q_theft_give', undefined, 'q');
      if (q.q_theft && q.q_theft.stage === 'done') add('（归还）物归原主', 'q_theft_in', undefined, 'q');
      add('提出请求', 'dreq');
      break;
    case 'adrian':
      add('请为我治疗（' + formatMoney(100) + '）', 'heal');
      if (!q.q_holy) add('「神殿有什么需要帮忙的吗？」', 'q_holy_give', undefined, 'q');
      if (q.q_holy && canTurnIn('q_holy')) add('（复命）三株月见草', 'q_holy_in', undefined, 'q');
      add('请教神学与星枢', 'lore_t');
      add('提出请求', 'dreq');
      break;
    case 'ash':
      add('看看「货色」（黑市）', 'shop_black');
      add('打听黑市动静（' + formatMoney(150) + '）', 'info_ash');
      if (q.q_theft && q.q_theft.stage === 'confront') add('（对质）剑坯是不是你拿的？', 'q_theft_cf', undefined, 'q');
      add('提出请求', 'dreq');
      break;
    case 'mia':
      if (!q.q_letter) add('「有活儿要人跑腿吗？」', 'q_letter_give', undefined, 'q');
      if (s.player.flags.msg_unlock) add('托她带口信（' + formatMoney(50) + '）', 'msg');
      add('提出请求', 'dreq');
      break;
    case 'reno':
      add('打听通缉与法令', 'law');
      if (s.player.wanted > 0) add('自首并缴罚金（' + formatMoney(300 * s.player.wanted) + '）', 'payfine', undefined, 'q');
      add('提出请求', 'dreq');
      break;
    case 'vandel':
      add('听他讲星枢', 'lore_s');
      if (!q.q_shard && day >= 3) add('「有什么我能帮忙研究的？」', 'q_shard_give', undefined, 'q');
      if (q.q_shard && canTurnIn('q_shard')) add('（复命）祭坛深处的残片', 'q_shard_in', undefined, 'q');
      add('提出请求', 'dreq');
      break;
    case 'otto':
      if (s.player.flags.caravan_evt && !s.qf.caravan_ok && !q.q_caravan)
        add('「您的货，我去夺回来。」', 'q_caravan_give', undefined, 'q');
      if (q.q_caravan && canTurnIn('q_caravan')) add('（复命）货物夺回来了', 'q_caravan_in', undefined, 'q');
      add('看看药材（购物）', 'shop_grocer');
      add('提出请求', 'dreq');
      break;
    case 'joe':
      if (q.q_debt && q.q_debt.stage === 'go') add('「老乔，莉安的账……」', 'q_debt_joe', undefined, 'q');
      add('提出请求', 'dreq');
      break;
    /* —— 卡 H6 · 学院导师（8 所学院，见 academy.json.mentor；四位导师由 people.json 播种） —— */
    case 'tutor_wind':
      add('听她讲「时间的褶皱」', 'lore_wind');
      add('「学园还收学生吗？」', 'ac_menu', '学院名录 · 报名', 'q');
      add('提出请求', 'dreq');
      break;
    case 'tutor_deepwell':
      add('看他拓的符文', 'lore_deep');
      add('「深井学院怎么进？」', 'ac_menu', '学院名录 · 报名', 'q');
      add('提出请求', 'dreq');
      break;
    case 'tutor_skycap':
      add('跟她上屋顶看星图', 'lore_sky');
      add('「观星台收人吗？」', 'ac_menu', '学院名录 · 报名', 'q');
      add('提出请求', 'dreq');
      break;
    case 'tutor_camp':
      add('请他指点基本功（受训）', 'train', '约六个时辰 · 恢复体力');
      add('「训练营怎么报名？」', 'ac_menu', '免费 · 需过测试', 'q');
      add('提出请求', 'dreq');
      break;
    default:
      /* G10「新 NPC 零代码契约」（约束 §5）：people.json 字段齐备（人设/topics/faction/
         likes/intimacyGate/reciprocate）→ 请求 / 叙事 / 赠礼三个交互面自动可用
         （「聊天」已不再占选项位：它升为框架级的「深谈」页，对 124 个 NPC 统一可用，
          留着逐人写一遍既重复、又会和深谈页抢同一个入口）。
         缺此分支时，任何未在上方逐人定制的 NPC 会退化成「只有一个赠礼」——契约形同虚设。 */
      add('提出请求', 'dreq');
      break;
  }
  /* 卡 11 羁绊入口：赠礼常在；有怨时给出赔罪出口（常驻，防死锁 A3） */
  o.push({ l: '赠礼', a: 'gift', n: id, h: '从背包挑一件送出去' });
  const g = bondOf(id).grudge;
  if (g) o.push({ l: '赔罪（' + formatMoney(100 * g.sev) + '）', a: 'apologize', n: id, h: '破财消怨，还得会说话' });
  /* 卡 I2 · G10 零代码契约：工坊入口由 craft.json.stations[].npcId 派生——
     新 NPC 挂站只改数据，不在本文件逐人加 case（H 阶段漏配 bug 的根治） */
  const st = stationOfNpc(id);
  if (st && stationGate(st).open) o.push({ l: '进工坊（' + st.name + '）', a: 'craft_menu', n: id, h: '锻造 · 炼金 · 铭刻', cls: 'q' });
  return o;
}

/* ---------- 提出请求：NPC 内心权衡（AI 决策 · 规则落地） ---------- */

interface ReqSpec {
  l: string;
  interest: number;
  risk: number;
  violate?: boolean;
}
/** 五项请求（原型 reqMenu.reqs；威胁＝violate → 规则层必然后果） */
const REQS: ReqSpec[] = [
  { l: '“能借我点钱吗？”', interest: -1, risk: 1 },
  { l: '“帮我个忙，行吗？”', interest: 0, risk: 1 },
  { l: '“把你知道的秘密告诉我。”', interest: -2, risk: 2 },
  { l: '“把你的东西送我一件。”', interest: -2, risk: 1 },
  { l: '“跟我合作，否则……（威胁）”', interest: -2, risk: 3, violate: true },
];

export function reqMenu(id: string) {
  const n = WB.npcs[id];
  const opts: OptDesc[] = REQS.map((r, i) => ({
    l: r.l,
    a: 'dreq',
    n: id,
    i,
    cls: r.violate ? 'dg' : '',
  }));
  opts.push({ l: '（换个话题）', a: 'dback', n: id });
  /* 走 renderDlg 而不是裸 openDialog：page / turns / chips / lastDlg 都靠它同步，
     绕过一次就会让「翻页重绘」拿到上一份正文（状态错位的经典来源）。 */
  renderDlg(id, '（' + n.name + '看着你，等你说完。）', '', opts);
}

export function runReq(id: string, i: number) {
  runReqSpec(id, REQS[i] || REQS[0], false);
}

/** 五项固定请求的关键词路由（自由输入通道用）：命中即用原表——interest/risk 是平衡值 */
const REQ_HINTS: [RegExp, number][] = [
  [/借.{0,3}钱|要点?钱|给点?钱/, 0],
  [/帮忙|帮个忙|搭把手|帮我/, 1],
  [/秘密|说实话|坦白/, 2],
  [/送我|给我一件|东西给我/, 3],
  [/威胁/, 4],
];

/**
 * 自由输入通道的「提出请求」：门禁、权衡、后果与 runReq 完全同一套；
 * 命中不了固定五项时按通用请求（interest 0 / risk 1），内容截 20 字进 ctx.request。
 * 呈现不走浮层：台词与权衡结论写进见闻录，由编织织入正文。
 * 「威胁」只认显式关键词——措辞再硬，没有威胁的字样就不触发 violate 的必然后果。
 */
export function runReqFree(id: string, ask: string) {
  const a = (ask || '').trim().slice(0, 20);
  const hit = REQ_HINTS.find(([re]) => re.test(a));
  runReqSpec(id, hit ? REQS[hit[1]] : { l: a || '帮我个忙', interest: 0, risk: 1 }, true);
}

function runReqSpec(id: string, spec: ReqSpec, free: boolean) {
  const n = WB.npcs[id];
  /* 卡 11 仇怨门禁：有仇时请求直接拒（规则层，不打扰 LLM）；亲密度≥2 知己相帮，利益度 +1 */
  const bv = bondOf(id);
  if (bv.grudge) {
    const line = n.name + '不接你的话茬。「' + (bv.grudge.sev >= 3 ? '我们之间，没什么可谈的。' : '我还在气头上。改日再来。') + '」';
    if (free) {
      log(line, 'say'); // 该句自带主语与引号，不再是光秃秃的台词，原样落见闻录
      sync();
    } else {
      renderDlg(id, line, '', [{ l: '（继续交谈）', a: 'dback', n: id }]);
    }
    return;
  }
  const req = { interest: spec.interest + (bv.intimacy >= 2 ? 1 : 0), risk: spec.risk, violate: spec.violate };
  if (free) log('你向' + n.name + '开口' + (spec.violate ? '——话里带着威胁的味道' : '') + '。', 'nar');
  const p = ai();
  if (p.npcDecideAsync) {
    /* LLM 通道：先给「沉吟」演出，回包后落地判定与后果 */
    if (free) log('（' + n.name + '沉吟着，似乎在斟酌措辞……）', 'nar');
    else renderDlg(id, '（' + n.name + '沉吟着，似乎在斟酌措辞……）', '', [{ l: '（等待回应）', a: 'noop', n: id, dis: true }]);
    p.npcDecideAsync(id, req, npcCtx(id, spec.l))
      .then((r) => finishReq(id, r || p.npcDecide(id, req), spec, !!r, free))
      .catch(() => finishReq(id, p.npcDecide(id, req), spec, false, free));
    return;
  }
  finishReq(id, p.npcDecide(id, req), spec, false, free);
}

function npcCtx(id: string, request: string): NpcCtx {
  const s = need();
  const n = WB.npcs[id];
  /* 上下文档位（2026-09 · NPC 分级）：NPC 判断「要不要答应你」时，该看的是
     **有分量的旧事**，不是最近三条闲聊——你上个月赖过别人的账，比昨天聊了天气
     更该影响他借不借钱给你。
     这里用 quest 档（minImportance 0.15、不听传闻）：三个检索档里它的判据最严，
     正合「权衡」这种要事实不要闲话的场合。在此之前它是唯一没有消费者的档位。 */
  const budget = resolveBudget(
    (n as { worldImportance?: number }).worldImportance ?? 1,
    lodOfNpc(id, s, sceneTime(s).day),
    'quest',
  );
  return {
    npcName: n.name,
    npcTitle: n.title,
    att: attOf(id),
    attWord: attWord(attOf(id)),
    mem: buildMemoryContext({ ownerId: id, query: request }, s, sceneTime(s).day, 'quest', {
      topK: budget.memoryTopK,
      tokens: budget.tokens,
    }).map((l) => l.text),
    playerName: s.player.name,
    playerCls: clsName(s),
    location: WB.locations[s.player.loc].name,
    request,
  };
}

function finishReq(id: string, res: NpcVerdict, spec: ReqSpec, fromLlm: boolean, free = false) {
  const n = WB.npcs[id];
  const W = res.W;
  /* 台词池与 LLM 的十档 verdict 契约一一对齐——此前只覆盖六档，
     「延迟回答」落在「拒绝并解释」的池子里，嘴里说「不行」，判定栏却写着「延迟回答」。 */
  const rp: Record<string, string[]> = {
    答应: ['“……行吧。就这一次。”', '“看在你的面子上，我答应了。”'],
    有条件答应: ['“可以——但你得先帮我办件事。”', '“不是不行。价钱，或者人情，你选一样。”'],
    延迟回答: ['“这事……容我想想。”', '“急什么。过几天再来听回话。”'],
    反提议: ['“直接答应你，我图什么？换个说法——你出什么价？”', '“这事对我没好处。除非……你能给我点别的。”'],
    拒绝并解释: ['“不行。不是针对你——这事对我没半点好处。”', '“抱歉，做不到。人得先顾好自己的日子。”'],
    拒绝并替代: ['“这个不行。不过——你要是缺别的，倒可以来找我。”', '“办不了。但你说的那件事，我可以换个法子帮你。”'],
    沉默: ['（' + n.name + '移开视线，一言不发。）', '（半晌的沉默。这个话题到此为止。）'],
    反问: ['“你先说说，凭什么？”', '“哦？那你为我做过什么？”'],
    质疑: ['“就凭你？”', '“你想清楚自己在说什么了吗？”'],
    拒绝: ['“不行。”', '“这件事，免谈。”'],
  };
  const line = fromLlm && res.line ? res.line : rng.pick(rp[res.verdict] || rp['拒绝并解释']);
  if (res.verdict === '有条件答应' && attOf(id) >= 0) adjAtt(id, 1, '请求');
  /* 威胁的必然后果由规则层执行（原型 reqMenu.cons —— 修正为真实触发） */
  if (spec.violate) {
    adjAtt(id, -30, '威胁');
    {
        const st = need();
        worldBus.emit(makeEvent({ type: 'grudge_formed', day: sceneTime(st).day, tick: st.t, level: levelOf('grudge_formed'), actor: 'player', target: id, data: { npc: id, why: '你出言威胁', sev: 2 } }));
      } // 卡 11：请求里的威胁同样结怨
    addMem(id, '被出言威胁', 3);
    const s = need();
    if (WB.locations[s.player.loc].danger < 2) {
      commitCrime('threat', s.player.loc);
      scheduler.after(1700, () => {
        if (need().player.wanted > 0) guardStop();
      });
    } else addRep('shadow', -5);
  }
  if (free) {
    /* 自由输入通道：权衡卡是浮层演出，见闻录里台词与结论各一行即可 */
    log(quoteSay(n.name, line), 'say');
  } else {
    const w =
      '<div class="weigh"><b>〔' +
      n.name +
      '的内心权衡 · NPC 决策' +
      (fromLlm ? ' ·LLM' : '') +
      '〕</b><br>· 是否符合我的利益？' +
      (W.interest > 0 ? '<span class="ok">是</span>' : '<span class="no">否</span>') +
      '<br>· 是否触碰我的底线？' +
      (W.vio ? '<span class="no">是</span>' : '<span class="ok">否</span>') +
      '<br>· 风险：<span class="' +
      (W.risk >= 2 ? 'no' : 'mid') +
      '">' +
      ['无', '低', '高', '极高'][W.risk] +
      '</span>　· 与你的关系：<span class="mid">' +
      attWord(W.att) +
      '</span><br>→ 判定：<b>' +
      res.verdict +
      '</b></div>';
    const opts: OptDesc[] = [{ l: '（继续交谈）', a: 'dback', n: id }];
    renderDlg(id, line, w, opts); // 同上：唯一渲染入口
  }
  log('（' + n.name + ' 权衡了你的请求——' + res.verdict + (fromLlm ? ' ·LLM' : '') + '。）', 'ai');
  sync();
}

/* ---------- 对话动作总线（原型 dlgAct 全量转写） ---------- */

export function dlgAct(id: string, a: string, extra?: string) {
  const s = need();
  const say = (t: string, e = '', opts?: OptDesc[]) => renderDlg(id, t, e, opts);
  switch (a) {
    case 'chat':
      openChat(id); // 聊天窗口（第四通道）：原硬编码单句闲聊表退役（C1 修复）
      break;
    case 'q_debt':
      giveQuest('q_debt');
      say('“老乔那笔账，三百铜板。你要能收回来——往后的房钱，我给你打个折。”');
      break;
    case 'q_debt_in':
      turnIn('q_debt');
      say('“收回来了？好孩子。”莉安把钱袋倒过来抖了抖，笑骂了一句，“这老酒鬼……行，往后你在这儿的房钱全免。”');
      break;
    case 'inn':
      closeSheet();
      restAt('lodging');
      break;
    case 'q_guild':
      if (!s.player.quests.q_rabbit) {
        giveQuest('q_rabbit');
        say('“新人就从猎兔令开始。城郊麦田的角兔成灾了——讨伐三只，拿凭证回来复命。”');
      } else say('“手上的委托做完了吗？公会的规矩：一次一件事。”');
      break;
    case 'q_rabbit_in':
      turnIn('q_rabbit');
      say('戈林验过凭证，在册子上划了一笔：“干净利落。公会见你不赖——下次有像样的委托，先想着你。”');
      break;
    case 'song':
      advanceAnd(1);
      adjAtt('selina', 1, '听歌');
      say(
        '琴弦轻拨——<br><br>　　“七塔灯火次第明，星海无声渡魂灵。<br>　　莫问归途何处是，人间一梦到天明。”<br><br>一曲终了，满堂喝彩。',
      );
      break;
    case 'info_buy':
      if (s.player.gold < 200) {
        say('“消息是金子买的，朋友。你差二百。”');
        break;
      }
      gainGold(-200);
      say(
        rng.pick([
          '“洞窟三层祭坛的东西——公会的老手叫它『尸鬼祭司』。圣光与火焰对亡灵最有效。”',
          '“城里唯一敢收赃的只有深巷的『灰烬』。但你最好别跟那种东西打交道。”',
          '“范德尔那老头在找星枢残片——如果你真从洞里挖出什么，他能出大价钱。”',
          '“奥托的货被劫进了旷野的营地。他现在见谁都哭丧着脸——正是表现的机会哦。”',
        ]),
      );
      log('（你从赛琳娜处买到了一条情报。）', 'gain');
      break;
    case 'q_letter_in':
      s.player.quests.q_letter.stage = 'done';
      removeItem('letter');
      turnIn('q_letter');
      say('赛琳娜挑开火漆，看完忽然笑了：“这小丫头……替我谢谢她。还有——”她冲你眨眨眼，“今后想听真话，来找我。”');
      break;
    case 'shop_iron':
      openShop('iron');
      break;
    /* 卡 I2：工坊入口（对话 → 浮层） */
    case 'craft_menu': {
      closeSheet();
      const st = stationOfNpc(id);
      if (st) craftMenu(st.id);
      break;
    }
    case 'q_theft_give':
      giveQuest('q_theft');
      say(
        '“打成一半的精钢剑坯，昨夜不翼而飞！”布伦丹的锤子砸得铁砧直响，“帮我找回来。那是我给守城卫队打的活儿——砸的是我的招牌！”',
      );
      break;
    case 'q_theft_in': {
      const q = s.player.quests.q_theft;
      if (itemCount('blade_blank')) {
        removeItem('blade_blank');
        q.stage = 'done';
        turnIn('q_theft');
        say('布伦丹接过剑坯，翻来覆去看了三遍，忽然大笑：“好小子！这炉钢总算没白打——往后你的铁器，一律八折！”');
      } else if (q.stage === 'trail' || q.stage === 'confront')
        say('“有线索了？脚印？……巷子。”布伦丹眯起眼，“继续查。查到东西，我记你一功。”');
      else say('“还没消息？去集市转转——东西不会飞出城去。”');
      break;
    }
    case 'q_theft_cf': {
      const q = s.player.quests.q_theft;
      check(
        '对质·灰烬',
        '魅力',
        13,
        (r) => {
          if (r.ok) {
            addItem('blade_blank');
            q.stage = 'done';
            renderDlg(
              id,
              '灰烬沉默良久，从阴影里推出一个布包：“……拿走。别问，也别说。”<br><br>（获得：精钢剑坯。可以还给布伦丹了。）',
            );
            log('灰烬交还了剑坯。他不想要麻烦——至少不想要城卫队的麻烦。', 'nar');
            sync();
          } else
            renderDlg(
              id,
              '“剑坯？”兜帽微微一斜，“不知道你在说什么。”<br><br>（检定失败——你可以花钱消灾，或者向城卫队告发。）',
              '',
              [
                { l: '花钱赎回（' + formatMoney(500) + '）', a: 'cf_pay', n: id },
                { l: '向城卫队告发', a: 'cf_report', n: id, cls: 'dg' },
              ],
            );
        },
        'NPC 决策：利益受损时会让步，但会记仇',
      );
      break;
    }
    case 'cf_pay':
      if (s.player.gold < 500) {
        say('“五百。少一个子儿都免谈。”（你的钱不够。）');
        break;
      }
      gainGold(-500);
      addItem('blade_blank');
      s.player.quests.q_theft.stage = 'done';
      say('钱货两讫。灰烬把布包推过来：“聪明人。东西拿走——我们两清。”');
      log('你花 ' + formatMoney(500) + '从灰烬手里赎回了剑坯。', 'nar');
      sync();
      break;
    case 'cf_report':
      s.player.quests.q_theft.stage = 'done';
      addRep('empire', 5);
      addRep('shadow', -10);
      say('（你没有理会灰烬的沉默，径直走向岗哨——城卫队很快封锁了深巷。）<br><br>剑坯物归原主。灰烬从此记住了你。');
      log('你向城卫队告发了深巷的销赃窝点。帝国记你一功，暗处则多了一道冰冷的目光。', 'nar');
      adjAtt('ash', -40, '告发');
      worldBus.emit(makeEvent({ type: 'grudge_formed', day: sceneTime(s).day, tick: s.t, level: levelOf('grudge_formed'), actor: 'player', target: 'ash', data: { npc: 'ash', why: '你向城卫告发', sev: 3 } })); // 卡 11：sev3 长记忆
      sync();
      break;
    case 'heal':
      closeSheet();
      healSvc();
      break;
    case 'q_holy_give':
      giveQuest('q_holy');
      say('“月祭需要圣泉之露——以三株月见草在月光下酿成。旷野背阴处应该能采到。”艾德里安合上典籍，“愿圣光指引你的脚步。”');
      break;
    case 'q_holy_in':
      turnIn('q_holy');
      say('“三株，品相都很好。”艾德里安郑重收好药草，回身取出两只小瓶，“圣水——路上小心使用，它会灼伤一切邪物。”');
      break;
    case 'lore_t':
      advanceAnd(1);
      adjAtt('adrian', 1, '求教');
      say(
        '“六大神系——战争之主阿尔卡斯、万典之主维罗妮卡、生命之源伊莲娜、冥府之主诺克斯、归墟之主洛基，还有缄默的龙神。”艾德里安的目光穿过彩窗，“神明从不在人间行走。我们感受到的一切——神谕、神罚、神选——都只是祂们的投影。”<br><br>“……而星枢，也许是我们离祂们最近的地方。”',
      );
      break;
    case 'lore_s':
      advanceAnd(1);
      adjAtt('vandel', 1, '求教');
      say(
        '“七塔！圣辉城、翠风港、金砂城、霜锚堡、血吼城、深井城、天穹之城——一塔一城，恰合北斗！”老人压低声音，“星枢只传心念，不传实体。可你想过没有——如果有一天它『完全启动』，顺着地脉渗上来的……会是什么？”',
      );
      break;
    case 'shop_black':
      openShop('black');
      break;
    case 'info_ash':
      if (s.player.gold < 150) {
        say('“……（兜帽朝你摊开一只枯瘦的手掌。）”（钱不够。）');
        break;
      }
      gainGold(-150);
      say('“最近风声紧。城卫在查商队的案子——你的『货』，藏严实点。”<br><br>（获得情报：近期被盘查概率上升。）');
      log('灰烬提醒你：风声正紧，违禁品容易被查获。', 'ai');
      break;
    case 'q_letter_give':
      giveQuest('q_letter');
      addItem('letter');
      say('“这封信要交给『银鸥』的赛琳娜姐姐——天黑前一定送到！这比跑腿费重要多啦！”');
      break;
    case 'msg':
      if (s.player.gold < 50) {
        say('“五十铜板……你还差一点。”');
        break;
      }
      gainGold(-50);
      say(
        '“要带给谁呀？”',
        '',
        Object.keys(WB.npcs)
          .filter((k) => k !== 'mia')
          .map((k) => ({ l: '带给 ' + WB.npcs[k].name, a: 'msg_to', n: 'mia', t: k })),
      );
      break;
    case 'msg_to':
      if (extra) {
        advanceAnd(1);
        adjAtt(extra, 3, '口信');
        adjAtt('mia', 1, '跑腿');
        renderDlg('mia', '“包在我身上！明天一早就到——米露的信使服务，全城最快！”');
        log('你托米露给 ' + WB.npcs[extra].name + ' 带了句问候。', 'sys');
        sync();
      }
      break;
    case 'law':
      advanceAnd(1);
      say(
        '“帝国律五等：S 灭世、A 极恶、B 重罪、C 中罪、D 轻罪。”雷诺扳着手指，“偷窃是 D，伤人是 C 或 B；赎罪金、监禁、流放、死刑——一档一档往上。缴纳罚金可以销案，但案底……案底会跟你一辈子。”',
      );
      break;
    case 'payfine': {
      const c = 300 * s.player.wanted;
      if (s.player.gold < c) {
        say('“赎罪金 ' + formatMoney(c) + '。少一个子儿都不行。”');
        break;
      }
      payFine();
      say('雷诺收下罚金，在册子上重重划去一行：“下不为例。圣辉城容得下回头的人——但只容一次。”');
      sync();
      break;
    }
    case 'q_shard_give':
      giveQuest('q_shard');
      say(
        '“洞窟三层，古代祭坛。”范德尔的眼睛在镜片后发亮，“我的推论：祭坛基座下埋着星枢残片。取回来——研究会不会亏待你。但要小心，那地方……有东西守着。”',
      );
      break;
    case 'q_shard_in':
      turnIn('q_shard');
      say(
        '老人捧着残片的手在抖：“六芒星纹……七塔同源。这值一枚白金币——不，值十枚。但研究会的规矩……”他郑重地递过一枚白金币，“拿着。这是你应得的。”',
      );
      break;
    case 'q_caravan_give':
      giveQuest('q_caravan');
      say(
        '“您是说真的？！”奥托一把抓住你的手，“货在旷野的劫掠者营地——两个亡命徒守着。夺回来，药价就能落回去！这是全城穷人都会念你好的大事！”',
      );
      break;
    case 'q_caravan_in':
      turnIn('q_caravan');
      say('奥托清点着货箱，数着数着就抹起了眼睛：“一箱不少……恩人！往后你的药，八折，永远八折！”');
      break;
    case 'shop_grocer':
      openShop('grocer');
      break;
    case 'q_debt_joe':
      renderDlg('joe', '老乔抬起醉眼，酒杯停在半空：“账……我知道。可我这条老命，当船员攒的棺材本早喝进肚子里了……”', '', [
        { l: '替他垫付 ' + formatMoney(300) + '（义气）', a: 'joe_pay', n: 'joe' },
        { l: '说服他打零工还债', a: 'joe_per', n: 'joe', h: '魅力检定' },
        { l: '施压（他不敢不从）', a: 'joe_threat', n: 'joe', cls: 'dg' },
      ]);
      break;
    case 'joe_pay':
      if (s.player.gold < 300) {
        renderDlg('joe', '（你的钱袋也不够三百……老乔看着你，忽然笑了：“咱俩，都是穷光蛋。”）');
        break;
      }
      gainGold(-300);
      s.player.quests.q_debt.stage = 'done';
      adjAtt('joe', 20, '垫付欠账');
      renderDlg('joe', '老乔盯着你放在桌上的钱，喉结动了动：“……你这孩子。”他别过头去，“『海燕号』的老水手不欠人情——记下了。”');
      log('你替老乔垫付了三百铜板。这笔账，他记在了心里。', 'nar');
      sync();
      break;
    case 'joe_per':
      check('说服·老乔', '魅力', 12, (r) => {
        if (r.ok) {
          s.player.quests.q_debt.stage = 'done';
          adjAtt('joe', 12, '说服');
          renderDlg(
            'joe',
            '“……行。”老乔把酒杯扣在桌上，“码头扛包，一个月还清。莉安那里，我明早自己去说。”他咧嘴一笑，“你这小子，会说话。”',
          );
        } else renderDlg('joe', '“打零工？我这把老骨头？”老乔摆摆手，又给自己倒了一杯。（换个方式试试——垫付，或者施压。）');
        sync();
      });
      break;
    case 'joe_threat':
      s.player.quests.q_debt.stage = 'done';
      adjAtt('joe', -10, '被施压');
      adjAtt('lita', -5, '粗暴讨账');
      renderDlg('joe', '老乔的手一抖，酒洒了半桌。他哆哆嗦嗦掏出几个铜板：“……有、有。别动手……”');
      log('你吓唬老乔还了账。莉安后来听说了，什么也没说——只是擦杯子的手重了几分。', 'nar');
      sync();
      break;
    /* —— 卡 H6 · 学院导师专属动作 —— */
    case 'lore_wind':
      advanceAnd(1);
      adjAtt('tutor_wind', 1, '求教');
      say(
        '“你看这条线。”雅拉在石阶上划了一道，“从这儿到那儿，正常走要一刻钟。可如果你走的是‘褶皱’——三步。”她把手指按在线段中段，“学园头一年只教一件事：分辨哪条线是直的。' +
          '大部分人一辈子都走在直线上，还以为那是唯一的路。”<br><br>“……星枢传讯也是这个道理。它不缩短距离，它找你最近的那道褶。”',
      );
      break;
    case 'lore_deep':
      advanceAnd(1);
      adjAtt('tutor_deepwell', 1, '求教');
      say(
        '科兹把拓片摊在膝盖上，指尖顺着纹路往下走。“这一笔是‘沉’。再往下第七笔，是‘归’。”他顿了顿，“第七层的墙上只有这两个字——写了两千遍。”' +
          '<br><br>兜帽下的眼窝没有一点光。“我不是在找宝藏。我在找：是谁在往下走的时候，还在数着步子。”',
      );
      break;
    case 'lore_sky':
      advanceAnd(1);
      adjAtt('tutor_skycap', 1, '求教');
      say(
        '“浮岛会漂。”阿亚仰着头，“今天在云海西侧，明年可能就到东边去了。可你抬头——‘织梭’永远在那个位置。”<br><br>' +
          '“观星台教的不是看星星，是在会动的地方，找到不动的东西。”她顿了顿，“八年很长。你要是熬得住，就来找我。”',
      );
      break;
    case 'train':
      advanceAnd(6);
      mutate.playerHp(s.player.hp + Math.ceil(maxHp() * 0.15), maxHp());
      say(
        '“脚跟再沉半寸。”罗兰用木剑敲了敲你的后腰，“你不是力气不够，是站不住。站不住的人，第一次出城就回不来了。”' +
          '<br><br>六个时辰后，你的腿在抖，但重心稳了。',
      );
      sync();
      break;
    case 'ac_menu':
      closeSheet();
      academyMenu(); // 卡 H6：学院名录 · 报名（与 engine 的 ac_menu 同一条路径）
      break;
    case 'gift':
      giftPicker(id); // 卡 11：赠礼选择器（背包→confirmSheet 路由 gift_give）
      break;
    case 'apologize':
      apologize(id); // 卡 11：赔罪（检定+补偿金→降怨）
      break;
    case 'dreq':
      reqMenu(id);
      break;
    case 'dback':
      openDlg(id);
      break;
  }
}

function advanceAnd(n: number) {
  advance(n);
}

export { attColor, attWord };

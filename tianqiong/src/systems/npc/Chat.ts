/* ============================================================
   聊天窗口（第四通道 · 卡片6）：自由对话会话引擎
   - chatCtx 关系包 = 唯一关系读取组装点（G8）：att/门禁档/mem/rels 牵扯/
     势力立场/日程 act/窗口历史，同源供 chat/chatAsync/npcDecide 消费；
   - 规则门禁（不依赖 LLM）：敌意档拒开、NPC 须在场、warm 话题需友好以上；
   - 后果收敛 chatApply：AI 只回 {line, attDelta, mem, rumor}，core 白名单
     + clamp + 日封顶（同 NPC ≤+2/日、全局 ≤+4/日，封堵闲聊刷好感洞 C2）；
     rumor 走 spreadRumor 沿 rels 关系网扩散；每 3 轮玩家发言 advance(1)；
   - 历史入 WorldState.chats（可选字段，每 NPC 封顶 20 轮，旧档可读）；
   - 降级铁律：chatAsync 失败/缺席 → ruleSim.chat 三档池+interest 模板+上句去重。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { hasTalk, loadTalk, talkOf } from '@/data/talk';
import type { NpcTopicCard, WorldState } from '@/types/world';
import { askedOf, markAsked, markDeep, topicDepth, type TopicGateCtx } from './Talk';
import { buildMemoryContext, memoryEngine } from '@/memory';
import { lodOfNpc } from './Lod';
import { chatBudget, personaCharsFor } from './ContextProfile';
import { bus, clamp, toast, worldBus } from '@/events/EventBus';
import { levelOf, makeEvent } from '@/events/EventSchema';
import { bondOf, grudgeCheck, tryIntimacyUp } from '@/systems/relationship/Bond';
import { clsName } from '@/systems/character/Derived';
import { addMem, adjAtt, attOf, attWord, npcActNow, npcAt, npcDyn, presentNPCs } from '@/systems/npc/Npcs';
import { ai } from '@/plugins/PluginInterface';
import type { ChatCtx, ChatReply } from '@/plugins/PluginInterface';
import { factionName, repAxis } from '@/systems/faction/Factions';
import { log } from '@/systems/character/Gains';
import { relsOf } from '@/systems/relationship/Relations';
import { currentChatId, currentDialogId, currentDialogPage, openChatSheet, openDialog } from '@/systems/character/Sheet';
import { mutate } from '@/world/WorldMutate';
import { need, sync } from '@/world/WorldState';
import { advance, sceneTime } from '@/world/WorldClock';

/** 窗口历史封顶（超出丢最旧，控制存档体积 R3） */
const CAP_TURNS = 20;

/** 会话条目的稳定 key：窗口有 20 条裁剪，下标会随之上移一格——React 只能复用节点
 *  装错内容（气泡动画重播、日分隔条串位）。序号只在会话内有意义，不入档。 */
let turnSeq = 0;
const turnId = (): string => 'c' + ++turnSeq;

export function chatTier(att: number): ChatCtx['tier'] {
  return att <= -45 ? 'hostile' : att < 20 ? 'cold' : att < 45 ? 'neutral' : 'warm';
}

function turnsOf(id: string) {
  const s = need();
  if (!s.chats) s.chats = {};
  return (s.chats[id] = s.chats[id] || []);
}

/** 话题 chips：safe 常在；warm 私密话题需友好档（att≥45）或亲密度≥1（卡 11 权益） */
export function chatChips(id: string): string[] {
  const s = need();
  const n = WB.npcs[id];
  if (!n) return [];
  const tier = chatTier(attOf(id, s));
  const iv = s.npcs[id]?.intimacy || 0; // 亲密度权益：档在则话题常在（att 回落不退档，权益仅私密话题保留）
  const labels = (n.topics || [])
    .filter((t) => (t.tier === 'warm' ? tier === 'warm' || iv >= 1 : true))
    .map((t) => t.l);
  /* P2 追问链：谈过的话题不再原样出标签（玩家问过了），换成它的 next 钩子。
     零 UI 改动就长出"接着问"——chips 本来就是 string[]，点即 send。
     话题卡没加载完时 talkOf 返回空表，行为与从前逐字节一致。 */
  /* P3：谈过与否从**落档**读（talkProg），不再扫对话窗口里玩家说过的话——
     窗口有 CAP_TURNS 封顶，满窗之后最老的提问被丢掉，问过的话题标签会重新冒出来。 */
  const asked = new Set(Object.keys(s.npcs[id]?.talkProg || {}));
  const out: string[] = labels.filter((l) => !asked.has(l));
  for (const c of talkOf(id)) if (asked.has(c.l) && c.next) out.push(...c.next);
  return out.slice(0, 4);
}

/**
 * 话题命中（P2 · 确定性，不掷随机）：
 *   ① 标签精确匹配——点 chip 走的就是这条
 *   ② 标签的 2-gram 与发言重叠计分，取最高者；至少命中两段才认，
 *      免得「我」「你」这类碎片把任意一句都误判成某个话题
 *   ③ 都不中 → null，调用方落原有三档池（行为不变、不报错）
 */
export function matchTopic(id: string, input: string): NpcTopicCard | null {
  const cards = talkOf(id);
  if (!cards.length) return null;
  const q = input.trim();
  if (!q) return null;
  const exact = cards.find((c) => c.l === q);
  if (exact) return exact;
  let best: NpcTopicCard | null = null;
  let bestScore = 0;
  for (const c of cards) {
    let score = 0;
    for (let i = 0; i + 1 < c.l.length; i++) if (q.includes(c.l.slice(i, i + 2))) score++;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 2 ? best : null;
}

/* P3：判据搬到 systems/npc/Talk.ts（纯模块：只读状态与卡片，零依赖、不掷随机）。
   这里保留同名再导出——既有的 `@/systems/npc/Chat` 导入路径不因此断掉。 */
export { topicDepth };

/**
 * 深水区门槛的运行时上下文。
 * 亲密度取 Bond 的「权益有效档」（att<60 时冻结为 0）——与赠礼、请求用的是同一口径，
 * 不在这里另立一套判据；quest/flag 直接查玩家状态。判据本身仍在 Talk.ts。
 */
function gateCtxOf(card: NpcTopicCard, id: string, s: WorldState): Omit<TopicGateCtx, 'att'> {
  const c = card.gate ?? {};
  const st = c.quest ? s.player.quests[c.quest]?.stage : undefined;
  return {
    intimacy: bondOf(id, s).intimacy,
    questOk: !c.quest || st === 'done' || st === 'fin',
    flagOk: !c.flag || !!s.player.flags[c.flag],
  };
}

/**
 * 深谈页的接管回调（由 Dialogue 在模块加载时注册）。
 * 注册了且深谈页正开着 → 气泡回流到对话框那一页，不再弹聊天浮层；
 * 没注册（例如只加载了 Chat）→ 照旧弹浮层，行为逐字节不变。
 */
let deepRenderer: ((id: string, busy: boolean) => void) | null = null;
export function setDeepTalkRenderer(fn: ((id: string, busy: boolean) => void) | null) {
  deepRenderer = fn;
}

/**
 * 往会话流里追加一条（只写条目，不碰好感/轮次/记忆——那些是 chatApply 的活）。
 * 目前只有一处消费者：对话的开场白。开场那句是这段对话的第一条，
 * 深谈页的时间线要从它开始，否则玩家一进深谈页就看见"凭空开始"的对话。
 */
export function pushTurn(id: string, who: 'p' | 'n', text: string) {
  const s = need();
  const turns = turnsOf(id);
  turns.push({ who, text, day: sceneTime(s).day, id: turnId() });
  if (turns.length > CAP_TURNS) turns.splice(0, turns.length - CAP_TURNS);
}

/** 这个 NPC 的会话流是不是正开着——聊天窗，或对话框的深谈页 */
function chatSurfaceOpen(id: string): boolean {
  if (currentChatId() === id) return true;
  return currentDialogId() === id && currentDialogPage() === 'timeline';
}

function render(id: string, busy: boolean) {
  /* 玩家已经站在深谈页上：回复就该落在这一页，而不是掀开另一个浮层把上下文冲掉 */
  if (deepRenderer && currentDialogId() === id && currentDialogPage() === 'timeline') {
    deepRenderer(id, busy);
    return;
  }
  openChatSheet({ npcId: id, turns: turnsOf(id).slice(-CAP_TURNS), chips: busy ? [] : chatChips(id), busy });
}

/** 打开会话窗口（门禁：NPC 须在场；敌意档拒开——规则层，不依赖 LLM） */
/**
 * P2：确保这名 NPC 的话题卡已加载，拉回来之后广播一次 changed 让对话浮层重算 chips。
 * 两条入口都要调它——npcTalk 走 Dialogue.openDlg，聊天窗口走 Chat.openChat；
 * 只挂在其中一条上，另一条就永远拿不到追问钩子（实测踩过）。
 * 没有卡、或已经加载过，就是一次空操作。
 */
export function ensureTalk(id: string): void {
  if (!hasTalk(id) || talkOf(id).length) return;
  void loadTalk(id).then((cards) => {
    /* UI 事件走 bus（CoreEvent），不是 worldBus——后者是 WorldEvent 总线，
       要 id/day/tick/level，发错了不会有人接。 */
    if (cards.length) bus.emit({ type: 'changed' });
  });
}

export function openChat(id: string) {
  ensureTalk(id);
  const s = need();
  const n = WB.npcs[id];
  if (!n) return;
  if (npcAt(id, s) !== s.player.loc) {
    openDialog({ npcId: id, text: n.name + '此刻不在你能找到的地方。', opts: [{ l: '（作罢）', a: 'dback', n: id }] });
    return;
  }
  if (chatTier(attOf(id, s)) === 'hostile') {
    openDialog({
      npcId: id,
      text: '(' + n.name + '背过身去。对现在的你来说，任何话都会说错。)',
      opts: [{ l: '（离开）', a: 'dback', n: id }],
    });
    return;
  }
  if (!s.npcs[id]) s.npcs[id] = { att: 0, mem: [], met: false };
  mutate.npcMet(id);
  render(id, false);
}

/** 关系包组装（G8 唯一读取点）：牵扯取 |val|≥10 的强边前三 */
function buildCtx(id: string, input: string): ChatCtx {
  const s = need();
  const att = attOf(id, s);
  const edgeWord = (v: number) => (v >= 20 ? '交好' : v > -20 ? '往来' : v > -45 ? '不睦' : '敌对');
  const rels = Object.entries(relsOf(id, s))
    .sort((a, b) => Math.abs(b[1].val) - Math.abs(a[1].val))
    .filter(([, e]) => Math.abs(e.val) >= 10)
    .slice(0, 3)
    .map(([oid, e]) => (WB.npcs[oid]?.name || oid) + '：' + edgeWord(e.val));
  const stance: string[] = [];
  const n = WB.npcs[id];
  if (n.faction) {
    const rep = repAxis(n.faction, 'attitude', s);
    stance.push('所属' + factionName(n.faction) + '·你对该势力声望 ' + (rep >= 0 ? '+' : '') + rep);
    if (repAxis(n.faction, 'hostility', s) >= 30) stance.push('该势力正警惕你');
  }
  if (s.player.wanted > 0) stance.push('你是通缉犯（' + s.player.wanted + ' 级）');
  /* 上下文档位（2026-09 · NPC 分级与 Context Budget 方案 §8/§11）：
     对话原先固定取「最近 3 条记忆」——只看时间不看内容，一位神祇和一位报童
     拿到的条数一模一样，而且陈年闲聊会挤掉真正相关的旧事。
     改走记忆相关度检索（查询词 = 玩家这一句），名额由档位给：
     世界重要度定上限，LOD 定当前投入，最终还得过 Token 预算裁剪。

     关系牵扯（下面 rels）不动：它本来就有筛选（|val|≥10 的强边取前三），
     不属于方案 §12 指的「无界展开」。 */
  /* C 卡：预算账本。人设 / 记忆 / canon / 立场与历史 / 预留五块共用同一个场景上限——
     此前记忆检索拿的是**整个**场景预算，人设与 canon 只能分零头，
     于是「同一个人的记忆越丰富，他越不像他自己」。 */
  const importance = (n as { worldImportance?: number }).worldImportance ?? 1;
  const plan = chatBudget(importance, lodOfNpc(id, s, sceneTime(s).day), 'npc_dialogue');
  return {
    npcId: id,
    att,
    attWord: attWord(att),
    tier: chatTier(att),
    /* 账本交给适配器：人设多长、canon 投多少，core 与 AI 层同一份数字 */
    budget: { profile: plan.profile, personaChars: personaCharsFor('chat', plan.profile), canonChars: plan.canon },
    mem: buildMemoryContext({ ownerId: id, query: input }, s, sceneTime(s).day, 'npc_dialogue', {
      topK: plan.memoryTopK,
      tokens: plan.memory,
    }).map((l) => l.text),
    rels,
    stance,
    location: WB.locations[s.player.loc]?.name || '',
    act: npcActNow(id, s),
    playerName: s.player.name,
    playerCls: clsName(s),
    history: turnsOf(id).slice(-6).map((t) => ({ who: t.who, text: t.text })),
    input,
  };
}

/** 玩家发言（经 GameCommand 唯一入口调用）；在场门禁与开窗一致（防中途 NPC 离场仍可发言） */
export function sendChat(id: string, text: string) {
  sendChatTo(id, text);
}

/**
 * 台词去向（呈现路由）。core 侧的副作用——好感、记忆、传闻、轮次、深水区代价——
 * 与 sink 无关，两条通道完全同一套管线；差别只在**台词落在哪个面上**：
 * · 缺省（深谈页/聊天窗）：busy 时「沉吟」演出，回包刷新浮层（applyChat 末尾的
 *   chatSurfaceOpen 检查，F-17：玩家关掉的窗口不得被异步回包弹回）。
 * · 自由输入通道：deliver 把定稿台词交给调用方落进见闻录，再由编织织入正文。
 */
export interface ChatSink {
  busy?: () => void;
  deliver: (line: string) => void;
}

/**
 * 自由通道「回包未落地」计数（BUG-002 · 2026-09-29 实测）：
 * 攀谈的台词是异步回流的，而编织窗在链尾 0ms 就合上——旧实现里窗先织走前半截，
 * 回包落地后再开第二批，两批各写各的、后批还插到前批上面。ActionParser 用这个
 * 计数把织窗推迟到最后一条回包落地，一轮输入只织一批。
 * 计数收口在 sendChatTo：门禁之后的每一条路径（敌意冰墙 / 无模型话题 / 异步回包）
 * 都恰好调一次 deliver，计数在这里 +1、在 deliver 包装里 -1，不依赖调用方自觉。
 */
let freeChatPending = 0;
export const freeChatsPending = (): number => freeChatPending;

export function sendChatTo(id: string, text: string, sink?: ChatSink, record?: string) {
  const s = need();
  const n = WB.npcs[id];
  if (!n) return;
  if (npcAt(id, s) !== s.player.loc) {
    toast('✖ ' + n.name + '不在你面前');
    return;
  }
  const input = (text || '').trim().slice(0, 40);
  if (!input) return;
  /* 会话记录写玩家原文（UX-001 实测）：free 通道传进来的是剥过动词的话题片段，
     窗口历史里却该是玩家真正说的那句话——否则翻旧账时对不上原话。 */
  const turnText = (record ?? input).trim().slice(0, 40) || input;
  const turns = turnsOf(id);
  turns.push({ who: 'p', text: turnText, day: sceneTime(s).day, id: turnId() });
  if (turns.length > CAP_TURNS) turns.splice(0, turns.length - CAP_TURNS);
  if (sink) {
    freeChatPending++;
    const out = sink;
    sink = { busy: out.busy, deliver: (line) => { freeChatPending--; out.deliver(line); } };
  }
  const tier = chatTier(attOf(id, s));
  if (tier === 'hostile') {
    applyChat(id, { line: '(' + n.name + '懒得回应。此刻你们之间只剩下冰。)' }, undefined, sink);
    return;
  }
  /* P2：命中话题时按「有没有模型」分两条路——
     无模型直出定稿的那一层（不配模型也能深入），
     有模型则把话题卡降为「素材 + 边界」，措辞交给它、范围由 facts 框住。 */
  const card = matchTopic(id, input);
  const p = ai();
  let topic: ChatCtx['topic'];
  /* 本轮命中的话题与其层号：谈透的产出与代价在 applyChat 里结算（两条路同一出口） */
  let deep: { card: NpcTopicCard; depth: 0 | 1 | 2 } | undefined;
  if (card) {
    /* 落档前先确保这家 NPC 的条目存在：npcDyn 是「建档即投影」的唯一入口，
       缺了它 markAsked 会因为读不到条目而静默丢弃这一次计数（实测踩过）。 */
    npcDyn(id, s);
    /* P3：次数从状态里读（talkProg），不从对话窗口里数——窗口 CAP_TURNS 封顶，
       满窗之后计数会掉头向下，深水区当场退回表层、追问链也会把问过的标签重新吐出来。
       askedOf 是**本次之前**的累计值，所以本次是第 asked+1 次。 */
    const asked = askedOf(s, id, card.l) + 1;
    markAsked(s, id, card.l);
    const depth = topicDepth(card, asked, attOf(id, s), gateCtxOf(card, id, s));
    deep = { card, depth };
    if (!p.chatAsync) {
      const line = [card.say, card.inner, card.core][depth] || card.say;
      /* mem 不在这里给：谈透的产出与代价统一由 applyChat 结算（只结一次） */
      applyChat(id, { line }, deep, sink);
      return;
    }
    topic = {
      l: card.l,
      layer: depth,
      /* 已经说过的层一并给出：让模型接着往下说，而不是把第一层重讲一遍 */
      said: [card.say, card.inner, card.core].slice(0, depth + 1).filter(Boolean).join(' / '),
      facts: card.facts,
      edge: card.edge,
    };
  }
  const ctx = buildCtx(id, input);
  if (topic) ctx.topic = topic;
  if (p.chatAsync) {
    if (sink) sink.busy?.();
    else render(id, true); // 「沉吟」演出（复用 runReq 的等待模式）
    p.chatAsync(id, ctx)
      .then((r) => applyChat(id, r || p.chat(id, ctx), deep, sink))
      .catch(() => applyChat(id, p.chat(id, ctx), deep, sink));
    return;
  }
  applyChat(id, p.chat(id, ctx), deep, sink);
}

/**
 * 自由输入通道的攀谈（弱化专用对话界 · 2026-09）：管线与深谈完全同一套
 * （在场/敌意门禁 → 话题卡三层 → chatAsync → applyChat 结算），唯一差异是
 * 台词不经任何浮层，交给 deliver 落进见闻录、由编织织入正文。
 * deliver 可能同步调（无模型 / 敌意冰墙），也可能在 chatAsync 回包后异步调——
 * 调用方（ActionParser）拿水位在 deliver 里补开编织窗。
 * `record`：写进会话记录的玩家原文（free 通道的 input 是剥过动词的话题片段，
 * 窗口历史里留原话——UX-005 实测：翻旧账对不上玩家原话）。
 */
export function chatViaFree(id: string, input: string, deliver: (line: string) => void, record?: string): void {
  const s = need();
  const n = WB.npcs[id];
  if (!n) return;
  if (npcAt(id, s) !== s.player.loc) {
    toast('✖ ' + n.name + '不在你面前');
    return;
  }
  ensureTalk(id); // 话题卡懒加载：不拉的话 matchTopic 永远空手而归
  if (!s.npcs[id]) s.npcs[id] = { att: 0, mem: [], met: false };
  mutate.npcMet(id);
  sendChatTo(id, input, {
    /* 沉吟广播只服务输入框的占位提示：异步回包期间玩家该知道对方在想；
       同步路径（规则池/敌意冰墙）不经过 busy，deliver 一律收尾清场。 */
    busy: () => bus.emit({ type: 'npcMusing', name: n.name }),
    deliver: (line) => {
      bus.emit({ type: 'npcMusing', name: null });
      deliver(line);
    },
  }, record);
}

/**
 * 台词进见闻录的统一格式：带引号/括号开头的挂上说话人（米露：「……」），
 * 光秃秃的一句话包进引号再挂（米露：「……」）——见闻录里没有气泡，
 * 不知道谁在说就读不懂。
 */
export function quoteSay(name: string, line: string): string {
  return /^[「『("(（‘“]/.test(line) ? name + '：' + line : name + '：「' + line + '」';
}

/** 后果收敛（G9 范式）：白名单+clamp+日封顶；rumor 传播；每 3 轮耗时。
 *  sink 在场 = 自由输入通道：台词交给它落见闻录，浮层渲染整段跳过。 */
function applyChat(id: string, r: ChatReply, deep?: { card: NpcTopicCard; depth: 0 | 1 | 2 }, sink?: ChatSink) {
  const s = need();
  const n = WB.npcs[id];
  const day = sceneTime(s).day;
  const line = (r.line || '').trim().slice(0, 140) || '(' + n.name + '轻轻嗯了一声，算是回应。)';
  /* F-17：NPC 已离场 → 好感与记忆照常落地，但不记轮次、不重开窗 */
  const away = npcAt(id, s) !== s.player.loc;
  grudgeCheck(id); // 卡 11：交谈中态度恶化兜底
  /* attDelta：[-2,2] 白名单 + 正向日封顶（同 NPC ≤2 / 全局 ≤4）；负值不受封顶 */
  let d = Number.isFinite(r.attDelta) ? clamp(Math.trunc(r.attDelta as number), -2, 2) : 0;
  if (!s.bondDay || s.bondDay.day !== day) s.bondDay = { day, chatGain: 0 };
  const dy = npcDyn(id, s);
  if (!dy.chatDay || dy.chatDay.day !== day) dy.chatDay = { day, gain: 0 };
  if (d > 0) {
    d = Math.min(d, Math.max(0, 2 - dy.chatDay.gain), Math.max(0, 4 - s.bondDay.chatGain));
    if (d > 0) {
      dy.chatDay.gain += d;
      s.bondDay.chatGain += d;
    }
  }
  if (d !== 0) adjAtt(id, d, '交谈');
  /* P3：图鉴解锁改为**谈透才发**。此前它每轮交谈都发一次——「深谈解锁」的门形同虚设
     （随意搭一句话就解锁）。现在只有话题首次进到第 3 层（深水区）才解锁，
     并以 talkDeep 落档保证幂等：同一个话题只解锁一次、代价也只付一次。 */
  if (deep && deep.depth === 2 && markDeep(s, id, deep.card.l)) {
    worldBus.emit(
      makeEvent({
        type: 'lore_unlocked',
        day: sceneTime(s).day,
        tick: s.t,
        level: levelOf('lore_unlocked'),
        actor: id,
        data: { mode: 'deep_talk', npcId: id, topic: deep.card.l },
      }),
    );
    /* 谈透写进见闻录：对话不再只活在浮层里——它进了故事的正史，
       会被织成正文、压进前情，影响之后的每一次叙事与权衡。 */
    log('（「' + deep.card.l + '」被谈到了底——' + n.name + '压在心底的那些话，从此成了你们之间的事。）', 'ai');
    settleDeep(id, deep.card); // 产出与代价
  }
  if (!dy.bondProg) dy.bondProg = { gifts: 0, chats: 0, quests: 0 };
  dy.bondProg.chats++; // 卡 11：聊天轮次计入亲密度升级门
  const turns = turnsOf(id);
  if (!away) {
    turns.push({ who: 'n', text: line, day, id: turnId() });
    if (turns.length > CAP_TURNS) turns.splice(0, turns.length - CAP_TURNS);
  }
  /* §37：AI 产出的记忆必须过验证闸——早前它直接调 addMem 落库，
     等于把「模型能往记忆表里塞东西」这条缝留着（老表时代它是完全无闸的）。 */
  if (r.mem) {
    memoryEngine.propose(
      { ownerId: id, type: 'observation', content: String(r.mem).slice(0, 24), source: 'received_information' },
      s,
      sceneTime(s).day,
    );
  }
  if (r.rumor) {
    const topic = String(r.rumor).slice(0, 20);
    if (topic) {
      worldBus.emit(
      makeEvent({
        type: 'rumor_spread',
        day: sceneTime(s).day,
        tick: s.t,
        level: levelOf('rumor_spread'),
        actor: id,
        data: { src: id, topic, imp: 1 },
      }),
    );
      log('（你与' + n.name + '的交谈顺着后巷的风，飘进了某些耳朵。）', 'ai');
    }
  }
  /* 轮次计时不能从**被裁剪过的窗口**里数（审查 §对话计时）：turns 有 CAP_TURNS 封顶，
     满窗之后 pCount 恒定 —— 要么每句发言都推进 1 刻（设计值的 3 倍），要么永远不推进，
     两种情形都不是注释声称的「每 3 轮推进 1 刻」。改用 bondProg.chats：每轮真实交谈 +1、
     入档且单调，口径与原意一致。 */
  const rounds = dy.bondProg?.chats ?? 0;
  if (rounds > 0 && rounds % 3 === 0) advance(1);
  /* F-17：只有窗口仍开着、且开的还是这个人，才刷新（玩家关掉的窗口不得被异步回包弹回） */
  /* 刷新的判据是「会话流正开着」，不只是「聊天窗正开着」——
     深谈页现在也承接对话，漏掉它，玩家发完话要等下一次渲染才看得见气泡。 */
  if (sink) sink.deliver(line); // 自由通道：台词去见闻录（NPC 离场也照交——话已经出了口）
  else if (!away && chatSurfaceOpen(id)) render(id, false);
  sync();
  tryIntimacyUp(id); // 卡 11：好感满+轮次/赠礼达标 → 升档仪式
}

/* ---------------- P3 · 深水区的产出与代价 ----------------
   用户 2026-09-27 裁决：**深水区带代价**。三层代价全部走既有通道，不新增依赖边：
     ① 基线（所有深水区话题）：逼问一次，好感 -1。负值不受日封顶（applyChat 的封顶只管正向），
        所以它一定生效；而每个话题只付一次（由 talkDeep 幂等）。
     ② gain.rumor：他说漏的那半句会传出去 → rumor_spread（imp 2）。
     ③ gain.grudge：他记住你逼过这件事 → grudge_formed（sev 1，与「威胁」走同一个事件与订阅）。
   产出同样按数据给：gain.att（好感）/ gain.mem（记忆）/ gain.flag（玩家 flag，走写入原语）。 */
function settleDeep(id: string, card: NpcTopicCard) {
  const s = need();
  const n = WB.npcs[id];
  const g = card.gain || {};
  const day = sceneTime(s).day;
  if (g.att) adjAtt(id, g.att, '深谈');
  adjAtt(id, -1, '逼问');
  if (g.mem) addMem(id, String(g.mem).slice(0, 24), 3, 'rel');
  if (g.flag) mutate.playerFlag(String(g.flag));
  if (g.rumor) {
    worldBus.emit(
      makeEvent({
        type: 'rumor_spread',
        day,
        tick: s.t,
        level: levelOf('rumor_spread'),
        actor: id,
        data: { src: id, topic: String(g.rumor).slice(0, 20), imp: 2 },
      }),
    );
    log('（你说出口的那半句，顺着街面上的风传了出去。）', 'ai');
  }
  if (g.grudge) {
    worldBus.emit(
      makeEvent({
        type: 'grudge_formed',
        day,
        tick: s.t,
        level: levelOf('grudge_formed'),
        actor: 'player',
        target: id,
        data: { npc: id, why: '你逼问出了他不愿说的事', sev: 1 },
      }),
    );
    log('（' + n.name + '把话咽了回去——你看见他记住了这一刻。）', 'bad');
  }
}

/** 在场校验给行动坞/意图通道复用：当前地点可聊的在场 NPC 名单 */
export const chatableNPCs = (loc: string) => presentNPCs(loc).map((n) => ({ id: n.id, name: n.name }));

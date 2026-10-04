/* ============================================================
   意图解析（原型 §42：自然语言 → 结构化意图 → 规则行动）
   双通道：Intent AI（LLM，可选）→ 失败/未启用时降级正则引擎；
   两条通道最终汇入同一个 executeIntent —— 行动与后果全在 core。
   自由行动 2a（参数包）：两通道产出同构 IntentParse
   {intent, target?, dest?, focus?, topic?}（G2）；target/dest 在
   汇合点统一收敛解析（G3）；玩家指明细节 focus/topic 在叙事中
   被回响（G5）；新增 go 意图接入 actions.go——移动请求从此在
   自由行动里可执行（F1 修复）。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { bus, esc, rng, scheduler, toast, worldBus } from '@/events/EventBus';
import { levelOf, makeEvent } from '@/events/EventSchema';
import { log } from '@/systems/character/Gains';
import { adjAtt, npcAt, presentNPCs } from '@/systems/npc/Npcs';
import { firstPasserby, knownRoster, seenHere } from '@/systems/npc/Passersby';
import { hasAbility, shopsAt } from '@/data/regions';
import { ai } from '@/plugins/PluginInterface';
import type { IntentParse } from '@/plugins/PluginInterface';
import { core, need, sync } from '@/world/WorldState';
import type { WorldState } from '@/types/world';
import { queueNarration } from '@/world/Narration';
import { checksRolled } from '@/dice/CheckResolver';
import { advance, sceneTime } from '@/world/WorldClock';
import { arrest, commitCrime } from '@/systems/law/Law';
import { openDlg, runReqFree } from '@/systems/dialogue/Dialogue';
import { chatViaFree, freeChatsPending, quoteSay } from '@/systems/npc/Chat';
import { giveGift } from '@/systems/relationship/Bond';
import { openShop } from '@/systems/economy/Shop';
import {
  drink,
  exploreCave,
  exploreWild,
  gather,
  go,
  observe,
  pray,
  restAt,
  search,
  steal,
} from '@/actions/ActionExecutor';

const INTENTS: [RegExp, string][] = [
  [/走进|进入|前往|赶到|回到|去往|直奔|抵达/, 'go'], // 移动语义最优先（2a：dest 由词典抽取）
  [/偷|窃|扒|顺走/, 'steal'],
  [/观察|看看|环顾|打量|张望/, 'observe'],
  [/调查|搜查|搜索|翻找|检查/, 'search'],
  /* 「问」不再单字命中（2026-09 误指人修复）：裸「问」会把「不问知道」
     「这个问题的答案」全判成打听。保下来的问法：复合词（询问/请问/问问）、
     带后缀的（问路/问下/问个/问他）、句尾的（接着问/再问/还是想问）；
     「问+人名」（问米露……）由 parseRegex 里的词典补判——正则没有名单，代码有。 */
  [/打听|情报|消息|新闻|八卦|询问|请问|问问|问(?:路|下|个|一句|他|她|它)|问$/, 'askinfo'],
  [/买|卖|购物|交易/, 'shop'],
  [/休息|睡觉|睡一?觉|打盹|歇|过夜|住店/, 'rest'],
  [/采集|采药|摘|挖/, 'gather'],
  [/祈祷|祷告|上香|祭拜|拜神|拜佛|参拜/, 'pray'], // 单字「拜」太宽——「拜托」是请求，不是祷告
  [/喝酒|麦酒|来一杯|喝一杯|买酒/, 'drink'],
  [/帮助|帮忙/, 'help'],
  [/威胁|恐吓/, 'threat'],
  /* 社交三件套（弱化专用对话界）：排在 help/threat 之后——「帮我个忙」归 help，
     「求你帮忙」里 help 先命中也无妨（同一句都成立时归谁都是善意）。 */
  [/聊天|闲聊|攀谈|交谈|打招呼|问候|搭话|聊聊|谈谈|讲讲|说说/, 'talk'],
  [/送给|赠给|赠送|赠予|献上|献给|把[^，。；、！？\s]{1,8}给/, 'give'],
  [/恳求|拜托|请求|求你|求他|求她|借.{0,3}钱/, 'request'],
  [/探索|探险|转转|走走|冒险/, 'explore'],
  [/攻击|揍|杀|动手/, 'attack'],
  [/听.*歌|点歌|听曲/, 'song'],
  [/抓|追/, 'chase'],
];

const INTENT_CN: Record<string, string> = {
  go: '前往',
  steal: '行窃',
  observe: '观察',
  search: '调查',
  askinfo: '打听',
  shop: '交易',
  rest: '休息',
  gather: '采集',
  pray: '祈祷',
  drink: '喝酒',
  help: '帮助',
  threat: '威胁',
  talk: '攀谈',
  give: '赠礼',
  request: '请求',
  explore: '探索',
  attack: '攻击',
  song: '听歌',
  chase: '追赶',
  unknown: '未能识别',
};

/** 正则通道：文本 → 意图 id（原型逻辑） */
export function regexAct(text: string): string {
  for (const kv of INTENTS) if (kv[0].test(text)) return kv[1];
  return 'unknown';
}

/* ---------------- 参数抽取（与 LLM 通道同构，G2） ---------------- */

/** 地点词典命中：id 或名称（"酒馆→银鸥酒馆"式包含），长词优先、前缀逐步尝试 */
export function findLoc(word: string): string | null {
  const w = (word || '').trim();
  if (!w) return null;
  const ids = Object.keys(WB.locations).sort((a, b) => WB.locations[b].name.length - WB.locations[a].name.length);
  for (let len = Math.min(w.length, 8); len >= 2; len--) {
    const seg = w.slice(0, len);
    for (const id of ids) {
      const n = WB.locations[id].name;
      if (id === seg || n === seg || n.includes(seg) || seg.includes(n)) return id;
    }
  }
  return null;
}

/** 移动短语中的目的地：动词后 1~8 字连续前缀尝试词典 */
function extractDest(text: string): string | undefined {
  const m = text.match(/(?:走进|进入|前往|赶到|回到|去往|直奔|抵达|去|到)\s*([^\s，。；、！？]{1,8})/);
  if (!m) return undefined;
  return findLoc(m[1]) || undefined;
}

/**
 * 在场/世界 NPC 名字典扫描（最长名优先）。
 * extra 是额外的候选名（当日见过的路人）——正则通道原本只认 WB.npcs，
 * 于是玩家指名一个刚在街上见过的人时，target 会被丢掉、静默回落到首位在场者。
 */
function extractTarget(text: string, extra: string[] = []): string | undefined {
  const names = [...Object.values(WB.npcs).map((n) => n.name), ...extra].sort((a, b) => b.length - a.length);
  /* 引号名（如「灰烬」）允许裸称：玩家不会照抄名单上的引号 */
  return names.find((n) => text.includes(n) || (n.startsWith('「') && text.includes(n.slice(1, -1))));
}

/** 裸方位词不算焦点：「观察环境」就是普通的观察，犯不上「凝神分辨『环境』」 */
const GENERIC_FOCUS = new Set(['环境', '四周', '周围', '一圈', '附近', '这里', '此地', '动静']);

/** 观察/调查的具体焦点（G5：细节须在叙事中被回响） */
function extractFocus(text: string): string | undefined {
  const m = text.match(/(?:观察|看看|留意|打量|检查|调查|搜查|翻找)([^\s，。；、！？]{2,20})/);
  return m && !GENERIC_FOCUS.has(m[1]) ? m[1] : undefined;
}

/** 打听的具体话题（剥离对象名，如"问米露报纸多少钱"→"报纸多少钱"）。
 *  纯指代（「再问问他」经回溯捕到「问他」）不算话题——那是指代上文，不是内容。 */
const PRONOUN_TOPIC = /^(?:问)?(?:他|她|它|ta|TA)(?:们)?$/;

function extractTopic(text: string, target?: string): string | undefined {
  const m = text.match(/(?:打听|询问|问问|问)[「『"]?([^\s，。；、！？」』"]{2,20})/);
  if (!m) return undefined;
  let t = m[1];
  if (target && t.startsWith(target)) t = t.slice(target.length);
  if (PRONOUN_TOPIC.test(t)) return undefined;
  return t || undefined;
}

/** 攀谈/请求的内容：剥掉称呼与「聊/说/谈」类动词，剩下的当话头（正则通道的话题来源） */
function extractChatInput(text: string, target?: string): string {
  let t = (text || '').trim();
  if (target) t = t.split(target).join('');
  t = t
    .replace(/^(跟|和|与|同|找|向)/, '')
    .replace(/聊一聊|聊聊天|聊聊|说说|谈谈|谈一谈|讲讲|问一问|问候一下|打个招呼|打招呼|问候|搭个话|搭话|聊|谈|讲|问/g, ' ');
  t = t.replace(/^[，。；、！？\s]+/, '').replace(/[一下]+$/, '').trim();
  return t.slice(0, 40);
}

/** 赠礼的物品名：「把面包给米露」「送米露一个苹果」两种语序 */
function extractItemName(text: string, target?: string): string | undefined {
  const t = target ? text.split(target).join('') : text;
  const m = t.match(/(?:把|将)([^，。；、！？\s]{1,10}?)(?=给|送|赠|献)/) || t.match(/(?:送给?|赠给?|献给)([^，。；、！？\s]{1,10})/);
  let name = m?.[1];
  if (name) name = name.replace(/^(一|一个|些|点)/, '').replace(/(吧|呗)$/, '').trim();
  return name || undefined;
}

/** 行囊里找玩家说的那件东西：名称包含匹配；只列拿得出手的（有价、非违禁，与赠礼浮层同口径） */
function findCarriedItem(name: string): { id: string; qty: number } | null {
  const s = need();
  const q = (name || '').trim();
  if (!q) return null;
  const rows = s.player.bag.filter((b) => WB.items[b.id] && WB.items[b.id].price > 0 && !WB.items[b.id].illegal);
  const exact = rows.find((b) => WB.items[b.id].name === q);
  const part = rows.find((b) => WB.items[b.id].name.includes(q) || q.includes(WB.items[b.id].name));
  return exact || part || null;
}

/** 正则通道完整解析：意图 + 同构参数包（executeIntent 消费） */
export function parseRegex(text: string): IntentParse {
  let intent = regexAct(text);
  const dest = extractDest(text);
  // 移动语义优先于原地兜底（"走进酒馆"≠"在附近转一圈"，F1）
  if (dest && (intent === 'unknown' || intent === 'explore')) intent = 'go';
  /* 「问+人名」补判（INTENTS 收紧后的回补）：词典在手，正则没有。放在
     dest 覆盖之后——移动语义仍然最优先（「去酒馆问莉安件事」先算移动）。 */
  if (intent === 'unknown' && Object.values(WB.npcs).some((n) => text.includes('问' + n.name))) intent = 'askinfo';
  const p: IntentParse = { intent };
  if (intent === 'go' && dest) p.dest = dest;
  if (intent === 'observe' || intent === 'search') p.focus = extractFocus(text);
  if (intent === 'askinfo') {
    p.target = extractTarget(text);
    p.topic = extractTopic(text, p.target);
  }
  if (intent === 'talk' || intent === 'request') {
    p.target = extractTarget(text);
    p.topic = extractChatInput(text, p.target) || undefined;
  }
  if (intent === 'give') {
    p.target = extractTarget(text);
    p.focus = extractItemName(text, p.target);
  }
  if (intent === 'attack' || intent === 'help' || intent === 'threat' || intent === 'steal') p.target = extractTarget(text);
  return p;
}

/* ---------------- 顺序分解（2b：复合句 ≤3 原子意图，G1 自由文本槽） ---------------- */

/** 会触发 check() 演出的意图（后续步须等检定窗口收束，R1） */
const CHECK_INTENTS = new Set(['observe', 'search', 'steal', 'gather']);

/**
 * 连动句剥头（无标点分不出段的「去圣辉神殿祈祷」）：句首是移动短语、
 * 目的地在词典里、余文还能解析出另一个意图，才拆成 [go, 后续]。
 * 目的地取**最长可匹配前缀**且必须给余文留 2 字以上——「祈祷」是下一件事，
 * 不是地名的一部分。余文解析不出（「去酒馆」）或还是移动就不动，交给原路径。
 */
function peelGo(text: string): { dest: string; rest: string } | null {
  const m = text.match(/^(?:走进|进入|前往|赶到|回到|去往|直奔|抵达|去|到)/);
  if (!m) return null;
  const head = text.slice(m[0].length).trim();
  for (let len = Math.min(8, head.length - 2); len >= 2; len--) {
    const dest = findLoc(head.slice(0, len));
    if (!dest) continue;
    const rest = head.slice(len).trim();
    const follow = regexAct(rest);
    if (follow === 'unknown' || follow === 'go') continue;
    return { dest, rest };
  }
  return null;
}

/** 正则通道切段：并列连词/标点分段 → 同构 steps（全 unknown 时回落整句） */
export function parseRegexSteps(text: string): IntentParse[] {
  const parts = text
    .split(/[，,；;、]|(?:然后|接着|之后|随后|再)/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  if (parts.length <= 1) {
    const whole = parts[0] ?? text;
    const peeled = peelGo(whole);
    if (peeled) {
      const tail = parseRegex(peeled.rest);
      return [{ intent: 'go', dest: peeled.dest }, ...(tail.intent !== 'unknown' ? [tail] : [])].slice(0, 3);
    }
    return [parseRegex(whole)];
  }
  const steps = parts.map(parseRegex).filter((s) => s.intent !== 'unknown');
  return steps.length ? steps.slice(0, 3) : [parseRegex(text)];
}

/** 顺序执行 steps：每步一个 chip；检定步后留演出窗（生产 1600ms > check 1450ms 收束）；战斗爆发即截断剩余步（链尾照常收口）。
 *  逐步以 core 侧 INTENT_CN 白名单二次校验（不信任适配器 sanitize，防御纵深）。
 *  onDone：全部步落地后回调（2026-09-29）。此前连动句的第 2..n 步经 500ms 调度器
 *  延迟执行，而自由行动的编织窗口 0ms 就合上——第二步的反馈永远落在窗外，裸着
 *  当系统回执（实测「去圣辉神殿祈祷」：移动叙事织了，祈祷反馈孤零零一条）。
 *  织窗改由链尾开，多步产出才罩得住同一场行动。
 *  2026-09-29 二轮实测补两笔：① 同句社交步合并为一次交谈（见函数体内注释）；
 *  ② 战斗截断也回调 onDone——freeBusy 的解除挪到了链尾（freeActSmart），
 *  截断不解锁会把输入框永远锁在「解析中」。 */
export function executeSteps(steps: IntentParse[], text: string, viaLlm = false, onDone?: () => void) {
  const valid = steps.filter((s) => s && s.intent && s.intent !== 'unknown' && INTENT_CN[s.intent]).slice(0, 3);
  if (!valid.length) {
    executeIntent({ intent: 'unknown' }, text, viaLlm);
    onDone?.();
    return;
  }
  /* 连动攀谈合并（BUG-002 · 2026-09-29 实测）：「跟米露打个招呼，问问她有什么新鲜事」
     无论 LLM 还是正则都会拆成 [talk, askinfo] 两步，各跑一遍完整聊天管线——
     两条记忆（第二条写着「又来」）、两条流言、两份互相矛盾的台词与正文。
     同一句话里的社交步本来就是**一次交谈**：相邻聊天意图向同一个人开口时，
     把话题并进前一步、合成一次对话。目标都用显式名或都未指名才算同一人
     （「跟米露聊聊，问莉安借宿」不许并）；聊天类是 talk / askinfo / request。 */
  const CHAT_INTENTS = new Set(['talk', 'askinfo', 'request']);
  const merged: IntentParse[] = [];
  for (const st of valid) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      CHAT_INTENTS.has(st.intent) &&
      CHAT_INTENTS.has(prev.intent) &&
      (!st.target || !prev.target || st.target === prev.target)
    ) {
      if (st.topic) prev.topic = prev.topic ? prev.topic + '，' + st.topic : st.topic;
      if (!prev.target && st.target) prev.target = st.target;
      continue;
    }
    merged.push(st);
  }
  const plan = merged.length ? merged : valid;
  let i = 0;
  const run = () => {
    const p = plan[i];
    executeIntent(p, text, viaLlm);
    i++;
    if (i < plan.length) {
      if (core.CB) {
        onDone?.(); // 途中遇袭进入战斗：剩余步作废，但链尾的收口（织窗/解锁）照常要跑
        return;
      }
      scheduler.after(CHECK_INTENTS.has(p.intent) ? 1600 : 500, run);
    } else {
      onDone?.();
    }
  };
  run();
}

/* ---------------- 会话焦点与自由通道编织水位 ----------------
   自由输入的每句独立解析，「再问问他」「继续」这类指代原本没有着落点。
   这里记最近一次交谈的对象与话题：LLM 通道经 ctx.lastTalk 自己解析代词，
   正则通道由 FOLLOWUP_RE 兜底指回同一个人。模块级而非存档态——丢了最多
   退化成「不知他在问谁」，不损档。
   焦点是**有时效的**（2026-09 误指人修复）：旧实现只记对象、永不过期，
   每次意图解析都把「上文正与XX交谈」带进提示词，模型便把后续输入往
   「继续跟她聊」上判——一次攀谈棘轮成「每次自由行动都由她接话」。
   现在记录赋值时刻，talkFocusValid 过期即失效（对象离场同样失效）。
   freeSeq0 是本轮 freeText 的编织水位（freeActSmart 入口快照）：
   攀谈的 NPC 回包是异步回流，落地时用它补开编织窗，台词单独织成续段。 */
let lastTalk: { id: string; name: string; topic?: string; t: number } | null = null;
/* 焦点时效（刻）：约 2~4 次自由行动的窗口。放太短，「看看告示→再问问他」
   这类间隔流程会断；放太长，棘轮只是被放缓而不是被打断。 */
const TALK_FOCUS_TICKS = 8;

/** 焦点有效性：对象仍在玩家当前地点，且距记录时刻未过期。 */
function talkFocusValid(s: WorldState): boolean {
  if (!lastTalk || s.t - lastTalk.t > TALK_FOCUS_TICKS) return false;
  return presentNPCs(s.player.loc, s).some((n) => n.id === lastTalk!.id);
}

const FOLLOWUP_RE = /^(他|她|它|ta|TA|继续|接着|再问|再聊聊|接着问|还是想问)/;
let freeSeq0 = 0;

/** 测试装配钩子：清会话焦点、在飞锁与编织水位。这些是模块级不入档的运行态，
 *  跨用例会串味（前一个用例的攀谈焦点影响下一个的指人路径）——与
 *  Narration 的 resetNarrationState 同一先例；生产流程不需要它。 */
export function resetFreeInputState(): void {
  lastTalk = null;
  freeInFlight.clear();
  freeSeq0 = 0;
  weaveWaitingReply = false;
}
/* 编织单批化（BUG-002 · 2026-09-29 实测）：攀谈台词异步回流，链尾的织窗 0ms 就
   合上——旧实现里回包落地后 freeWeave 再开第二批，两批各写各的（事实互相矛盾），
   后批的替换区间不含先批成品，正文还被插到先批上面（顺序错乱）。
   现在：回包未落地（freeChatsPending() > 0）时不开窗，改挂 weaveWaitingReply，
   由**最后一条回包**的 freeWeave 统一开窗——一轮输入只织一批。 */
let weaveWaitingReply = false;
const freeWeave = (): void => {
  if (weaveWaitingReply) {
    if (freeChatsPending() === 0) {
      weaveWaitingReply = false;
      queueNarration(freeSeq0, false);
    }
    return; // 还有回包在路上：等最后一条落地再一起织
  }
  queueNarration(freeSeq0, false);
};

/** 执行一个已解析的意图（所有通道汇聚点；参数在汇合点收敛，G3） */
export function executeIntent(p: IntentParse, text: string, viaLlm = false) {
  const s = need();
  const loc = s.player.loc;
  /* cls 用 'meta' 而不是 'ai'：这是给排障看的内部标记，既不该显示成叙事，
     更不能被编织层当作"已写好的正文"读进前情——模型看到一串
     "〔意图解析·LLM〕打听·米露"，就会顺着它编对话。 */
  const chip = (extra = '') => log('〔意图解析' + (viaLlm ? '·LLM' : '') + '〕' + (INTENT_CN[p.intent] || p.intent) + extra, 'meta');
  /**
   * 涉人意图的 target 收敛（静默解析，chip 时序由 case 掌控）：
   * 显式 target → 在场白名单校验（缺席给 missing，F3）；无 target → 唯一在场
   * 自动指他，多人在场时续会话焦点、焦点也没有就返回 ambiguous 问一句（不猜人）。
   * allowAnchor=false（威胁）：敌意行为**不吃**会话焦点——「跟米露聊聊→威胁」
   * 不许顺延到刚聊过的人，多人在场一律先问（实机二次现场抓到的误伤路径）。
   *
   * 「在场 NPC」之外还有一类人：今天在这个地点见过的路人（Passersby 的当日名单）。
   * 他们不能被深聊、不进关系表，但**搭得上话**——不接这一步的话，
   * 观察时看见名字、搭话时却「周围没有可以搭话的人」，叙事与机制就自相矛盾。
   */
  const day = sceneTime(s).day;
  const resolveTarget = (allowAnchor = true): {
    npc?: { id: string; name: string };
    passer?: string;
    missing?: string;
    nobody?: boolean;
    ambiguous?: boolean;
    candidates?: string[];
  } => {
    const ps = presentNPCs(loc);
    /* 正则通道只扫 WB.npcs，认不出当日路人；这里对「今天见过的人」再扫一次。
       knownRoster 不触发生成——没观察过的人不该能被指名。 */
    let tgtName = p.target ?? extractTarget(text, knownRoster(loc, day).map((x) => x.name));
    /* 会话焦点兜底（正则通道）：「再问问他」——没点名、句首是指代/继续，
       上一位交谈对象还在场、焦点未过期，就还找他。 */
    if (!tgtName && FOLLOWUP_RE.test(text.trim()) && talkFocusValid(s)) tgtName = lastTalk!.name;
    if (tgtName) {
      const hit = ps.find((n) => n.name === tgtName || n.name.includes(tgtName) || tgtName.includes(n.name));
      if (hit) return { npc: hit };
      if (seenHere(tgtName, loc, day)) return { passer: tgtName };
      return { missing: tgtName };
    }
    if (!ps.length) {
      /* 兜底只在城内：野外本来就不该有「街上的人」，没必要为它造一份名单 */
      if (hasAbility(loc, 'urban')) {
        const fp = firstPasserby(loc, day);
        if (fp) return { passer: fp.name };
      }
      return { nobody: true };
    }
    /* 唯一在场 → 直接指他。多人时不再「回落首位在场」——名册顺序的第一个
       不是玩家心里的人（2026-09 误指人修复）：有有效会话焦点就续着他说，
       否则返回 ambiguous，由各 case 问一句「你要找谁」，不猜人、不产出台词。 */
    if (ps.length === 1) return { npc: ps[0] };
    if (allowAnchor && talkFocusValid(s)) {
      const anchored = ps.find((n) => n.id === lastTalk!.id);
      if (anchored) return { npc: anchored };
    }
    return { ambiguous: true, candidates: ps.map((n) => n.name) };
  };
  const noOneMsg = (r: { missing?: string; nobody?: boolean }) =>
    r.missing ? '「' + esc(r.missing) + '」不在这里。' + (presentNPCs(loc).length ? '在场的是 ' + presentNPCs(loc).map((n) => n.name).join('、') + '。' : '周围没有其他人。') : '周围没有可以搭话的人。';
  /** 多人在场又没点名：不猜人，问一句。不推进时间、不产出台词、不改任何状态。 */
  const whomLine = (verb: string, names: string[]): string =>
    '你要找谁' + verb + '？眼前有：' + names.join('、') + '。——指个名，或把话说得再具体些。';
  switch (p.intent) {
    case 'go': {
      const dest = p.dest ? (WB.locations[p.dest] ? p.dest : findLoc(p.dest)) : null;
      if (!dest) {
        chip();
        log('你想去的方向不在街巷图里——想想酒馆、集市、神殿这些地方的名字。', 'nar');
        sync();
        break;
      }
      chip('→' + WB.locations[dest].name);
      if (dest === loc) {
        log('你已经在这里了。', 'nar');
        sync();
        break;
      }
      go(dest);
      break;
    }
    case 'observe':
      chip();
      if (p.focus) log('你凝神分辨：「' + esc(p.focus) + '」。', 'nar');
      observe();
      break;
    case 'search':
      chip();
      if (p.focus) log('你循着「' + esc(p.focus) + '」的痕迹翻查。', 'nar');
      search();
      break;
    case 'steal':
      chip();
      if (WB.locations[loc].danger >= 3) {
        log('在这种鬼地方行窃？你环顾四周——只有岩壁和黑暗。', 'nar');
        sync();
      } else steal(text);
      break;
    case 'rest':
      chip();
      /* 地区规整：能力的名字就是语义——新增地区只要标注 rest_lodging / rest_camping，
         这里一行都不用改。 */
      if (hasAbility(loc, 'rest_lodging')) restAt('lodging');
      else if (hasAbility(loc, 'rest_camping')) restAt('camping');
      else {
        log('这里不是能安心睡下的地方。酒馆的阁楼要舒服得多。', 'nar');
        sync();
      }
      break;
    case 'gather':
      chip();
      gather();
      break;
    case 'pray':
      chip();
      if (hasAbility(loc, 'pray')) pray();
      else {
        log('你默诵祷词。没有祭坛的祈祷，更像自言自语。', 'nar');
        sync();
      }
      break;
    case 'drink':
      chip();
      if (hasAbility(loc, 'drink')) drink();
      else {
        log('这里没有酒。你咽了咽口水。', 'nar');
        sync();
      }
      break;
    case 'shop': {
      chip();
      /* 商店从地点数据推导，而不是写死 market → grocer：
         新地区开商铺只需在 people.json 声明自己的 loc，这里自动认得。 */
      const shop = shopsAt(loc)[0];
      if (shop) openShop(shop.id);
      else {
        log('这里没有商铺。', 'nar');
        sync();
      }
      break;
    }
    case 'explore':
      chip();
      if (hasAbility(loc, 'explore_wild')) exploreWild();
      else if (hasAbility(loc, 'explore_cave')) exploreCave();
      else {
        log('你在附近转了一圈：' + ai().narrativeAmbient(), 'nar');
        advance(1);
        sync();
      }
      break;
    case 'askinfo': {
      const r = resolveTarget();
      /* 当日见过的路人：能搭一句话，仅此一句。不 advance 之外不做任何状态改写——
         他不是 NPC，没有关系、没有记忆、不会记住你问过什么。 */
      if (r.passer) {
        chip('·' + r.passer);
        log('你在' + (WB.locations[loc]?.name ?? '这里') + '转了一圈，找到「' + r.passer + '」。', 'nar');
        log(
          rng.pick([
            '「赶路呢，没空。」对方摆摆手，脚步没停。',
            '「我？这条街上叫这名字的多了。」他笑了一声，走开了。',
            '他上下打量你一眼，摇头：「认错人了吧。」',
          ]),
          'say',
        );
        advance(1);
        sync();
        break;
      }
      if (!r.npc) {
        if (r.ambiguous) {
          chip();
          log(whomLine('打听', r.candidates!), 'nar');
          sync();
          break;
        }
        chip(r.missing ? '·' + esc(r.missing) : '');
        log(noOneMsg(r), 'nar');
        sync();
        break;
      }
      const tgt = r.npc;
      chip('·' + tgt.name);
      log('你向' + tgt.name + '打听' + (p.topic ? '「' + esc(p.topic) + '」' : '消息') + '。', 'nar');
      advance(1);
      /* 打听升级为真对话：话题走攀谈管线（在场/敌意门禁→话题卡→chatAsync），
         台词由 deliver 落见闻录再织入正文。无模型时 ruleSim 的态度台词就是罐头降级。 */
      if (tgt.id === 'selina' && s.player.gold >= 200) log('“消息嘛……”赛琳娜朝你伸出手，“两百铜一条。”（可用对话购买）', 'say');
      else {
        const ask = p.topic || '最近有什么消息？';
        chatViaFree(tgt.id, ask, (line) => {
          log(quoteSay(tgt.name, line), 'say');
          freeWeave(); // 回包是异步回流：落地后单独成批织进正文
        }, text); // 会话记录写玩家原文（UX-005）
        lastTalk = { id: tgt.id, name: tgt.name, topic: p.topic, t: s.t };
      }
      sync();
      break;
    }
    /* —— 社交三件套（弱化专用对话界）：台词全部落见闻录，不再弹浮层 —— */
    case 'talk': {
      const r = resolveTarget();
      if (r.passer) {
        chip('·' + r.passer);
        log('你朝「' + r.passer + '」打了个招呼。', 'nar');
        log(
          rng.pick([
            '「嗯。」对方点了点头，脚步没停。',
            '「有事？」他狐疑地看了你一眼，绕开了。',
            '她朝你笑了笑，算是回应。',
          ]),
          'say',
        );
        advance(1);
        sync();
        break;
      }
      if (!r.npc) {
        if (r.ambiguous) {
          chip();
          log(whomLine('说话', r.candidates!), 'nar');
          sync();
          break;
        }
        chip(r.missing ? '·' + esc(r.missing) : '');
        log(noOneMsg(r), 'nar');
        sync();
        break;
      }
      const tgt = r.npc;
      chip('·' + tgt.name);
      const said = p.topic || extractChatInput(text, tgt.name);
      log(said ? '你与' + tgt.name + '攀谈起来。' : '你朝' + tgt.name + '走了过去。', 'nar');
      chatViaFree(tgt.id, said || '你好。', (line) => {
        log(quoteSay(tgt.name, line), 'say');
        freeWeave();
      }, text); // 会话记录写玩家原文（UX-005）
      lastTalk = { id: tgt.id, name: tgt.name, topic: said || undefined, t: s.t };
      sync();
      break;
    }
    case 'give': {
      const r = resolveTarget();
      if (r.ambiguous) {
        chip();
        log(whomLine('送东西', r.candidates!), 'nar');
        sync();
        break;
      }
      if (r.passer || !r.npc) {
        chip(r.passer ? '·' + r.passer : r.missing ? '·' + esc(r.missing) : '');
        log(r.passer ? '「' + esc(r.passer) + '」摆摆手走开了——东西塞不到陌生人手里。' : noOneMsg(r), 'nar');
        sync();
        break;
      }
      const tgt = r.npc;
      chip('·' + tgt.name);
      const want = p.focus || extractItemName(text, tgt.name);
      const row = findCarriedItem(want || '');
      if (!row) {
        const carry = need().player.bag
          .filter((b) => WB.items[b.id] && WB.items[b.id].price > 0 && !WB.items[b.id].illegal)
          .slice(0, 4)
          .map((b) => WB.items[b.id].name);
        log(
          '你翻遍行囊' + (want ? '，找不到「' + esc(want) + '」' : '') + '。' +
            (carry.length ? '拿得出手的大概是：' + carry.join('、') + '。' : '没有拿得出手的东西。'),
          'nar',
        );
        sync();
        break;
      }
      /* 赠礼管线与浮层完全同一套（门禁/日限/喜恶/连带好感都在 Bond.giveGift），
         台词由它自己写进见闻录。 */
      giveGift(tgt.id, row.id);
      lastTalk = { id: tgt.id, name: tgt.name, t: s.t };
      break;
    }
    case 'request': {
      const r = resolveTarget();
      if (r.ambiguous) {
        chip();
        log(whomLine('求助', r.candidates!), 'nar');
        sync();
        break;
      }
      if (r.passer || !r.npc) {
        chip(r.passer ? '·' + r.passer : r.missing ? '·' + esc(r.missing) : '');
        log(r.passer ? '「' + esc(r.passer) + '」头也不回——陌生人不接你这茬。' : noOneMsg(r), 'nar');
        sync();
        break;
      }
      const tgt = r.npc;
      chip('·' + tgt.name);
      /* 请求管线复用 runReq（门禁/npcDecide 权衡/威胁后果全同源），
         free 呈现：台词与权衡结论落见闻录，不弹浮层。 */
      runReqFree(tgt.id, p.topic || extractChatInput(text, tgt.name) || '帮我个忙');
      lastTalk = { id: tgt.id, name: tgt.name, t: s.t };
      break;
    }
    case 'song':
      chip();
      if (loc === 'tavern' && npcAt('selina') === 'tavern') openDlg('selina');
      else {
        log('没有琴声。只有风声。', 'nar');
        sync();
      }
      break;
    case 'attack': {
      // 攻击只认显式指名（文本含名或 LLM target），缺省不锁定首位——防误伤
      const ps = presentNPCs(loc);
      const tgt = ps.find((n) => text.includes(n.name) || (p.target && (n.name === p.target || n.name.includes(p.target) || p.target.includes(n.name))));
      if (!tgt) {
        chip();
        log('你对着空气比划了两下。路人纷纷绕开你走。', 'nar');
        sync();
        break;
      }
      chip('·' + tgt.name);
      log('你摆出了攻击的架势——' + tgt.name + '的脸色骤变。周围的尖叫引来了城卫！', 'bad');
      commitCrime('assault', need().player.loc);
      adjAtt(tgt.id, -50, '行凶');
      /* 卡 11：重事件结仇（sev3 长记忆）。二期 H-09：改发事件，关系系统自己订阅 */
      worldBus.emit(makeEvent({ type: 'grudge_formed', day: sceneTime(s).day, tick: s.t, level: levelOf('grudge_formed'), actor: 'player', target: tgt.id, data: { npc: tgt.id, why: '你当街行凶', sev: 3 } }));
      arrest();
      sync();
      break;
    }
    case 'help': {
      const r = resolveTarget();
      if (r.ambiguous) {
        chip();
        log(whomLine('帮忙', r.candidates!), 'nar');
        sync();
        break;
      }
      if (!r.npc) {
        chip(r.missing ? '·' + esc(r.missing) : '');
        log(noOneMsg(r), 'nar');
        sync();
        break;
      }
      const tgt = r.npc;
      chip('·' + tgt.name);
      log('你上前搭手帮' + tgt.name + '做了点杂事。对方道了谢。', 'nar');
      adjAtt(tgt.id, 3, '主动帮忙');
      advance(2);
      sync();
      break;
    }
    case 'threat': {
      const r = resolveTarget(false); // 威胁不吃焦点锚点：刚聊过的人不该挨威胁
      if (r.ambiguous) {
        chip();
        log(whomLine('发出警告', r.candidates!), 'nar');
        sync();
        break;
      }
      if (!r.npc) {
        chip(r.missing ? '·' + esc(r.missing) : '');
        log(noOneMsg(r), 'nar');
        sync();
        break;
      }
      const tgt = r.npc;
      chip('·' + tgt.name);
      log('你压低声音，向' + tgt.name + '发出了威胁。', 'nar');
      adjAtt(tgt.id, -30, '威胁');
      worldBus.emit(makeEvent({ type: 'grudge_formed', day: sceneTime(s).day, tick: s.t, level: levelOf('grudge_formed'), actor: 'player', target: tgt.id, data: { npc: tgt.id, why: '你出言威胁', sev: 2 } }));
      commitCrime('threat', need().player.loc);
      arrest();
      sync();
      break;
    }
    case 'chase':
      chip();
      log('你追了几步，什么也没追上。倒是有只猫被你吓跑了。', 'nar');
      advance(1);
      sync();
      break;
    default:
      chip();
      /* 2026-09-29：unknown 不再是"轻描淡写的一行"——它后面跟着的编织曾经把
         这行提示连同玩家输入一起替换成假叙事（说祈祷、被写成已进神殿）。
         现在：unknownOnly 置位让本轮不织（freeActSmart 的 finally 检查），
         这行原样留在见闻录里；文案也从"世界没反应"改成"没听懂 + 怎么办"。 */
      unknownOnly = true;
      log(
        rng.pick([
          '（你这句话没能落成具体的行动——试试「观察环境」「调查搜索」「打听消息」，或「去某地」「跟某人聊聊」「把某物送给某人」。）',
          '（这几下没有对上任何世界认识的做法——换个说法，比如「喝一杯」「祈祷」「买点补给」。）',
        ]),
        'bad',
      );
      sync();
  }
}

/** 同步入口（正则通道：切段产同构 steps，2b） */
export function freeAct(text: string) {
  executeSteps(parseRegexSteps(text), text);
}

/** 自由行动 in-flight 锁（F-14）：core 侧权威去重，不依赖 UI 的禁用态 */
const freeInFlight = new Set<string>();

/**
 * 本轮是否只落了「未识别」反馈（freeActSmart 入口清零，executeIntent 的
 * default 分支置位）。为真的轮次**不开编织窗**：玩家输入被 AI 判为无法理解时，
 * 「＞ 玩家原文」与那一行反馈就是全部真相——交给润色，模型会把玩家的意图
 * 当成已发生的事实写成一段假叙事（2026-09-29 实机：说「祈祷」被织成
 * 「走进神殿祈祷」，实际哪儿都没去、时间没走，玩家毫无察觉）。
 */
let unknownOnly = false;

/** 智能入口：意图解析的**唯一权威是 AI**（LLM 说什么就是什么，包括 unknown——
 *  它判不出的输入，正则再抢答一遍只会交出两套互相矛盾的结果；2026-09-29 实机：
 *  LLM 判 unknown 的「祈祷」被正则词表 100% 命中，两通道答案打架）。
 *  正则通道只保留一个身份：**断网 / 未配模型时的规则模拟**（README 承诺的降级），
 *  以及 LLM 通道返回空（传输失败、JSON 解析失败）时的兜底。
 *  F-14：整段 try/catch（异常不再变成 unhandled rejection），同刻重复提交直接拒绝。
 *  seq0：dispatch 入口的编织水位快照（freeText 传入，覆盖「＞ 玩家原文」回显行）。
 *  编织窗由这里统一开——此前 dispatch 出口也开一次，但意图解析没回来时那一次
 *  只罩得住回显行，玩家输入被单独织成脑补正文、行动产出反而成了第二批（实机踩过）。
 *  2026-09-29 二轮实测：freeBusy 的解除从 finally 挪到**链尾**——多步链的步间
 *  调度空隙此前已经在自动流逝，意图解析的暂停承诺只兑现了一半；链尾收口
 *  （chainDone）统一负责开织窗、解在飞锁、发 freeBusy:false。 */
export async function freeActSmart(text: string, seq0In?: number) {
  const key = (text || '').trim();
  if (!key) return;
  if (freeInFlight.has(key)) {
    toast('上一句还在解析——稍候再试。');
    return;
  }
  freeInFlight.add(key);
  unknownOnly = false;
  weaveWaitingReply = false;
  bus.emit({ type: 'freeBusy', busy: true });
  const seq0 = seq0In ?? core.S?.logSeq ?? 0;
  freeSeq0 = seq0; // 攀谈的异步回包落地时（freeWeave）用同一水位补窗
  const rolls0 = checksRolled();
  /* 多步连动时织窗由 executeSteps 链尾开（见 executeSteps onDone 的注释）；
     单步/正则路径仍走收口处。两处只会生效一处。 */
  let weaveDeferred = false;
  /* 回包未落地时链尾不开窗：改挂等待旗，由最后一条回包的 freeWeave 接手（单批化） */
  const deferWeaveIfPending = (rolled: boolean): void => {
    if (freeChatsPending() > 0) {
      weaveWaitingReply = true;
      return;
    }
    queueNarration(seq0, rolled);
  };
  const weaveAtTail = () => {
    /* 链上全是 unknown 步（valid 过滤后为空）→ 走默认分支，不织 */
    if (unknownOnly) return;
    weaveDeferred = true;
    deferWeaveIfPending(checksRolled() > rolls0);
  };
  /* 多步链的收口：freeBusy 与在飞锁的寿命跟随整条链，不再首步后就解除；
     战斗截断路径 executeSteps 也会回调 onDone（见其函数体），不会悬置。 */
  let chainLive = false;
  /* LLM 的解析结果（或正则兜底链）是否已开始执行：catch 里据此决定「换通道兜底」
     还是「不再重放」——已执行过再重放，同一句就被两套通道各跑一遍（BUG-002 的
     另一条双重执行路径：副作用落了一半，正则又全量来一次）。 */
  let executed = false;
  const finish = () => {
    freeInFlight.delete(key);
    bus.emit({ type: 'freeBusy', busy: false });
    sync();
  };
  const chainDone = () => {
    weaveAtTail();
    finish();
  };
  const runRegexChain = () => {
    executed = true;
    chainLive = true;
    executeSteps(parseRegexSteps(key), key, false, chainDone);
  };
  try {
    const p = ai();
    if (p.intentAsync) {
      const s = need();
      const loc = s.player.loc;
      const ps = presentNPCs(loc);
      /* 目的地底册给**全部已探明地点**而不只相邻：玩家说「去圣辉神殿」时，
         神殿多半不在脚下这一站的直达表里——只给相邻，模型只能在 go 与 unknown
         之间犹豫（实测它选了 unknown，整句话被吞）。给全名册，它放心填 dest，
         走不走得到由引擎回答（「无法直接前往——沿街巷走」），职责各归各位。 */
      const dests = Object.keys(WB.locations)
        .filter((id) => !WB.locations[id].locked)
        .map((id) => ({ id, name: WB.locations[id].name }));
      const r = await p.intentAsync(key, {
        loc,
        locName: WB.locations[loc].name,
        npcs: ps.map((n) => n.name),
        npcIds: ps.map((n) => n.id),
        dests,
        /* 焦点有效期才进提示词：过期/离场后不再对模型说「上文正与XX交谈」，
           否则它会把后续输入全部往「继续跟TA聊」上判（棘轮的另一半）。 */
        lastTalk: talkFocusValid(s) ? { name: lastTalk!.name, topic: lastTalk!.topic } : undefined,
      });
      if (r && r.intent) {
        /* 多步：织窗与解锁都交给链尾（chainDone）；单步：收口处统一处理。殊途同归。 */
        executed = true;
        if (r.steps && r.steps.length > 1) {
          chainLive = true;
          executeSteps(r.steps, key, true, chainDone);
        } else executeIntent(r, key, true);
        return;
      }
    }
    runRegexChain();
  } catch {
    /* 降级：LLM 通道异常时回到正则通道（玩家输入必须有反馈）。
       但**本轮已开始执行**就不再重放——部分副作用已落地，正则再全量来一次，
       玩家会得到两份矛盾的执行结果；此时只兜底解锁，反馈以已落地的为准。 */
    if (executed) {
      finish();
      return;
    }
    try {
      runRegexChain();
    } catch {
      toast('这句暂时处理不了——换个说法试试。', 'bad');
      finish();
    }
  } finally {
    /* 掷骰与否用"执行前后计数有没有变"判断，与 dispatch 出口同一套。
       多步链尾已收口（chainLive）或整轮 unknown（unknownOnly）都不再织：
       前者避免第二批重复罩住同一区间，后者保住"没发生任何事"的真相（见其注释）。
       单步攀谈（回包未落地）同样推迟：等最后一条回包统一开窗。 */
    if (!chainLive) {
      if (!weaveDeferred && !unknownOnly) deferWeaveIfPending(checksRolled() > rolls0);
      finish();
    }
  }
}

/* ============================================================
   叙事编织（Narration）
   ------------------------------------------------------------
   玩家每做一件事，规则引擎先给出事实（「你搜了一圈，一无所获。」）；
   这里把这一轮的事实交给 AI，请它织成一段小说正文，回来替换掉那几条原文。
   于是见闻录读起来不是一条条系统回执，而是连续的小说。

   铁律不变：AI 只产文本。这里动的是**文本层**，不碰任何状态字段。

   渐进增强：端口没实现 / 没配模型 / 调用失败 / 超时 —— 规则原文原样留着，
   游戏照常可读，只是少了润色。这条降级路径与其它通道同规。

   为什么住在 world/：它是命令出口的钩子，只依赖端口（AiPort）与写入原语，
   不 import ai/ —— 依赖方向保持不变。
   ============================================================ */
import { ai, type AiPort } from '@/plugins/PluginInterface';
import { bus } from '@/events/EventBus';
import { WB } from '@/data/worldBook';
import { core } from './WorldState';
import { mutate } from './WorldMutate';
import { sceneTime } from './WorldClock';
import { buildNarrativeContext, fitBudget, narrativeBudget } from './NarrativeContext';
import { runLog } from '@/devlog/RunLog';
import type { LogEntry } from '@/types/world';

/** 串行链：一次命令一次编织。并发发出去会有两个结果抢同一段区间——先到先写，后到的覆盖 */
let chain: Promise<void> = Promise.resolve();

/** 合并窗口的起点（这一批最早的水位） */
let pendingFrom: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** 上一段正文写在哪个地点：用来判断这一段要不要提示"换地方了"。
    模块级而非存档态——它只服务下一句衔接话术，丢了最多少一句提示。 */
let lastLoc: string | null = null;
/**
 * 世界世代：resetWorld / newGame 递增一次。
 * 在途的编织响应只对**同世代**有效——旧局的迟到响应若照常执行，
 * 会 emit 一次解锁把新局刚挂起的批次提前放出来，玩家看到的就是
 * "点了没反应，只有规则原文"（而替换要等新局自己的请求回来，更晚）。
 */
let epoch = 0;

/** 上一次**检查归档**时是哪一天（不是"上次真归档时"）。
    差别很关键：若只在归档成功时更新，从没归档过的档永远检测不到跨天，
    第一天的零散段落会一直拖到凑满一批，跨天归档形同虚设。 */
let lastArchiveDate = '';
/** 归档与编织共用一条串行链，但**不阻塞下一轮编织**——摘要是慢活，不能让玩家等它 */
let archiveChain: Promise<void> = Promise.resolve();

/* ---------------- 编织诊断 ----------------
   失败原本是**完全静默**的：界面上原文留着、控制台什么都没有，排查时只能猜是
   "没配模型"还是"上游限流"。这份记录在系统面板里直接可读。 */
export interface WeaveDiag {
  from: number;
  end: number;
  ok: boolean;
  why: string;
}
const DIAG_MAX = 6;
const diagLog: WeaveDiag[] = [];

/** 记一条；与上一条同因则只更新水位，免得连点几次刷满屏 */
function note(d: WeaveDiag): void {
  const last = diagLog[diagLog.length - 1];
  if (last && last.ok === d.ok && last.why === d.why) {
    last.from = d.from;
    last.end = d.end;
    return;
  }
  diagLog.push(d);
  if (diagLog.length > DIAG_MAX) diagLog.shift();
  runLog.info('ai', '编织' + (d.ok ? '落地' : '未落地') + '：' + d.why, { from: d.from, end: d.end });
}

/** 系统面板读取：最近几次编织的结果（新 → 旧） */
export function weaveDiag(): WeaveDiag[] {
  return diagLog.slice().reverse();
}


/** 测试与重置世界时清掉衔接状态（跨局不该记着上一局的地址） */
export function resetNarrationState(): void {
  epoch++; // 旧世代的一切在途响应从此作废
  lastLoc = null;
  lastArchiveDate = '';
  pendingFrom = null;
  if (timer) clearTimeout(timer);
  timer = null;
}
/**
 * 为什么不是「命令出口立刻织」：**部分产出是异步回流的**。
 * 观察/搜索先掷骰，CheckResolver 演出 1450ms 后才在收束回调里写「情报 +1」——
 * 那时代码早就从 dispatch 出去了。曾经的实现直接在出口发请求，于是同一次观察被
 * 拆成两半：同步阶段的原文被织进小说，收束时才到的那条孤零零留在外面当系统回执
 * （实机截图抓到过）。等一个窗口把回流罩进来，才是完整的一轮。
 */
const WINDOW_MS = 1600;

/** 把一条见闻翻成给 AI 看的事实：标出它是收获、不利还是提示，它才知道该用什么语气。
 *  玩家原文（「＞ …」say 行）单独成标（2026-09-29）：此前它也标【有人说】，模型把
 *  玩家想做的事当成了世界里说出的话——「祈祷」被写成走进了神殿（引擎实际什么都没
 *  执行），攀谈时模型替 NPC 发明清单外的回答。它是**动因**，不是事实。 */
function factOf(e: LogEntry): string {
  const cls = e.cls || 'nar';
  if (cls === 'say' && e.text.startsWith('＞')) return '【玩家提出】' + e.text.slice(1).trim();
  const tag =
    cls === 'gain' ? '【获得】' : cls === 'bad' ? '【不利】' : cls === 'sys' ? '【提示】' : cls === 'say' ? '【有人说】' : '';
  return tag + e.text;
}

/**
 * 命令出口调用：把 seq0 之后新写的见闻织成一段小说。
 * 纯面板操作（不写见闻）在这一行就返回，零开销；没配模型同样一次都不发。
 */
export function queueNarration(seq0: number, rolled = false): void {
  const s = core.S;
  if (!s) return;
  const fresh = (s.log || []).filter((e) => (e.id ?? 0) > seq0);
  /* **掷过骰的操作必须无条件开窗口。**
     检定是异步演出：check() 掷完骰要等 1450ms 收束回调才把收益写回见闻，
     所以此刻 logSeq 往往与入口一样、fresh 是空的。按"有没有新见闻"来判，
     会把这一整轮直接漏掉——表现就是"点了观察环境，只有规则原文，永远不织"。
     没掷骰的操作才用它判断：面板操作不写见闻，确实该直接返回。 */
  if (!rolled && (!s.logSeq || s.logSeq <= seq0 || !fresh.length)) return;

  let port: ReturnType<typeof ai> | null;
  try {
    port = ai();
  } catch {
    return; // 端口未注册（测试环境等）：保持规则文本
  }
  if (!port?.narrateAsync) {
    /* 没配模型时会走这里——这正是"点了没反应"最常见的原因，必须记下来 */
    note({ from: seq0, end: 0, ok: false, why: '端口没有编织能力（未配模型 / 已关闭）' });
    return;
  }

  /* 只记起点，不在出口发请求：等窗口合上再一次性织，异步回流才进得来。
     窗口已经开着时不再重置——连点两次操作不该把第一次的润色无限往后推。 */
  if (pendingFrom === null) pendingFrom = seq0;
  if (timer) return;
  /* 告诉界面「这一批正在被书写」：润色期间它们先不显示，
     由写作占位顶上——否则玩家点了操作会以为没生效。 */
  bus.emit({ type: 'weave', from: seq0 });
  /* 只有**掷过骰**的这一轮才需要等窗口：检定演出 1450ms 后才把收益写回来。
     没掷骰的操作（打听、赠礼、移动…）当场就能织，不必让玩家白等一秒半。
     rolled 由调用方在**命令入口**取快照后算好传进来 —— 曾经在这里现采 s.checks，
     而 check() 是同步写入的，出口采到的已含本次，于是判断恒为"没掷骰"、
     窗口从来没生效过（异步回流仍然漏在外面）。 */
  const wait = rolled ? WINDOW_MS : 0;
  timer = setTimeout(() => {
    const from = pendingFrom;
    pendingFrom = null;
    timer = null;
    if (from !== null) runWeave(from);
  }, wait);
  /* facts 与 ctx 不在这里采：窗口期间世界可能已经变了（换地点、进战斗），
     flush 时才按当时的状态重新采一遍，见 runWeave。 */
}

/** 真正发起编织：读取 [from, 现在] 区间里的全部见闻，交给模型织成一段 */
function runWeave(from: number): void {
  const s = core.S;
  /* 提前退出的三条路都要解锁：否则那批消息会永远藏在界面后面 */
  const unlock = () => bus.emit({ type: 'weave', from: null });
  /* 每条早返回都要留痕：不然"点了没反应"到底是没触发、没内容、还是没端口，
     从外面完全看不出来——诊断面板上只会是一片空白。 */
  if (!s) {
    note({ from, end: from, ok: false, why: '世界已卸载（跨局竞态）' });
    unlock();
    return;
  }
  const fresh = (s.log || []).filter((e) => (e.id ?? 0) > from);
  if (!fresh.length) {
    note({ from, end: from, ok: false, why: '区间内没有可织的见闻（水位 ' + from + '，当前 logSeq ' + (s.logSeq ?? 0) + '）' });
    unlock();
    return;
  }
  /* meta 条目（〔意图解析·LLM〕这类内部标记）是给排障看的，不是事实——
     混进清单里，模型会顺着「打听·米露」这种电报体去编对话。 */
  const factsAll = fresh.filter((e) => e.cls !== 'meta');
  if (!factsAll.length) {
    note({ from, end: from, ok: false, why: '区间里只有内部标记，没有可织的事实' });
    unlock();
    return;
  }
  /* 本批的右边界：**发起时的快照**。等待期间新写进来的日志属于下一批，
     不能被这一批吞掉（见 weaveLogs 的注释——那正是"点了没反应"的来源）。 */
  const end = fresh.at(-1)?.id ?? from;
  /* **现取**适配器，不用窗口开启那一刻的快照：玩家可能在窗口期间存了配置
     （换端点 / 换 Key），端口已重建，用旧适配器发出去的这一趟会走错服务，
     而面板上显示的 provider 已经是新的。 */
  let p: AiPort | null = null;
  try {
    p = ai();
  } catch {
    p = null;
  }
  if (!p?.narrateAsync) {
    note({ from, end, ok: false, why: '窗口合上时端口已不可用（配置被改？）' });
    unlock();
    return;
  }
  const t = sceneTime(s);
  /* 五层上下文：场景（上面三个字段）+ 前情 + 近因 + 衔接，事实由调用方给。
     前情与衔接是"接得上"的关键——没有它们，每一轮都从零描写同一个场景
     （实机上出现过米露一段里在喂鸽子、下一段又从广场另一头走来）。 */
  const nc = buildNarrativeContext(s, from, lastLoc);
  lastLoc = s.player.loc;
  const ctx = {
    loc: s.player.loc,
    locName: WB.locations[s.player.loc]?.name ?? s.player.loc,
    time: t.month + t.date + '日 ' + t.period,
    weather: s.weather,
    chronicle: nc.chronicle,
    recap: nc.recap,
    events: nc.events,
    continuity: nc.continuity,
  };
  /* 事实区也要卡预算：规则偶尔会吐长句（案件描述、事件公告），
     一条就能把整段上下文吃光。config 里的 factsChars 就是给它准备的。 */
  const facts = fitBudget(factsAll.map(factOf), N_FACTS);
  const myEpoch = epoch;

  chain = chain
    .then(async () => {
      /* try/finally 而不是单靠 .catch()：端口是外部实现，**同步抛错**会发生在
         await 之前，.catch() 接不住；而链一旦 reject，后面每一轮编织都会被立刻拒绝。
         解锁放在 finally —— 异常路径上界面同样不能永远藏着那批消息。 */
      try {
        const text = await p.narrateAsync!(facts, ctx as never).catch(() => null);
        /* 世界已经换代：这一趟整个作废。既不能写日志，也不能解锁——
           新局的批次有自己的解锁，旧局的 emit 只会把它提前放出来。 */
        if (myEpoch !== epoch) {
          note({ from, end, ok: false, why: '世界已重置，本次作废' });
          return;
        }
        if (text && (core.S?.logSeq ?? 0) > from) {
          /* 回来时水位还在，才动这批日志（新开局 / 重置后不能改别人的消息） */
          const done = mutate.weaveLogs(from, end, text);
          note({ from, end, ok: done, why: done ? '已替换规则原文' : '区间里没有可替换的条目' });
        } else if (!text) {
          /* 失败要留痕：否则玩家只看到"点了没反应"，而日志里什么都没有，
             排查时只能猜是没配模型还是上游限流。 */
          note({ from, end, ok: false, why: '调用失败 / 超时 / 返回空（保留规则原文）' });
        }
        maybeArchive(p); // 归档挂在编织之后，但不阻塞它——见 maybeArchive 的注释
      } finally {
        /* 成功=正文已就位；失败=原文照常显示。两条路都必须解锁。
           但**跨世代不解锁**：新局有自己的批次与解锁，旧局的这一发只会帮倒忙。 */
        if (myEpoch === epoch) bus.emit({ type: 'weave', from: null });
      }
    })
    /* 兜底：chain 是"下一次的起点"，它必须是永远 resolved 的 */
    .catch(() => {});
}

/* 预算取 NarrativeContext 的那一份（含兜底），不在这里另写一套 */
const N_CFG = narrativeBudget();
/** 事实区字数上限：规则偶尔吐长句（案件描述、公告），一条就能吃光整段上下文 */
const N_FACTS = N_CFG.factsChars;

/**
 * 章级归档：攒够一批就把最早的那几段压成一段前情，写进 s.recap。
 * 水位用 s.recapSeq（见闻 id）而不是计数——重启或读档后不会把同一批重复摘要。
 * 摘要失败**不推进水位**，下一批连本批一起再试；最坏情况是退回"只有最近两段前情"。
 */
function maybeArchive(p: AiPort): void {
  const s = core.S;
  if (!s || !p.summarizeAsync) return;
  const water = s.recapSeq ?? 0;
  const pending = (s.log || []).filter((e) => e.cls === 'ai' && (e.id ?? 0) > water);
  if (!pending.length) return;
  const t = sceneTime(s);
  const day = t.month + '/' + t.date;
  const crossedDay = lastArchiveDate !== '' && lastArchiveDate !== day;
  /* 每次检查都推进这个"检查点"，**失败也要推进**——它记的是我们看过哪一天，
     不是归档成功过哪一天。 */
  lastArchiveDate = day;
  /* 攒够一批，或者跨天了（章边界与天对齐，免得一天的情节被切进两天） */
  if (pending.length < N_CFG.recapArchive && !crossedDay) return;
  const batch = pending.slice(0, Math.max(1, N_CFG.recapSummaryPassages));
  const upto = batch.at(-1)?.id ?? 0;
  const ctx = {
    loc: s.player.loc,
    locName: WB.locations[s.player.loc]?.name ?? s.player.loc,
    time: t.month + t.date + '日 ' + t.period,
    weather: s.weather,
  };
  archiveChain = archiveChain
    .then(async () => {
      /* 同步抛错同样会污染这条链（见编织链的注释），所以取结果也走 try */
      let sum: string | null;
      try {
        sum = await p.summarizeAsync!(batch.map((e) => e.text), ctx as never);
      } catch {
        sum = null;
      }
      if (!sum) {
        /* 不推进水位（下一批连本批再试），但要留下痕迹：摘要是"尽力而为"，
           真正的边界是这批若滚出 70 条窗口就再也摘不到了——至少让它可观测。 */
        runLog.warn('ai', '章级摘要失败，本批留待下次重试', { from: upto, batch: batch.length });
        return;
      }
    /* 摘要是异步的，回来的路上世界可能已经被重置 / 读成别的档——那时 appendRecap
       会把这批段落的前情塞进新档。判据是**严格小于**：logSeq 小于 upto 才说明换了档；
       相等只是"没有更新的条目"，那是常态（归档本来就发生在没有新条目的时候）。 */
      if ((core.S?.logSeq ?? 0) < upto) return;
      mutate.appendRecap(sum, upto, N_CFG.recapKeep);
    })
    .catch(() => {});
}

/** 测试与排障用：立即合上窗口并等编织链跑完（生产路径不调它，窗口自然到时） */
export async function narrationIdle(): Promise<void> {
  if (timer && pendingFrom !== null) {
    clearTimeout(timer);
    timer = null;
    const from = pendingFrom;
    pendingFrom = null;
    runWeave(from); // 端口由它自己现取
  }
  await chain;
  await archiveChain; // 测试与排障要看到归档的结果，生产路径不等它
}

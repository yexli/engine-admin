/* ============================================================
   openai-compat 适配器：DeepSeek 及任意 OpenAI 兼容端点。
   三通道（Intent / Narrative / NPC 决策）走异步 LLM；
   任何失败返回 null，由调用方降级 rule-sim —— 铁律不变：
   LLM 只产文本与判断，状态改写全部在 core。
   ============================================================ */
import { bus, clamp } from '@/events/EventBus';
import { core } from '@/world/WorldState';
import { presentNPCs } from '@/systems/npc/Npcs';
import { sceneTime } from '@/world/WorldClock';
import cfg from '@/data/world/context.json';
import { WB } from '@/data/worldBook';
import { matchLore, loreCanonBlock, persistentCanon } from './retriever';
import { personaBlock } from './persona';
import type { AiHelpers, AiPort, ChatCtx, ChatReply, GreetCtx, IntentCtx, IntentParse, NarrateCtx, NpcCtx, NpcReq, NpcVerdict } from '@/plugins/PluginInterface';
import type { WorldState } from '@/types/world';
import { runLog } from '@/devlog/RunLog';
import { ruleSim } from './ruleSim';
import { buildChatBody } from './chatParams';
import { extractJson, parseCompletion, pluckJsonString, scanSse, type Delta } from './streaming';
import { buildCondition } from '@/world/NarrativeContext';
import { resolveTier, type LlmConfig } from './llmConfig';
import { buildPromptBlock, type PromptChannel, type PromptConfig } from './promptPreset';

/**
 * 把玩家配置的提示词块追加到第一条 system 之后（没有 system 就插到最前）。
 * 纯函数、无副作用：配置为空返回原数组引用（调用方据此跳过），便于单测。
 */
export function injectUserPrompt(
  messages: { role: string; content: string }[],
  prompts: PromptConfig | undefined,
  channel: PromptChannel,
): { role: string; content: string }[] {
  const block = buildPromptBlock(prompts, channel);
  if (!block) return messages;
  /* **前置**，不是追加：意图 / 权衡 / 对话 / 开场白这四个通道的 system 都以
     「只输出 JSON：{…}」收尾，而模型对末尾指令的服从度最高。追加在后面等于让
     玩家的一句散文指令压过输出格式约束——解析会退化成失败、静默掉回正则。
     玩家的设定说"怎么写"，任务约束说"输出成什么形状"，后者本就该靠近结尾。 */
  const wrapped = '【玩家的附加设定】\n' + block;
  const i = messages.findIndex((m) => m.role === 'system');
  if (i < 0) return [{ role: 'system', content: wrapped }, ...messages];
  return messages.map((m, k) => (k === i ? { ...m, content: wrapped + '\n\n' + m.content } : m));
}

/**
 * 把 system 内容归并进第一条 user。
 *
 * 起因是一次实测：同一段指令，放进 role:system 被模型彻底无视，放进 user 则严格服从
 * —— 有些中转网关在 OpenAI → 上游的转换里把 system 整条丢了。丢了不报错，只是「静默变质」：
 * 意图通道收到一段散文（自由行动于是全落进 unknown）、叙事通道把玩家的输入写成 NPC 的台词、
 * NPC 权衡退化成规则台词。三处症状，同一个原因。
 *
 * 归并不是将就：指令在 user 里对模型的约束力与 system 等价，而真正支持 system 的端点也照吃
 * ——所以默认开着，只在确认端点吃 system 时才切成 native（见 LlmConfig.systemMode）。
 */
export function foldSystem(messages: { role: string; content: string }[]): { role: string; content: string }[] {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).filter(Boolean);
  if (!sys.length) return messages;
  const rest = messages.filter((m) => m.role !== 'system');
  const text = sys.join('\n\n');
  const i = rest.findIndex((m) => m.role === 'user');
  /* 没有 user（理论上的空会话）：造一条出来，否则这段指令会连同这一发一起消失 */
  if (i < 0) return [{ role: 'user', content: text }, ...rest];
  return rest.map((m, k) => (k === i ? { ...m, content: text + '\n\n' + m.content } : m));
}

const INTENT_SET = new Set([
  'steal', 'observe', 'search', 'askinfo', 'shop', 'rest', 'gather', 'pray', 'drink',
  'help', 'threat', 'talk', 'give', 'request', 'explore', 'attack', 'song', 'chase', 'go', 'unknown',
]);
/* 卡 R6：十档（世界书 §118 的 10 种回答类型）；LLM 通道只许落在这十档内 */
const VERDICT_SET = new Set([
  '答应',
  '有条件答应',
  '延迟回答',
  '反提议',
  '拒绝',
  '拒绝并解释',
  '拒绝并替代',
  '沉默',
  '反问',
  '质疑',
]);

/* ---------- 失败诊断 ----------
   面板上「调用失败」的三种成因在过去长得一模一样，而它们要的处置完全不同：
     · 端点明确回错——有状态码，指向鉴权 / 权限 / 模型名 / 限流；
     · 浏览器根本没拿到响应——CORS 被拦、DNS 不通、断网，只剩一句
       TypeError: Failed to fetch，**连状态码都拿不到**；
     · 超时。
   实机踩过：中转端点没开 CORS，401 / 403 全被浏览器拦成 Failed to fetch，
   面板与见闻诊断同时显示这句话，分不出是 Key 错、没权限，还是上游挂了。
   这里把三者翻成人话，toast、运行日志、面板「连通性测试」共用同一句。 */
const HTTP_WHY: Record<number, string> = {
  400: '请求被拒绝（参数或请求体不合端点口味）',
  401: '鉴权失败（Key 无效 / 未启用）',
  403: '权限不足（令牌无该模型或该分组的访问权）',
  404: '路径或模型名不存在',
  408: '端点自己超时',
  413: '请求体过大',
  429: '触发限流（稍后自动重试一次）',
};
/* 拿不到响应时的唯一一句话。实测的成因分布（中转站 openclawroot）：
   **2xx 响应带 Access-Control-Allow-Origin，4xx/5xx 不带** —— 于是端点的每一次
   报错都被浏览器连状态码一起丢掉，前端只剩 Failed to fetch。真正"网络不通"反而少见。 */
const NO_RESPONSE_WHY = '浏览器未拿到响应（端点报错时错误响应常不带 CORS 头，状态码被一起丢掉；其次才是网络 / 域名不可达）';

function httpWhy(status: number): string {
  const w = HTTP_WHY[status];
  return 'HTTP ' + status + (w ? '：' + w : '');
}

function errWhy(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string } | null;
  if (e?.name === 'AbortError') return '调用超时（' + timeoutMs + 'ms 内没有拿到响应）';
  const msg = typeof e?.message === 'string' ? e.message : String(err);
  if (/failed to fetch|fetch failed|networkerror|load failed/i.test(msg)) return NO_RESPONSE_WHY;
  return msg.slice(0, 60) || '未知错误';
}

/* 同一模型同一原因 30 秒只喊一次——但不让先到的原因压住后到的：
   键里带原因，401 之后紧跟的 CORS 仍各喊各的（换原因 = 换了要处置的事）。 */
let lastFailKey = '';
let lastFailAt = 0;
function failOnce(adapter: string, why: string) {
  const key = adapter + '|' + why;
  const now = Date.now();
  if (key === lastFailKey && now - lastFailAt < 30000) return;
  lastFailKey = key;
  lastFailAt = now;
  bus.emit({ type: 'toast', text: '⚠ ' + adapter + ' 调用失败，已降级规则模拟（' + why + '）', cls: 'bad' });
  /* toast 会自己消失，运行日志里能回看——排查时不必再翻控制台 */
  runLog.warn('ai', '模型调用失败 · ' + adapter + ' · ' + why, { model: adapter });
}

interface ChatOpts {
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** 本次调用的超时（缺省 = 配置里的 timeoutMs）。开场白这类「玩家在等」的通道用它压短上限。 */
  timeoutMs?: number;
  /** 本调用属于哪个 AI 通道：决定用户提示词是否注入、以及注入哪些条目。
      不传 = 不注入（连通性测试这类非玩法调用就该走这条路）。 */
  channel?: PromptChannel;
  /** 草稿归属的 NPC（chat / greet 用）：界面据此把逐字文本放进正确的那个气泡 */
  npcId?: string;
  /** 机械性短 JSON 通道（意图/权衡/台词/问候）传 true：无视用户思考档位强制尝试关思考。
      关不掉的端点（档位式、忽略字段的部署）靠调用方的大预算与重试兜底，见各调用点。 */
  noThinking?: boolean;
}

/**
 * 会把半截文本推上屏的通道。三条判据：
 *   · 意图解析 / 权衡 / 结构化推演产出的是 JSON 或判定，逐字显示等于往屏幕上打字表
 *     —— 它们照常走流式收包（首字节更快），但一个草稿事件都不发；
 *   · scene-narrative 有自己的落点（开场描写那段带「✦ AI 生成中…」角标），
 *     逐字塞进见闻录的写作占位只会与它抢位置，所以也不发；
 *   · 留下的是"写进见闻录的正文"（weave / recap）与"台词"（chat / greet）。
 */
const DRAFT_CHANNELS: ReadonlySet<string> = new Set(['weave', 'recap', 'chat', 'greet']);
/** 端点明确表示"不玩流式"的状态码：回退整包重发，而不是把这一轮让给规则模拟 */
const STREAM_REJECT: ReadonlySet<number> = new Set([400, 404, 405, 415, 422]);
/** 草稿推送节流（毫秒）：比这更密的推送只会让 React 白重渲染 */
const DRAFT_MS = 120;

export class OpenAiCompatAdapter implements AiPort {
  constructor(private cfg: LlmConfig, private helpers: () => AiHelpers) {}

  /** 最近一次失败的原因：面板「连通性测试」把它带回去（见 testConnection） */
  private lastWhy = '';

  /** 记下原因并（按节流）喊一声。所有失败出口都走这里，别各写各的。 */
  private fail(why: string): void {
    this.lastWhy = why;
    failOnce(this.cfg.model, why);
  }

  get provider(): string {
    let host = this.cfg.baseURL;
    try {
      host = new URL(this.cfg.baseURL).host;
    } catch {
      /* keep raw */
    }
    return `openai-compat · ${this.cfg.model} @ ${host}`;
  }

  /* ---------- 底层调用 ---------- */

  /**
   * W6.4 · 通道路由（§66 通道→能力→端点）：channelRoutes 把该通道映射到某个档位槽，
   * 本调用就改走那个槽的端点/模型；未配置的通道返回主模型——与单模型时代逐字节相同。
   * 分流决策留痕（W6.5）：只有真正换走别的槽时记一笔，主模型路径零日志噪音。
   */
  private targetFor(channel?: PromptChannel | string): { baseURL: string; model: string; apiKey: string } {
    const main = { baseURL: this.cfg.baseURL, model: this.cfg.model, apiKey: this.cfg.apiKey };
    const tier = channel ? this.cfg.channelRoutes?.[channel] : undefined;
    if (!tier) return main;
    const slot = resolveTier(tier, this.cfg);
    if (slot.baseURL === main.baseURL && slot.model === main.model) return main;
    runLog.info('ai', '通道路由：该通道改走分层槽', { channel, tier, model: slot.model });
    return slot;
  }

  private async complete(messages: { role: string; content: string }[], opts: ChatOpts = {}): Promise<string | null> {
    /* 用户提示词在这里统一注入：各通道不必知道自己被追加了什么，新增通道也不会漏。
       配置为空时 injectUserPrompt 原样返回，行为与本功能不存在时逐字节相同。 */
    const injected = opts.channel ? injectUserPrompt(messages, this.cfg.prompts, opts.channel) : messages;
    /* system 归并放在注入**之后**：玩家的附加设定本身也是 system 块，同样需要一起搬进 user。 */
    const msgs = (this.cfg.systemMode ?? 'fold') === 'native' ? injected : foldSystem(injected);
    /* W6.4 通道路由：本通道去哪个端点/模型（缺省 = 主模型）。 */
    const target = this.targetFor(opts.channel);
    /* 瞬时故障重试一次（审查 §LLM 通道）：此前超时 / 网络 / 429 / 5xx 一视同仁 return null，
       一次抖动就让整轮推演掉回规则模拟，而且日志里分不出「没配 Key」与「上游限流」。 */
    let stream = this.cfg.stream;
    let fellBack = false;
    let droppedThinking = false;
    let retries = 0;
    for (;;) {
      const out = await this.attemptComplete(msgs, opts, stream, droppedThinking, target);
      if (out.text !== null) return out.text;
      /* 端点不认流式（4xx / 读不出流）：原地关掉流式重发一次。**不占重试名额**——
         否则"开了流式"会变成"少一次容错"，一个纯优化开关反倒更容易掉回规则模拟。 */
      if (stream && out.streamRejected && !fellBack) {
        fellBack = true;
        stream = false;
        continue;
      }
      /* 端点把思考字段当参数错误（HTTP 400）：去掉它重发一次，同样不占重试名额。
         自动关思考（见 chatParams）是给思考型端点省预算的优化，撞上"不认识 thinking
         就是 400"的严格端点时，不该让这一发直接判死、整条通道降级回规则模拟。 */
      if (out.thinkingRejected && !droppedThinking) {
        droppedThinking = true;
        continue;
      }
      if (!out.retryable || retries >= 1) return null;
      retries++;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /**
   * 单次补全尝试：返回文本 + 这一趟是否值得重试（+ 是否该关掉流式重来）。
   * stream=true 走 SSE：正文边到边上屏；端点不认（4xx / 回不了流）就打上
   * streamRejected，由 complete 回退整包重发——两条路最终拿到的是同一份文本。
   */
  private async attemptComplete(
    messages: { role: string; content: string }[],
    opts: ChatOpts,
    stream: boolean,
    dropThinking = false,
    target?: { baseURL: string; model: string; apiKey: string },
  ): Promise<{ text: string | null; retryable: boolean; streamRejected?: boolean; thinkingRejected?: boolean }> {
    /* W6.4：本调用的生效配置 = 主配置 + 通道路由覆盖（覆盖只动端点三元组，其余字段原样） */
    const cfgForCall: LlmConfig = target ? { ...this.cfg, ...target } : this.cfg;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? this.cfg.timeoutMs);
    try {
      const reqBody = buildChatBody(cfgForCall, messages, {
        json: opts.json,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        stream,
        dropThinking,
        noThinking: opts.noThinking,
      });
      const res = await fetch(cfgForCall.baseURL.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfgForCall.apiKey.trim() },
        body: JSON.stringify(reqBody),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        /* 流式被端点拒绝 ≠ 调用失败：只是一条优化路径不通，静默回退整包，
           别让玩家看见「已降级规则模拟」而其实下一秒就成功了。 */
        if (stream && STREAM_REJECT.has(res.status)) {
          runLog.info('ai', '端点拒绝流式（HTTP ' + res.status + '），回退整包重发', { model: cfgForCall.model });
          return { text: null, retryable: false, streamRejected: true };
        }
        /* 400 且这一发带了思考字段（自动关思考或用户档位）：先怀疑字段本身——
           严格端点把不认识的字段当参数错误。去掉重发一次再判死。 */
        if (res.status === 400 && ('thinking' in reqBody || 'reasoning_effort' in reqBody)) {
          runLog.info('ai', '端点拒绝思考字段（HTTP 400），去掉后重发', { model: cfgForCall.model });
          return { text: null, retryable: false, thinkingRejected: true };
        }
        this.fail(httpWhy(res.status));
        /* 429 / 5xx 是瞬时的（限流 / 网关抖动）；4xx 是永久的（鉴权 / 参数），重试无意义 */
        return { text: null, retryable: res.status === 429 || res.status >= 500 };
      }
      const out = stream ? await this.readStream(res, opts) : parseCompletion(await res.text());
      if (!out) {
        /* 200 但读不出正文：端点回的多半不是 chat/completions 形状（登录页 HTML、
           风控提示、空 body）。这种失败同样会让见闻停在规则原文，必须留痕。 */
        this.fail('200 但响应读不出正文（端点回的不是 chat/completions 形状）');
        return { text: null, retryable: false };
      }
      /* 截断要说出来（审查 §LLM 通道）：max_tokens 打满时回来的是半截 JSON，
         下游解析失败会被当成「模型答错」，与「端点不支持 response_format」混作一团。 */
      if (out.finish === 'length') {
        runLog.warn('ai', '补全被 max_tokens 截断', { model: cfgForCall.model, maxTokens: opts.maxTokens ?? 300 });
      }
      const text = out.text.trim();
      return { text: text || null, retryable: false };
    } catch (e) {
      this.fail(errWhy(e, opts.timeoutMs ?? this.cfg.timeoutMs));
      /* 超时（AbortError）与网络中断都是瞬时的 */
      return { text: null, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 读 SSE。三条落地路径：
   *   · 正常流式：逐帧攒 content，同时把半截正文广播给界面（草稿）；
   *   · 端点忽略了 stream（直接回一份整包 JSON）：退化成 parseCompletion；
   *   · 运行环境给不出可读流（没有 getReader）：先整体读文本，再按上一条处理。
   * 中途断流不算全败：已攒到的半段照交（有正文总比让玩家读规则原文强），
   * 只是这一趟标成可重试，下一发整包重来。
   */
  private async readStream(res: Response, opts: ChatOpts): Promise<Delta | null> {
    const body = res.body as ReadableStream<Uint8Array> | null | undefined;
    if (!body || typeof body.getReader !== 'function') {
      const whole = parseCompletion(await res.text());
      if (whole) this.publishDraft(opts, whole.text, true);
      return whole;
    }
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let raw = '';
    let text = '';
    let think = 0;
    let finish: string | undefined;
    let sawSse = false;
    let done = false;
    try {
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const piece = dec.decode(chunk.value, { stream: true });
        raw += piece;
        buf += piece;
        const scan = scanSse(buf);
        buf = scan.rest;
        sawSse = sawSse || scan.sawSse;
        for (const d of scan.deltas) {
          text += d.text;
          think += d.reasoning.length; // 只计数：思维链永不进正文，也不进草稿
          if (d.finish) finish = d.finish;
        }
        /* 先推草稿、再看是否收尾：所有帧挤在一次读取里时（小响应很常见），
           不先推就等于这一趟没有逐字效果 */
        this.publishDraft(opts, text, false);
        if (scan.done) {
          done = true;
          break;
        }
      }
    } catch (e) {
      if (!text) throw e;
      runLog.warn('ai', '流式读取中断，保留已收到的部分', { model: this.cfg.model, chars: text.length });
    } finally {
      this.endDraft(opts);
      try {
        reader.releaseLock();
      } catch {
        /* 已经释放过 / 环境不支持：忽略 */
      }
    }
    if (think) runLog.info('ai', '本次思考链 ' + think + ' 字（未并入正文）', { model: this.cfg.model });
    /* 一条 data: 帧都没见过 → 端点没按流式回，按整包解析（比报「流式解析失败」有用得多） */
    if (!sawSse) {
      const whole = parseCompletion(raw);
      if (whole) {
        this.publishDraft(opts, whole.text, true);
        return whole;
      }
    }
    return { text, reasoning: '', finish };
  }

  private draftAt = 0;
  private draftLast = '';

  /** 这一趟该不该推草稿：只有「写成正文给人读」的通道值得逐字 */
  private draftOn(opts: ChatOpts): boolean {
    return !!opts.channel && DRAFT_CHANNELS.has(opts.channel);
  }

  /**
   * 把半截文本推给界面：只服务「正在书写 / 沉吟着」那一处的显示，
   * **不参与任何状态**——最终文本仍由各通道解析后落地。
   */
  private publishDraft(opts: ChatOpts, text: string, force: boolean): void {
    if (!this.draftOn(opts)) return;
    /* JSON 通道拿到的是一段还没闭合的 {"line":"…"}：把已经到达的那截台词抠出来。
       要拿**累积的正文**去抠，不能拿 SSE 原文——原文里那对引号是二次转义的，
       正则找不到字段名，草稿就会永远是空的。 */
    const body = opts.json ? pluckJsonString(text) : text;
    const now = Date.now();
    if (!force && (now - this.draftAt < DRAFT_MS || body === this.draftLast)) return;
    this.draftAt = now;
    this.draftLast = body;
    /* 界面只显示尾巴：草稿是「正在长出来的那句话」，不是缓冲区转储 */
    bus.emit({ type: 'aidraft', channel: opts.channel ?? null, npcId: opts.npcId, text: body.slice(-320), done: false });
  }

  /** 收尾：无论成败都要清掉草稿，否则界面会停在半截句子上 */
  private endDraft(opts: ChatOpts): void {
    if (!this.draftOn(opts)) return;
    this.draftAt = 0;
    this.draftLast = '';
    bus.emit({ type: 'aidraft', channel: opts.channel ?? null, npcId: opts.npcId, text: '', done: true });
  }

  /**
   * 通用结构化补全出口（World Reasoner 等要求严格 JSON 的通道使用）。
   * 走 response_format=json_object，温度压低；任何失败返回 null，
   * 由调用方回退规则推演——与三条既有通道的降级语义一致。
   */
  async ask(system: string, user: string, maxTokens = 900): Promise<string | null> {
    return this.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { json: true, temperature: 0.3, maxTokens, channel: 'reason' },
    );
  }

  /**
   * 连通性测试（面板按钮用）。失败时**把原因带回去**——原来只回一个 ok:false，
   * 面板上是「✗ 测试失败：无响应」，等于没测：Key 错、没 CORS、上游挂了三种情况
   * 在这里长得一样，排查只能去开控制台。原因与降级 toast 同源（this.lastWhy）。
   */
  async testConnection(): Promise<{ ok: boolean; ms: number; reply?: string }> {
    const t0 = Date.now();
    this.lastWhy = '';
    /* 预算是 64 而不是 8：思考型端点（deepseek-flash / deepseek-reasoner）的思维链
       与正文共用这一个 max_tokens，8 会被思维链整发吃光——正文空串 → 这一发判失败，
       面板显示「端点没有返回可用文本」，而其实端点、Key、模型全是好的。
       实测（2026-09 · deepseek-flash）：预算 8 → 正文长度 0；预算 64 → 正文「在线」。
       对非思考端点只是放宽上限，回复照旧一句话。 */
    const reply = await this.complete([{ role: 'user', content: '回复两个字：在线' }], { temperature: 0, maxTokens: 64 });
    const ms = Date.now() - t0;
    if (reply) return { ok: true, ms, reply };
    /* 失败时补一次体检（只在手动测试这条路上做，不进游戏内的失败路径）：
       把「网络到不了」与「端点可达但拒绝了这一发」分开——错误响应常不带 CORS 头，
       浏览器会把 401/403/503 连状态码一起丢掉，只留一句 Failed to fetch；
       而"该换网络"和"该换模型 / 换 Key"是两件事。 */
    if (this.lastWhy === NO_RESPONSE_WHY) this.lastWhy = await this.diagnose();
    return { ok: false, ms, reply: this.lastWhy || '端点没有返回可用文本（可能是空响应，或模型没答出内容）' };
  }

  /**
   * 端点体检：打一发只读的 /models（所有 OpenAI 兼容端点都有、便宜、不改任何状态）。
   *   探测拿到 2xx → 端点、网络、Key 三者都正常，这一发是被**这一格**拒绝的
   *                   （模型名 / 分组权限 / 限流）；
   *   探测拿到非 2xx → 连只读接口都拒：Key 失效，或站点自身在报错；
   *   探测也抛错     → 才是真的到不了（网络 / 域名 / DNS）。
   */
  private async diagnose(): Promise<string> {
    try {
      const res = await fetch(this.cfg.baseURL.replace(/\/$/, '') + '/models', {
        headers: { Authorization: 'Bearer ' + this.cfg.apiKey.trim() },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) return '端点与 Key 都正常，这一发是被端点拒绝的（多为模型名 / 分组权限 / 限流）';
      return '端点可达，但连只读探测都被拒：' + httpWhy(res.status);
    } catch {
      return NO_RESPONSE_WHY;
    }
  }

  /* ---------- 同步通道：委托规则模拟（不可阻塞） ---------- */

  narrative(kind: string, p: { loc: string }): string {
    return ruleSim.narrative(kind, p);
  }
  narrativeAmbient(): string {
    return ruleSim.narrativeAmbient();
  }
  npcDecide(npcId: string, req: NpcReq): NpcVerdict {
    return ruleSim.npcDecide(npcId, req);
  }
  contextLayers(s: WorldState, h: AiHelpers): [string, string[]][] {
    return ruleSim.contextLayers(s, h);
  }

  /* ---------- 异步通道：真实模型 ---------- */

  /** 场景进入叙事（60~120 字文学化描写；只产文本，不碰状态） */
  async narrativeAsync(kind: 'enter' | 'ambient', p: { loc: string }): Promise<string | null> {
    const s = core.S;
    if (!s) return null;
    const h = this.helpers();
    const t = sceneTime(s);
    const ps = presentNPCs(p.loc, s);
    const locName = WB.locations[p.loc]?.name ?? p.loc;
    const sys =
      '你是文字RPG《天穹纪元》的叙事引擎（Narrative AI）。世界观：第三纪元612年·圣辉城，暗黑奇幻，简体中文，文学化克制笔调，像《暗黑地牢》的氛围文案。' +
      '规则：只描写场景与氛围；不得替玩家行动；不得提及数值/系统/界面；60~120字；不要引号包裹。';
    const user =
      kind === 'enter'
        ? `地点：${locName}。时间：${t.month}${t.date}日 ${t.period}。季节：${h.seasonName(s)}，天气：${s.weather}。在场人物：${ps.length ? ps.map((n) => n.name).join('、') : '无人'}。玩家：${s.player.name}（${h.raceName(s)}${h.clsName(s)}）。写一段玩家抵达此地的场景描写。`
        : `地点：${locName}。写一句此刻的环境氛围短句（30字内）。`;
    /* 卡 R7：叙事通道的上下文 = 常驻准则 + 本场景相关设定。
       常驻层在前：它是「无论走到哪都不能违背」的规则（NPC 准则 / 命名 / 历法 / 货币…），
       场景层在后：只对当前地点成立。预算各自独立，互不挤占。 */
    const persist = this.cfg.loreEnabled === false ? { text: '', used: 0 } : persistentCanon(900);
    const sceneBlock =
      this.cfg.loreEnabled === false
        ? ''
        : loreCanonBlock(matchLore({ area: WB.locations[p.loc]?.area, locName, npcNames: ps.map((n) => n.name) }, { max: 5 }), 240);
    const loreBlock = [persist.text, sceneBlock].filter(Boolean).join('\n');
    const out = await this.complete(
      [
        { role: 'system', content: sys },
        { role: 'user', content: loreBlock ? user + '\n【世界设定·须与之一致，勿改写数值/历史】\n' + loreBlock : user },
      ],
      /* 长文通道的预算含**思维链**：思考型端点会从同一个 max_tokens 里先扣掉一截，
         原值 200 在扣掉思维链后写不满「三五句」。给足余量，非思考端点不受影响
         （它写够了就自己停，上限只是上限）。 */
      { temperature: 1.0, maxTokens: 320, channel: 'narrative' },
    );
    return out ? out.replace(/^["“」]+|["”」]+$/g, '').slice(0, 220) : null;
  }

  /** 自由文本 → 结构化意图+参数包（Intent AI · G1 参数包契约；失败/越界返回 null 由 core 走正则降级） */
  async intentAsync(text: string, ctx: IntentCtx): Promise<IntentParse | null> {
    const destNames = (ctx.dests || []).map((d) => d.name);
    const sys =
      '你是文字RPG的意图解析器（Intent AI）。把玩家的自然语言输入映射为结构化意图，并抽取参数。' +
      `意图（只能选其一）：${[...INTENT_SET].join(' / ')}。` +
      /* 意图速查表（2026-09-29）：此前只列意图名不解释含义，玩家说「祈祷」时模型
         在 20 个英文意图里猜，猜成 unknown 的那轮整句被吞（玩家以为去了神殿，
         引擎什么都没执行）。把常见说法钉进提示词，机械映射的活就不靠运气。 */
      '常见说法对照：祈祷/祷告/上香/祭拜→pray；买/卖/购物/交易→shop；休息/睡觉/过夜/住店→rest；' +
      '喝酒/来一杯→drink；采集/采药/挖→gather；观察/看看/打量/环顾→observe；调查/搜查/搜索/翻找→search；' +
      '偷/窃/扒/顺走→steal；走进/进入/前往/去/回到/直奔→go（dest 必填）；打听/询问/问…消息→askinfo（topic 必填）；' +
      '聊天/闲聊/攀谈/搭话/聊聊→talk；送给/赠给/把某物给某人→give；请求/拜托/求你/借…→request；' +
      '威胁/恐吓→threat；帮助/帮忙→help；探索/探险/转转→explore；攻击/揍/动手→attack；听歌/点歌→song；追→chase。' +
      '参数：target=动作/对话对象的姓名（不涉及留空）；' +
      'dest=目的地' +
      (destNames.length ? `（可从这些地点选：${destNames.join('、')}；go 意图必填，玩家说别名也算；列表外的真实地点也照填，走不走得到引擎会回答）` : '（go 意图必填）') +
      '；focus=你想额外留意、追查或拿出的具体东西（≤20字，可空；give 意图填物品名）；' +
      'topic=打听/攀谈/请求的具体内容（≤20字，可空：问什么、聊什么、求什么）。' +
      '社交意图的区分：talk=闲聊问候拉家常，askinfo=打听具体消息，request=求人办事，give=把东西送人。' +
      /* 指向约束（自由输入误指人修复）：在场名单是给 target 白名单校验用的底册，
         不是让模型替玩家挑聊天对象——此前模型看到在场人物就往攀谈上判，
         配合 core 的「无点名回落首位在场」兜底，表现为「每次自由行动都是同一个人接话」。 */
      'target 只在输入文字实际提到某人、或用「他/她/继续」指代上文交谈对象时才填，不要因为某人在场就填。' +
      '玩家点名的人若不在在场名单里，target 仍照原样写那个名字——引擎会告诉他「那人不在场」；' +
      '绝不要替玩家把问题转给在场的别人（实机踩过：问米露怎么走，米露不在场，模型改让奥托作答）。' +
      '社交意图只在玩家确实想跟人交流时选；移动、观察、调查、探索这类与说话无关的输入，选对应的非社交意图，宁可 unknown 也不硬凑社交。' +
      /* unknown 收紧（2026-09-29）：unknown 只留给真正的天书；有动词就往最接近的
         具体意图判——判得略宽的代价（如把「转转」判成 explore）远小于判 unknown
         的代价（玩家输入被无声吞掉）。 */
      'unknown 仅用于完全无法理解的输入：只要输入里有一个能对上表的动词，就选那个意图。' +
      '若输入用「他/她/继续/再问」指代上文交谈对象，target 填 lastTalk 里的名字（对方须还在场，不在场则留空）。' +
      '若输入含多个先后动作（如"走进酒馆，观察有没有人盯着我"），拆为至多 3 个原子意图放入 steps 数组，按执行顺序排列；否则只回单个意图。' +
      '只输出 JSON：{"intent":"...","target":"","dest":"","focus":"","topic":""} 或 {"steps":[{"intent":"...", ...}]}。';
    const user =
      `当前地点：${ctx.locName}（${ctx.loc}）。在场人物：${ctx.npcs.join('、') || '无'}。` +
      (ctx.lastTalk ? `上文正与${ctx.lastTalk.name}交谈${ctx.lastTalk.topic ? `（话题：${ctx.lastTalk.topic}）` : ''}。` : '') +
      `玩家输入：「${text}」`;
    /* 两级预算（思考兼容）：意图是每个自由输入都要走的最高频通道，预算本按
       「无思维链」画（旧值 140）。有的端点关不掉思考（档位式没有 off、忽略
       disabled 字段的部署、思维链内联进 content），思维链与 JSON 共用同一个
       max_tokens，140 必被吃光 → JSON 截断 → 解析失败 → 整条意图通道静默
       永久降级正则。现在：强制尝试关思考（能关的端点省时省钱），关不掉的
       首发 640 容下常规思维链，解析仍失败再给一次 1600 的机会，之后才降级。
       noThinking 的端点两档都在生成完 JSON 时自然停，多给的预算零开销。 */
    for (const maxTokens of [640, 1600]) {
      const out = await this.complete(
        [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        { json: true, temperature: 0, maxTokens, channel: 'intent', noThinking: true },
      );
      if (!out) return null; // 传输层失败：complete 内部已重试过，再换预算也不会通，直接降级
      const p = this.parseIntent(out, ctx);
      if (p) return p;
    }
    return null;
  }

  /** 意图回包解析：逐字段白名单（R3 越界伪造防护）——target 限在场、dest 限可直达或真实地点、focus/topic 限长 */
  private parseIntent(out: string, ctx: IntentCtx): IntentParse | null {
    const sanitize = (o: Record<string, unknown>): IntentParse | null => {
      const intent = typeof o.intent === 'string' ? o.intent : '';
      if (!intent || !INTENT_SET.has(intent)) return null;
      const p: IntentParse = { intent };
      const tgt = typeof o.target === 'string' ? o.target.trim() : '';
      /* 白名单两类：在场名单（正常指人）+ 世界书名册（玩家点名了**不在场**的人——
         这恰恰要保留原名，让 core 走「X 不在这里」的缺席反馈。此前只认在场名单，
         目标被静默丢弃后模型在提示词引导下填了在场的别人，问米露却由奥托作答
         （2026-09 实机复现）。 */
      if (
        tgt &&
        (ctx.npcs.some((n) => n === tgt || n.includes(tgt) || tgt.includes(n)) ||
          Object.values(WB.npcs).some((n) => n.name === tgt || n.name.includes(tgt) || tgt.includes(n.name)))
      )
        p.target = tgt;
      const dst = typeof o.dest === 'string' ? o.dest.trim() : '';
      if (dst) {
        const hit = (ctx.dests || []).find((d) => d.name === dst || d.id === dst || d.name.includes(dst) || dst.includes(d.name));
        if (hit) p.dest = hit.id;
        else if (Object.values(WB.locations).some((L) => L.name.includes(dst) || dst.includes(L.name))) p.dest = dst; // 真实但不可直达：留给 core 的 go() 出"无法直接前往"反馈
      }
      const fc = typeof o.focus === 'string' ? o.focus.trim() : '';
      if (fc) p.focus = fc.slice(0, 20);
      const tp = typeof o.topic === 'string' ? o.topic.trim() : '';
      if (tp) p.topic = tp.slice(0, 20);
      return p;
    };
    try {
      const j = JSON.parse(extractJson(out)) as Record<string, unknown>;
      if (Array.isArray(j.steps)) {
        const steps = (j.steps as Record<string, unknown>[]).map(sanitize).filter((s): s is IntentParse => !!s).slice(0, 3);
        if (!steps.length) return null;
        return { ...steps[0], steps }; // 首步兼作单意图回退
      }
      return sanitize(j);
    } catch {
      return null;
    }
  }

  /** NPC 内心权衡与回应（NPC AI；verdict 必须落在六档内，line 为 NPC 台词） */
  async npcDecideAsync(npcId: string, req: NpcReq, ctx: NpcCtx): Promise<NpcVerdict | null> {
    const pb = this.cfg.loreEnabled === false ? '' : personaBlock(npcId, cfg.personaChars.decide); // G7 + P1：人设锚含 lore，按通道预算裁剪
    const sys =
      `你扮演《天穹纪元》中的 NPC：${ctx.npcName}（${ctx.npcTitle}）。以第一人称权衡玩家的请求。` +
      `判定档位（只能六选一）：${[...VERDICT_SET].join(' / ')}。` +
      '只输出 JSON：{"verdict":"...","line":"NPC 说的一句话（30字内，符合人设与态度）"}。不得改写世界、不得承诺超出请求范围的事。' +
      (pb ? '\n你的人设（须与之一致，勿编造）：' + pb : '');
    const user =
      `玩家「${ctx.playerName}」（${ctx.playerCls}）在${ctx.location}对你说：「${ctx.request}」\n` +
      `你与他的关系：${ctx.attWord}（好感 ${ctx.att}）。相关记忆：${ctx.mem.join('；') || '无'}。` +
      `请求利益度 ${req.interest}、风险 ${req.risk ?? 0}${req.violate ? '、对方在威胁你' : ''}。`;
    const out = await this.complete(
      [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      /* 思考兼容：权衡是机械判定，预算按无思维链画（关得掉的端点省时省钱，
         关不掉的端点 400 也容得下思维链 + JSON，见 noThinkingFields 注释） */
      { json: true, temperature: 0.8, maxTokens: 400, channel: 'decide', noThinking: true },
    );
    if (!out) return null;
    try {
      const j = JSON.parse(extractJson(out)) as { verdict?: string; line?: string };
      if (!j.verdict || !VERDICT_SET.has(j.verdict)) return null;
      const att = ctx.att;
      return {
        verdict: j.verdict,
        line: (j.line || '').slice(0, 80) || undefined,
        W: { interest: req.interest, vio: !!req.violate, risk: req.risk || 0, att },
      };
    } catch {
      return null;
    }
  }

  /** 聊天窗口同步路径：委托规则池（不可阻塞；真实模型走 chatAsync） */
  chat(npcId: string, ctx: ChatCtx): ChatReply {
    return ruleSim.chat(npcId, ctx);
  }

  /**
   * C 卡 · 对话侧的两块补充上下文（受账本字数上限约束，超限整条丢弃、不切句子）：
   *   ① 本场景 canon —— 检索词**带上玩家本句**。此前只有地点与在场人名，
   *      玩家问「星枢塔」唤不起星枢塔的设定（narrative 通道早就是这么做的，对话通道漏了）。
   *   ② 被提及者的公开一行 —— NPC 眼里有别人，但只到「知道他是谁」这一层，
   *      不给完整档案：认知边界天然由「给多少」决定。
   */
  private ctxBlock(ctx: ChatCtx, npcId: string): string {
    if (this.cfg.loreEnabled === false) return '';
    const rows: string[] = [];
    const canon = loreCanonBlock(matchLore({ locName: ctx.location, text: ctx.input }, { max: 3 }), ctx.budget?.canonChars ?? 240);
    if (canon) rows.push('【世界设定·须与之一致，勿改写】\n' + canon);
    const mentions = this.mentionedBlock(ctx.input, npcId);
    if (mentions) rows.push('【你认得的人】\n' + mentions);
    return rows.length ? '\n' + rows.join('\n') : '';
  }

  /** 输入里被提到的人（名册内、除本 NPC 之外），最多 2 位；只给一行身份，不给档案 */
  private mentionedBlock(input: string, selfId: string, max = 2): string {
    const out: string[] = [];
    for (const [id, n] of Object.entries(WB.npcs)) {
      if (id === selfId || !n.name || n.name.length < 2) continue;
      if (!input.includes(n.name)) continue;
      out.push('· 你认得' + n.name + '：' + (n.lore?.identity ? n.lore.identity.slice(0, 40) : n.title || ''));
      if (out.length >= max) break;
    }
    return out.join('\n');
  }
  /** 自由对话（Chat AI · 第四通道）：人设锚+关系包入 prompt，只回台词与有界判定；
   *  attDelta/mem/rumor 的最终落地（clamp+日封顶+传播）由 core.chatApply 白名单执行 */
  async chatAsync(npcId: string, ctx: ChatCtx): Promise<ChatReply | null> {
    const n = WB.npcs[npcId];
    if (!n) return null;
    /* C 卡：人设字数 = min(通道上限, 档位上限)——档位由 core 按 worldImportance × LOD 算好放进 ctx。
       神祇与报童此前是同一长度；现在报童拿不到 300 字传记，省下的额度归记忆与 canon。 */
    const pb = this.cfg.loreEnabled === false ? '' : personaBlock(npcId, ctx.budget?.personaChars ?? cfg.personaChars.chat);
    const sys =
      `你扮演《天穹纪元》中的 NPC：${n.name}（${n.title}·${n.race}），与玩家自由交谈。` +
      `当前你对玩家的态度：${ctx.attWord}。台词须符合该态度与人设，口语化、60字内；` +
      '不得替玩家行动、不得提及数值/系统/界面、不得编造设定或改写世界。' +
      /* AI-002（2026-09-29 二轮实测）：玩家在对话窗说「这个铜板给你」，模型回「铜板收了」
         ——对话通道不结算货币与物品，NPC 表演收下就成了跨通道假账。 */
      '这条对话通道**不交接钱物**：玩家说「给你钱／给你东西」时，东西并没有真的易手——' +
      '不要表演收下、更不要说已收下；可以推辞、打趣，或让他把东西当面递过来再说。' +
      (pb ? '\n你的人设（须与之一致，勿编造）：' + pb : '') +
      '\n只输出 JSON：{"line":"你的回应","attDelta":0,"mem":"你想记住的一句话（可空，≤20字）","rumor":"你可能会传出去的话题（可空，≤20字）"}。' +
      'attDelta 为本次交谈对你的好感影响（-2 到 2 的整数，多数时候为 0）。';
    const user =
      `场景：${ctx.location}${ctx.act ? '（你正在' + ctx.act + '）' : ''}。对方：${ctx.playerName}（${ctx.playerCls}）。` +
      (ctx.stance.length ? '立场背景：' + ctx.stance.join('；') + '。' : '') +
      (ctx.rels.length ? '你的人际关系：' + ctx.rels.join('；') + '。' : '') +
      (ctx.mem.length ? '你记得关于TA的事：' + ctx.mem.join('；') + '。' : '') +
      (ctx.history.length
        ? '最近交谈：' + ctx.history.map((h) => (h.who === 'p' ? '玩家' : n.name) + '：' + h.text).join(' / ') + '。'
        : '') +
      (ctx.topic
        ? `\n【本次话题：${ctx.topic.l}（说到第 ${ctx.topic.layer + 1} 层）】` +
          `\n你已经说过的（不必重复）：${ctx.topic.said}` +
          (ctx.topic.facts?.length
            ? `\n你只可以在这些事实范围内展开，不得编造范围外的事：${ctx.topic.facts.join('；')}`
            : '') +
          (ctx.topic.edge ? `\n边界：${ctx.topic.edge}` : '')
        : '') +
      this.ctxBlock(ctx, npcId) +
      `\n玩家对你说：「${ctx.input}」`;
    const out = await this.complete(
      [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      { json: true, temperature: 0.9, maxTokens: 400, channel: 'chat', npcId, noThinking: true },
    );
    if (!out) return null;
    try {
      const j = JSON.parse(extractJson(out)) as { line?: string; attDelta?: number; mem?: string; rumor?: string };
      if (typeof j.line !== 'string' || !j.line.trim()) return null;
      /* F-43：越界数据不越过端口——适配器出口就 clamp/截断（core 的第二道 clamp 仍保留） */
      const r: ChatReply = { line: j.line.trim().slice(0, 140) };
      if (typeof j.attDelta === 'number' && Number.isFinite(j.attDelta)) r.attDelta = clamp(Math.trunc(j.attDelta), -2, 2);
      if (typeof j.mem === 'string' && j.mem.trim()) r.mem = j.mem.trim().slice(0, 24);
      if (typeof j.rumor === 'string' && j.rumor.trim()) r.rumor = j.rumor.trim().slice(0, 20);
      return r;
    } catch {
      return null;
    }
  }

  /** 开场白（greet 通道 · 人设锚 + 此刻处境）：数据台词先上屏，这里给的是
   *  「这个时辰、这个身份、这个关系」下的第一句。只产一句台词、不改状态；
   *  任何失败返回 null，由 core 保留数据里的 greet[tier] —— 降级路径零变化。 */
  async greetAsync(ctx: GreetCtx): Promise<string | null> {
    const n = WB.npcs[ctx.npcId];
    if (!n) return null;
    const pb = this.cfg.loreEnabled === false ? '' : personaBlock(ctx.npcId, cfg.personaChars.greet);
    const s = ctx.samples;
    const sys =
      `你扮演《天穹纪元》中的 NPC：${n.name}（${n.title}·${n.race}）。玩家刚向你搭话，写你开口的第一句。` +
      '一句话，40 字内，口语化，符合人设与此刻处境；可以带一处动作或神态（用（）括住）；' +
      '不得替玩家行动、不得提及数值/系统/界面、不得编造设定。' +
      (pb ? '\n你的人设（须与之一致，勿编造）：' + pb : '') +
      `\n你平时的开口方式（只作语气参考，不要照抄）：冷「${s.cold}」／中「${s.neutral}」／热「${s.warm}」` +
      '\n只输出 JSON：{"line":"你的第一句话"}';
    const user =
      `场景：${ctx.location}${ctx.act ? '（你正在' + ctx.act + '）' : ''}。` +
      `对方：${ctx.playerName}${ctx.playerTitle ? '（' + ctx.playerTitle + '）' : ''}——你们${ctx.firstMeet ? '素未谋面，这是第一次见面' : '见过面'}，你对他的态度：${ctx.attWord}。` +
      (ctx.lastChat ? `\n你们上次聊到：「${ctx.lastChat}」。开场可以自然接上这个旧话头，也可以不提。` : '');
    const out = await this.complete(
      [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      /* 开场白是「玩家盯着屏幕等」的通道：超时压到 7 秒（core 侧还有 5 秒软超时先落回） */
      { json: true, temperature: 0.9, maxTokens: 280, timeoutMs: 7000, channel: 'greet', npcId: ctx.npcId, noThinking: true },
    );
    if (!out) return null;
    try {
      const j = JSON.parse(extractJson(out)) as { line?: string };
      const line = (j.line || '').trim();
      /* F-43 同规：适配器出口就截断，越界数据不越过端口 */
      return line ? line.slice(0, 60) : null;
    } catch {
      return null;
    }
  }

  /**
   * 叙事编织（weave 通道）：规则刚产出的几条事实 → 一段小说正文。
   * 每做一件事都会走这里，是「每一步都像在写小说」的落点。
   * 只重写文本、不产出任何判定；失败返回 null，见闻录保留规则原文。
   */
  async narrateAsync(facts: string[], ctx: NarrateCtx): Promise<string | null> {
    const s = core.S;
    if (!s || !facts.length) return null;
    const ps = presentNPCs(ctx.loc, s);
    /* 玩家处境：把数值翻成叙事短语（"带着伤"而不是"hp 32/74"）。
       派生上限走 helpers —— world/ 不为几个比例数字新增依赖边。 */
    const h = this.helpers();
    const condition = buildCondition({
      hp: s.player.hp,
      hpMax: h.maxHp(s),
      mp: s.player.mp,
      mpMax: h.maxMp(s),
      effects: (s.player.effects ?? []).map((e) => ({ id: e.id, left: e.left })),
      wanted: s.player.wanted ?? 0,
      titles: s.titles ?? [],
      level: s.player.level,
    });
    const sys =
      '你是文字RPG《天穹纪元》的叙事者。玩家刚做了一件事，规则引擎给出了这件事的实情。' +
      '你只写**这次行动的经过**：玩家做了什么、谁因此有了反应、事情怎么变化。' +
      '有动作、有神态、有细节，写得具体；细节可以补——那是小说必需的血肉。' +
      '但**事实本身不得改写**：谁做了什么、得到或失去了什么，必须与清单一致。' +
      /* 实机踩过：玩家打听「是否有人」，模型写成「你叫什么名字」，还把 NPC 的拒绝
         （"你问我？我还想问别人呢。"）写成配合回答（报出了名字）。台词是最容易被
         "写好看"带跑的一层，这里逐条钉住。 */
      '**人物说了什么就必须写成那样**：清单给了台词，它的意思与态度不得改变——' +
      '拒绝、沉默、反问不能写成配合或答应；也不要替人物发明清单之外的台词或信息' +
      '（清单里没提名字，就不要让人物报出名字）。' +
      /* 实机踩过（2026-09-29）：赠礼结算「你送上黑麦面包」+「东西是好东西」，模型把
         收下的东西写成"往玩家这边推了推，示意你收好"——把送出去的东西又还了回来。
         结算是引擎裁定的，润色只能添血肉，不能翻案。 */
      '**结算不得反转**：送出去的东西就是送出去了（不得写回退、推还、婉拒收下）；' +
      '扣掉的钱不会回来；失败的检定不能改成成功；清单说拒绝就还是拒绝。' +
      /* 实机踩过（2026-09-29 二轮）：编织素材里带着 NPC 记忆/传闻（「米露提过干饼」），
         模型把它写成「你从怀中摸出米露早些时候塞来的那块干饼」——行囊里根本没有饼。
         别人的记忆与传闻只是背景，不是玩家亲历过的事实。 */
      '**传闻不是玩家的亲历**：【有人说】、他人记忆、流言之类的条目只能作背景提及，' +
      '不得写成玩家「你」亲身经历、已收到或已拥有的东西——不得凭传闻给玩家添物品、添旧事；' +
      '细节可以补，但不得为玩家或世界虚构清单里不存在的物品与既成事实。' +
      '【玩家提出】是玩家说的话/想做的事——它是这一轮的动因，写它时要写成玩家的言行；' +
      '它的结果**只以清单其余条目为准**，不要顺着玩家的话替世界编造回应或结果。' +
      '**不要重新描写整个场景**，也不要逐一交代在场每个人的样貌与动作——' +
      '那是「场景叙事」的职责，重复描写会与它互相矛盾；只提与这次行动直接相关的人。' +
      '不要写名单之外的陌生人；同一个人不要同时出现在两处（前文写他在哪儿，就还在哪儿）。' +
      '带【提示】字样的是给玩家看的界面说明（操作引导之类），不要写进正文。' +
      '不得提及数值/系统/界面、不要复述玩家做了什么、不要向玩家提问。' +
      '只输出正文本身，不要标题、不要引号包裹、不要分点。';
    /* 上下文按五层拼接，顺序即优先级：场景 → 衔接 → 前情 → 近因 → 人物 → 事实。
       衔接放在前情之前是有意的：先告诉它"接不接得上"，再给它接的东西。 */
    const user =
      '地点：' + ctx.locName + '。时间：' + ctx.time + '。天气：' + ctx.weather + '。\n' +
      (ctx.continuity.length ? ctx.continuity.join('') + '\n' : '') +
      (condition.length ? '你的处境：' + condition.join('') + '\n' : '') +
      (ctx.chronicle.length ? '更早的前情：\n' + ctx.chronicle.join('\n') + '\n\n' : '') +
      (ctx.recap.length ? '最近写到这里（接着往下写，不要重复描写）：\n' + ctx.recap.join('\n') + '\n\n' : '') +
      (ctx.events.length ? '最近发生过：' + ctx.events.join('；') + '。\n' : '') +
      (ps.length ? '在场（只在必要时提及，不要逐一交代）：' + ps.map((n) => n.name).join('、') + '。\n' : '') +
      '这一件事：\n' + facts.map((x) => '· ' + x).join('\n') + '\n\n' +
      '请写成 1~2 个自然段（80~180 字）。';
    const out = await this.complete(
      [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      /* 420 → 700：同一发预算里思维链先花掉一截（实测 deepseek-flash 在 420 时
         思维链占 150/178 完成 token，正文只剩 37 字，而 prompt 要 80~180 字）。 */
      { temperature: 0.95, maxTokens: 700, channel: 'weave' },
    );
    if (!out) return null;
    const text = out.replace(/^["“」]+|["”」]+$/g, '').trim();
    return text ? text.slice(0, 600) : null;
  }

  /**
   * 章级摘要（recap 通道）：把最早的那批正文压成一段前情，供后面的段落衔接。
   * 它服务的是**接得上**，不是好看——所以只留推进情节的事，删掉景物与修辞。
   * 失败返回 null，调用方不推进归档水位（下一批连本批一起再试）。
   */
  async summarizeAsync(texts: string[], ctx: NarrateCtx): Promise<string | null> {
    if (!texts.length) return null;
    const sys =
      '你在为一部连载小说整理前情。把给出的几段正文压成**一段 80~140 字的前情**。' +
      '只留推进了情节的事：谁做了什么、发生了什么变化、留下了什么后果或线索；' +
      '人物此刻在哪儿、身上带着什么伤或状态也要留。' +
      '**删掉纯景物描写与修辞**——前情是用来接戏的，不是用来好看的。' +
      '用叙述语气写成连续的一段话，不要分点、不要标题、不要引号包裹、不要评价。';
    const user =
      '这几段发生在' + ctx.locName + '（' + ctx.time + '）：\n\n' +
      texts.join('\n\n') +
      '\n\n请压成一段前情。';
    const out = await this.complete(
      [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      /* 同上：前情要 80~140 字，思维链先扣一截，260 会写不完。 */
      { temperature: 0.5, maxTokens: 420, channel: 'recap' },
    );
    if (!out) return null;
    const t = out.replace(/^["“」]+|["”」]+$/g, '').trim();
    return t ? t.slice(0, 300) : null;
  }
}

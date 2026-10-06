/* ============================================================
   Tianqiong 游戏会话宿主（Phase 3 终局形态 · 服务端裁定）
   ------------------------------------------------------------
   在 Node 进程里**原样运行天穹的游戏核心**（dispatch + 24 系统 +
   规则推演兜底），把命令面暴露成 HTTP 会话：

     GET  /game/health                   → { ok, t, loc, day }
     GET  /game/state                    → { snapshot }（完整 WorldState）
     POST /game/new {name,race,cls}      → { events, snapshot }
     POST /game/command {cmd}            → { events, snapshot }

   客户端（外部模式 session 档）只产生 GameCommand；世界发生什么
   全部由这里的裁定决定——客户端收到的事实流与状态快照后整体回灌
   core.S，UI 零改动（方案 §9 运行循环的服务端形态）。

   纪律：
   · 客户端事件流去掉 'changed'（客户端应用快照后自行发 changed）；
   · AI 一律走规则兜底（ruleReasoner/ruleSim）——模型网关是 Phase 8；
   · 命令处理是同步的：响应里的 events 就是本次命令的完整因果；
     少数 setTimeout 延续（叙事编织窗口）会落进下一次响应（文档已注）。

   运行：
     npm run build:game && npm run host:game
   环境变量：
     TIANQIONG_GAME_PORT（缺省 8797）
     TIANQIONG_GAME_SAVE（存档文件路径，缺省 .world-data/game-session.json）
     TIANQIONG_GAME_SEED（rng 种子——VRT 对照测试用，缺省不播种）
     TIANQIONG_GAME_AUTONEW=1（无存档时自动开一局固定角色）
   ============================================================ */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { bus, core, dispatch, newGame, rng, flushSave } from '@/world';
import { advance } from '@/world/WorldClock';
import { sceneTime } from '@/world/WorldClock';
import { hydrate } from '@/world/WorldState';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { bootstrapWorld } from '@/plugins/bootstrap';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { ruleSim } from '@/ai/ruleSim';
import { OpenAiCompatAdapter } from '@/ai/openaiCompat';
import { aiHelpers } from '@/ai/helpers';
import { DEFAULT_LLM, embeddingUsable, llmUsable, resolveEmbedding, type LlmConfig } from '@/ai/llmConfig';
import { applyEmbeddingProvider } from '@/ai/embeddingCompat';
import type { AiPort } from '@/plugins/PluginInterface';
import type { GameCommand } from '@/types/uispec';
import type { WorldState } from '@/types/world';
import { createModelRouter, parseRouteConfig, routedProvider, startGatewayServer, type GatewayProvider } from 'world-gateway';

/* ---------------- 文件存档介质（SavePort 结构化实现，tmp+rename 原子写） ---------------- */

class FileSessionSavePort {
  readonly medium = 'memory' as const; /* 介质语义上是"服务端托管"，面板只读展示用 */
  private readonly file: string;
  onError?: (msg: string) => void;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
  }

  load(): WorldState | null {
    try {
      if (!existsSync(this.file)) return null;
      return JSON.parse(readFileSync(this.file, 'utf8')) as WorldState;
    } catch (err) {
      this.onError?.(`读取存档失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  save(s: WorldState): void {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(s));
      renameSync(tmp, this.file);
    } catch (err) {
      this.onError?.(`写入存档失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  clear(): void {
    try {
      if (existsSync(this.file)) {
        /* 可恢复语义：清档先改名备份，不直接销毁 */
        renameSync(this.file, `${this.file}.cleared-${Date.now()}`);
      }
    } catch {
      /* 清不掉不算致命 */
    }
  }
}

/* ---------------- AI 装配（Phase 8 · world-gateway 统一持钥） ----------------
   三档优先级：
     ① gateway 档（TIANQIONG_GAME_GATEWAY 外联 / TIANQIONG_GAME_GATEWAY_EMBED=1
        内嵌）：模型名=能力通道（§65 六角色），Key 由网关侧 apiKeyRef:{env}
        持握——客户端转发与本地配置都不再经手钥匙；
     ② 转发档：客户端 POST /game/ai-config 注入本地 LlmConfig；
     ③ ruleSim 兜底：没配置世界照常转。
   narrateAsync 恒为摘除：编织按方案 §30 属客户端表现层。 */

let aiProviderId = 'rule';
let aiPatch: Partial<LlmConfig> | null = null;
let gatewayUrl: string | null = null;
let gatewayServer: { url: string; close(): Promise<void> } | null = null;
/** 测试钩子（FAKE 上游）记录的 AI 调用（/game/__aicalls 观测） */
const aiCalls: Array<{ model: string; text: string }> = [];

/** 宿主 LlmConfig → 指向网关：通道经 tiers+channelRoutes 映射到 §65 角色
 *  （light→intent 快通道 / heavy→npc 角演通道；主模型落 intent 兜底）。 */
function gatewayLlmConfig(url: string): LlmConfig {
  const v1 = url.replace(/\/+$/, '') + '/v1';
  return {
    ...DEFAULT_LLM,
    enabled: true,
    baseURL: v1,
    apiKey: 'gateway-local', /* 网关在本机回环；此字段只为过 llmUsable 的形 */
    model: 'intent',
    tiers: {
      light: { baseURL: v1, model: 'intent', apiKey: 'gateway-local' },
      heavy: { baseURL: v1, model: 'npc', apiKey: 'gateway-local' },
    },
    channelRoutes: { intent: 'light', greet: 'light', npcDecide: 'heavy', chat: 'heavy', reason: 'heavy', narrative: 'heavy' },
    embedding: { ...DEFAULT_LLM.embedding, enabled: true, baseURL: v1, apiKey: 'gateway-local', model: 'memory', reuseLlm: false },
  } as LlmConfig;
}

/** §65 六角色的假上游（测试钩子，TIANQIONG_GAME_AI_FAKE=1）：确定性回包，
 *  并把调用记进 aiCalls 供 /game/__aicalls 观测。 */
function fakeUpstreamProvider(): GatewayProvider {
  const roles = ['intent', 'npc', 'reasoning', 'narrative', 'memory', 'embedding'];
  return {
    owner: 'fake-upstream',
    models: roles,
    async complete(model, messages) {
      const last = [...messages].reverse().find((m) => m.role === 'user');
      const text = `【fake:${model}】${String(last?.content ?? '').slice(0, 60)}`;
      aiCalls.push({ model, text });
      return text;
    },
    async embed(_model, input) {
      aiCalls.push({ model: 'embedding', text: input.join('|').slice(0, 60) });
      return input.map(() => [1, 0]);
    },
  };
}

async function startGateway(): Promise<void> {
  const external = (process.env.TIANQIONG_GAME_GATEWAY ?? '').trim();
  const embed = process.env.TIANQIONG_GAME_GATEWAY_EMBED === '1';
  if (!external && !embed) return;

  if (external) {
    gatewayUrl = external;
    console.log(`[game-host] AI 网关（外联）：${gatewayUrl}`);
    return;
  }

  /* 内嵌网关：上游二选一——FAKE 测试上游 / 远端 OpenAI 兼容端点 */
  const gwPort = Number(process.env.TIANQIONG_GAME_GATEWAY_PORT ?? 8788);
  let providers: GatewayProvider[];
  if (process.env.TIANQIONG_GAME_AI_FAKE === '1') {
    providers = [fakeUpstreamProvider()];
    console.log('[game-host] AI 网关上游：fake（测试钩子）');
  } else {
    const upstream = (process.env.TIANQIONG_GAME_AI_UPSTREAM ?? '').trim();
    if (!upstream) throw new Error('内嵌网关需要 TIANQIONG_GAME_AI_UPSTREAM（OpenAI 兼容端点）');
    const keyEnv = process.env.TIANQIONG_GAME_AI_KEY_ENV ?? 'TIANQIONG_GAME_AI_KEY';
    const wire = process.env.TIANQIONG_GAME_AI_WIRE ?? 'deepseek-chat';
    const router = createModelRouter(
      parseRouteConfig({
        models: [
          {
            id: wire,
            endpoint: upstream,
            apiKeyRef: { env: keyEnv }, /* 钥匙只存引用，调用时从环境解析 */
            tags: ['fast', 'roleplay', 'reasoning', 'narrative', 'memory'],
            wireModel: wire,
          },
        ],
      }),
    );
    providers = [routedProvider(router)];
    console.log(`[game-host] AI 网关上游：${upstream}（wire=${wire}，keyEnv=${keyEnv}）`);
  }
  gatewayServer = await startGatewayServer({ providers, port: gwPort, host: '127.0.0.1' });
  gatewayUrl = gatewayServer.url;
  console.log(`[game-host] AI 网关（内嵌）：${gatewayUrl}/v1/models`);
}

function buildAiPort(): void {
  /* ① gateway 档优先：钥匙在网关侧，客户端转发不再参与 */
  if (gatewayUrl) {
    const c = gatewayLlmConfig(gatewayUrl);
    const adapter = new OpenAiCompatAdapter(c, () => aiHelpers);
    (adapter as { narrateAsync?: unknown }).narrateAsync = undefined;
    setAiPort(adapter as AiPort);
    aiProviderId = adapter.provider;
    applyEmbeddingProvider(resolveEmbedding(c));
    console.log(`[game-host] AI 通道：${aiProviderId}（经网关 ${gatewayUrl}）`);
    return;
  }
  /* ② 转发档 */
  const c = { ...DEFAULT_LLM, ...(aiPatch ?? {}) } as LlmConfig;
  if (llmUsable(c)) {
    const adapter = new OpenAiCompatAdapter(c, () => aiHelpers);
    (adapter as { narrateAsync?: unknown }).narrateAsync = undefined;
    setAiPort(adapter as AiPort);
    aiProviderId = adapter.provider;
  } else {
    const fallback = { ...ruleSim, narrateAsync: undefined } as AiPort;
    setAiPort(fallback);
    aiProviderId = 'rule';
  }
  /* 向量与对话互相独立：任一可用即接（记忆检索的语义通道） */
  applyEmbeddingProvider(embeddingUsable(c) ? resolveEmbedding(c) : null);
  console.log(`[game-host] AI 通道：${aiProviderId}${embeddingUsable(c) ? ' + 向量' : ''}`);
}

/* ---------------- 事件捕获（命令处理是同步的：swap 即取走本次因果） ---------------- */

type LiteEvent = { type: string; _seq?: number; [k: string]: unknown };
let captured: LiteEvent[] = [];
let eventSeq = 0;
/** 事件环（供 SSE 补发与 ?after= 轮询；迟到事实的可靠通道） */
const ring: LiteEvent[] = [];
const RING_CAP = 1000;
const sseClients = new Set<ServerResponse>();

function publish(e: LiteEvent): void {
  eventSeq += 1;
  e._seq = eventSeq;
  ring.push(e);
  if (ring.length > RING_CAP) ring.shift();
  const frame = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

bus.on((e) => {
  /* 'changed' 不下发：客户端应用快照后自行发，驱动本地重渲染 */
  if (e.type !== 'changed') {
    const lite = e as unknown as LiteEvent;
    publish(lite);
    captured.push(lite);
    if (captured.length > 800) captured.shift(); /* 无请求消费时的防膨胀上限 */
  }
});
const takeEvents = (): LiteEvent[] => {
  const out = captured;
  captured = [];
  return out;
};

/* 进程韧性（游戏服务器不该被一次坏延续打死）：异步延续（聊天回话、
   AI 后续、编织窗口……）里的异常就地观测、进程不死。
   writeSync 直写 stderr——SIGKILL 时 stdout/stderr 的用户态缓冲会丢，
   同步写是崩溃现场能留下来的唯一方式。 */
process.on('unhandledRejection', (reason) => {
  try {
    writeSync(2, `[game-host] unhandledRejection: ${reason instanceof Error ? (reason.stack ?? String(reason)) : String(reason)}\n`);
  } catch {
    /* 观测通道自身失败不处理 */
  }
});
process.on('uncaughtException', (err) => {
  try {
    writeSync(2, `[game-host] uncaughtException: ${err instanceof Error ? (err.stack ?? String(err)) : String(err)}\n`);
  } catch {
    /* 观测通道自身失败不处理 */
  }
});

/* 装配（顺序与生产组合根一致）。rng 播种必须在 bootstrapWorld 之前——
   与本地 VRT 参照组同序（seed → bootstrap → newGame），装配若消耗 rng
   也保持两边错位一致 */
const seedEnv = process.env.TIANQIONG_GAME_SEED;
if (seedEnv && Number.isFinite(Number(seedEnv))) rng.seed(Number(seedEnv));

const SAVE_FILE = resolve(process.cwd(), process.env.TIANQIONG_GAME_SAVE ?? '.world-data/game-session.json');
const port = new FileSessionSavePort(SAVE_FILE);
setSavePort(port as never);
/* 无头部署的 AI 配置（优先级低于客户端转发与网关档）：TIANQIONG_GAME_AI = LlmConfig JSON */
const aiEnv = process.env.TIANQIONG_GAME_AI;
if (aiEnv) {
  try {
    aiPatch = JSON.parse(aiEnv) as Partial<LlmConfig>;
  } catch {
    console.error('[game-host] TIANQIONG_GAME_AI 不是合法 JSON，忽略');
  }
}
/* 网关先起（外联/内嵌），再装配 AiPort——gateway 档优先于转发档 */
await startGateway();
buildAiPort();
const disposeWorld = bootstrapWorld({ reasoner: ruleReasoner });

/* 开局：有存档接续（与 DEV 续档同一条 hydrate 路径），否则按需开新局 */
const loaded = port.load();
if (loaded) {
  core.S = hydrate(loaded);
  console.log(`[game-host] 已接续存档：t=${core.S.t} loc=${core.S.player.loc}（${SAVE_FILE}）`);
} else if (process.env.TIANQIONG_GAME_AUTONEW === '1') {
  newGame({ name: '远行者', race: 'human', cls: 'warrior' });
  console.log('[game-host] AUTONEW：已开新局');
}
/* 启动期（开局/续档）的事件属于装配因果，不属于任何命令——丢弃，
   保证首条命令响应里只有该命令自己的事实 */
takeEvents();
let bootedAt = Date.now();

/* ---------------- 会话端点 ---------------- */

/* ---------------- GM 兼容面（/v1/worlds）：实时对局世界 ---------------- */

const LIVE_WORLD_ID = 'tianqiong-live';

function liveWorldInfo() {
  const s = core.S;
  if (!s) return null;
  const t = sceneTime(s);
  return {
    worldId: LIVE_WORLD_ID,
    name: '天穹纪元 · 实时对局',
    ownerGame: 'tianqiong',
    location: s.player.loc,
    entities: Object.keys(s.npcs ?? {}).length + 1,
    time: { tick: s.t, day: t.day, year: t.year, month: t.month, monthIndex: t.monthIndex, date: t.date, hour: t.h, period: t.period, weather: s.weather },
    status: 'running',
  };
}

function snapshotPayload() {
  /* CB（战斗瞬态）与 curShop（商店上下文）是 core 的另外两个槽位，
     不在 WorldState 快照里——会话响应必须一并回灌，客户端的战斗浮层
     与商店面板才有东西可渲染（UI 零改动的关键）。 */
  return {
    snapshot: core.S,
    cb: core.CB,
    curShop: core.curShop,
    t: core.S?.t ?? null,
    loc: core.S?.player.loc ?? null,
  };
}

function readBody(req: IncomingMessage, cap = 4 * 1024 * 1024): Promise<string | null> {
  return new Promise((resolveBody) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        resolveBody(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolveBody(null));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/* ---------------- 本机 CSRF 基线（审查 P1-7） ----------------
   恶意网页可用 text/plain 简单请求跨站 POST 写端点（写操作可执行）。
   浏览器不允许伪造 Origin 头——凡 Origin 存在且不是本机来源一律 403；
   无 Origin（curl / 同源 GET）放行。 */
function csrfOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  } catch {
    return false;
  }
}

/* ---------------- 命令幂等键（审查 P1-6） ----------------
   客户端为每次逻辑操作生成稳定 commandId；超时/重试场景下重放的
   命令不再二次执行，直接返回当前状态（世界未变化）。 */
const commandSeen = new Map<string, boolean>();
const COMMAND_SEEN_CAP = 512;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '');

  /* —— 浏览器跨域：dev 页面（127.0.0.1:5273）→ 宿主（8797）是跨源请求。
     对本机来源（127.0.0.1/localhost 任意端口）回 CORS 头；带外来源不回
     （其 fetch 不可读；写端点另有 csrfOk 403 闸门——两层防线不冲突）。
     OPTIONS 预检（application/json 的 POST 会触发）直接 204 放行。 —— */
  const origin = req.headers.origin;
  let originLocal = false;
  if (typeof origin === 'string' && origin) {
    try {
      originLocal = ['127.0.0.1', 'localhost', '::1'].includes(new URL(origin).hostname);
    } catch {
      originLocal = false;
    }
    if (originLocal) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'content-type,x-api-key');
    }
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-max-age': '86400' });
    res.end();
    return;
  }

  void (async () => {
    /* 写端点的跨站基线：带外 Origin 的 POST 一律 403（审查 P1-7） */
    if (req.method === 'POST' && !csrfOk(req)) {
      send(res, 403, { error: 'cross-origin request rejected' });
      return;
    }
    if (path === '/game/health' && req.method === 'GET') {
      send(res, 200, {
        ok: true,
        boot: bootedAt,
        ai: aiProviderId,
        lastSeq: eventSeq,
        /* 网关地址下发：客户端表现层 AI（编织/场景叙事）经同一网关，
           Key 只存在于宿主环境（M3.1：彻底摘掉客户端 Key） */
        ...(gatewayUrl ? { gateway: gatewayUrl } : {}),
        ...snapshotPayload(),
      });
      return;
    }
    /* —— 事件流（SSE · 迟到事实的实时通道）：?after=N 补发环内缺口，
        之后实时推送；15s 心跳注释保活。 —— */
    if (path === '/game/events/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      const after = Number(url.searchParams.get('after') ?? 0) || 0;
      for (const e of ring) {
        if ((e._seq ?? 0) > after) res.write(`data: ${JSON.stringify(e)}\n\n`);
      }
      sseClients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* close 事件会清理 */
        }
      }, 15_000);
      res.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }
    /* —— 事件轮询兜底（SSE 不可用环境）：?after=N —— */
    if (path === '/game/events' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? 0) || 0;
      send(res, 200, { events: ring.filter((e) => (e._seq ?? 0) > after), last: eventSeq });
      return;
    }
    /* —— AI 配置注入（客户端转发本地已配 Key / 无头用环境变量）。
        gateway 档优先：钥匙在网关侧持握，转发配置不参与装配。 —— */
    if (path === '/game/ai-config' && req.method === 'POST') {
      if (gatewayUrl) {
        send(res, 200, { ok: true, ai: aiProviderId, gateway: true, note: 'gateway 档优先：钥匙由网关侧持握，转发配置已忽略' });
        return;
      }
      const raw = await readBody(req, 256 * 1024);
      if (!raw) {
        send(res, 413, { error: 'payload too large' });
        return;
      }
      try {
        const body = JSON.parse(raw) as { llm?: Partial<LlmConfig> };
        aiPatch = body.llm ?? null;
      } catch {
        send(res, 400, { error: 'invalid json' });
        return;
      }
      buildAiPort();
      const c = { ...DEFAULT_LLM, ...(aiPatch ?? {}) } as LlmConfig;
      send(res, 200, { ok: true, ai: aiProviderId, llmUsable: llmUsable(c), embeddingUsable: embeddingUsable(c) });
      return;
    }
    /* —— AI 调用观测（测试钩子，随 __emit 同守卫）：fake 上游的调用清单 —— */
    if (path === '/game/__aicalls' && req.method === 'GET') {
      if (process.env.TIANQIONG_GAME_TESTHOOK !== '1') {
        send(res, 404, { error: 'no such resource' });
        return;
      }
      send(res, 200, { calls: aiCalls });
      return;
    }
    /* —— 测试钩子（TIANQIONG_GAME_TESTHOOK=1 才开）：注入合成事件，
        验证「迟到事实 → SSE 推送 → 客户端重放 + 投影重同步」全链路 —— */
    if (path === '/game/__emit' && req.method === 'POST') {
      if (process.env.TIANQIONG_GAME_TESTHOOK !== '1') {
        send(res, 404, { error: 'no such resource' });
        return;
      }
      const raw = await readBody(req, 64 * 1024);
      try {
        const e = JSON.parse(raw ?? '{}') as LiteEvent;
        if (typeof e.type !== 'string') throw new Error('type required');
        publish(e);
        send(res, 200, { ok: true, seq: e._seq });
      } catch (err) {
        send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (path === '/game/state' && req.method === 'GET') {
      if (!core.S) {
        send(res, 409, { error: 'no world（尚未开局：POST /game/new 或置 TIANQIONG_GAME_AUTONEW=1）' });
        return;
      }
      send(res, 200, snapshotPayload());
      return;
    }
    if (path === '/game/new' && req.method === 'POST') {
      const raw = await readBody(req);
      let spec: { name?: string; race?: string; cls?: string } = {};
      try {
        spec = raw ? (JSON.parse(raw) as typeof spec) : {};
      } catch {
        send(res, 400, { error: 'invalid json' });
        return;
      }
      /* 重开一局 = 清档 + 新世界（引擎时间不可回拨的限制由会话宿主自持世界消除） */
      port.clear();
      core.S = null;
      core.CB = null;
      bootedAt = Date.now();
      newGame({
        name: spec.name ?? '远行者',
        race: spec.race ?? 'human',
        cls: spec.cls ?? 'warrior',
      });
      send(res, 200, { ok: true, events: takeEvents(), ...snapshotPayload() });
      return;
    }
    if (path === '/game/command' && req.method === 'POST') {
      const raw = await readBody(req);
      if (!raw) {
        send(res, 413, { error: 'payload too large' });
        return;
      }
      let cmd: GameCommand;
      try {
        cmd = JSON.parse(raw) as GameCommand;
      } catch {
        send(res, 400, { error: 'invalid json' });
        return;
      }
      /* 元命令（开局/续档/导入/重置）在无世界时也必须受理——
         客户端标题屏的第一条命令就是它们 */
      const META = new Set(['newGame', 'continueSave', 'importState', 'resetWorld']);
      if (!core.S && !META.has(cmd?.type as string)) {
        send(res, 409, { error: 'no world（尚未开局）' });
        return;
      }
      if (!cmd || typeof cmd.type !== 'string') {
        send(res, 400, { error: 'command body must be an object with a "type"' });
        return;
      }
      /* 幂等键去重（审查 P1-6）：超时/重试场景下重放的命令不再二次执行，
         返回当前状态（世界未变化，duplicate 标记如实上报） */
      const cid = typeof (cmd as { commandId?: unknown }).commandId === 'string'
        ? (cmd as unknown as { commandId: string }).commandId
        : null;
      if (cid && commandSeen.has(cid)) {
        send(res, 200, { ok: true, duplicate: true, events: [], ...snapshotPayload() });
        return;
      }
      try {
        dispatch(cmd);
      } catch (err) {
        /* 系统抛错不该拖垮会话进程：把错误当作一条 toast 事实回传 */
        publish({ type: 'toast', text: `内部错误：${err instanceof Error ? err.message : String(err)}`, cls: 'bad' });
      }
      if (cid) {
        commandSeen.set(cid, true);
        if (commandSeen.size > COMMAND_SEEN_CAP) {
          const oldest = commandSeen.keys().next().value;
          if (oldest !== undefined) commandSeen.delete(oldest);
        }
      }
      send(res, 200, { ok: true, events: takeEvents(), ...snapshotPayload() });
      return;
    }
    /* ================= GM 兼容面（/v1/worlds 协议子集） =================
       admin-web 把 /world-api 指向本端口即可看到**实时对局世界**：
       后台推进时间 → advance() → 事实进事件环 → SSE 推给游戏客户端
       → 客户端重放 + 快照对齐（时辰边界/日结算照常触发）。 */
    if (path === '/v1/worlds' && req.method === 'GET') {
      send(res, 200, { worlds: core.S ? [liveWorldInfo()] : [] });
      return;
    }
    if (path.startsWith('/v1/worlds/')) {
      const seg = path.split('/').filter(Boolean); /* ['v1','worlds',id,(leaf)] */
      const id = decodeURIComponent(seg[2] ?? '');
      if (id !== LIVE_WORLD_ID) {
        send(res, 404, { error: 'no such world' });
        return;
      }
      if (seg.length === 3 && req.method === 'GET') {
        const info = liveWorldInfo();
        send(res, info ? 200 : 409, info ?? { error: 'no world（尚未开局）' });
        return;
      }
      if (seg.length === 4 && seg[3] === 'state' && req.method === 'GET') {
        if (!core.S) {
          send(res, 409, { error: 'no world' });
          return;
        }
        send(res, 200, { ...core.S, worldId: LIVE_WORLD_ID });
        return;
      }
      if (seg.length === 4 && seg[3] === 'events' && req.method === 'GET') {
        const cap = Math.min(Number(url.searchParams.get('n') ?? 50) || 50, 500);
        send(res, 200, { events: [...ring].reverse().slice(0, cap), total: ring.length });
        return;
      }
      if (seg.length === 4 && seg[3] === 'time' && req.method === 'POST') {
        if (!core.S) {
          send(res, 409, { error: 'no world' });
          return;
        }
        const raw = await readBody(req, 4 * 1024);
        const ticks = Math.max(1, Math.min(Math.floor(Number(JSON.parse(raw ?? '{}')?.ticks ?? 0)) || 0, 1440));
        if (ticks < 1) {
          send(res, 400, { error: 'body must be {"ticks": <positive number>}' });
          return;
        }
        advance(ticks); /* 与玩家 wait 同一条时钟：时辰边界/日结算照常触发 */
        send(res, 200, { ok: true, events: takeEvents().map((e) => ({ seq: e._seq, type: e.type })), ...snapshotPayload() });
        return;
      }
    }
    send(res, 404, { error: 'no such resource' });
  })().catch((err) => {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  });
});

const PORT = Number(process.env.TIANQIONG_GAME_PORT ?? 8797);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[game-host] 游戏会话已托管：http://127.0.0.1:${PORT}/game/health`);
  console.log(`[game-host] 裁定栈：dispatch + 24 系统 + 规则推演（模型网关为 Phase 8）`);
});

process.on('SIGINT', () => {
  try {
    flushSave();
  } catch {
    /* 退出时的冲盘失败不阻塞退出 */
  }
  disposeWorld();
  /* 先拆流连接（close 只等排空不主动断，活跃 SSE 会让关闭挂死） */
  for (const res of sseClients) res.destroy();
  sseClients.clear();
  void gatewayServer?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
});

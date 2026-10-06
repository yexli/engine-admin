/* ============================================================
   会话事件流（SSE）+ 迟到事实收敛 + AI 配置注入（Phase 8 前置验收）
   ------------------------------------------------------------
   ① SSE 读取器（协议层）：帧切分 / 心跳注释忽略 / 断开通知；
   ② 宿主流集成：命令事实在响应与流上同达（tee）；`?after=N` 补发；
   ③ 迟到事实全链路：__emit 合成事实 → SSE 推送 → 客户端重放 bus
      → 投影重同步（合并窗口）；
   ④ AI 配置注入：不可用配置保持 rule；可用形态（假端点+字段齐全）
      切到 openai-compat；再转发不可用配置回落 rule。
   ============================================================ */
import { createServer, type Server } from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bus, core, dispatch, resetWorld, rng } from '@/world';
import { setSavePort, setAiPort } from '@/plugins/PluginInterface';
import { MemorySaveRepository } from '@/repo';
import { ruleSim } from '@/ai/ruleSim';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { bootstrapWorld } from '@/plugins/bootstrap';
import { plugins } from '@/plugins/PluginRegistry';
import { resetEventSeq } from '@/events/EventSchema';
import { worldEventLog } from '@/events/EventStore';
import { GameSessionClient, readSse } from '@/world-engine/client/gameSession';
import { attachExternalSession } from '@/plugins/extSession';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BUNDLE = ROOT + '.server-build/game-host.mjs';

/* ---------------- ① SSE 读取器（协议层，裸 http 服务器） ---------------- */

describe('readSse（SSE 读取器）', () => {
  let server: Server | null = null;
  let port = 0;
  const frames: string[] = [];

  beforeEach(async () => {
    frames.length = 0;
    await new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('retry: 100\n\n');
        res.write(': heartbeat comment\n'); /* 注释帧必须被忽略 */
        res.write('data: {"n":1}\n\n');
        res.write('data: {"n":2}\ndata: {"n":3}\n\n'); /* 一块多帧 */
        setTimeout(() => {
          res.write('data: {"n":4}\n\n');
          res.end();
        }, 60);
      });
      server.listen(0, '127.0.0.1', () => {
        port = (server!.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it('帧切分正确、注释忽略、多帧块解析、结束即返回', async () => {
    await readSse(`http://127.0.0.1:${port}/`, {}, (e) => frames.push(JSON.stringify(e)));
    expect(frames).toEqual(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}']);
  });

  it('abort 立即停止并静默返回', async () => {
    const ctrl = new AbortController();
    const done = readSse(`http://127.0.0.1:${port}/`, { signal: ctrl.signal }, (e) => frames.push(JSON.stringify(e)));
    setTimeout(() => ctrl.abort(), 10);
    await expect(done).resolves.toBeUndefined();
  });
});

/* ---------------- ②③④ 宿主集成 ---------------- */

const ROOT_URL = fileURLToPath(new URL('../..', import.meta.url));
const SEED = 20261006;
const PORT = 18_640 + Math.floor(Math.random() * 50);
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess | null = null;
let saveDir = '';

beforeAll(() => {
  const res = spawnSync(process.execPath, [ROOT_URL + 'node_modules/vite/bin/vite.js', 'build', '-c', 'vite.game-host.config.ts'], {
    cwd: ROOT_URL,
    encoding: 'utf8',
  });
  if (res.status !== 0 || !existsSync(BUNDLE)) throw new Error(`宿主构建失败：${res.stderr?.slice(0, 300)}`);
});

beforeEach(() => {
  core.S = null;
  core.CB = null;
  core.curShop = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort({ ...ruleSim, narrateAsync: undefined } as typeof ruleSim);
  plugins.clear();
  worldEventLog.clear();
  resetEventSeq();
  rng.seed(SEED);
  bootstrapWorld({ reasoner: ruleReasoner });
});

afterEach(() => {
  proc?.kill('SIGKILL');
  proc = null;
  if (saveDir) {
    rmSync(saveDir, { recursive: true, force: true });
    saveDir = '';
  }
});

async function startHost(): Promise<void> {
  saveDir = `${ROOT_URL}.qa-tmp/session-stream-${Date.now()}`;
  mkdirSync(saveDir, { recursive: true });
  proc = spawn(process.execPath, [BUNDLE], {
    cwd: ROOT_URL,
    env: {
      ...process.env,
      TIANQIONG_GAME_PORT: String(PORT),
      TIANQIONG_GAME_SAVE: `${saveDir}/save.json`,
      TIANQIONG_GAME_SEED: String(SEED),
      TIANQIONG_GAME_AUTONEW: '1',
      TIANQIONG_GAME_TESTHOOK: '1',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/game/health`)).ok) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error('宿主 10s 内未就绪');
    await new Promise((r) => setTimeout(r, 120));
  }
}

const poll = async (cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`超时：${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
};

describe('会话事件流（真实宿主）', () => {
  it('② 命令事实 tee 到流上；?after=N 补发；迟到事实③重放 bus + 投影重同步', async () => {
    await startHost();

    /* 会话装配（真实客户端路径） */
    let reportCount = 0;
    const busTypes: string[] = [];
    const offBus = bus.on((e) => {
      /* 合成事件类型不在 BusEvent 联合里，按信封面读（会话事件本就是不透明传输） */
      const raw = e as unknown as { type: string };
      if (raw.type === 'extstream_test') busTypes.push(raw.type);
    });
    const reports: Array<{ status: string; t: number | null }> = [];
    const dispose = attachExternalSession({
      baseUrl: BASE,
      report: (p) => {
        reports.push(p);
        reportCount += 1;
      },
    });
    await poll(() => reports.some((r) => r.status === 'online'), '会话上线');

    /* ② 命令事实 tee：流上应看到与响应相同的事实（travel 的 toast/screen） */
    const streamed: string[] = [];
    const client = new GameSessionClient({ baseUrl: BASE });
    const stopTee = client.streamEvents({
      onEvent: (e) => streamed.push(e.type),
    });
    dispatch({ type: 'wait', ticks: 1 } as never);
    await poll(() => streamed.length > 0, '命令事实 tee 到流上');
    stopTee();

    /* ③ 迟到事实全链路：__emit 合成事实 → SSE → bus 重放 + 重同步 */
    const before = reportCount;
    const res = await fetch(`${BASE}/game/__emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'extstream_test', text: '迟到事实' }),
    });
    expect(res.ok).toBe(true);
    await poll(() => busTypes.includes('extstream_test'), '迟到事实重放到 bus');
    await poll(() => reportCount > before, '迟到事实触发投影重同步');

    /* ?after= 补发：取 lastSeq 之后必为空、取 0 必含历史 */
    const since = await client.eventsSince(0);
    expect(since.events.length).toBeGreaterThan(0);
    const tail = await client.eventsSince(since.last);
    expect(tail.events).toHaveLength(0);

    offBus();
    dispose();
  }, 30_000);

  it('④ AI 配置注入：rule ↔ openai-compat 切换，health 如实回报', async () => {
    await startHost();
    const client = new GameSessionClient({ baseUrl: BASE });

    /* 缺省（AUTONEW 宿主未注入配置）：rule 兜底 */
    let h = (await client.health()) as unknown as { ai: string };
    expect(h.ai).toBe('rule');

    /* 注入不可用配置（缺 Key）→ 仍 rule */
    let r = await client.setAiConfig({ enabled: true, baseURL: 'https://api.example.com/v1', apiKey: '', model: 'x' });
    expect(r.llmUsable).toBe(false);
    h = (await client.health()) as unknown as { ai: string };
    expect(h.ai).toBe('rule');

    /* 注入可用形态（字段齐全即可；端点是假地址，不实际调用模型）→ openai-compat */
    r = await client.setAiConfig({ enabled: true, baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'test-model' });
    expect(r.llmUsable).toBe(true);
    h = (await client.health()) as unknown as { ai: string };
    expect(h.ai).not.toBe('rule');

    /* 回落：清掉配置 → rule */
    r = await client.setAiConfig({});
    expect(r.llmUsable).toBe(false);
    h = (await client.health()) as unknown as { ai: string };
    expect(h.ai).toBe('rule');
  }, 30_000);
});

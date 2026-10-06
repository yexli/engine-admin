/* ============================================================
   Phase 8 收尾：world-gateway 接入宿主
   ------------------------------------------------------------
   内嵌网关（TIANQIONG_GAME_GATEWAY_EMBED=1）+ 假上游
   （TIANQIONG_GAME_AI_FAKE=1）验证 §65 的完整 AI 线：

     客户端命令 → 会话门 → 服务端 AiPort（openai-compat 适配器）
       → world-gateway（模型名=能力通道）→ 上游提供方

   断言：
   ① health 如实回报 AI 通道已切 openai-compat（指向内嵌网关）；
   ② freeText 命令触发 intent 通道调用（/game/__aicalls 可观测，
      假上游确定性回包）；
   ③ 网关档优先：ai-config 转发被忽略（钥匙由网关侧持握）；
   ④ 网关的 /v1/models 暴露 §65 六角色。
   ============================================================ */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { gateway } from '@/ai/gateway';
import { attachExternalSession } from '@/plugins/extSession';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BUNDLE = ROOT + '.server-build/game-host.mjs';
const PORT = 18_500 + Math.floor(Math.random() * 40);
const GW_PORT = PORT + 100;
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ChildProcess | null = null;
let saveDir = '';

beforeAll(() => {
  const res = spawnSync(process.execPath, [ROOT + 'node_modules/vite/bin/vite.js', 'build', '-c', 'vite.game-host.config.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.status !== 0 || !existsSync(BUNDLE)) throw new Error(`宿主构建失败：${res.stderr?.slice(0, 300)}`);
});

afterEach(() => {
  proc?.kill('SIGKILL');
  proc = null;
  if (saveDir) {
    rmSync(saveDir, { recursive: true, force: true });
    saveDir = '';
  }
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(cond: () => Promise<boolean> | boolean, what: string, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    let why = '';
    try {
      ok = await cond();
    } catch (err) {
      why = `（cond 异常：${err instanceof Error ? err.message.slice(0, 60) : String(err)}）`;
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`超时：${what}${why}`);
    await sleep(40);
  }
}

async function jfetch(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  return res.json();
}

describe('Phase 8：world-gateway 接入宿主（内嵌 + 假上游）', () => {
  it('AI 全线：health 切 openai-compat → freeText 走 intent 通道 → 网关档优先', async () => {
    saveDir = `${ROOT}.qa-tmp/session-gw-${Date.now()}`;
    mkdirSync(saveDir, { recursive: true });
    const childLog = openSync(`${ROOT}.qa-tmp/gw-child.log`, 'w');
    proc = spawn(process.execPath, [BUNDLE], {
      cwd: ROOT,
      env: {
        ...process.env,
        TIANQIONG_GAME_PORT: String(PORT),
        TIANQIONG_GAME_SAVE: `${saveDir}/save.json`,
        TIANQIONG_GAME_AUTONEW: '1',
        TIANQIONG_GAME_TESTHOOK: '1',
        TIANQIONG_GAME_GATEWAY_EMBED: '1',
        TIANQIONG_GAME_GATEWAY_PORT: String(GW_PORT),
        TIANQIONG_GAME_AI_FAKE: '1',
      },
      stdio: ['ignore', childLog, childLog],
    });

    /* ① 宿主就绪且 AI 通道指向内嵌网关 */
    await poll(async () => {
      const h = (await jfetch(`${BASE}/game/health`)) as { ai?: string };
      return String(h.ai ?? '').includes('openai-compat');
    }, '宿主就绪且 AI 通道切换');

    /* M3.1：health 下发网关地址 → 客户端表现层 AI 已切网关
       （gateway.use 换端口：provider 指向网关，编织/场景叙事不再用本地 Key） */
    const disposeSession = attachExternalSession({ baseUrl: BASE, report: () => {} });
    try {
      await poll(() => gateway.hasLlm(), '客户端表现层 AI 已切网关', 8_000);
    } finally {
      disposeSession();
    }

    /* ④ 网关暴露 §65 六角色（模型名=通道） */
    const models = (await jfetch(`http://127.0.0.1:${GW_PORT}/v1/models`)) as { data: Array<{ id: string }> };
    const ids = models.data.map((m) => m.id);
    for (const role of ['intent', 'npc', 'reasoning', 'narrative', 'memory', 'embedding']) {
      expect(ids, `网关缺少角色 ${role}`).toContain(role);
    }

    /* ② freeText 命令 → 意图解析走 AI 线（假上游确定性回包，解析失败自动
       落正则兜底——断言的是「调用发生」，不是假上游会真的解析） */
    await jfetch(`${BASE}/game/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'freeText', text: '看看四周' }),
    });
    await poll(async () => {
      const calls = (await jfetch(`${BASE}/game/__aicalls`)) as { calls: Array<{ model: string }> };
      return calls.calls.some((c) => c.model === 'intent');
    }, 'intent 通道调用未发生');

    /* ③ 网关档优先：转发配置被忽略（钥匙由网关侧 apiKeyRef 持握） */
    const r = (await jfetch(`${BASE}/game/ai-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: { enabled: true, baseURL: 'http://attacker.example/v1', apiKey: 'k', model: 'm' } }),
    })) as { gateway?: boolean; ai?: string };
    expect(r.gateway).toBe(true);
    expect(String(r.ai)).toContain('openai-compat');
  }, 40_000);
});

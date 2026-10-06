/* ============================================================
   M1 修复回归测试（审查 P0/P1 逐项验收）
   ------------------------------------------------------------
   ① 握手恢复（P0-2）：刷新页面（新客户端接入）后不再重放历史环——
      接入前 __emit 的陈旧事实不进 bus；
   ② 重启去重（P0-3）：宿主重启后 _seq 归零，握手重置水位——
      新进程的迟到事实照常到达；
   ③ 重放过滤（P1-4）：SSE 在线时命令事实只出现一次（无 double-toast）；
   ④ 幂等键（P1-6）：同 commandId 重复提交，世界不二次变化；
   ⑤ CSRF 基线（P1-7）：带外 Origin 的 POST 403，无 Origin 放行。
   ============================================================ */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bus, core, dispatch, resetWorld, rng } from '@/world';
import { setSavePort, setAiPort } from '@/plugins/PluginInterface';
import { MemorySaveRepository } from '@/repo';
import { ruleSim } from '@/ai/ruleSim';
import { plugins } from '@/plugins/PluginRegistry';
import { resetEventSeq } from '@/events/EventSchema';
import { worldEventLog } from '@/events/EventStore';
import { attachExternalSession } from '@/plugins/extSession';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BUNDLE = ROOT + '.server-build/game-host.mjs';
const PORT = 18_400 + Math.floor(Math.random() * 40);
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

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort({ ...ruleSim, narrateAsync: undefined } as typeof ruleSim);
  plugins.clear();
  worldEventLog.clear();
  resetEventSeq();
  rng.seed(20261006);
});

afterEach(() => {
  proc?.kill('SIGKILL');
  proc = null;
  if (saveDir) {
    rmSync(saveDir, { recursive: true, force: true });
    saveDir = '';
  }
});

/** 起宿主（TESTHOOK 开，供 __emit 注入合成事实） */
async function startHost(autoNew = true): Promise<void> {
  saveDir = `${ROOT}.qa-tmp/session-m1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync(saveDir, { recursive: true });
  proc = spawn(process.execPath, [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      TIANQIONG_GAME_PORT: String(PORT),
      TIANQIONG_GAME_SAVE: `${saveDir}/save.json`,
      TIANQIONG_GAME_AUTONEW: autoNew ? '1' : '0',
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
    await new Promise((r) => setTimeout(r, 100));
  }
}

const poll = async (cond: () => boolean, what: string, timeoutMs = 12_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`超时：${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
};

describe('M1 修复回归', () => {
  it('①② 握手：新客户端不重放历史；宿主重启后迟到事实仍可达', async () => {
    await startHost();

    /* 接入前先注入一条「历史」合成事实——它属于事件环，但属于页面打开之前 */
    await fetch(`${BASE}/game/__emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'toast', text: '历史事实-不应重放', cls: 'sys' }),
    });

    const seen: string[] = [];
    const offBus = bus.on((e) => {
      const raw = e as unknown as { type: string; text?: string };
      if (raw.type === 'toast' && typeof raw.text === 'string') seen.push(raw.text);
    });
    const reports: Array<{ status: string; t: number | null }> = [];
    const dispose = attachExternalSession({
      baseUrl: BASE,
      report: (p) => reports.push(p),
    });
    await poll(() => reports.some((r) => r.status === 'online'), '会话上线');

    /* ① 历史事实不重放（流从握手水位起步；快照回灌承载真相） */
    await new Promise((r) => setTimeout(r, 400));
    expect(seen.some((t) => t.includes('历史事实-不应重放'))).toBe(false);

    /* ② 宿主重启 → boot 变化 → 握手取新 head 并回局 →
       之后（握手完成后）的迟到事实经新流实时到达 */
    proc!.kill('SIGKILL');
    proc = null;
    const before = reports.length;
    await startHost();
    await poll(
      () => reports.slice(before).some((r) => r.status === 'online' && r.t !== null),
      '重启后握手回局（快照回灌）',
      15_000,
    );

    await fetch(`${BASE}/game/__emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'toast', text: '重启后事实-应到达', cls: 'sys' }),
    });
    await poll(() => seen.some((t) => t.includes('重启后事实-应到达')), '重启后实时事实未到达');

    offBus();
    dispose();
  }, 40_000);

  it('③ 重放过滤：SSE 在线时命令事实只出现一次', async () => {
    await startHost();
    const toastTexts: string[] = [];
    const offBus = bus.on((e) => {
      const raw = e as unknown as { type: string; text?: string };
      if (raw.type === 'toast' && typeof raw.text === 'string') toastTexts.push(raw.text);
    });
    const reports: Array<{ status: string }> = [];
    const dispose = attachExternalSession({ baseUrl: BASE, report: (p) => reports.push(p) });
    await poll(() => reports.some((r) => r.status === 'online'), '会话上线');

    /* 开局（newGame 命令，服务端产生 toast/screen 事实）+ 一次移动 */
    dispatch({ type: 'newGame', name: '重放员', race: 'human', cls: 'warrior' } as never);
    await poll(() => core.S !== null, '快照回灌');
    dispatch({ type: 'travel', loc: 'market' } as never);
    await new Promise((r) => setTimeout(r, 600)); /* 双通道投递的窗口 */

    /* 去重后：同一文本的 toast 不应重复出现 */
    const dup = toastTexts.filter((t, i) => toastTexts.indexOf(t) !== i);
    expect(dup, `重复 toast：${JSON.stringify(dup)}`).toEqual([]);

    offBus();
    dispose();
  }, 40_000);

  it('⑤ CSRF 基线：带外 Origin 403；无 Origin 放行', async () => {
    await startHost();
    const evil = await fetch(`${BASE}/game/command`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
      body: JSON.stringify({ type: 'wait', ticks: 2 }),
    });
    expect(evil.status).toBe(403);

    const ok = await fetch(`${BASE}/game/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'wait', ticks: 2, commandId: 'csrf-ok-1' }),
    });
    expect(ok.status).toBe(200);
  }, 30_000);


  it('⑥ GM 兼容面：/v1/worlds 列出实时对局，后台推时间世界真实前进', async () => {
    await startHost();

    /* 世界列表（引擎协议形状） */
    const worlds = (await fetch(`${BASE}/v1/worlds`).then((r) => r.json())) as {
      worlds: Array<{ worldId: string; ownerGame: string; time: { tick: number } }>;
    };
    const live = worlds.worlds.find((w) => w.worldId === 'tianqiong-live');
    expect(live).toBeTruthy();
    expect(live!.ownerGame).toBe('tianqiong');
    const t0 = live!.time.tick;

    /* 后台推进 → 宿主真实时钟前进（与玩家 wait 同一条） */
    const r = (await fetch(`${BASE}/v1/worlds/tianqiong-live/time`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticks: 3 }),
    }).then((x) => x.json())) as { ok: boolean; t: number };
    expect(r.ok).toBe(true);
    expect(r.t).toBe(t0 + 3);

    /* 会话协议面与 GM 面看到同一个世界 */
    const snap = (await fetch(`${BASE}/game/state`).then((x) => x.json())) as { t: number };
    expect(snap.t).toBe(t0 + 3);
  }, 30_000);

  it('④ 幂等键：同 commandId 重复提交，世界只变化一次', async () => {
    await startHost();
    const body = JSON.stringify({ type: 'advance_time', amount: 4, commandId: 'idem-001' });
    const r1 = (await fetch(`${BASE}/game/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then(
      (r) => r.json(),
    )) as { ok: boolean; t: number };
    const r2 = (await fetch(`${BASE}/game/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then(
      (r) => r.json(),
    )) as { ok: boolean; duplicate?: boolean; t: number };

    expect(r1.ok).toBe(true);
    expect(r2.duplicate).toBe(true);
    expect(r2.t).toBe(r1.t); /* 世界未二次变化 */
  }, 30_000);
});

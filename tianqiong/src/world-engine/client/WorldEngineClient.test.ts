/* ============================================================
   WorldEngineClient 集成测试（Phase 1 验收）
   ------------------------------------------------------------
   拓扑与生产一致：World Engine 跑在**独立子进程**里（真实
   node 进程 + 真实 TCP），测试里的客户端跨进程连 127.0.0.1。
   不在 vitest worker 里 in-process 起服务——连接层的断线/重连
   语义只有对着真实进程生死才作数。

   验证（对应方案 §Phase1 / §22）：
   ① connect → 世界概要 + 状态快照 + WS 上线；
   ② sendIntent → 引擎裁定 → 事实经 WS 流回（§4.2）；
   ③ commandId 幂等；
   ④ 断线写拒绝（OfflineError，绝不回落本地）；
   ⑤ 服务进程被杀 → 自动重连 → 新进程上的事实经 REST/replay
      双窗口补齐，eventId 幂等不重放；
   ⑥ close 后彻底停机；
   ⑦ 意图→命令映射纯函数。
   ============================================================ */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { WireEvent } from './types';
import {
  WorldEngineClient,
  WorldEngineOfflineError,
  intentToCommand,
  type ConnectionStatus,
} from './WorldEngineClient';

/** 项目根（tianqiong/）：子进程从这里解析 world-engine 依赖（node_modules 符号链接） */
const PROJECT_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/* ---------------- 子进程里的引擎宿主（与 scripts/world-host.mjs 同形态的最小版） ---------------- */

const CHILD_SCRIPT = `
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/package.json');
const { createWorldRegistry, hostGameWorld } = require('world-engine');
const { startWorldServer } = require('world-engine/http');

const port = Number(process.argv[1] ?? 0);
const adapter = {
  gameId: 'tq-test',
  name: '测试世界',
  seed: () => ({
    worldId: 'tq-test-main',
    name: '测试世界',
    ownerGame: 'tq-test',
    locations: [
      { id: 'plaza', name: '中央广场', type: 'urban' },
      { id: 'tavern', name: '银鸥酒馆', type: 'urban' },
    ],
    npcs: [{ id: 'milu', name: '米露', loc: 'tavern', data: { title: '侍者' } }],
    relations: [],
    facts: [{ type: 'npc_identity', actor: 'milu', data: { identity: '银鸥酒馆的侍者' } }],
  }),
};
const registry = createWorldRegistry();
hostGameWorld(registry, adapter);
const server = await startWorldServer({ registry, port });
process.stdout.write(JSON.stringify({ ready: true, port: server.port, url: server.url, worldId: 'tq-test-main' }) + '\\n');
process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
`;

interface EngineProc {
  proc: ChildProcess;
  port: number;
  url: string;
  worldId: string;
}

/** 起一个引擎子进程；就绪行（JSON）从 stdout 读出 */
async function startEngineProc(port = 0): Promise<EngineProc> {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT, String(port)], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const ready = await new Promise<{ port: number; url: string; worldId: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('引擎子进程 8s 内未就绪')), 8_000);
    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const line = buf.split('\n').find((l) => l.includes('"ready"'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line.trim()));
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`引擎子进程提前退出（code=${code}）`));
    });
  });
  return { proc, port: ready.port, url: ready.url, worldId: ready.worldId };
}

function killEngineProc(p: EngineProc): Promise<void> {
  return new Promise((resolve) => {
    p.proc.once('exit', () => resolve());
    p.proc.kill('SIGKILL');
  });
}

/* ---------------- 等待工具 ---------------- */

function waitForEvent(client: WorldEngineClient, pred: (e: WireEvent) => boolean, timeoutMs = 6_000): Promise<WireEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`等待事件超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const unsub = client.onEvent((e) => {
      if (pred(e)) {
        clearTimeout(timer);
        unsub();
        resolve(e);
      }
    });
  });
}

function waitForStatus(client: WorldEngineClient, target: ConnectionStatus, timeoutMs = 8_000): Promise<ConnectionStatus> {
  if (client.status === target) return Promise.resolve(client.status);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`等待状态 ${target} 超时（当前 ${client.status}）`));
    }, timeoutMs);
    const unsub = client.onStatus((s) => {
      if (s === target) {
        clearTimeout(timer);
        unsub();
        resolve(s);
      }
    });
  });
}

/* ---------------- 用例 ---------------- */

describe('WorldEngineClient（独立引擎进程）', () => {
  const procs: EngineProc[] = [];
  const clients: WorldEngineClient[] = [];

  const startProc = async (port = 0): Promise<EngineProc> => {
    const p = await startEngineProc(port);
    procs.push(p);
    return p;
  };
  const makeClient = (p: EngineProc, over: Partial<ConstructorParameters<typeof WorldEngineClient>[0]> = {}): WorldEngineClient => {
    const c = new WorldEngineClient({
      baseUrl: p.url,
      worldId: p.worldId,
      reconnectBaseDelayMs: 50,
      reconnectMaxDelayMs: 200,
      ...over,
    });
    clients.push(c);
    return c;
  };

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    for (const p of procs) await killEngineProc(p);
    procs.length = 0;
  });

  it('① connect：概要 + 快照 + 上线', async () => {
    const p = await startProc();
    const client = makeClient(p);
    const { info, snapshot } = await client.connect();
    expect(info.worldId).toBe(p.worldId);
    expect(client.status).toBe('online');
    expect(snapshot.player.loc).toBe('plaza');
    expect(snapshot.npcs['milu']?.met).toBe(false);
    expect(snapshot.t).toBeGreaterThanOrEqual(0);
  });

  it('② sendIntent：travel 意图 → 引擎裁定 → player_moved 事实流回', async () => {
    const p = await startProc();
    const client = makeClient(p);
    await client.connect();

    const moved = waitForEvent(client, (e) => e.type === 'player_moved');
    const res = await client.sendIntent({ type: 'travel', target: 'tavern' });
    expect(res.ok).toBe(true);

    const e = await moved;
    expect(e.location).toBe('tavern');
    expect(e.actor).toBe('player');

    /* 世界确实变了（读引擎快照，不信本地） */
    const snap = await client.getState();
    expect(snap.player.loc).toBe('tavern');
  });

  it('②b sendIntent：wait → advance_time，时间由引擎推进', async () => {
    const p = await startProc();
    const client = makeClient(p);
    await client.connect();
    const before = (await client.getState()).t;

    const advanced = waitForEvent(client, (e) => e.type === 'time_advanced');
    const res = await client.sendIntent({ type: 'wait', ticks: 4 });
    expect(res.ok).toBe(true);
    await advanced;

    const after = (await client.getState()).t;
    expect(after).toBe(before + 4);
  });

  it('③ commandId 幂等：同键重复提交返回首次结果（duplicate）', async () => {
    const p = await startProc();
    const client = makeClient(p);
    await client.connect();

    const cmd = { type: 'advance_time', amount: 2, commandId: 'fixed-id-001' };
    const first = await client.sendCommand(cmd);
    expect(first.ok).toBe(true);

    const tAfterFirst = (await client.getState()).t;
    const second = await client.sendCommand(cmd);
    expect(second.duplicate).toBe(true);
    expect((await client.getState()).t).toBe(tAfterFirst);
  });

  it('④ 断线写拒绝：未连接时 sendIntent 抛 OfflineError（不回落本地）', async () => {
    const p = await startProc();
    const client = makeClient(p);
    await expect(client.sendIntent({ type: 'travel', target: 'tavern' })).rejects.toBeInstanceOf(
      WorldEngineOfflineError,
    );
    expect(client.status).toBe('idle');
  });

  it('⑤ 进程被杀：自动重连 + 事件补齐（REST/replay 双窗口 + id 幂等）', async () => {
    /* 固定端口：新进程要在原端口复活，客户端才知道去哪重连 */
    const port = 18_798 + Math.floor(Math.random() * 100);
    const p = await startProc(port);
    const client = makeClient(p);
    await client.connect();

    /* 杀引擎进程 → 客户端状态机进入 reconnecting（SIGKILL，无 close 帧） */
    await killEngineProc(p);
    procs.length = 0;
    await waitForStatus(client, 'reconnecting');

    /* 「停机期间世界继续演化」：新进程接同一端口，先推时间再走两步，
       产生客户端错过的历史事实 */
    const p2 = await startProc(port);
    {
      const bystander = makeClient(p2);
      await bystander.connect();
      await bystander.sendIntent({ type: 'wait', ticks: 2 });
      await bystander.sendIntent({ type: 'travel', target: 'tavern' });
      const missed = await bystander.getEvents(50);
      expect(missed.events.length).toBeGreaterThanOrEqual(2);
      bystander.close();
    }

    /* 客户端自动重连成功，并补齐错过的世界事实 */
    await waitForStatus(client, 'online', 10_000);
    const seen: WireEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('补齐超时：未收到 player_moved')), 10_000);
      const unsub = client.onEvent((e) => {
        seen.push(e);
        if (e.type === 'player_moved') {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });

    const types = seen.map((e) => e.type);
    expect(types).toContain('time_advanced');
    expect(types).toContain('player_moved');
    /* 幂等：同一条事实不会因 REST 补齐 + WS replay 重叠而投递两次 */
    const ids = seen.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('⑥ close 之后彻底停机：不再重连、读写被拒', async () => {
    const p = await startProc();
    const client = makeClient(p);
    await client.connect();
    client.close();
    expect(client.status).toBe('closed');
    await expect(client.sendIntent({ type: 'wait', ticks: 1 })).rejects.toBeInstanceOf(WorldEngineOfflineError);
    await expect(client.getState()).rejects.toBeInstanceOf(WorldEngineOfflineError);
  });
});

describe('intentToCommand（意图映射纯函数）', () => {
  it('方案 §4.2 的六类意图机械映射，不做本地裁定', () => {
    expect(intentToCommand({ type: 'travel', target: 'tavern' })).toEqual({ type: 'move', targetId: 'tavern' });
    expect(intentToCommand({ type: 'wait', ticks: 4.7 })).toEqual({ type: 'advance_time', amount: 4 });
    expect(intentToCommand({ type: 'talk', target: 'milu', text: '来杯麦酒' })).toEqual({
      type: 'talk',
      targetId: 'milu',
      text: '来杯麦酒',
    });
    expect(intentToCommand({ type: 'attack', target: 'wolf', amount: 3 })).toEqual({
      type: 'attack',
      targetId: 'wolf',
      amount: 3,
    });
    expect(intentToCommand({ type: 'setAttitude', target: 'milu', delta: 2 })).toEqual({
      type: 'set_attitude',
      targetId: 'milu',
      amount: 2,
    });
    expect(intentToCommand({ type: 'changeWeather', weather: '雨' })).toEqual({ type: 'change_weather', text: '雨' });
    expect(intentToCommand({ type: 'raw', command: { type: 'forge' } })).toEqual({ type: 'forge' });
  });
});

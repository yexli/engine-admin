/* ============================================================
   用量数据面单测（M2.2）：记录器（JSONL/轮转/停写）+ 纯查询 +
   server 层流式代记（时延只有传输层完整）
   ============================================================ */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore } from '../src/keys/keystore.ts';
import { ModelRouter } from '../src/router/modelrouter.ts';
import { createUsageRecorder } from '../src/usage/recorder.ts';
import { queryUsage } from '../src/usage/query.ts';
import type { UsageEntry } from '../src/usage/recorder.ts';
import { startPlatformServer } from '../src/http/server.ts';
import type { EngineClient, GatewayClient } from '../src/types.ts';

let dir: string;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  cleanups.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

function tmpPath(name: string): string {
  dir = mkdtempSync(join(tmpdir(), 'platform-usage-'));
  return join(dir, name);
}

const entry = (over: Partial<UsageEntry>): UsageEntry => ({
  ts: '2026-09-30T10:00:00.000Z',
  requestId: 'req-1',
  kind: 'chat',
  keyId: 'key-a',
  tenantId: 'default',
  method: 'POST',
  path: '/v1/chat/completions',
  status: 200,
  latencyMs: 120,
  ...over,
});

describe('用量记录器', () => {
  it('追加 → readAll 往返；flush 等待挂起写完成', async () => {
    const file = tmpPath('usage.jsonl');
    const rec = createUsageRecorder({ filePath: file });
    rec.record(entry({ requestId: 'r1' }));
    rec.record(entry({ requestId: 'r2', kind: 'worlds', path: '/v1/worlds' }));
    await rec.flush();
    const all = rec.readAll();
    expect(all.map((e) => e.requestId)).toEqual(['r1', 'r2']);
    expect(all[1]!.kind).toBe('worlds');
  });

  it('轮转：超阈值改名 .1（保留一代），readAll 两代都读', async () => {
    const file = tmpPath('usage.jsonl');
    const rec = createUsageRecorder({ filePath: file, rotateBytes: 10 });
    rec.record(entry({ requestId: 'old-1' }));
    await rec.flush();
    rec.record(entry({ requestId: 'old-2' }));
    await rec.flush();
    expect(existsSync(`${file}.1`)).toBe(true); /* 第二条写入前把 old-1 挤到 .1 */
    rec.record(entry({ requestId: 'new' }));
    await rec.flush();
    /* 第三条又把 old-2 挤到 .1（覆盖上一代）——只保留一代 */
    expect(rec.readAll().map((e) => e.requestId).sort()).toEqual(['new', 'old-2']);
  });

  it('写失败只报一次并停写，不拖垮调用方；坏行跳过不污染读', async () => {
    /* 用一个目录当文件路径 → append 必败 */
    const asDir = tmpPath('blocked-dir');
    mkdirSync(asDir, { recursive: true });
    const rec = createUsageRecorder({ filePath: asDir });
    rec.record(entry({ requestId: 'boom' }));
    await rec.flush();
    rec.record(entry({ requestId: 'boom-2' })); /* 已停写：不再抛/不再试 */
    await rec.flush();
    expect(readdirSync(asDir).length).toBe(0);

    /* 坏行跳过 */
    const file = tmpPath('partial.jsonl');
    writeFileSync(file, `${JSON.stringify(entry({ requestId: 'ok' }))}\n{broken\n`, 'utf8');
    const rec2 = createUsageRecorder({ filePath: file });
    expect(rec2.readAll().map((e) => e.requestId)).toEqual(['ok']);
  });
});

describe('用量查询（纯函数）', () => {
  const entries: UsageEntry[] = [
    entry({ ts: '2026-09-29T22:00:00.000Z', requestId: 'r1', worldId: 'w-main', capability: 'roleplay', model: 'world-agent', modelUsed: 'mdl-a', promptTokens: 100, completionTokens: 50, totalTokens: 150 }),
    entry({ ts: '2026-09-30T01:00:00.000Z', requestId: 'r2', worldId: 'w-main', capability: 'narrative', model: 'world-agent', modelUsed: 'mdl-b', promptTokens: 200, completionTokens: 100, totalTokens: 300 }),
    entry({ ts: '2026-09-30T02:00:00.000Z', requestId: 'r3', status: 502, error: 'upstream_error', model: 'mdl-a', route: 'proxy', worldId: null }),
    entry({ ts: '2026-09-30T03:00:00.000Z', requestId: 'r4', kind: 'worlds', method: 'GET', path: '/v1/worlds/w-2/state', worldId: 'w-2', status: 200 }),
  ];

  it('过滤：kind/status/model（含 modelUsed）/worldId', () => {
    expect(queryUsage(entries, { kind: 'chat' }).total).toBe(3);
    expect(queryUsage(entries, { status: 'error' }).total).toBe(1);
    expect(queryUsage(entries, { model: 'mdl-a' }).total).toBe(2); /* r1 的 modelUsed + r3 的 model */
    expect(queryUsage(entries, { worldId: 'w-2' }).total).toBe(1);
    expect(queryUsage(entries, { from: '2026-09-30T00:00:00.000Z' }).total).toBe(3);
    expect(queryUsage(entries, { capability: 'roleplay' }).total).toBe(1);
  });

  it('G3 · 游戏方维度：gameId 过滤（含平台钥匙）与 game 分组', () => {
    const gameEntries: UsageEntry[] = [
      entry({ requestId: 'g1', gameId: 'tianqiong', worldId: 'w-tq', totalTokens: 100 }),
      entry({ requestId: 'g2', gameId: 'tianqiong', worldId: 'w-tq', totalTokens: 50 }),
      entry({ requestId: 'g3', gameId: 'nova', worldId: 'w-nv', totalTokens: 70 }),
      entry({ requestId: 'g4' }), /* 平台钥匙：无 gameId */
    ];
    expect(queryUsage(gameEntries, { gameId: 'tianqiong' }).total).toBe(2);
    expect(queryUsage(gameEntries, { gameId: 'nova' }).summary.totalTokens).toBe(70);
    expect(queryUsage(gameEntries, { gameId: '' }).total).toBe(1); /* '' = 平台钥匙 */
    const byGame = queryUsage(gameEntries, { groupBy: 'game' });
    expect(byGame.groups!.map((g) => g.key)).toEqual(['tianqiong', 'nova', '(平台)']); /* 请求数降序，同数按键降序 */
    expect(byGame.groups!.find((g) => g.key === 'tianqiong')!.totalTokens).toBe(150);
  });

  it('汇总与分组：summary 覆盖全量过滤结果；group_by day/model', () => {
    const all = queryUsage(entries, { kind: 'chat' });
    expect(all.summary.requests).toBe(3);
    expect(all.summary.totalTokens).toBe(450);
    expect(all.summary.successRate).toBe(66.7);

    const byDay = queryUsage(entries, { groupBy: 'day' });
    expect(byDay.groups).toEqual([
      { key: '2026-09-30', requests: 3, totalTokens: 300, errors: 1 },
      { key: '2026-09-29', requests: 1, totalTokens: 150, errors: 0 },
    ]);

    const byModel = queryUsage(entries, { groupBy: 'model' });
    expect(byModel.groups!.find((g) => g.key === 'mdl-b')!.requests).toBe(1);
  });

  it('分页：ts 降序、pageSize 封顶、页码越界空页', () => {
    const p1 = queryUsage(entries, { page: 1, pageSize: 2 });
    expect(p1.total).toBe(4);
    expect(p1.list.map((e) => e.requestId)).toEqual(['r4', 'r3']);
    const capped = queryUsage(entries, { pageSize: 99999 });
    expect(capped.pageSize).toBe(500);
    expect(queryUsage(entries, { page: 9 }).list).toEqual([]);
  });
});

describe('server 层流式计量代记', () => {
  it('代理流泵完后由 server 记录（requestId 与 x-request-id 同源）', async () => {
    const file = tmpPath('usage-stream.jsonl');
    const usage = createUsageRecorder({ filePath: file });
    const keys = new KeyStore(join(dir, 'keys.json'));
    const { plaintext } = keys.create({ name: 'k', permissions: ['chat:completions'] });
    const gateway: GatewayClient = {
      chat: async () => ({ ok: true, text: 'x' }),
      proxyChat: async () => ({
        ok: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        stream: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"delta":1}'));
            c.close();
          },
        }),
      }),
    };
    const engine: EngineClient = {
      proxy: async () => ({ status: 200, body: {} }),
      getState: async () => ({ ok: false, status: 404, error: 'x' }),
      getEvents: async () => ({ ok: false, status: 404, error: 'x' }),
      executeCommand: async () => ({ ok: false, status: 404, error: 'x' }),
    };
    const server = await startPlatformServer({
      keys,
      engine,
      gateway,
      router: new ModelRouter(null),
      port: 0,
      accessLog: false,
      usage,
    });
    cleanups.push(() => void server.close());

    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ model: 'npc', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get('x-request-id')!;
    await res.text(); /* 泵完流 */
    await usage.flush();

    const all = usage.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.kind).toBe('chat');
    expect(all[0]!.route).toBe('proxy');
    expect(all[0]!.model).toBe('npc');
    expect(all[0]!.status).toBe(200);
    expect(all[0]!.requestId).toBe(requestId); /* 与访问日志对账键 */
    expect(typeof all[0]!.latencyMs).toBe('number');
  });
});

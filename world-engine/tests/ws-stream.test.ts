/* ============================================================
   G3 · WebSocket 事件流（1.2.0）—— 真实 socket 测试
   ------------------------------------------------------------
   · 握手：合法 upgrade → 101；非流式路径 → 404；
   · 鉴权：无钥匙 → 401；游戏方钥匙只见本方世界（越权 404）；
   · 单世界流：hello 信封 + 命令事实实时推送；
   · 全局流：多世界事件带 worldId 标签，游戏方钥匙只见本方；
   · replay：重连衔接最近 N 条历史。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { createWorldRegistry } from '../src/index';
import { startWorldServer } from '../src/http/index';

const AUTH = {
  keys: {
    'tq-key': { gameId: 'tianqiong', scopes: ['worlds:read', 'worlds:write'] },
    'admin-key': {},
  },
};

/* 原始 upgrade 探测：拿得到 HTTP 状态码（101/401/404） */
const upgradeProbe = (port: number, path: string, key?: string): Promise<number> =>
  new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...(key ? { 'x-api-key': key } : {}),
      },
    });
    req.on('upgrade', () => resolve(101));
    req.on('response', (r) => {
      r.resume();
      resolve(r.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
    req.end();
  });

interface WsClient {
  messages: { type: string; worldId?: string; event?: { id: string; type: string }; worlds?: string[] }[];
  waitFor(pred: (m: (typeof messages)[number]) => boolean, ms?: number): Promise<(typeof messages)[number]>;
  close(): Promise<void>;
}

function wsConnect(url: string): WsClient {
  const ws = new WebSocket(url);
  const messages: WsClient['messages'] = [];
  const waiters: { pred: (m: WsClient['messages'][number]) => boolean; resolve: (m: WsClient['messages'][number]) => void }[] = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    messages.push(m);
    const idx = waiters.findIndex((w) => w.pred(m));
    if (idx >= 0) waiters.splice(idx, 1)[0]!.resolve(m);
  };
  ws.onerror = () => {};
  return {
    messages,
    waitFor(pred, ms = 4000) {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws waitFor 超时')), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.onclose = () => resolve();
        ws.close();
      });
    },
  };
}

async function boot(): Promise<{ port: number; registry: ReturnType<typeof createWorldRegistry>; stop: () => Promise<void> }> {
  const registry = createWorldRegistry();
  const server = await startWorldServer({ registry, port: 0, auth: AUTH });
  return { port: server.port, registry, stop: server.close };
}

describe('G3 · WebSocket 事件流', () => {
  it('握手：合法 upgrade 101；非流式路径 404；无钥匙 401', async () => {
    const { port, stop } = await boot();
    try {
      expect(await upgradeProbe(port, '/v1/stream', 'admin-key')).toBe(101);
      expect(await upgradeProbe(port, '/v1/other/ws', 'admin-key')).toBe(404);
      expect(await upgradeProbe(port, '/v1/stream')).toBe(401);
      expect(await upgradeProbe(port, '/v1/worlds/w-x/events/stream', 'bogus')).toBe(401);
    } finally {
      await stop();
    }
  });

  it('单世界流：hello 后命令事实实时推送；越权世界流 404', async () => {
    const { port, registry, stop } = await boot();
    const created = registry.create({ worldId: 'w-tq' });
    created.emitEvent({ type: 'seed_fact', data: { n: 1 } });
    let client: WsClient | null = null;
    try {
      client = wsConnect(`ws://127.0.0.1:${port}/v1/worlds/w-tq/events/stream?key=admin-key`);
      const hello = await client.waitFor((m) => m.type === 'hello');
      expect(hello.worlds).toEqual(['w-tq']);

      created.emitEvent({ type: 'live_fact', data: { n: 2 } });
      const live = await client.waitFor((m) => m.event?.type === 'live_fact');
      expect(live.worldId).toBe('w-tq');
      expect(live.event!.id).toMatch(/^evt_/);

      expect(await upgradeProbe(port, '/v1/worlds/w-tq/events/stream?key=tq-key')).toBe(404); /* 无主世界对游戏方钥匙不存在 */
    } finally {
      if (client) await client.close();
      await stop();
    }
  });

  it('全局流：游戏方钥匙只见本方世界的事件；管理钥匙全见；replay 衔接历史', async () => {
    const { port, registry, stop } = await boot();
    const a = registry.create({ worldId: 'w-a' });
    const b = registry.create({ worldId: 'w-b' });
    const m = (w: ReturnType<typeof registry.create>, owner: string) => {
      const s = w.getState()!;
      s.metadata = { ...(s.metadata ?? {}), ownerGame: owner };
    };
    m(a, 'tianqiong');
    m(b, 'nova');
    a.emitEvent({ type: 'hist_a', data: {} });
    a.emitEvent({ type: 'hist_a2', data: {} });
    b.emitEvent({ type: 'hist_b', data: {} });

    const tq = wsConnect(`ws://127.0.0.1:${port}/v1/stream?key=tq-key&replay=10`);
    try {
      const hello = await tq.waitFor((x) => x.type === 'hello');
      expect(hello.worlds).toEqual(['w-a']);
      /* replay：本方历史两条都在，别家历史不在 */
      await tq.waitFor((x) => x.event?.type === 'hist_a2');
      expect(tq.messages.some((x) => x.event?.type === 'hist_a')).toBe(true);
      expect(tq.messages.some((x) => x.event?.type === 'hist_b')).toBe(false);

      a.emitEvent({ type: 'live_a', data: {} });
      const live = await tq.waitFor((x) => x.event?.type === 'live_a');
      expect(live.worldId).toBe('w-a');

      const admin = wsConnect(`ws://127.0.0.1:${port}/v1/stream?key=admin-key`);
      const ahello = await admin.waitFor((x) => x.type === 'hello');
      expect([...ahello.worlds!].sort()).toEqual(['w-a', 'w-b']);
      b.emitEvent({ type: 'live_b', data: {} });
      await admin.waitFor((x) => x.event?.type === 'live_b');
      await admin.close();
    } finally {
      await tq.close();
      await stop();
    }
  });
});

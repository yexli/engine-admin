/* ============================================================
   G3 · WebSocket 事件流（1.2.0 · 零依赖 RFC6455 最小实现）
   ------------------------------------------------------------
   替代轮询：客户端升级连接后，服务端把世界事实流实时推过来。

     GET（Upgrade） /v1/worlds/{id}/events/stream   单世界事实流
     GET（Upgrade） /v1/stream                      全部可见世界事实流

   设计纪律：
   · 零依赖——握手（SHA-1 accept）与帧编解码自实现，只支持本协议
     实际用到的最小子集：服务端→客户端文本帧单向推、ping/pong、
     close；客户端→服务端帧只消费控制语义，数据帧忽略；
   · 鉴权同 HTTP 面：x-api-key / Authorization Bearer 头，浏览器
     WebSocket 无自定义头，兼容 `?key=` 查询参数（仅流式端点）；
     游戏方钥匙只见 ownerGame 匹配的世界（与 HTTP 面一致）；
   · 推送信封：{type:'hello', worlds:[...]} → {type:'event',
     worldId, event}；断线重连用 ?replay=N 取最近 N 条做衔接，
     客户端按 event.id 幂等去重。
   ============================================================ */
import { createHash } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WorldHandle } from '../api/WorldAPI.ts';
import type { WorldRegistry } from '../api/WorldRegistry.ts';
import type { EngineWorldState } from '../types.ts';
import type { WorldAuthInit } from './protocol.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 心跳间隔与判死倍数：30s ping，90s 无任何 pong/消息判定断链 */
const PING_INTERVAL_MS = 30_000;
const DEAD_MULTIPLIER = 3;

export interface EventStreamOptions<W extends EngineWorldState = EngineWorldState> {
  /** 注册表模式：/v1/stream 的世界集合来源 */
  registry?: WorldRegistry<W> | null;
  /** 单世界模式兜底 */
  world?: WorldHandle<W> | null;
  /** 与 HTTP 面同一把钥匙表（缺省 = 不鉴权，仅本机使用形态） */
  auth?: WorldAuthInit;
}

/* ---------------- 帧编解码（服务端出站不掩码；入站按 RFC 必掩码） ---------------- */

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 解析缓冲区内的完整帧；返回 [帧, 剩余字节]。不完整返回 [null, buf] */
function decodeFrame(buf: Buffer): [Buffer | null, number, Buffer] {
  if (buf.length < 2) return [null, 0, buf];
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return [null, 0, buf];
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return [null, 0, buf];
    const big = buf.readBigUInt64BE(2);
    if (big > 16_777_216n) return [null, 0, buf]; /* 16MiB 上限，防 mem 炸弹 */
    len = Number(big);
    off = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return [null, 0, buf];
  let payload = buf.subarray(off + maskLen, off + maskLen + len);
  if (masked) {
    const mask = buf.subarray(off, off + 4);
    const copy = Buffer.from(payload);
    for (let i = 0; i < copy.length; i++) copy[i] = copy[i]! ^ mask[i % 4]!;
    payload = copy;
  }
  return [payload, opcode, buf.subarray(off + maskLen + len)];
}

/* ---------------- 连接与订阅管理 ---------------- */

interface StreamConn {
  socket: Duplex;
  unsubs: (() => void)[];
  rescan?: ReturnType<typeof setInterval>;
  pingTimer: ReturnType<typeof setInterval>;
  lastPong: number;
}

function sendText(conn: StreamConn, obj: unknown): void {
  if (conn.socket.destroyed) return;
  conn.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')));
}

/** 钥匙解析（HTTP 头优先，兼容浏览器 ?key=） */
function streamKeyOf(req: IncomingMessage, query: URLSearchParams): string | undefined {
  const h = req.headers;
  const x = h['x-api-key'];
  if (typeof x === 'string' && x) return x;
  const auth = h['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const bearer = auth.slice(7).trim();
    if (bearer) return bearer;
  }
  const q = query.get('key');
  return q && q.length <= 256 ? q : undefined;
}

/** 挂载到 node:http server 的 upgrade 事件（startWorldServer 调用）。
 *  返回 destroy()：主动拆掉全部流连接——server.close() 只等排空不主动断，
 *  有活跃流时必须先调它，否则优雅退出会挂死。 */
export function attachEventStream<W extends EngineWorldState = EngineWorldState>(
  server: HttpServer,
  opts: EventStreamOptions<W>,
): { destroy(): void } {
  const conns = new Set<StreamConn>();

  const visibleWorlds = (gameId: string | undefined): WorldHandle<W>[] => {
    const all: WorldHandle<W>[] = opts.registry ? opts.registry.list() : opts.world ? [opts.world] : [];
    const ownerOf = (w: WorldHandle<W>): string | undefined => {
      const m = w.getState()?.metadata as Record<string, unknown> | undefined;
      return typeof m?.['ownerGame'] === 'string' ? (m['ownerGame'] as string) : undefined;
    };
    return all.filter((w) => !gameId || ownerOf(w) === gameId);
  };

  const attachSubscriptions = (conn: StreamConn, worlds: WorldHandle<W>[], replay: number): void => {
    for (const unsub of conn.unsubs) unsub();
    conn.unsubs = [];
    if (replay > 0) {
      for (const w of worlds) {
        for (const ev of w.getEvents(replay).reverse()) {
          sendText(conn, { type: 'event', worldId: w.worldId, event: ev });
        }
      }
    }
    for (const w of worlds) {
      conn.unsubs.push(
        w.bus.on('*', (e) => {
          sendText(conn, { type: 'event', worldId: w.worldId, event: e });
        }),
      );
    }
    sendText(conn, { type: 'hello', worlds: worlds.map((w) => w.worldId) });
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const segments = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);

    /* 只接流式端点；其余 upgrade 一律拒绝（回 404 后断开） */
    const isGlobal = segments.length === 2 && segments[0] === 'v1' && segments[1] === 'stream';
    const isWorld =
      segments.length === 5 &&
      segments[0] === 'v1' &&
      segments[1] === 'worlds' &&
      segments[3] === 'events' &&
      segments[4] === 'stream';
    if (!isGlobal && !isWorld) {
      socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const wantKey = req.headers['sec-websocket-key'];
    if (!wantKey || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    /* 鉴权（与 HTTP 面同一张钥匙表） */
    let gameId: string | undefined;
    if (opts.auth) {
      const key = streamKeyOf(req, url.searchParams);
      const rec = key !== undefined ? opts.auth.keys[key] : undefined;
      if (!rec) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      gameId = rec.gameId;
    }

    /* 目标世界集合（越权世界直接不可见，与 HTTP 404 语义一致） */
    let targets: WorldHandle<W>[];
    if (isWorld) {
      const id = decodeURIComponent(segments[2]!);
      const w = opts.registry ? opts.registry.get(id) : opts.world?.worldId === id ? opts.world : null;
      if (!w) {
        socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const m = w.getState()?.metadata as Record<string, unknown> | undefined;
      const owner = typeof m?.['ownerGame'] === 'string' ? (m['ownerGame'] as string) : undefined;
      if (gameId && owner !== gameId) {
        socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      targets = [w];
    } else {
      targets = visibleWorlds(gameId);
    }

    /* 101 握手完成 */
    const accept = createHash('sha1').update(`${wantKey}${WS_GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'upgrade: websocket\r\n' +
        'connection: Upgrade\r\n' +
        `sec-websocket-accept: ${accept}\r\n\r\n`,
    );
    if (head.length) socket.unshift(head);

    const conn: StreamConn = {
      socket,
      unsubs: [],
      pingTimer: setInterval(() => {
        if (socket.destroyed) return;
        if (Date.now() - conn.lastPong > PING_INTERVAL_MS * DEAD_MULTIPLIER) {
          socket.destroy();
          return;
        }
        socket.write(encodeFrame(0x9, Buffer.alloc(0)));
      }, PING_INTERVAL_MS),
      lastPong: Date.now(),
    };
    conns.add(conn);
    socket.on('close', () => {
      clearInterval(conn.pingTimer);
      if (conn.rescan) clearInterval(conn.rescan);
      for (const unsub of conn.unsubs) unsub();
      conns.delete(conn);
    });
    socket.on('error', () => socket.destroy());

    /* 入站帧只消费控制语义：close → 回关；ping → pong；其余忽略 */
    let acc: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk]);
      for (;;) {
        const [payload, opcode, rest] = decodeFrame(acc);
        if (!payload) break;
        acc = rest;
        if (opcode === 0x8) {
          socket.write(encodeFrame(0x8, payload.subarray(0, 2)));
          socket.destroy();
          return;
        }
        if (opcode === 0x9) {
          conn.lastPong = Date.now();
          socket.write(encodeFrame(0xa, payload));
        }
        if (opcode === 0xa) conn.lastPong = Date.now();
      }
    });

    attachSubscriptions(conn, targets, Number(url.searchParams.get('replay') ?? 0) || 0);

    /* 全局流：后建的世界自动补挂（5s 重扫；单世界流无需） */
    if (isGlobal) {
      conn.rescan = setInterval(() => {
        if (socket.destroyed) return;
        attachSubscriptions(conn, visibleWorlds(gameId), 0);
      }, 5_000);
    }
  });

  return {
    destroy(): void {
      for (const conn of conns) {
        clearInterval(conn.pingTimer);
        if (conn.rescan) clearInterval(conn.rescan);
        for (const unsub of conn.unsubs) unsub();
        conn.socket.destroy();
      }
      conns.clear();
    },
  };
}

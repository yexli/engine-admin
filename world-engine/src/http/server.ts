/* ============================================================
   World HTTP Server（Node 传输层，V0.4）
   ------------------------------------------------------------
   startWorldServer = node:http 薄壳 + createWorldHttp 协议适配器。
   职责只有四件：收请求、解析 URL/JSON、交给协议适配器、序列化回包。
   业务全部在 World API（本文件零业务逻辑）。

   安全基线（方案 §3：本阶段不做鉴权/多租户）：
   · **默认只绑 127.0.0.1**——不做鉴权的端口绝不默认暴露到外网；
     要对外服务必须显式传 host: '0.0.0.0' 并自行加反代/鉴权。
   · 请求体上限 1 MiB，超限回 413；JSON 解析失败回 400。
   · 内部地址（127.0.0.1/localhost/环回）由 node:http 常规监听处理，
     不做任何向内或向外的代理转发。
   ============================================================ */
import { createServer, type Server } from 'node:http';
import type { CreateWorldOptions, WorldHandle } from '../api/WorldAPI.ts';
import type { WorldRegistry } from '../api/WorldRegistry.ts';
import type { EngineWorldState } from '../types.ts';
import { createWorldHttp, type WorldAuthInit } from './protocol.ts';
import { attachEventStream } from './ws.ts';

/** 请求体上限（字节）。超过即 413——引擎的存档/命令都是小载荷，1 MiB 富余 */
const MAX_BODY_BYTES = 1024 * 1024;

export interface WorldServerOptions<W extends EngineWorldState = EngineWorldState> {
  /** 预建世界（startWorldServer 之外由代码 createWorld / 接管已有世界） */
  world?: WorldHandle<W>;
  /** 不传 world 时，POST /v1/worlds 用这组参数创建 */
  createOptions?: CreateWorldOptions<W>;
  /** V0.9 注册表模式：多世界共存（POST /v1/worlds 不再 409；每世界独立作用域，DR-003 兑现） */
  registry?: WorldRegistry<W>;
  /** G2：API Key 鉴权（缺省关）。钥匙事实由接入方持有（平台 KeyStore 语义） */
  auth?: WorldAuthInit;
  /** G3：WebSocket 事件流（缺省开）。/v1/worlds/{id}/events/stream 与 /v1/stream */
  stream?: boolean;
  /** 监听端口；缺省 8787，测试传 0 取临时端口 */
  port?: number;
  /** 监听地址；**缺省 127.0.0.1（仅本机）**——无鉴权端口不默认外露 */
  host?: string;
}

export interface WorldServer {
  /** 实际监听端口（传 0 时为内核分配的临时端口） */
  readonly port: number;
  /** http://host:port 基地址 */
  readonly url: string;
  /** 关闭服务器（等待存量连接排空） */
  close(): Promise<void>;
}

export function startWorldServer<W extends EngineWorldState = EngineWorldState>(
  opts: WorldServerOptions<W> = {},
): Promise<WorldServer> {
  const http = createWorldHttp<W>({ world: opts.world, createOptions: opts.createOptions, registry: opts.registry, auth: opts.auth });
  const host = opts.host ?? '127.0.0.1';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', async () => {
      if (aborted) return;
      let body: unknown;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json' }));
          return;
        }
      }
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        query[k] = v;
      });
      /* 头名统一小写（G2 鉴权面只读 x-api-key / authorization） */
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }
      let out;
      try {
        out = await http.handle({ method: req.method ?? 'GET', path: url.pathname, query, headers, body });
      } catch (err) {
        /* 协议层之上的意外异常不裸奔：500 + 可读原因 */
        out = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });

  /* G3：WebSocket 事件流（缺省开；stream: false 显式关闭） */
  const streams = opts.stream !== false
    ? attachEventStream<W>(server, { registry: opts.registry ?? null, world: opts.world ?? null, auth: opts.auth })
    : null;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8787, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 8787);
      resolve({
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            /* 先拆流连接（close 只等排空不主动断，活跃流会让关闭挂死） */
            streams?.destroy();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

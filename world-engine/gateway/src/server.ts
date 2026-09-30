/* ============================================================
   网关服务器（Node 传输层，V0.5）
   ------------------------------------------------------------
   node:http 薄壳：收请求 → 解析 JSON → createGateway 协议适配器 →
   序列化回包；stream 请求走 SSE（text/event-stream）。

   安全基线与引擎 http 层同规（DR-003 精神）：
   · **默认只绑 127.0.0.1**——本阶段无鉴权（方案 §3），端口不默认外露；
     对外服务必须显式传 host 并自备反代/鉴权。
   · 请求体上限 1 MiB（→ 413）；JSON 解析失败 → 400。
   ============================================================ */
import { createServer, type Server } from 'node:http';
import type { GatewayProvider } from './provider.ts';
import { createGateway, sseFrame } from './protocol.ts';

const MAX_BODY_BYTES = 1024 * 1024;

export interface GatewayServerOptions {
  /** 启动即注册的提供方（之后可经 registry 继续注册） */
  providers?: GatewayProvider[];
  port?: number;
  /** **缺省 127.0.0.1（仅本机）** */
  host?: string;
}

export interface GatewayServer {
  readonly port: number;
  readonly url: string;
  /** 动态注册提供方（提供方可热插：注册即出现在 /v1/models） */
  register(provider: GatewayProvider): void;
  close(): Promise<void>;
}

export function startGatewayServer(opts: GatewayServerOptions = {}): Promise<GatewayServer> {
  const gateway = createGateway();
  for (const p of opts.providers ?? []) gateway.registry.register(p);

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
        res.end(JSON.stringify({ error: { message: 'payload too large' } }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (aborted) return;
      let body: unknown;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid json' } }));
          return;
        }
      }

      const wantsStream =
        url.pathname.replace(/\/+$/, '') === '/v1/chat/completions' &&
        (body as { stream?: boolean } | undefined)?.stream === true;

      if (wantsStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        gateway
          .handle({ method: req.method ?? 'GET', path: url.pathname, body }, {
            send: (frameText) => res.write(sseFrame(frameText)),
            end: () => {
              res.write(sseFrame('[DONE]'));
              res.end();
            },
          })
          .then((out) => {
            /* 流式路径的返回值只反映「流已正常驱动」；若适配器要求直接回 JSON
               （缺流通道的 500），说明调用方没给 io——此处不会发生，兜底序列化。 */
            if (!res.writableEnded && out.status !== 200) {
              res.writeHead(out.status, { 'content-type': 'application/json' });
              res.end(JSON.stringify(out.body));
            }
          })
          .catch(() => {
            if (!res.writableEnded) {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: { message: 'gateway failure' } }));
            }
          });
        return;
      }

      gateway
        .handle({ method: req.method ?? 'GET', path: url.pathname, body })
        .then((out) => {
          res.writeHead(out.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.body));
        })
        .catch(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'gateway failure' } }));
        });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8788, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 8788);
      resolve({
        port,
        url: `http://${opts.host ?? '127.0.0.1'}:${port}`,
        register: (p) => gateway.registry.register(p),
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

/* ============================================================
   Memory HTTP Server（Node 传输层，M1.1 · G7）
   ------------------------------------------------------------
   startMemoryServer = node:http 薄壳 + createMemoryHttp 协议适配器。
   职责只有四件：收请求、解析 URL/JSON、交给协议适配器、序列化回包。
   业务全部在 MemoryEngine（本文件零业务逻辑）。

   安全基线（同引擎 server.ts）：
   · 默认只绑 127.0.0.1——不做鉴权的端口绝不默认暴露到外网；
   · 请求体上限 256 KiB（检索查询是小载荷），超限回 413；
     JSON 解析失败回 400。
   ============================================================ */
import { createServer, type Server } from 'node:http';
import { createMemoryHttp, type MemoryHttpInit } from './protocol.ts';

const MAX_BODY_BYTES = 256 * 1024;

export interface MemoryServerOptions extends Partial<MemoryHttpInit> {
  /** 监听端口；缺省 8789，测试传 0 取临时端口 */
  port?: number;
  /** 监听地址；**缺省 127.0.0.1（仅本机）** */
  host?: string;
}

export interface MemoryServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export function startMemoryServer(opts: MemoryServerOptions = {}): Promise<MemoryServer> {
  const http = createMemoryHttp({ stores: opts.stores ?? [] });
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
      let out;
      try {
        out = await http.handle({ method: req.method ?? 'GET', path: url.pathname, query, body });
      } catch (err) {
        out = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8789, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 8789);
      resolve({
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

/* ============================================================
   World Platform 服务器（Node 传输层，Phase 1）
   ------------------------------------------------------------
   node:http 薄壳：收请求 → 解析 → 纯协议适配器 → 序列化/透传。
   与 engine/gateway 同规：
   · 默认只绑 127.0.0.1（公共部署必须显式 host + 反代/TLS）；
   · 请求体上限 2 MiB（chat 消息可能大于引擎的 1 MiB 约定）；
   · 每请求生成 x-request-id 并回传，访问日志一行一条（Phase 9/12
     可观测性的最小种子）。
   ============================================================ */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { KeyStore } from '../keys/keystore.ts';
import type { EngineClient, GatewayClient, StreamResponse } from '../types.ts';
import type { ModelRouter } from '../router/modelrouter.ts';
import type { UsageSink } from '../usage/recorder.ts';
import { createWorldPlatform } from './protocol.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface PlatformServerOptions {
  keys: KeyStore;
  engine: EngineClient;
  gateway: GatewayClient;
  router: ModelRouter;
  version?: string;
  port?: number;
  /** **缺省 127.0.0.1（仅本机）**——公共部署必须显式传 host */
  host?: string;
  /** 访问日志（默认开启；测试可关） */
  accessLog?: boolean;
  /**
   * 结构化用量记录（M2.2；缺省不计量）。JSON 路径由协议层记，
   * 流式透传在泵完/中断时由本层代记（时延只有这里完整）。
   */
  usage?: UsageSink;
  /**
   * CORS 允许来源（默认 '*'）。
   * 安全说明：本 API 用 Bearer 头鉴权而非 Cookie，浏览器不会跨站自动携带
   * 凭据，`*` 不构成 CSRF 面；但浏览器端 JS 若持有 Key 仍可调用——与
   * 任何持有 Key 的非浏览器客户端等价。公共部署建议收紧为具体来源列表。
   */
  corsAllowOrigin?: string;
}

export interface PlatformServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export function startPlatformServer(opts: PlatformServerOptions): Promise<PlatformServer> {
  const platform = createWorldPlatform({
    keys: opts.keys,
    engine: opts.engine,
    gateway: opts.gateway,
    router: opts.router,
    version: opts.version,
    usage: opts.usage,
  });
  const accessLog = opts.accessLog ?? true;

  /** 流式透传的计量：泵完/中断时才有时延，协议层把 key/model 挂在 usageMeta 上 */
  function recordStreamUsage(
    out: StreamResponse,
    method: string | undefined,
    pathname: string,
    requestId: string,
    startedAt: number,
    error: string | null,
  ): void {
    if (!opts.usage || !out.usageMeta) return;
    opts.usage.record({
      ts: new Date().toISOString(),
      requestId,
      kind: 'chat',
      keyId: out.usageMeta.keyId,
      tenantId: out.usageMeta.tenantId,
      method: method ?? 'GET',
      path: pathname,
      status: out.status,
      latencyMs: Date.now() - startedAt,
      model: out.usageMeta.model,
      route: 'proxy',
      ...(error ? { error } : {}),
    });
  }

  const server: Server = createServer((req, res) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    /* 公共 API：统一 CORS 头（来源可配置收紧，见 PlatformServerOptions） */
    res.setHeader('access-control-allow-origin', opts.corsAllowOrigin ?? '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('x-request-id', requestId);

    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'payload too large', type: 'invalid_request_error' } }));
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
          res.end(JSON.stringify({ error: { message: 'invalid json', type: 'invalid_request_error' } }));
          logLine(accessLog, req.method, url.pathname, requestId, 400, startedAt);
          return;
        }
      }
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        query[k] = v;
      });

      platform
        .handle({
          method: req.method ?? 'GET',
          path: url.pathname,
          query,
          body,
          headers: req.headers as Record<string, string | string[] | undefined>,
          requestId,
        })
        .then((out) => {
          if (out.kind === 'json') {
            res.writeHead(out.status, { 'content-type': 'application/json' });
            res.end(out.body === undefined || out.body === null ? '' : JSON.stringify(out.body));
            logLine(accessLog, req.method, url.pathname, requestId, out.status, startedAt);
          } else {
            res.writeHead(out.status, out.headers);
            const reader = out.body.getReader();
            const pump = (): Promise<void> =>
              reader.read().then(({ done, value }) => {
                if (done) {
                  res.end();
                  logLine(accessLog, req.method, url.pathname, requestId, out.status, startedAt);
                  recordStreamUsage(out, req.method, url.pathname, requestId, startedAt, null);
                  return;
                }
                res.write(Buffer.from(value));
                return pump();
              });
            pump().catch((err) => {
              res.end();
              recordStreamUsage(out, req.method, url.pathname, requestId, startedAt, `stream_aborted: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        })
        .catch((err) => {
          if (!res.writableEnded) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err), type: 'internal_error' } }));
          }
          logLine(accessLog, req.method, url.pathname, requestId, 500, startedAt);
        });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8790, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 8790);
      resolve({
        port,
        url: `http://${opts.host ?? '127.0.0.1'}:${port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

function logLine(
  enabled: boolean,
  method: string | undefined,
  path: string,
  requestId: string,
  status: number,
  startedAt: number,
): void {
  if (!enabled) return;
  console.log(
    `[platform] ${new Date().toISOString()} ${method ?? '-'} ${path} -> ${status} ${Date.now() - startedAt}ms ${requestId}`,
  );
}

/* ============================================================
   World Engine HTTP 客户端（Phase 1 · 平台 → 引擎）
   ------------------------------------------------------------
   平台是引擎的「唯一公共门面」：worlds 系列请求鉴权后原样透传
   （引擎是权威实现，平台不复制业务）；world-agent 管线用两个类型化
   读取（state / events）组装世界上下文。
   超时 10s；网络错误统一转 { ok:false, status:502 }。
   ============================================================ */
import type { EngineClient } from '../types.ts';

interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export interface EngineClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export function createEngineClient(opts: EngineClientOptions): EngineClient {
  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function request(
    method: string,
    pathWithQuery: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${pathWithQuery}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { error: 'upstream returned non-json' };
      }
      return { status: res.status, body: parsed };
    } catch (err) {
      return {
        status: 502,
        body: { error: { message: `World Engine 不可达：${err instanceof Error ? err.message : String(err)}`, type: 'upstream_error' } },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    proxy: (method, pathWithQuery, body) => request(method, pathWithQuery, body),

    async getState(worldId) {
      const res = await request('GET', `/v1/worlds/${encodeURIComponent(worldId)}/state`);
      if (res.status !== 200) {
        return { ok: false, status: res.status, error: describe(res.body, '世界状态读取失败') };
      }
      return { ok: true, state: res.body };
    },

    async getEvents(worldId, n) {
      const res = await request('GET', `/v1/worlds/${encodeURIComponent(worldId)}/events?n=${n}`);
      if (res.status !== 200) {
        return { ok: false, status: res.status, error: describe(res.body, '世界事件读取失败') };
      }
      const events = (res.body as { events?: unknown[] } | null)?.events ?? [];
      return { ok: true, events };
    },
  };
}

function describe(body: unknown, fallback: string): string {
  const e = body as { error?: { message?: string } | string } | null;
  if (e && typeof e === 'object' && e.error) {
    return typeof e.error === 'string' ? e.error : (e.error.message ?? fallback);
  }
  return fallback;
}

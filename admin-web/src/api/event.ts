/** Event 查询客户端：世界事实来自引擎真实 API；平台级事件流为 Mock */
import { http } from "@/utils/http";
import type { WorldEvent } from "./types";

export type { WorldEvent };

/** 引擎世界事实（GET /v1/worlds/{id}/events，倒序） */
export const listWorldEvents = (worldId: string, n = 100) => {
  return http.request<{ events: WorldEvent[] }>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/events`,
    { params: { n } }
  );
};

/** 平台级事件流（Mock；真实化见 ADMIN-API-GAP.md） */
export const listPlatformEvents = (params?: Record<string, unknown>) => {
  return http.request<{ success: boolean; data: PageResult<EventStreamRow> }>(
    "get",
    "/admin-api/observability/events",
    { params }
  );
};

export interface EventStreamRow {
  id: string;
  time: string;
  type: string;
  worldId: string;
  actor: string | null;
  target: string | null;
  level: number;
  status: string;
}

/** 引擎因果链向上追溯（前端遍历：事件含 parent/rootCause 字段） */
export function buildCausalChain(
  events: WorldEvent[],
  eventId: string
): WorldEvent[] {
  const byId = new Map(events.map(e => [e.id, e]));
  const chain: WorldEvent[] = [];
  let cur = byId.get(eventId);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.push(cur);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return chain;
}

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

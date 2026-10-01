/** Event 查询客户端（M4.1 起全部真实）：世界事实来自引擎；平台级事件流 = 管理监听
 *  /v1/obs/events 跨世界只读聚合。诚实边界：世界事件只有世界历时间（day/tick），
 *  没有墙钟时间——事件流按「第 N 天 · 场景时刻」排序展示，不编造时刻。
 */
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
}

/** 平台级事件流（M4.1：跨世界聚合，worldId 标注，day/tick 降序） */
export interface EventStreamRow extends WorldEvent {
  worldId: string;
}

export interface EventStreamResult {
  worlds: string[];
  total: number;
  events: EventStreamRow[];
}

export const listPlatformEvents = (params?: Record<string, unknown>) => {
  return http.request<EventStreamResult>(
    "get",
    "/control-api/v1/obs/events",
    { params }
  );
};

/** 引擎因果链向上追溯（前端遍历：事件含 parentId/sourceId/cause 字段，M4.3 修正字段名） */
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
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

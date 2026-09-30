/** Runtime 观察客户端：从引擎真实 API 派生运行时视图
 *  Scheduler 事件队列、暂停/恢复等控制面暂无引擎 API（见 docs/ADMIN-API-GAP.md）
 */
import { http } from "@/utils/http";
import type { CommandResult, EngineWorldState, WorldEvent } from "./types";

/** 运行时总览（从 state + events 派生） */
export interface RuntimeSummary {
  worldId: string;
  tick: number;
  weather: string;
  entityCount: number;
  locationCount: number;
  relationCount: number;
  eventCount: number;
  logSeq: number;
  ver: number;
  seed?: number;
  lastEvents: WorldEvent[];
}

export async function getRuntimeSummary(
  worldId: string,
  eventN = 30
): Promise<RuntimeSummary> {
  const state = await http.request<EngineWorldState>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/state`
  );
  const { events } = await http.request<{ events: WorldEvent[] }>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/events`,
    { params: { n: eventN } }
  );
  return {
    worldId,
    tick: state.t,
    weather: state.weather,
    entityCount: Object.keys(state.npcs ?? {}).length + 1,
    locationCount: Object.keys(state.locations ?? {}).length,
    relationCount:
      (state.relations?.length ?? 0) +
      Object.values(state.npcs ?? {}).reduce(
        (s, n) => s + Object.keys(n.rels ?? {}).length,
        0
      ),
    eventCount: state.events?.length ?? 0,
    logSeq: state.logSeq ?? 0,
    ver: state.ver,
    seed: state.seed,
    lastEvents: events
  };
}

/** 推进时间（Runtime Monitor 的快捷操作） */
export const advanceTime = (worldId: string, ticks: number) => {
  return http.request<CommandResult>(
    "post",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/time`,
    { data: { ticks } }
  );
};

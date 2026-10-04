/** Runtime 观察客户端：从引擎真实 API 派生运行时视图
 *  M1.2 起调度观测接真（GET /v1/worlds/{id}/scheduler）；
 *  暂停/恢复/关闭控制面已接引擎 API（api/world.ts pause/resume/closeWorld）
 */
import { http } from "@/utils/http";
import type {
  CommandResult,
  EngineWorldState,
  SchedulerView,
  WorldEvent
} from "./types";

export type { SchedulerView };

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

/** 调度观测：bus 统计 + 定时 / 延后 / 死信事件（真实只读面） */
export const getSchedulerView = (worldId: string, n = 50) => {
  return http.request<SchedulerView>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/scheduler`,
    { params: { n } }
  );
};

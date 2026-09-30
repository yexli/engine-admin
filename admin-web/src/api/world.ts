/** World Engine 真实 HTTP API 客户端（vite 代理 /world-api → 引擎 8787）
 *  路由契约：world-engine/src/http/protocol.ts
 */
import { http } from "@/utils/http";
import type {
  CommandResult,
  EngineWorldState,
  WorldCommand,
  WorldEvent,
  WorldInfo
} from "./types";

/** 世界清单 */
export const getWorlds = () => {
  return http.request<{ worlds: WorldInfo[] }>("get", "/world-api/v1/worlds");
};

/** 单个世界信息 */
export const getWorld = (worldId: string) => {
  return http.request<WorldInfo>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}`
  );
};

/** 创建世界（registry 模式必传 worldId） */
export const createWorld = (data: CreateWorldPayload) => {
  return http.request<WorldInfo>("post", "/world-api/v1/worlds", { data });
};

export interface CreateWorldPayload {
  worldId: string;
  playerName?: string;
  startLoc?: string;
  weather?: string;
  labels?: {
    months?: string[];
    shichen?: string[];
    periodOf?: string[];
    baseYear?: number;
    daysPerMonth?: number;
  };
}

/** 完整世界状态 */
export const getWorldState = (worldId: string) => {
  return http.request<EngineWorldState>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/state`
  );
};

/** 最近世界事实（n 上限由引擎侧决定） */
export const getWorldEvents = (worldId: string, n = 50) => {
  return http.request<{ events: WorldEvent[] }>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/events`,
    { params: { n } }
  );
};

/** 提交命令（命令载荷契约：一层基本类型） */
export const executeWorldCommand = (worldId: string, cmd: WorldCommand) => {
  return http.request<CommandResult>(
    "post",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/commands`,
    { data: cmd }
  );
};

/** 推进时间 */
export const advanceWorldTime = (worldId: string, ticks: number) => {
  return http.request<CommandResult>(
    "post",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/time`,
    { data: { ticks } }
  );
};

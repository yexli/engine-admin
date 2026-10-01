/** World Engine 真实 HTTP API 客户端（vite 代理 /world-api → 引擎 8787）
 *  路由契约：world-engine/src/http/protocol.ts
 */
import { http } from "@/utils/http";
import type {
  CommandHistoryEntry,
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
  /** 世界元数据（M1.5：经 definition.metadata 挂载，随存档持久化） */
  name?: string;
  description?: string;
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

/** 最近命令历史（新 → 旧；Runtime 侧环形缓冲） */
export const getCommandHistory = (worldId: string, n = 50) => {
  return http.request<{ total: number; commands: CommandHistoryEntry[] }>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/commands`,
    { params: { n } }
  );
};

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

/* ---------- 生命周期（引擎 1.0.3 · G1 软暂停；语义见 docs/G1-PAUSE-DESIGN-REVIEW.md） ---------- */

/** 暂停：拒绝命令/时间推进，读操作不受影响；重复暂停 409 */
export const pauseWorld = (worldId: string) => {
  return http.request<WorldInfo>(
    "post",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/pause`
  );
};

/** 恢复；未暂停时 409 */
export const resumeWorld = (worldId: string) => {
  return http.request<WorldInfo>(
    "post",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/resume`
  );
};

/** 关闭：注册表摘除（不可逆；关闭后的世界一切访问 404） */
export const closeWorld = (worldId: string) => {
  return http.request<{ closed: boolean; worldId: string }>(
    "delete",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}`
  );
};


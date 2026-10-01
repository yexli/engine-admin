/** Location 管理客户端
 *  M1.3 起接真实独立端点（服务端派生驻留统计与完整性告警，
 *  替代前端全量派生）。端点契约：world-engine/src/http/protocol.ts
 */
import { http } from "@/utils/http";
import type { LocationRecord } from "./types";

export interface LocationView extends LocationRecord {
  entityCount: number;
  /** 停留在此的实体（含玩家） */
  occupants: string[];
}

export interface LocationListResult {
  total: number;
  page: number;
  pageSize: number;
  locations: LocationView[];
  /** 出现在实体档案但不在地点表中的位置 id（数据完整性观察） */
  unknown: string[];
}

export async function listLocations(
  worldId: string,
  params?: { q?: string; page?: number; pageSize?: number }
): Promise<LocationListResult> {
  return http.request<LocationListResult>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/locations`,
    {
      params: {
        ...(params?.q ? { q: params.q } : {}),
        ...(params?.page ? { page: params.page } : {}),
        ...(params?.pageSize ? { pageSize: params.pageSize } : {})
      }
    }
  );
}

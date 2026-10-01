/** Relation 管理客户端
 *  M1.3 起接真实独立端点（状态关系表 + 实体关系边双视图，服务端筛选分页）；
 *  前端不把 Relation 固定理解为“好感度”。端点契约：world-engine/src/http/protocol.ts
 */
import { http } from "@/utils/http";
import type { RelationRecord } from "./types";

export type { RelationRecord };

export interface RelationListResult {
  totals: { state: number; edges: number };
  page: number;
  pageSize: number;
  stateRelations: RelationRecord[];
  edgeRelations: RelationRecord[];
}

export async function listRelations(
  worldId: string,
  params?: { q?: string; page?: number; pageSize?: number }
): Promise<RelationListResult> {
  return http.request<RelationListResult>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/relations`,
    {
      params: {
        ...(params?.q ? { q: params.q } : {}),
        ...(params?.page ? { page: params.page } : {}),
        ...(params?.pageSize ? { pageSize: params.pageSize } : {})
      }
    }
  );
}

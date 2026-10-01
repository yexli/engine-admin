/** Entity 管理客户端
 *  M1.3 起接真实独立端点（服务端分页/筛选/详情，替代前端全量派生，
 *  解决已知问题 #3）；修改必须走 Command/Mutation（见 api/command.ts）。
 *  端点契约：world-engine/src/http/protocol.ts
 */
import { http } from "@/utils/http";
import type { EngineWorldState, EntityDynamic } from "./types";

/** 管理后台实体视图（服务端派生字段） */
export interface EntityView {
  id: string;
  type: string;
  att: number;
  met: boolean;
  location: string;
  gold?: number;
  bagCount: number;
  relCount: number;
  effectCount: number;
  memCount: number;
  attributes?: Record<string, unknown>;
}

export interface EntityListResult {
  total: number;
  page: number;
  pageSize: number;
  player: { name: string; loc: string; bagCount: number } | null;
  entities: EntityView[];
}

/** 实体列表（服务端分页 + 筛选；世界变大后不再全量拉 state） */
export async function listEntities(
  worldId: string,
  params?: { q?: string; type?: string; page?: number; pageSize?: number }
): Promise<EntityListResult> {
  return http.request<EntityListResult>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/entities`,
    {
      params: {
        ...(params?.q ? { q: params.q } : {}),
        ...(params?.type ? { type: params.type } : {}),
        ...(params?.page ? { page: params.page } : {}),
        ...(params?.pageSize ? { pageSize: params.pageSize } : {})
      }
    }
  );
}

export interface RelationView {
  source: string;
  target: string;
  type: string;
  value?: number;
}

/** 单实体详情（真实端点；关系来自实体的 rels 邻接表） */
export async function getEntity(
  worldId: string,
  entityId: string
): Promise<{ entity: EntityView & { raw: EntityDynamic }; relations: RelationView[] } | null> {
  try {
    return await http.request<{
      entity: EntityView & { raw: EntityDynamic };
      relations: RelationView[];
    }>(
      "get",
      `/world-api/v1/worlds/${encodeURIComponent(worldId)}/entities/${encodeURIComponent(entityId)}`
    );
  } catch (e) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 404) return null;
    throw e;
  }
}

export type { EngineWorldState };

/** Entity 管理客户端
 *  引擎 V1.0 无独立实体查询端点；实体视图从世界状态（GET /state）派生。
 *  修改必须走 Command/Mutation（见 api/command.ts），禁止直接写状态。
 *  独立分页/筛选端点缺口记录于 docs/ADMIN-API-GAP.md
 */
import { http } from "@/utils/http";
import type { EngineWorldState, EntityDynamic } from "./types";

/** 管理后台实体视图（含派生字段） */
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
  raw: EntityDynamic;
}

/** 拉取世界状态并派生实体列表（player 单列；npcs 为主列表） */
export async function listEntities(worldId: string): Promise<{
  entities: EntityView[];
  player: EngineWorldState["player"] | null;
}> {
  const state = await http.request<EngineWorldState>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/state`
  );
  const entities: EntityView[] = Object.entries(state.npcs ?? {}).map(
    ([id, n]) => ({
      id,
      type: n.type ?? "npc",
      att: n.att,
      met: n.met,
      location: deriveLocation(state, id),
      gold: n.gold,
      bagCount: n.bag?.length ?? 0,
      relCount: Object.keys(n.rels ?? {}).length,
      effectCount: n.effects?.length ?? 0,
      memCount: n.mem?.length ?? 0,
      raw: n
    })
  );
  return { entities, player: state.player ?? null };
}

/** 从状态推导实体位置：优先世界级 location 覆盖（引擎仅持有最小档案） */
function deriveLocation(state: EngineWorldState, entityId: string): string {
  const attrLoc = state.npcs?.[entityId]?.attributes?.["location"];
  if (typeof attrLoc === "string") return attrLoc;
  return state.player?.loc ?? "—";
}

/** 单实体详情（从状态派生；关系来自实体的 rels 邻接表） */
export async function getEntity(
  worldId: string,
  entityId: string
): Promise<{ entity: EntityView; relations: RelationView[] } | null> {
  const { entities } = await listEntities(worldId);
  const entity = entities.find(e => e.id === entityId);
  if (!entity) return null;
  const relations: RelationView[] = [];
  for (const [other, edges] of Object.entries(entity.raw.rels ?? {})) {
    for (const edge of Array.isArray(edges) ? edges : []) {
      relations.push({
        source: entityId,
        target: other,
        type: edge.type,
        value: edge.val
      });
    }
  }
  return { entity, relations };
}

export interface RelationView {
  source: string;
  target: string;
  type: string;
  value?: number;
}

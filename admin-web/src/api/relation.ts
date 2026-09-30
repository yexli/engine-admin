/** Relation 管理客户端（从世界状态派生；前端不把 Relation 固定理解为“好感度”） */
import { http } from "@/utils/http";
import type { EngineWorldState, RelationRecord } from "./types";

export type { RelationRecord };

export async function listRelations(worldId: string): Promise<{
  stateRelations: RelationRecord[];
  edgeRelations: RelationRecord[];
}> {
  const state = await http.request<EngineWorldState>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/state`
  );
  const stateRelations = state.relations ?? [];
  // 实体动态里的 rels 邻接表（otherId → 边）展开为统一视图
  const edgeRelations: RelationRecord[] = [];
  for (const [owner, npc] of Object.entries(state.npcs ?? {})) {
    for (const [other, edges] of Object.entries(npc.rels ?? {})) {
      for (const edge of Array.isArray(edges) ? edges : []) {
        edgeRelations.push({
          source: owner,
          target: other,
          type: edge.type,
          value: edge.val
        });
      }
    }
  }
  return { stateRelations, edgeRelations };
}

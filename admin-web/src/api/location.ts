/** Location 管理客户端（从世界状态派生；独立端点缺口见 docs/ADMIN-API-GAP.md） */
import { http } from "@/utils/http";
import type { EngineWorldState, LocationRecord } from "./types";

export interface LocationView extends LocationRecord {
  entityCount: number;
  /** 停留在此的实体（含玩家） */
  occupants: string[];
}

export async function listLocations(worldId: string): Promise<{
  locations: LocationView[];
  unknown: string[];
}> {
  const state = await http.request<EngineWorldState>(
    "get",
    `/world-api/v1/worlds/${encodeURIComponent(worldId)}/state`
  );
  const occupants = new Map<string, string[]>();
  const push = (loc: string | null | undefined, who: string) => {
    if (!loc) return;
    const arr = occupants.get(loc) ?? [];
    arr.push(who);
    occupants.set(loc, arr);
  };
  push(state.player?.loc, `player:${state.player?.name ?? "player"}`);
  for (const [id, n] of Object.entries(state.npcs ?? {})) {
    push(
      (typeof n.attributes?.["location"] === "string"
        ? (n.attributes["location"] as string)
        : state.player?.loc) as string,
      id
    );
  }
  const locations: LocationView[] = Object.entries(state.locations ?? {}).map(
    ([id, rec]) => ({
      ...rec,
      id,
      entityCount: occupants.get(id)?.length ?? 0,
      occupants: occupants.get(id) ?? []
    })
  );
  // 出现在实体档案但不在地点表中的位置 id（数据完整性观察用）
  const known = new Set(locations.map(l => l.id));
  const unknown = [...occupants.keys()].filter(k => !known.has(k));
  return { locations, unknown };
}

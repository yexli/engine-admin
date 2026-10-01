/** G2 · 游戏方聚合视图（多游戏托管）
 *  数据来源两路，前端按方归组：
 *  · 世界：/world-api/v1/worlds（ownerGame 元数据，引擎 1.1.0）
 *  · 钥匙：/control-api/v1/admin/keys（gameId 字段）
 *  无 ownerGame 的世界 / 无 gameId 的钥匙 → 平台托管桶。
 */
import { http } from "@/utils/http";
import type { WorldInfo } from "./types";
import { listApiKeys, type ApiKeyRow } from "./apiKey";

/** 平台托管桶（未归属世界 / 平台管理钥匙） */
export const PLATFORM_BUCKET = "__platform__";

export interface GameRow {
  gameId: string;
  worldCount: number;
  running: number;
  paused: number;
  entityCount: number;
  /** worlds.updatedAt 最新值（诚实语义：最近一次成功的世界推进） */
  lastActiveAt: string | null;
  worlds: WorldInfo[];
  keys: ApiKeyRow[];
}

export async function getGameAggregates(): Promise<GameRow[]> {
  const [worldsRes, keysRes] = await Promise.all([
    http.request<{ worlds: WorldInfo[] }>("get", "/world-api/v1/worlds"),
    listApiKeys({ page: 1, page_size: 200 })
  ]);
  const worlds = worldsRes?.worlds ?? [];
  const keys = keysRes?.list ?? [];

  const map = new Map<string, GameRow>();
  const bucket = (id: string): GameRow => {
    let row = map.get(id);
    if (!row) {
      row = {
        gameId: id,
        worldCount: 0,
        running: 0,
        paused: 0,
        entityCount: 0,
        lastActiveAt: null,
        worlds: [],
        keys: []
      };
      map.set(id, row);
    }
    return row;
  };

  for (const w of worlds) {
    const row = bucket(w.ownerGame ?? PLATFORM_BUCKET);
    row.worldCount++;
    if (w.status === "paused") row.paused++;
    else row.running++;
    row.entityCount += w.entities ?? 0;
    row.worlds.push(w);
    const t = w.updatedAt ?? w.createdAt;
    if (t && (!row.lastActiveAt || t > row.lastActiveAt)) row.lastActiveAt = t;
  }
  for (const k of keys) bucket(k.gameId ?? PLATFORM_BUCKET).keys.push(k);

  /* 游戏方在前（按世界数），平台桶殿后 */
  return [...map.values()].sort((a, b) =>
    a.gameId === PLATFORM_BUCKET
      ? 1
      : b.gameId === PLATFORM_BUCKET
        ? -1
        : b.worldCount - a.worldCount
  );
}

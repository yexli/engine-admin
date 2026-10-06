/* scripts/lib/tianqiong-seed.mjs 的类型声明（宿主镜像；实现见同名 .mjs） */
export declare function locationTypeOf(name: string | undefined): string;
export declare function buildTianqiongWorldSeed(): {
  worldId: string;
  name: string;
  description?: string;
  ownerGame: string;
  playerName?: string;
  startLoc?: string;
  locations: { id: string; name: string; type: string; attributes?: Record<string, unknown> }[];
  npcs?: { id: string; name: string; loc: string; data?: Record<string, unknown> }[];
  relations?: { source: string; target: string; type: string; value?: number }[];
  facts?: { type: string; actor: string; data?: Record<string, unknown> }[];
};

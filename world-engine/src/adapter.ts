/* ============================================================
   游戏适配器契约（GAME-PLATFORM-PLAN G1 · 可复用接入层）
   ------------------------------------------------------------
   回答"其他游戏方如何接入引擎"：接入方实现一个 GameAdapter
   （世界书/设定 → 引擎世界种子），宿主辅助函数把它装配成
   引擎注册表里的常驻世界——数据映射在此，规则仍在引擎。

   设计纪律：
   · 零运行时依赖；类型固化，白名单重建（纪律同引擎 http 层）；
   · 契约只做映射，不承载玩法语义——玩法由接入方经 registerRule
     挂载（引擎不变量）；
   · 未知字段一律丢弃（不透传），与引擎净化姿态一致。
   ============================================================ */
import { InMemoryWorldStorage } from './state/storage.ts';
import type { SavePort } from './state/storage.ts';
import type { WorldDefinition } from './state/WorldDefinition.ts';
import type { EngineWorldState } from './types.ts';
import type { WorldHandle } from './api/WorldAPI.ts';
import type { WorldRegistry } from './api/WorldRegistry.ts';

/* ---------------- 种子类型（接入方的声明面） ---------------- */

export interface GameLocationSeed {
  id: string;
  /** 展示名（进入 attributes.desc） */
  name?: string;
  /** 城市内为 urban；野外/林/原建议 wilderness（缺省 urban） */
  type?: string;
  attributes?: Record<string, unknown>;
}

export interface GameNpcSeed {
  id: string;
  name: string;
  /** 必须是 locations 中已声明的地点 id */
  loc: string;
  data?: Record<string, unknown>;
}

export interface GameRelationSeed {
  source: string;
  target: string;
  type: string;
  value?: number;
  note?: string;
}

export interface GameFactSeed {
  type: string;
  actor?: string;
  data?: Record<string, unknown>;
}

/** 一个游戏世界的完整种子（数据权威层 → 引擎的一次声明） */
export interface GameWorldSeed {
  worldId: string;
  name: string;
  description?: string;
  /** 归属游戏方（G2 多游戏托管）：进 metadata.ownerGame，后台按方聚合/隔离 */
  ownerGame?: string;
  playerName?: string;
  /** 缺省 = 第一个地点 */
  startLoc?: string;
  locations: GameLocationSeed[];
  npcs?: GameNpcSeed[];
  relations?: GameRelationSeed[];
  facts?: GameFactSeed[];
}

/** 接入方契约：实现 seed()，其余由宿主辅助装配 */
export interface GameAdapter {
  gameId: string;
  name: string;
  seed(): GameWorldSeed;
}

/* ---------------- 种子 → 引擎世界定义（纯映射） ---------------- */

const LOC_NAME_MAX = 128;

export function definitionFromSeed(seed: GameWorldSeed): WorldDefinition {
  return {
    locations: seed.locations.map((l) => ({
      id: l.id,
      type: l.type ?? 'urban',
      attributes: { desc: (l.name ?? l.id).slice(0, LOC_NAME_MAX), ...(l.attributes ?? {}) },
    })),
    metadata: {
      name: seed.name.slice(0, 128),
      ...(seed.description ? { description: seed.description.slice(0, 512) } : {}),
      ...(seed.ownerGame ? { ownerGame: seed.ownerGame.slice(0, 64) } : {}),
    },
  };
}

/* ---------------- 宿主辅助：种子 → 注册表常驻世界 ---------------- */

export interface HostedGame {
  worldId: string;
  handle: WorldHandle<EngineWorldState>;
}

export interface HostGameOptions<W extends EngineWorldState = EngineWorldState> {
  /** 持久化介质（G3）：缺省内存介质；单机持久化传 new FileSavePort(path) */
  savePort?: SavePort<W>;
}

/**
 * 把接入方装配进注册表：建世界（含定义/元数据）→ NPC 落位 →
 * 关系网 → 种子事实上总线。返回后台可见的常驻世界。
 * @throws WorldRegistryError（worldId 非法/重复）与引擎创建错误原样上抛
 */
export function hostGameWorld<W extends EngineWorldState>(
  registry: WorldRegistry<W>,
  adapter: GameAdapter,
  opts: HostGameOptions<W> = {},
): HostedGame {
  const seed = adapter.seed();
  if (!Array.isArray(seed.locations) || seed.locations.length === 0) {
    throw new Error('GameAdapter 种子缺少 locations（至少一个地点）');
  }
  const def = definitionFromSeed(seed);

  const world = registry.create({
    worldId: seed.worldId,
    playerName: seed.playerName ?? '旅人',
    startLoc: seed.startLoc ?? seed.locations[0]!.id,
    weather: 'clear',
    savePort: opts.savePort ?? new InMemoryWorldStorage(),
    definition: def,
  });

  /* NPC 落位（核心 create_entity：attributes.location 正确落位，
     并发出 entity_created 事实） */
  for (const npc of seed.npcs ?? []) {
    world.executeCommand({
      type: 'create_entity',
      payload: {
        id: npc.id,
        type: 'npc',
        name: npc.name,
        location: npc.loc,
        ...(npc.data ?? {}),
      },
    } as never);
  }

  /* 关系网（数值含义由游戏定义，引擎不解释） */
  for (const rel of seed.relations ?? []) {
    world.executeCommand({
      type: 'set_relation',
      actorId: rel.source,
      targetId: rel.target,
      payload: { type: rel.type, value: rel.value ?? 0, ...(rel.note ? { note: rel.note } : {}) },
    } as never);
  }

  /* 种子事实上总线（lore/身份设定等，供后台事件页与记忆摄取） */
  for (const f of seed.facts ?? []) {
    world.emitEvent({ type: f.type, ...(f.actor ? { actor: f.actor } : {}), data: f.data });
  }

  return { worldId: seed.worldId, handle: world as WorldHandle<never> };
}

/* ============================================================
   Perspective 视角构建（V2.4-06 · 方案 §十：World Truth ≠ NPC Knowledge）
   ------------------------------------------------------------
   链路：World Truth → Observation → Knowledge → Memory → Context →
   Decision。NPC 不应默认看到整个 World State——本模块提供「以某实体
   为中心的知识视图」过滤原语：

     事件可见性（感知边界，与触发侧 deriveWitnesses 同纪律）：
       · 事件自带 witnesses → 只有列名者（或事件直接当事人）可见
       · 无 witnesses → 公开事实，同地点实体可见（当事人跨地点可见）
     实体可见性：同地点实体 + 自己

   只读过滤原语——给观测面（「这个 NPC 当时知道什么」）、调试与未来
   per-NPC Context 使用；不改变现有演化上下文的行为。
   ============================================================ */

export interface PerspectiveEvent {
  id?: string;
  type: string;
  actor?: string;
  target?: string;
  location?: string;
  witnesses?: string[];
  data?: Record<string, unknown>;
}

export interface PerspectiveInput {
  /** 视角所属实体 id */
  npcId: string;
  /** 该实体当前所在地点 */
  npcLocation?: string;
  /** 世界事实（新 → 旧） */
  events: PerspectiveEvent[];
  /** 世界实体位置投影（同地点实体互相可见） */
  npcLocations?: Record<string, string>;
}

export interface PerspectiveView {
  npcId: string;
  location?: string;
  /** 该实体可感知的事件（新 → 旧，保序） */
  knownEvents: PerspectiveEvent[];
  /** 同地点的其他实体（含玩家；不含自己） */
  knownEntities: string[];
}

/** 事件对该实体是否可见（感知边界单一判定点） */
export function isVisibleTo(
  npcId: string,
  npcLocation: string | undefined,
  event: PerspectiveEvent,
  npcLocations: Record<string, string> = {},
): boolean {
  const involved = event.actor === npcId || event.target === npcId;
  if (event.witnesses?.length) {
    return event.witnesses.includes(npcId) || involved;
  }
  /* 公开事实：同地点可见；当事人跨地点可见 */
  if (involved) return true;
  const evtLoc = event.location ?? (typeof event.data?.['location'] === 'string' ? (event.data['location'] as string) : undefined);
  if (!evtLoc || !npcLocation) return false;
  if (evtLoc === npcLocation) return true;
  const actorLoc = event.actor ? npcLocations[event.actor] : undefined;
  return actorLoc !== undefined && actorLoc === npcLocation;
}

/**
 * 构建某实体的知识视图：它可感知的事件 + 同地点的其他实体。
 * 确定性、只读——「NPC 当时知道什么」由此回答。
 */
export function buildPerspective(input: PerspectiveInput): PerspectiveView {
  const knownEvents = input.events.filter((e) => isVisibleTo(input.npcId, input.npcLocation, e));
  const knownEntities = Object.entries(input.npcLocations ?? {})
    .filter(([id, loc]) => id !== input.npcId && loc !== undefined && loc === input.npcLocation)
    .map(([id]) => id);
  return {
    npcId: input.npcId,
    ...(input.npcLocation !== undefined ? { location: input.npcLocation } : {}),
    knownEvents,
    knownEntities,
  };
}

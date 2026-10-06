/* ============================================================
   WorldEngineClient · Wire 协议类型
   ------------------------------------------------------------
   这里是「天穹 → 外部 World Engine」连接层的传输契约，形状与
   world-engine 的 HTTP/WS 面一一对应（world-engine/src/http/protocol.ts
   与 ws.ts 的信封）。刻意**不 import 引擎包**：连接层只依赖线上
   协议（结构化类型），这样它可以在引擎未构建、甚至换一个实现
   （平台面 / 未来 v2）时独立存在，也方便在 vitest 的 node 环境
   与浏览器里用同一套类型。

   字段语义以引擎为唯一权威；本文件只做结构性收窄（客户端只读
   它关心的字段）。零依赖层：不 import 任何东西。
   ============================================================ */

/** 世界概要（GET /v1/worlds/{id}） */
export interface WorldInfo {
  worldId: string;
  location: string | null;
  entities: number;
  time: WorldTimeView | null;
  name?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: 'running' | 'paused';
  ownerGame?: string;
}

/** 世界时间视图（query.get_time 的线上形状） */
export interface WorldTimeView {
  /** 世界日（从 1 起） */
  day: number;
  /** 总刻数 */
  tick: number;
  /** 时辰内刻序 / 时辰下标（展示用，客户端不解释） */
  h?: number;
  monthIndex?: number;
  month?: string;
  date?: number;
  period?: string;
  year?: number;
}

/** 玩家动态（引擎最小信封；游戏富字段不在此列） */
export interface PlayerDynamic {
  name: string;
  loc: string;
  bag?: { id: string; qty: number; uid?: string }[];
  flags?: Record<string, boolean>;
  effects?: unknown[];
  attributes?: Record<string, unknown>;
}

/** 实体动态（引擎最小信封） */
export interface EntityDynamic {
  att: number;
  mem?: unknown[];
  met: boolean;
  rels?: Record<string, { type: string; val: number }>;
  bag?: { id: string; qty: number; uid?: string }[];
  gold?: number;
  effects?: unknown[];
  type?: string;
  attributes?: Record<string, unknown>;
}

/** 世界状态快照（GET /v1/worlds/{id}/state）——引擎侧世界真相的一次完整投影 */
export interface WorldStateSnapshot {
  worldId?: string;
  ver: number;
  t: number;
  weather: string;
  player: PlayerDynamic;
  npcs: Record<string, EntityDynamic>;
  rep?: Record<string, number>;
  locations?: Record<string, { id: string; type?: string; attributes?: Record<string, unknown> }>;
  relations?: { source: string; target: string; type: string; value?: number }[];
  logSeq?: number;
  [key: string]: unknown;
}

/** 命令提交体（POST /v1/worlds/{id}/commands）。形状与引擎 WorldCommand 同构 */
export interface WireCommand {
  type: string;
  commandId?: string;
  actorId?: string;
  targetId?: string;
  amount?: number;
  text?: string;
  payload?: Record<string, unknown>;
}

/** 命令结果（引擎 CommandResult） */
export interface CommandResult {
  ok: boolean;
  events: string[];
  reason?: string;
  duplicate?: boolean;
  appliedRules?: string[];
}

/** 世界事实（引擎 WorldEvent 的线上形状；事件信封自带 day/tick——
 *  客户端做增量镜像的时间来源就是它，不自行推钟） */
export interface WireEvent {
  id: string;
  type: string;
  worldId?: string;
  ts?: string;
  day: number;
  tick: number;
  level?: number;
  actor?: string;
  target?: string;
  location?: string;
  cause?: string;
  witnesses?: string[];
  data?: Record<string, unknown>;
  parentId?: string;
  sourceId?: string;
  origin?: 'reasoner';
}

/** WS 推送信封 */
export type WireFrame =
  | { type: 'hello'; worlds: string[] }
  | { type: 'event'; worldId: string; event: WireEvent };

/** 实体摘要（GET /entities 的行形状） */
export interface EntitySummary {
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

/** 玩家 Intent（方案 §4.2：Tianqiong 只产生意图，不决定结果）。
 *  引擎裁不裁、怎么裁，都是引擎的事；这里只做意图→命令的映射。
 *  `type: 'raw'` 是自定义命令直通口（Phase 3 起游戏命令经规则注册后使用）。 */
export type GameIntent =
  | { type: 'travel'; target: string }
  | { type: 'wait'; ticks: number }
  | { type: 'talk'; target: string; text?: string }
  | { type: 'attack'; target: string; amount?: number }
  | { type: 'setAttitude'; target: string; delta: number }
  | { type: 'changeWeather'; weather: string }
  | { type: 'raw'; command: WireCommand };

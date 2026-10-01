/** 与 world-engine 引擎契约对齐的类型（镜像 src/types.ts 与 src/http/protocol.ts，前端侧不 import 引擎代码） */

/** 世界时钟读数 */
export interface WorldTimeView {
  tick: number;
  day: number;
  year: number;
  month: string;
  monthIndex: number;
  date: number;
  hour: number;
  period: string;
  weather: string | null;
}

/** 世界概要（GET /v1/worlds；M1.5 起带注册表层元数据） */
export interface WorldInfo {
  worldId: string;
  location: string | null;
  entities: number;
  time: WorldTimeView | null;
  name?: string;
  description?: string;
  /** ISO 8601（经 definition.metadata 挂载；未设置时缺省） */
  createdAt?: string;
  updatedAt?: string;
  /** 服务面状态（引擎 1.0.3 G1 软暂停）：paused = 拒绝命令/推进；关闭后的世界不出现在清单 */
  status?: "running" | "paused";
  /** 归属游戏方（引擎 1.1.0 G2 多游戏托管）：按方聚合/隔离的依据；缺省 = 平台托管 */
  ownerGame?: string;
}

/** 引擎实体关系边 */
export interface RelEdge {
  type: string;
  val: number;
}

/** 引擎实体动态 */
export interface EntityDynamic {
  att: number;
  mem: unknown[];
  met: boolean;
  rels?: Record<string, RelEdge>;
  bag?: { id: string; qty: number; uid?: string }[];
  gold?: number;
  effects?: { id: string; left?: number; power?: number; source?: string }[];
  type?: string;
  attributes?: Record<string, unknown>;
}

/** 引擎地点记录 */
export interface LocationRecord {
  id: string;
  type?: string;
  attributes?: Record<string, unknown>;
}

/** 引擎关系记录 */
export interface RelationRecord {
  source: string;
  target: string;
  type: string;
  value?: number;
  metadata?: Record<string, unknown>;
}

/** 引擎世界状态信封（GET /v1/worlds/{id}/state） */
export interface EngineWorldState {
  worldId?: string;
  ver: number;
  evtSeq?: number;
  seed?: number;
  t: number;
  weather: string;
  player: {
    name: string;
    loc: string;
    bag: { id: string; qty: number; uid?: string }[];
    flags: Record<string, boolean>;
    effects?: { id: string; left?: number; power?: number; source?: string }[];
    attributes?: Record<string, unknown>;
  };
  npcs: Record<string, EntityDynamic>;
  rep: Record<string, number>;
  events: { id: string; name: string; day: number }[];
  history: { d: string; c: string; r: string; imp: number }[];
  log: { t: string; text: string; cls: string; id?: number }[];
  logSeq?: number;
  recap?: string[];
  recapSeq?: number;
  locations?: Record<string, LocationRecord>;
  relations?: RelationRecord[];
  variables?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** 世界事实（GET /v1/worlds/{id}/events） */
export interface WorldEvent {
  id: string;
  type: string;
  day: number;
  tick: number;
  level: 0 | 1 | 2 | 3;
  actor?: string;
  target?: string;
  location?: string;
  cause?: string;
  witnesses?: string[];
  data?: Record<string, unknown>;
  /** 因果链（引擎真实契约，M4.3 修正字段名）：直接父事件与源头事件 */
  parentId?: string;
  sourceId?: string;
  origin?: "reasoner";
}

/** 世界命令（POST /v1/worlds/{id}/commands） */
export interface WorldCommand {
  type: string;
  actorId?: string;
  targetId?: string;
  amount?: number;
  text?: string;
  payload?: Record<string, string | number | boolean>;
}

/** 命令执行结果 */
export interface CommandResult {
  ok: boolean;
  events: string[];
  reason?: string;
}

/** 命令历史条目（GET /v1/worlds/{id}/commands；M1.4 起真实，Runtime 侧环形缓冲） */
export interface CommandHistoryEntry {
  seq: number;
  /** ISO 8601 */
  at: string;
  tick: number;
  day: number;
  command: WorldCommand;
  ok: boolean;
  reason?: string;
  events: string[];
  tookMs: number;
}

/** 调度观测（GET /v1/worlds/{id}/scheduler；M1.2 起真实，bus 只读面） */
export interface SchedulerView {
  stats: {
    subscribers: number;
    scheduled: number;
    deadLetters: number;
    tickEmitted: number;
    deferred: number;
  };
  scheduled: { dueDay: number; event: WorldEvent }[];
  deferred: WorldEvent[];
  deadLetters: WorldEvent[];
}

/** 引擎管理面暂缺：暂停/恢复/关闭（见 ADMIN-API-GAP.md），列表页用该状态做占位 */
export type WorldRuntimeStatus = "unknown" | "assumed-running";

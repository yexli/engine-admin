/* ============================================================
   World Engine · 状态信封类型
   ------------------------------------------------------------
   引擎只要求世界状态满足这份**最小信封**；具体游戏（如宿主）的
   WorldState 通过 TS 结构化类型满足它，游戏自己的字段（数值表、
   任务、法律、地下城……）全部留在游戏侧，引擎不感知、不触碰。
   零依赖层：本文件不 import 任何东西。
   ============================================================ */

/** 世界级状态效果（add_status / remove_status 的落点）。left 缺省 = 永久 */
export interface StatusEffect {
  id: string;
  /** 剩余时长（刻）；缺省 = 永久，直到被显式移除 */
  left?: number;
  /** 强度（与具体效果同义，由接入方定义） */
  power?: number;
  /** 来源（事件 id / 施术者），可追溯 */
  source?: string;
}

/** 背包行：uid 缺省 = 可堆叠的普通行；有 uid = 独立实例（qty 恒 1） */
export interface BagRow {
  id: string;
  qty: number;
  uid?: string;
}

/** 实体间关系边（有向）：type = 关系类型，val = 强度（负 = 敌对） */
export interface RelEdge {
  type: string;
  val: number;
}

/**
 * 实体运行时动态：任何"活物"（NPC / 玩家以外的角色）进入世界视野后
 * 的最小档案。游戏可以在此之上扩展自己的字段（日程、职业、立绘……），
 * 引擎只读写下面这些通用槽位。
 */
export interface EntityDynamic {
  /** 对玩家的态度，[-100, 100] */
  att: number;
  /** 记忆条目（引擎不解释内容，只持有） */
  mem: unknown[];
  /** 是否正式见过面 */
  met: boolean;
  /** 与其他实体的关系网（otherId → 边） */
  rels?: Record<string, RelEdge>;
  bag?: BagRow[];
  gold?: number;
  effects?: StatusEffect[];
  /** 实体类型（V1.0 通用属性：character / building / vehicle…由宿主定义） */
  type?: string;
  /** 通用属性袋（V1.0）：新游戏与新规则的正解字段；旧字段保留兼容 */
  attributes?: Record<string, unknown>;
  /** 内部版本戳（P2 卡片8 · additive）：经受控写入路径修改时单调递增。
   *  并发冲突检测用（演化侧观察/落地比对）；游戏语义不消费。 */
  _ver?: number;
}

/** 玩家实体：引擎要求的最小面（其余字段归游戏） */
export interface PlayerDynamic {
  name: string;
  /** 当前所在地点（地点本身是字符串 id，地点表归游戏） */
  loc: string;
  bag: BagRow[];
  flags: Record<string, boolean>;
  effects?: StatusEffect[];
  /** 通用属性袋（V1.0） */
  attributes?: Record<string, unknown>;
}

/** 地点记录（V1.0 · 方案 §4.2 Location）：内核只知道 id/type/attributes */
export interface LocationRecord {
  id: string;
  type?: string;
  attributes?: Record<string, unknown>;
}

/** 关系记录（V1.0 · 方案 §4.2 Relation）：有向、带类型与强度 */
export interface RelationRecord {
  source: string;
  target: string;
  type: string;
  value?: number;
  metadata?: Record<string, unknown>;
}

/** 落在世界状态里的轻量事件行（世界事实的持久存根，供查询用） */
export interface WorldEventInst {
  id: string;
  name: string;
  day: number;
}

/** 见闻录条目（文本层；cls 的取值集由接入方定义） */
export interface LogEntry {
  /** 时间戳（展示用，由接入方的历法格式化） */
  t: string;
  text: string;
  cls: string;
  /** 单调递增条目号（UI 增量检测与替换的凭据） */
  id?: number;
}

/** 世界史条目（何时、何事、结果、重要度） */
export interface HistoryEntry {
  d: string;
  c: string;
  r: string;
  imp: number;
}

/**
 * 世界状态信封：引擎所有通用机制（时钟 / 容器 / 写入原语 / 分片）
 * 只依赖这些字段。字段与宿主既有 WorldState 精确同形——这是抽取
 * 而不是重写：宿主类型结构化满足本信封，两边共用一套运行时。
 */
export interface EngineWorldState {
  /** 世界标识（§42 预留：未来多世界 / 多用户的键）。可选以兼容旧档 */
  worldId?: string;
  ver: number;
  /** 事件序号（随档持久化，重启后 id 不回退） */
  evtSeq?: number;
  /** 本局世界种子：一旦定下不再变 */
  seed?: number;
  /** 总刻数（世界的绝对时间） */
  t: number;
  weather: string;
  player: PlayerDynamic;
  npcs: Record<string, EntityDynamic>;
  /** 声望表（factionId → 数值） */
  rep: Record<string, number>;
  events: WorldEventInst[];
  history: HistoryEntry[];
  log: LogEntry[];
  /** 见闻录累计条数（log 是环形窗口，长度恒定，增量检测靠它） */
  logSeq?: number;
  /** 章级前情摘要（叙事用，旧 → 新） */
  recap?: string[];
  /** 已归档到哪条见闻（log id 水位） */
  recapSeq?: number;
  /** 地点表（V1.0 · 方案 §4.2 Location；内核只知道 id/type/attributes） */
  locations?: Record<string, LocationRecord>;
  /** 实体间关系（V1.0 · 方案 §4.2 Relation） */
  relations?: RelationRecord[];
  /** 世界变量（V1.0）：宿主与规则的通用键值空间 */
  variables?: Record<string, unknown>;
  /** 宿主元数据（V1.0）：内核不解释 */
  metadata?: Record<string, unknown>;
}

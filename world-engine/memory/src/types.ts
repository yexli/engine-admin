/* ============================================================
   World Memory Engine · 领域类型（零依赖）
   ------------------------------------------------------------
   World Truth ≠ Character Memory（方案 §16 数据流的存储侧）。
   WorldFact 是「世界事实」的结构化最小面——引擎的 WorldEvent
   直接结构化满足它；本包不 import 任何引擎模块。
   ============================================================ */

/** 世界事实的结构化最小面（引擎 WorldEvent 结构化满足） */
export interface WorldFact {
  id: string;
  type: string;
  day: number;
  actor?: string;
  target?: string;
  location?: string;
  /** 感知边界：只有列名者「看见」了这件事（§8） */
  witnesses?: string[];
  data?: Record<string, unknown>;
}

/** 摄取路径：亲历 / 传闻 / 自记（AI 或角色主动记住） */
export type MemoryVia = 'witness' | 'rumor' | 'self';

/** 一条角色记忆 */
export interface MemoryEntry {
  id: string;
  ownerId: string;
  /** 类别（缺省取事实 type；宿主可自定义类别体系） */
  kind: string;
  /** 记住的版本（传闻按保真度改写过，细节已含在文本里） */
  text: string;
  /** 世界日（与宿主时钟同源，不引入第二套时间） */
  day: number;
  via: MemoryVia;
  /** 置信度 [0,1]：亲历 1，传闻按配置衰减 */
  confidence: number;
  /** 重要度 [0,1]：高重要度衰得慢 */
  importance: number;
  entities: string[];
  recallCount: number;
  lastRecalledDay?: number;
  /** 被遗忘的条目保留在快照里供审计，检索不再返回 */
  forgotten?: boolean;
}

/** 记忆快照（持久化的载与卸单位） */
export interface MemorySnapshot {
  seq: number;
  entries: MemoryEntry[];
}

/** 检索选项 */
export interface RecallOptions {
  limit?: number;
  /** 当前世界日（参与新近度打分；缺省 0 = 不计新近度） */
  day?: number;
  /** 剔除已遗忘条目（缺省 true） */
  includeForgotten?: boolean;
}

/** 向量钩子：宿主可注入（如经 V0.6 路由的 embedding 通道）；缺省纯词面检索 */
export interface EmbedHook {
  embed(texts: string[]): Promise<number[][] | null>;
}

/** 持久化端口（形状对齐引擎 SavePort 纪律：载失败返回 null，不抛） */
export interface MemorySavePort {
  load(): MemorySnapshot | null;
  save(snapshot: MemorySnapshot): void;
  clear(): void;
}

export interface MemoryConfig {
  /** 传闻置信度（亲历恒为 1） */
  rumorConfidence?: number;
  /** 每世界日的线性衰减量；实际衰减 = decayPerDay × (1 − importance / 2)（重要度越高衰得越慢） */
  decayPerDay?: number;
  /** 置信度低于此值 → 遗忘（保留标记，检索不再返回） */
  forgetBelow?: number;
  /** 单 owner 记忆上限（超出淘汰置信最低者） */
  maxPerOwner?: number;
  /** 检索缺省条数 */
  defaultLimit?: number;
}

export interface MemoryEngineConfigAll {
  rumorConfidence: number;
  decayPerDay: number;
  forgetBelow: number;
  maxPerOwner: number;
  defaultLimit: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryEngineConfigAll = {
  rumorConfidence: 0.6,
  decayPerDay: 0.05,
  forgetBelow: 0.05,
  maxPerOwner: 200,
  defaultLimit: 5,
};

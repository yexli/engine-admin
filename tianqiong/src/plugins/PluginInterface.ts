/* ============================================================
   Core 对外端口（六边形架构）：
   - AiPort：AI 层实现由此注入（§7 铁律：AI 只能提出判断与文本，
     不得直接改写 WorldState —— 所有状态突变都在 core 内完成）。
   - SavePort：持久化抽象（§8/§9：GameCore → Repository → SQLite，
     第一阶段由 localStorage 实现，未来换 Drizzle/SQLite 不动核心）。
   ============================================================ */
import type { Belief, CaseState, LogEntry, Memory, NpcDynamic, PerceivedFact, WorldState } from '@/types/world';
import type { WorldEvent } from '@/events/EventSchema';

export interface NpcReq {
  interest: number;
  violate?: boolean;
  risk?: number;
}
export interface NpcVerdict {
  verdict: string;
  W: { interest: number; vio: boolean; risk: number; att: number };
  /** LLM 通道可附带台词（规则通道由 core 台词池生成） */
  line?: string;
}
/** 提供给 LLM 的紧凑上下文（由 core 组装，AI 层只读） */
export interface NpcCtx {
  npcName: string;
  npcTitle: string;
  att: number;
  attWord: string;
  mem: string[];
  playerName: string;
  playerCls: string;
  location: string;
  request: string;
}
/**
 * 意图解析产物（自由行动 2a · G1 参数包契约）：
 * 枚举意图 + 参数包（target/dest/focus/topic）+ 可选 steps 序列（2b 顺序分解预留）。
 * LLM 通道与正则通道产出同一形状（G2 双通道同构）。
 */
export interface IntentParse {
  intent: string;
  /** 动作对象的 NPC 姓名（涉人意图） */
  target?: string;
  /** 目的地（id 或玩家原词，由 core 的 findLoc 收敛） */
  dest?: string;
  /** 观察/调查的具体焦点（≤20 字，须在叙事中被回响 G5） */
  focus?: string;
  /** 打听/询问的具体话题（≤20 字） */
  topic?: string;
  /** 2b 顺序分解：复合句拆解后的原子意图序列（≤3）；2a 忽略 */
  steps?: IntentParse[];
}
export interface IntentCtx {
  loc: string;
  locName: string;
  npcs: string[];
  /** 在场 NPC id（供 target 白名单校验） */
  npcIds?: string[];
  /** 当前可直达目的地（travel 邻接表；dest 白名单来源） */
  dests?: { id: string; name: string }[];
  /** 会话焦点：自由输入里上一次交谈的对象与话题（「再问问他」的指代来源；可空） */
  lastTalk?: { name: string; topic?: string };
}

/* ---------------- 聊天窗口（第四通道）契约 ---------------- */

/** 关系包：唯一关系读取组装点（G8），chat/chatAsync/npcDecide 同源消费；人设锚由 AI 层 personaBlock 组装（G7） */
export interface ChatCtx {
  npcId: string;
  att: number;
  attWord: string;
  /** 门禁档：hostile 拒聊 / cold 仅安全话题 / warm 解锁私密话题 */
  tier: 'hostile' | 'cold' | 'neutral' | 'warm';
  mem: string[];
  /** 关系牵扯摘要（如「莉安：敌对」） */
  rels: string[];
  /** 势力立场摘要（如「帝国·声望-10」） */
  stance: string[];
  location: string;
  /** 此刻正在做什么（schedule act） */
  act?: string;
  playerName: string;
  playerCls: string;
  /** 近 6 轮窗口历史（旧→新） */
  history: { who: 'p' | 'n'; text: string }[];
  /** 玩家本句 */
  input: string;
  /**
   * 【P2】命中话题卡时的素材与边界。
   * 有它时 AI 的职责只是「措辞」——facts 是它能展开的全部范围，edge 是它不许越过的线。
   * 没有它（自由发言）时行为与从前一致。
   */
  topic?: { l: string; layer: 0 | 1 | 2; said: string; facts?: string[]; edge?: string };
  /**
   * 【C 卡】本次对话的预算档位与各块字数上限：core 按 worldImportance × LOD 算好，
   * 适配器照着用（人设多长、canon 投多少）。**同一份账本两个消费方**——
   * 适配器自己拍脑袋定字数，就会出现「core 按档位减了内容、适配器又按通道加回去」。
   */
  budget?: { profile: string; personaChars: number; canonChars: number };
}
/** AI 对话输出 = 台词 + 有界判定（G9 前奏）；后果由 core chatApply 白名单校验后落地 */
export interface ChatReply {
  line: string;
  attDelta?: number;
  mem?: string;
  /** 传闻话题（core 走 spreadRumor 沿关系网扩散） */
  rumor?: string;
}

/* ---------------- 开场白（greet 通道）契约 ---------------- */

/**
 * 开场白上下文：只装「此刻」——地点、他正在做什么、是否初次见面、玩家是谁、关系档。
 * 刻意**不复用 chatCtx 的关系包**（G8 的唯一组装点）：开场白用不到立场摘要，
 * 多一处组装就多一处会漂移的第二真相。
 */
export interface GreetCtx {
  npcId: string;
  att: number;
  attWord: string;
  tier: 'cold' | 'neutral' | 'warm';
  /** 数据里的三档问候——作「你惯常这样开口」的语气锚，AI 不得照抄 */
  samples: { cold: string; neutral: string; warm: string };
  location: string;
  /** 此刻在做什么（schedule act） */
  act?: string;
  firstMeet: boolean;
  playerName: string;
  /** 世界怎么称呼玩家（称号前缀；空串 = 无称号） */
  playerTitle: string;
  /** 上次对话的尾巴（末一条，≤20 字；可空）。开场白接得住旧话头，
      「你上次说到弟弟的病……」比「你好」更像认识你的人。 */
  lastChat?: string;
}

export interface AiPort {
  readonly provider: string;
  narrative(kind: string, p: { loc: string }): string;
  narrativeAmbient(): string;
  npcDecide(npcId: string, req: NpcReq): NpcVerdict;
  contextLayers(s: WorldState, helpers: AiHelpers): [string, string[]][];
  /* ---- 可选异步通道（真实模型实现；缺省=规则模拟同步路径） ---- */
  intentAsync?(text: string, ctx: IntentCtx): Promise<IntentParse | null>;
  narrativeAsync?(kind: 'enter' | 'ambient', p: { loc: string }): Promise<string | null>;
  npcDecideAsync?(npcId: string, req: NpcReq, ctx: NpcCtx): Promise<NpcVerdict | null>;
  /* ---- 聊天窗口（第四通道）：同步=规则池降级路径；异步=真实模型，失败回同步 ---- */
  chat(npcId: string, ctx: ChatCtx): ChatReply;
  chatAsync?(npcId: string, ctx: ChatCtx): Promise<ChatReply | null>;
  /* ---- 开场白（greet 通道 · AI 化）：数据台词先上屏，这里给的是「此刻的版本」；
     缺省 / 失败 / null → 保留数据台词（降级铁律：不配模型也开得了口） ---- */
  greetAsync?(ctx: GreetCtx): Promise<string | null>;
  /* ---- 叙事编织（weave 通道）：玩家每做一件事，规则引擎先给出事实，
     这里把它们织成一段小说正文。**缺省 / 失败 / null → 规则原文原样留在见闻录里**
     （渐进增强：不配模型时游戏照常可读，只是少了润色）。 ---- */
  narrateAsync?(facts: string[], ctx: NarrateCtx): Promise<string | null>;
  /* ---- 章级摘要（recapSeq 到期时调用一次）：把最早的那批正文压成一段前情，
     供后续段落衔接。**缺省 / 失败 / null → 不归档**（下一批再试），
     最坏情况就是回到「只有最近两段前情」，与没有这个机制时一样。 ---- */
  summarizeAsync?(texts: string[], ctx: NarrateCtx): Promise<string | null>;
}

/** 叙事编织的上下文：此刻在哪、什么时候。在场名单由 AI 层用既有 helpers 查，
    避免 world → systems 多出一条依赖边（冻结基线不允许新增）。 */
export interface NarrateCtx {
  loc: string;
  locName: string;
  time: string;
  weather: string;
  /** 章级摘要（旧 → 新）：跨天的前情。见闻录只有 70 条会被丢，跨天衔接只能靠它 */
  chronicle: string[];
  /** 前情：最近几段已写正文（旧 → 新）。没有它，模型每轮都从零描写整个场景，
      于是同一个人在同一时刻既在喂鸽子、又从广场另一头走来。 */
  recap: string[];
  /** 近因：见闻录里那些"不是散文"的条目——收获、损失、系统提示 */
  events: string[];
  /** 衔接提示：时间是否连续、地点是否变过 */
  continuity: string[];
}

/** core 提供给 AI 层的只读查询助手（避免 ai 反向 import 造成环） */
export interface AiHelpers {
  shichenOf(t: number): number;
  seasonName(s: WorldState): string;
  presentNPCs(s: WorldState, loc: string): { id: string; name: string; title: string }[];
  attOf(s: WorldState, id: string): number;
  attWord(a: number): string;
  raceName(s: WorldState): string;
  clsName(s: WorldState): string;
  rankName(s: WorldState): string;
  maxHp(s: WorldState): number;
  maxMp(s: WorldState): number;
  hasIllegalStr(s: WorldState): string;
  lastLogs(s: WorldState): LogEntry[];
}

let _ai: AiPort | null = null;
export function setAiPort(p: AiPort) {
  _ai = p;
}
export function ai(): AiPort {
  if (!_ai) throw new Error('AiPort 未注册：请在组合根（main.tsx）调用 setAiPort(ruleSim)');
  return _ai;
}

/**
 * 向量索引的持久化行（记忆方案 §13：事实与向量**分开存**）。
 * 刻意不塞进 WorldState：1024 维浮点会让主存档膨胀几个数量级。
 */
export interface PortVectorRow {
  id: string;
  ownerId: string;
  fp: string;
  vec: number[];
  /** 生成它的模型：换模型后旧行必须作废（两套向量空间的余弦没有意义） */
  model?: string;
  dim?: number;
  lastUsed: number;
}

/**
 * 存档分片（《剩余工作实施方案》§3 · 第二杠杆）。
 * 事实：save() 每次把整个 core.S 序列化落盘，npcs / memories / knowledge / cases
 * 随 NPC 规模线性膨胀（200 NPC 时每次几 MB），而浏览器配额只有 5MB。
 * 分片把「随规模增长的表」与「尺寸基本恒定的表」分开：主档小且每次都写，
 * 三张增长表只在**内容真的变了**时才写。
 * 分片缺失 = 该表没写成功 → 归零成空表（由 hydrate 兜底），不拖垮整档。
 */
/**
 * 主档分片：五张随规模增长的表**都被摘掉了**，所以它不是一个完整 WorldState。
 * 声明成 `WorldState` 会是类型谎言——`npcs` 在 WorldState 里是必需字段，
 * 而这里运行时根本没有它（消费方一读就会拿到 undefined 而不是编译期报错）。
 */
export type MainShard = Omit<WorldState, 'npcs' | 'memories' | 'beliefs' | 'knowledge' | 'cases'>;

export interface PortShards {
  /** 主档：除五张增长表之外的一切（player / rep / econ / log / dungeon / …） */
  main: MainShard;
  npcs?: Record<string, NpcDynamic>;
  memories?: Record<string, Memory[]>;
  beliefs?: Record<string, Belief[]>;
  knowledge?: Record<string, PerceivedFact[]>;
  cases?: CaseState[];
}

export interface SavePort {
  /** 介质标识（F-21：系统面板只读展示——"存档莫名消失"多半是介质换了） */
  readonly medium?: 'sqlite' | 'localStorage' | 'memory';
  load(): WorldState | null;
  save(s: WorldState): void;
  clear(): void;
  /** 落盘错误通道（F-20/F-23）：组合根注入 → toast；repo 层不依赖 UI */
  onError?: (msg: string) => void;
  /** 向量索引读写（可选：不实现则退化为纯内存，重启重算——只是慢，不会出错） */
  loadVectors?(): PortVectorRow[] | null;
  saveVectors?(rows: PortVectorRow[]): void;
  /** §29/§44 世界史读写（可选：不实现则退化为内存，重启即失去长期追溯——查不到，但不会出错） */
  loadWorldLog?(): WorldEvent[] | null;
  saveWorldLog?(rows: WorldEvent[]): void;
  /**
   * 分片读写（可选：不实现则整档往返——只是每次都要写全部几 MB，不会出错）。
   * 契约同向量索引那一对：读失败返回 null，写失败记账不抛。
   */
  loadShards?(): PortShards | null;
  saveShards?(shards: PortShards): void;
}
let _save: SavePort | null = null;
export function setSavePort(p: SavePort) {
  _save = p;
}
export function savePort(): SavePort | null {
  return _save;
}

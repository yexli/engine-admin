/* ============================================================
   AI World Evolution Runtime · 核心概念（方案 §五/§六/§七/§八）
   ------------------------------------------------------------
   本文件是演化层的「宪法」：先划清概念边界，再谈实现。

   五个必须严格区分的概念：
     Intent    「我想做什么」——来自玩家/游戏方的原始意图，可能改变世界
     Command   「请引擎尝试执行」——进 Rules 校验，可能被拒绝
     Proposal  「AI 认为可能发生什么」——只是建议，不是事实，单独存在
     Mutation  「世界真正发生的状态变化」——只有 Rules 放行的 Command 能产生
     Event     「世界刚刚发生了什么」——事实，向所有系统广播

   三个永远不是世界事实（World Fact）的东西：
     OOC（out-of-character 玩家场外话）
     Narrative（叙事文本）
     AI Proposal（本文件定义的演化建议）

   铁律（结构保证，不靠自觉）：
     AI → Proposal/Command → Rules → Mutation → State → Event
     本模块没有任何一个函数能直接写 World State——AI 侧的全部
     影响力都被压缩成 Command，经引擎的 Rules 链落地。

   分层归属：本文件只依赖平台 types（EngineClient 的形状），不 import
   引擎内核——演化层通过 HTTP 与引擎对话，与引擎保持进程边界。
   ============================================================ */

/* ---------------- Intent（方案 §五/§七：意图与 OOC 隔离） ---------------- */

/** 意图种类：只有 ic_action 允许被翻译成 Command，其余一律不进引擎 */
export type IntentKind =
  | 'ic_action' // 世界内行动：「我想去酒馆」→ 可翻译为 Command
  | 'ooc' // 场外话：「帮我调一下难度」→ 永远不是世界事实
  | 'narrative'; // 叙事/描述文本 → 永远不是世界事实

/** 一条待处置的意图。kind 由调用方（游戏适配层）声明，演化层只认声明，
 *  绝不猜测——把 OOC 当事实是本层唯一不可容忍的越权。 */
export interface WorldIntent {
  kind: IntentKind;
  /** 自然语言原文（ooc/narrative 只留档，不进引擎） */
  text: string;
  /** 谁做的（ic_action 翻译成 Command 时的 actorId，缺省 player） */
  actorId?: string;
  /** 游戏适配层已翻译好的命令（ic_action 可携带；不携带则仅留档） */
  command?: { type: string; targetId?: string; amount?: number; text?: string; payload?: Record<string, unknown> };
}

/** 意图处置结果：ooc/narrative 永远 received-only；ic_action 才有命令链结果 */
export interface IntentOutcome {
  kind: IntentKind;
  /** ic_action 且携带 command 时才有：引擎命令链结果 */
  commandResult?: { ok: boolean; events: string[]; reason?: string };
}

/* ---------------- Observation（方案 §四：观察） ---------------- */

/** 演化输入的一次观察：来自世界的事实切片（不是 AI 的想象） */
export interface Observation {
  /** 事实来源：一条世界事件的 id，或 'state' = 状态快照 */
  ref: string;
  kind: 'event' | 'state';
  /** 一句话摘要（因果链展示用；结构化数据在 EvolutionContext 里） */
  summary: string;
}

/* ---------------- Evolution Context（方案 §四：Context Builder 的产物） ---------------- */

/** 上下文构建时刻的世界状态摘要（全部来自引擎权威读取，逐字陈述事实） */
export interface EvolutionContext {
  worldId: string;
  builtAt: string;
  /** 引擎世界刻度 / 天 */
  tick: number;
  day: number;
  weather: string;
  /** 玩家摘要 */
  player: { name: string; loc: string; bagSize: number };
  /** 在场实体（id → 摘要；attributes 透传，供 AI 读取游戏字段） */
  entities: Record<
    string,
    { att: number; met: boolean; type?: string; location?: string; attributes?: Record<string, unknown> }
  >;
  /** 世界关系表（有向边） */
  relations: { source: string; target: string; type: string; value?: number }[];
  /** 观察窗口内的世界事实（新 → 旧） */
  events: {
    id: string;
    type: string;
    day: number;
    actor?: string;
    target?: string;
    location?: string;
    data?: Record<string, unknown>;
  }[];
}

/* ---------------- Evolution Proposal（方案 §八：AI 的建议，不是事实） ---------------- */

/** AI 提出的一条具体变化。action 必须能被翻译成引擎 Command，否则整条被拒 */
export interface ProposedChange {
  /** 作用对象（实体 id / 'player' / 'world'） */
  targetId: string;
  /** 动作名（与演化层命令白名单对齐，如 update_attribute / set_relation） */
  action: string;
  /** 动作载荷（翻译成对应 Command 的 amount/text/payload） */
  payload?: Record<string, unknown>;
  /** 为什么（因果链里「AI 为什么让世界发生这个」的答案） */
  reason: string;
}

/** 一份完整的演化提案。它只是 AI 的建议——在被 Rules 放行并产生 Mutation 之前，
 *  对世界零影响。 */
export interface EvolutionProposal {
  /** 提案 id（= 所属 run 的 id，一一对应） */
  id: string;
  worldId: string;
  /** AI 对当前局势的整体判断（为什么此时要演化） */
  reason: string;
  /** 提案依据的观察（必须引用真实事件 id 或 'state'，不得凭空捏造） */
  observations: Observation[];
  changes: ProposedChange[];
  /** AI 自报置信度 [0,1]（展示用；是否放行只看 Rules，不看它） */
  confidence?: number;
  source: {
    type: 'ai';
    /** 产生提案的模型（脚本化驱动填 'scripted'） */
    model?: string;
    /** 驱动侧角色标注（如 npc_behavior / world_reasoning） */
    role?: string;
  };
}

/* ---------------- Run（方案 §九：完整因果链的可追溯记录） ---------------- */

/** 一条 ProposedChange 的最终裁决：Rules 的裁决就是世界的裁决 */
export interface ChangeOutcome {
  change: ProposedChange;
  /** 翻译出的命令（未过白名单的 change 没有 command） */
  command?: { type: string; actorId?: string; targetId?: string; amount?: number; text?: string; payload?: Record<string, unknown> };
  /** 白名单翻译 + 引擎命令链双关都过才算 accepted */
  accepted: boolean;
  /** 拒绝环节与原因：translate = 白名单拒绝；rules = 引擎规则拒绝 */
  rejectedBy?: 'translate' | 'rules';
  reason?: string;
  /** 引擎放行后产生的事实 id（时序）——因果链的「果」 */
  eventIds: string[];
}

/** 一次演化运行的完整留痕：Event → Observation → Context → Proposal → Rules → Mutation → Event */
export interface EvolutionRun {
  id: string;
  worldId: string;
  startedAt: string;
  finishedAt?: string;
  /** running / completed / failed（failed = 观察或驱动失败，世界未被动过） */
  status: 'running' | 'completed' | 'failed';
  /** 触发来源：admin = 管理台手动；auto = 周期调度；api = 公共 API */
  trigger: 'admin' | 'auto' | 'api';
  /** 观察窗口（本次演化读了哪些事实） */
  observationWindow: { eventCount: number; latestEventId?: string };
  /** 组装出的上下文（完整留存——「AI 当时看到了什么」） */
  context?: EvolutionContext;
  /** 产生提案的模型（未走到驱动 = null） */
  modelUsed?: string | null;
  /** AI 的提案（failed 时可能没有） */
  proposal?: EvolutionProposal;
  /** 每条变化的裁决（completed 时必有） */
  outcomes?: ChangeOutcome[];
  acceptedCount?: number;
  rejectedCount?: number;
  /** 本次运行最终产生/关联的全部世界事实 id */
  eventIds: string[];
  /** 驱动/翻译/执行异常（failed 时必有，completed 时通常为空） */
  error?: string;
  tookMs?: number;
}

/* ---------------- Driver（方案 §六：AI 与引擎的唯一接口） ---------------- */

/** AI 世界驱动的抽象：给上下文，还一份提案。
 *  这是 AI 参与世界的**唯一**形状——拿不到状态写入口，拿不到引擎句柄。
 *  网关驱动（真模型）与脚本化驱动（测试/演示）都实现它。 */
export interface EvolutionDriver {
  /** 驱动名（观测用，如 'gateway:reasoning' / 'scripted'） */
  readonly name: string;
  propose(context: EvolutionContext): Promise<EvolutionProposal>;
}

/** 驱动失败：驱动层把模型调用失败 / 结构不合法统一转成它，
 *  runtime 据实记 run.status = failed，绝不把坏提案放行给引擎 */
export class EvolutionDriverError extends Error {
  constructor(
    message: string,
    public readonly code: 'model_unavailable' | 'invalid_proposal' | 'driver_error',
  ) {
    super(message);
  }
}

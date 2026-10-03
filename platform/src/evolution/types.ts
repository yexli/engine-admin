/* ============================================================
   AI World Evolution Runtime · 核心概念（方案 §五/§六/§七/§八；V2 收口）
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

   V2.0 收口（方案 §二）：
     · Change/Command 全程带唯一 ID（changeId / commandId）
     · 每条 Change 有独立执行结果（status / rejectedBy / reason / eventIds）
     · Proposal 有最终状态（completed / partially_applied / rejected / failed）
     · 幂等保护：同一 Proposal / 同一 Change 不重复执行，重复返回既有结果
     · 因果关联以 Journal 为权威（Event → Run → Proposal → Change →
       Command → Rules Result），不把 Evolution 专属字段硬编码进 Core

   分层归属：本文件只依赖平台 types（EngineClient 的形状），不 import
   引擎内核——演化层通过 HTTP 与引擎对话，与引擎保持进程边界。
   ============================================================ */

/* ---------------- Intent（方案 §五/§七：意图与 OOC 隔离） ---------------- */

/** 意图种类：只有 ic_action 允许被翻译成 Command，其余一律不进引擎 */
export type IntentKind =
  | 'ic_action' // 世界内行动：「我想去酒馆」→ 可翻译为 Command
  | 'ooc' // 场外话：「帮我调一下难度」「让我直接变强」→ 永远不是世界事实
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

/* ---------------- Evolution Context（方案 §五：地点作用域，不 SELECT *） ---------------- */

/** 上下文构建时刻的世界状态摘要（全部来自引擎权威读取，逐字陈述事实）。
 *  V2 收敛：在 detail 的是「玩家当前地点的实体」；其余实体只给轻量名册——
 *  AI 看得见世界有哪些人，但只有眼前的实体的完整字段。 */
export interface EvolutionContext {
  worldId: string;
  builtAt: string;
  tick: number;
  day: number;
  weather: string;
  /** 玩家摘要 */
  player: { name: string; loc: string; bagSize: number; attributes?: Record<string, unknown> };
  /** 玩家所在地点（作用域中心） */
  location?: { id: string; desc?: string };
  /** 在场实体（玩家当前地点，完整字段） */
  entities: Record<
    string,
    { att: number; met: boolean; type?: string; location?: string; attributes?: Record<string, unknown> }
  >;
  /** 世界其余实体（轻量名册：id/type/location——跨系统推演看得见，细节不可写） */
  otherEntities: { id: string; type?: string; location?: string }[];
  /** 关系边（只保留涉及玩家或在场实体的） */
  relations: { source: string; target: string; type: string; value?: number }[];
  /** 触发事件段（P4 · 方案 §七「当前事件」：本 run 由哪个事件唤醒、谁被唤醒。
   *  预算优先级最高，永不裁剪；无 wakePlan 的 tick 没有此段） */
  trigger?: { primaryEventId?: string; woken?: string[] };
  /** 当前目标（方案 §七组成项；引擎暂无目标事实，P5 Goals 接入位——缺事实不编造） */
  goal?: string;
  /** 相关记忆（方案 §七组成项；记忆源 P7 接入，本阶段只通预算与渲染通路） */
  memory?: { ref: string; summary: string; day?: number }[];
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
  /** P4 预算执行报告（传入 budget 时携带；裁了什么、剩多少，失败必须可见） */
  budgetReport?: ContextBudgetReport;
}

/* ---------------- Context Budget（P4 · 方案 §七：被唤醒后看到什么，有预算） ---------------- */

/** 上下文预算：五项旋钮（方案 §七「至少支持」）。全部可选；未给的字段不设限。
 *  裁剪优先级（方案 §七）：当前事件 > 当前位置 > 相关实体 > 直接关系 >
 *  近期事件 > 长期记忆 > 全局信息。 */
export interface ContextBudget {
  /** 渲染后事实文本的 token 估算上限（超限按优先级从低到高逐段裁剪） */
  maxTokens?: number;
  /** 带完整细节的实体数上限（超出者降级为名册，不丢名字） */
  maxEntities?: number;
  /** 上下文携带的事件条数上限（触发事件永远保留，其余新→旧截断） */
  maxEvents?: number;
  /** 关系边条数上限（玩家/被唤醒实体相关的边优先保留） */
  maxRelations?: number;
  /** 记忆条目数上限（P7 接入记忆源后生效） */
  maxMemoryItems?: number;
}

/** 预算执行报告：管理台/审计从 run.context.budgetReport 能看到 AI 实际看到了什么、被裁了什么 */
export interface ContextBudgetReport {
  maxTokens: number;
  estimatedTokens: number;
  /** 各段最终携带量 */
  carried: { entities: number; events: number; relations: number; memory: number };
  /** 因预算被降级/裁剪的数量 */
  dropped: { entitiesToRoster: number; events: number; relations: number; memory: number; rosterByTokens: number };
}

/* ---------------- Evolution Proposal（方案 §八：AI 的建议，不是事实） ---------------- */

/** AI 提出的一条具体变化。action 必须能被翻译成引擎 Command，否则整条被拒 */
export interface ProposedChange {
  /** 唯一 ID（驱动可自带；缺省由运行时补发 chg_*）——幂等与因果链的锚 */
  changeId?: string;
  /** 作用对象（实体 id / 'player' / 'world'） */
  targetId: string;
  /** 动作名（必须在演化策略白名单内，如 update_attribute / set_relation） */
  action: string;
  /** 动作载荷（翻译成对应 Command 的 amount/text/payload） */
  payload?: Record<string, unknown>;
  /** 为什么（因果链里「AI 为什么让世界发生这个」的答案） */
  reason: string;
}

/** 一份完整的演化提案。它只是 AI 的建议——在被 Rules 放行并产生 Mutation 之前，
 *  对世界零影响。changes 允许为空：AI 判断「什么都不该发生」（如 NPC 没注意到
 *  玩家）是合法结论，**不是失败**。 */
export interface EvolutionProposal {
  /** 提案 id（= 所属 run 的 id，一一对应） */
  id: string;
  worldId: string;
  /** AI 对当前局势的整体判断（为什么此时要演化 / 为什么不演化） */
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

/* ---------------- 演化策略（V2 · 方案 §四/§五：第一阶段 NPC 演化的围栏） ---------------- */

/** 演化策略：AI 影响力的第二道白名单（第一道是内核命令翻译）。
 *  第一阶段只开放 NPC 演化：attention / mood / relationship / location /
 *  simple_schedule，对应动作限制为 update_attribute / set_relation /
 *  move_entity；禁止创建/删除 NPC、修改玩家核心属性、改时间天气。 */
export interface EvolutionPolicy {
  /** 允许 AI 提议的动作（内核白名单的子集） */
  allowedActions: readonly string[];
  /** 禁止 AI 触碰的目标：targetId === 'player' 的动作在 forbiddenActionsOnPlayer 内时拒 */
  forbiddenActionsOnPlayer: readonly string[];
  /** 禁止 AI 直接修改的属性键（P5 · 方案 §八「不得直接修改金币」：
   *  经济/系统属性归游戏规则，AI 提案对任何目标都改不了这些键） */
  forbiddenAttributeKeys?: readonly string[];
  /** 单次提案变化数上限 */
  maxChangesPerProposal: number;
  /** 单次提案可影响的实体数上限（去重后 targetId 计数） */
  maxEntitiesAffected: number;
  /** 触发冷却（毫秒）：auto/api 触发在冷却期内拒绝；admin 手动不受限 */
  cooldownMs: number;
}

/** 第一阶段缺省策略（方案 §四：最小围栏，宁窄勿宽）。
 *  AI 完全不可触碰玩家：位置/属性/关系都归游戏与玩家本人管。
 *  金币（money/gold）归经济规则——方案 §八「禁止 AI 直接修改金币」。 */
export const NPC_EVOLUTION_POLICY: EvolutionPolicy = {
  allowedActions: ['update_attribute', 'set_relation', 'move_entity'],
  forbiddenActionsOnPlayer: ['update_attribute', 'set_relation', 'move_entity'],
  forbiddenAttributeKeys: ['money', 'gold'],
  maxChangesPerProposal: 3,
  maxEntitiesAffected: 3,
  cooldownMs: 30_000,
};

/* ---------------- Trigger（V2 · 方案 §五：事件驱动分级） ---------------- */

/** 事件对演化的触发级别 */
export type TriggerGrade = 'high' | 'medium' | 'low';

/** 事件对某个实体的唤醒级别（P3 · 方案 §六：Trigger 只决定「是否值得考虑」，
 *  绝不决定 NPC 做什么——被唤醒 ≠ 必须反应，反应与否仍由 AI 提案 + Rules 裁决）。
 *  none = 感知不到也不相关：同一个 Event 不该让所有实体都去打扰 AI。 */
export type WakeGrade = TriggerGrade | 'none';

/** 单个实体的唤醒裁决（可解释：reasons 列出命中了哪些因素） */
export interface WakeAssessment {
  entityId: string;
  grade: WakeGrade;
  /** 判定依据（如 'same_location' / 'involved' / 'witnessed' / 'relationship' / 'not_perceived'） */
  reasons: string[];
}

/** 一次触发评估的完整结论：世界级分级 + 逐实体唤醒 + 是否值得调用 AI */
export interface WakePlan {
  /** 世界级分级（gradeEvents 的结论） */
  worldGrade: TriggerGrade;
  /** 主事件（唤醒评估的锚点，通常是窗口内最高级的玩家发起事实） */
  primaryEventId?: string;
  /** 逐实体唤醒裁决（世界内全部实体，含 none——「谁没被唤醒」也要可查） */
  wakes: WakeAssessment[];
  /** 是否值得调用 AI：存在 high 唤醒。false = 本批事实零 AI 调用（成本闸门） */
  worthWaking: boolean;
}

/** 分级输入的世界事实最小面（引擎 WorldEvent 结构化满足） */
export interface TriggerEventView {
  type: string;
  /** 引擎事件携带的感知边界：只有列名者「看见」了这件事 */
  witnesses?: string[];
  actor?: string;
}

/** 因果关联（V2 · 方案 §二/§九）：以 Journal 为权威的追溯凭据。
 *  引擎 Event 不携带 Evolution 专属字段（Core 纪律）；反向追溯
 *  Event → Run 经管理面 trace API 在 Journal 中完成。 */
export interface EvolutionCausation {
  source: 'evolution';
  evolutionRunId: string;
  proposalId: string;
  changeId: string;
}

/* ---------------- Run（方案 §九：完整因果链的可追溯记录） ---------------- */

/** 一条 Change 的执行状态：独立记录，绝不「部分成功却显示全部成功」 */
export type ChangeStatus = 'accepted' | 'rejected' | 'duplicate';

/** 一条 ProposedChange 的最终裁决：Rules 的裁决就是世界的裁决 */
export interface ChangeOutcome {
  change: ProposedChange;
  /** 归一化后的唯一 ID（与 change.changeId 一致；运行时补发） */
  changeId: string;
  /** 独立执行状态（V2：不再只有 accepted 布尔） */
  status: ChangeStatus;
  /** 兼容字段 = status === 'accepted'（既有观测面平滑过渡） */
  accepted: boolean;
  /** 翻译出的命令（未过白名单的 change 没有 command） */
  command?: { type: string; actorId?: string; targetId?: string; amount?: number; text?: string; payload?: Record<string, unknown> };
  /** 本次派发的命令凭据（幂等与因果链锚点；演化层生成） */
  commandId?: string;
  /** 拒绝环节：translate = 内核白名单外；policy = 策略围栏拒绝；
   *  rules = 引擎规则拒绝；duplicate = 幂等去重跳过 */
  rejectedBy?: 'translate' | 'policy' | 'rules' | 'duplicate';
  reason?: string;
  /** 引擎放行后产生的事实 id（时序）——因果链的「果」 */
  eventIds: string[];
}

/** Proposal/Run 最终状态（方案 §二：禁止「失败但不知道原因」「部分成功显示全部成功」） */
export type EvolutionRunStatus =
  | 'running' // 执行中
  | 'completed' // 全部 change 放行（含零 change：AI 判断无需演化）
  | 'partially_applied' // 部分放行、部分被拒
  | 'rejected' // 有 change 且全部被拒（每条都有原因可查）
  | 'failed'; // 观察/驱动失败（提案都没有，世界未被动过）

/** 一次演化运行的完整留痕：Event → Observation → Context → Proposal → Rules → Mutation → Event */
export interface EvolutionRun {
  id: string;
  worldId: string;
  startedAt: string;
  finishedAt?: string;
  status: EvolutionRunStatus;
  /** 触发来源：admin = 管理台手动；auto = 事件驱动自动；api = 公共 API；
   *  manual 幂等重放时返回既有 run（deduplicated = true） */
  trigger: 'admin' | 'auto' | 'api';
  /** 触发分级依据（auto 触发时记录命中的事件） */
  triggerGrade?: TriggerGrade;
  /** 唤醒计划（P3 Trigger Engine：本 run 由哪个触发评估产出、谁被唤醒、谁没被唤醒） */
  wakePlan?: WakePlan;
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
  /** 本次提案实际影响的实体（去重 targetId；方案 §五 maxEntitiesAffected 的落点） */
  entitiesAffected?: string[];
  /** 本次运行最终产生/关联的全部世界事实 id */
  eventIds: string[];
  /** 幂等重放：同一提案/幂等键命中既有 run，未重复执行（方案 §二.3） */
  deduplicated?: boolean;
  /** 触发时携带的幂等键（落账留痕：进程重启后运行时据此从 Journal 重建幂等账） */
  idempotencyKey?: string;
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

/** 冷却期内触发被拒（auto/api；admin 不受限） */
export class EvolutionCooldownError extends Error {
  constructor(
    message: string,
    public readonly retryInMs: number,
  ) {
    super(message);
  }
}

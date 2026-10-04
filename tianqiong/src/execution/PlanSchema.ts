/* ============================================================
   后果计划契约（《插件化世界模拟架构方案》§15 / §17 / §42 / §47）
   —— AI 与确定性世界之间的交界数据结构。
   铁律 §18：AI 只产出本结构，不得直接修改任何状态；
   本结构的合法性由 validation/ 判定，执行由 execution/ 完成。
   ============================================================ */

/** 单条后果动作（§15）：动作名必须对应某个系统已注册的 Capability（§20） */
export interface ConsequenceAction {
  /** 能力名（如 start_investigation / change_reputation） */
  action: string;
  /** 发起者实体 id */
  actor?: string;
  /** 承受者实体 id */
  target?: string;
  /** 为何发生（§26：因果链必须绑定依据，禁止「因为剧情需要」） */
  reason?: string;
  /** 依据来源实体（势力 / NPC / 任务） */
  source?: string;
  /** 触发该后果的事件 id（§26 trigger_event） */
  triggerEvent?: string;
  /** 动作参数 */
  params?: Record<string, unknown>;
  /** 优先级 0–100（越大越先执行） */
  priority?: number;
}

/** 一次推演产出的完整后果计划 */
export interface ConsequencePlan {
  planId: string;
  /** 触发本次推演的事件 id */
  triggerEvent: string;
  consequences: ConsequenceAction[];
  /** AI 的自然语言解释（§42：解释与严格 JSON 并存，解释不参与执行） */
  narrative?: string;
}

export interface ActionOutcome {
  action: string;
  ok: boolean;
  /** 失败原因 / 执行注记 */
  note?: string;
}

export interface ExecResult {
  planId: string;
  executed: number;
  rejected: number;
  outcomes: ActionOutcome[];
  /** 执行期间由各系统新产生的世界事件（回合闭环 §47） */
  newEvents: string[];
}

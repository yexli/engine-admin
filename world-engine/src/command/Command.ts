/* ============================================================
   命令契约
   ------------------------------------------------------------
   Command 表示「我要让世界做什么」（意图）；Event 表示「世界发生
   了什么」（事实）。两者必须区分：命令可能被规则拒绝，事实不会。

   引擎内置的通用命令形状覆盖最基础的交互（移动 / 攻击 / 交谈 /
   推进时间 / 天气 / 生成实体 / 调整态度）；游戏专属命令经 `custom`
   携带自己的 type 与载荷，由游戏注册的规则处理——引擎不认识
   任何具体游戏，也不该认识。
   ============================================================ */

export interface WorldCommand {
  /** 命令名（snake_case 意图名，如 move / attack / advance_time） */
  type: string;
  /** 幂等键（V2.4-02 · 方案 §二十一，可选）：同键重复提交返回首次结果，不重复执行。
   *  典型来源 = 客户端为一次逻辑操作生成的稳定 id（HTTP 重试安全）。
   *  缺省 = 无幂等（既有行为不变）。 */
  commandId?: string;
  /** 谁做的 */
  actorId?: string;
  /** 对谁 / 到哪 */
  targetId?: string;
  /** 数值参数（伤害 / 刻数 / 好感增量……） */
  amount?: number;
  /** 文本参数（台词 / 天气名……） */
  text?: string;
  /** 其余载荷 */
  payload?: Record<string, unknown>;
}

export interface CommandResult {
  ok: boolean;
  /** 执行期间发布的世界事实（时序） */
  events: string[];
  /** 拒绝原因（ok = false 时） */
  reason?: string;
  /** V2.4-02：幂等命中——本次返回的是首次执行的结果，世界未再次变化 */
  duplicate?: boolean;
}

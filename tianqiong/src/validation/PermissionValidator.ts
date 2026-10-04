/* ============================================================
   权限与合法性校验（《插件化世界模拟架构方案》§16）
   第二道闸。逐条对应方案列出的问题，**已实现的部分写在这里，未实现的也写明**：
     实体是否存在？      ✓ 玩家 / NPC / 地点 / 物品 / 势力 / 声望键 / 委托定义
     目标是否存在？      ✓ 同上（actor / target / source 三者都查）
     动作是否允许？      ✓ 必须已被某系统登记为能力
     权限是否满足？      ✓ 能力是否**已接入执行器**（登记≠有人执行）
     数值是否合法？      ✓ amount / delta / reputation / priority / qty / dv / delayDays
                            （键名白名单 + 强制 number 类型；未列入白名单的键不受限）
     是否超过范围？      ✓ 同上
     是否重复执行？      △ 仅限**同一份计划内**（跨计划去重由处理器自身幂等负责）
     是否违反世界规则？  △ 仅到「实体属于世界书表」这一层
     是否违反时间条件？  ✓ 契约 = SystemSpec.constraints.periods（二期 H-07）
     是否违反空间条件？  ✓ 契约 = SystemSpec.constraints.locations（同上）
                          未声明约束的动作不受限——契约可选是刻意的，避免一次性收紧玩法
   ============================================================ */
import { WB } from '@/data/worldBook';
import { core } from '@/world/WorldState';
import { capabilities } from '@/plugins/CapabilityRegistry';
import { plugins } from '@/plugins/PluginRegistry';
import { sceneTime } from '@/world/WorldClock';
import type { ConsequenceAction } from '@/execution/PlanSchema';

/** 玩家在后果计划中的别名（§15 计划常以「谁受影响」而非实体 id 表述） */
const PLAYER_ALIASES = new Set(['player', 'player_001', 'self']);

/** 零依赖的实体存在性判定：玩家 / NPC / 地点 / 物品 / 势力 / 声望键 / 已接任务 */
export function entityExists(id: string): boolean {
  if (PLAYER_ALIASES.has(id)) return !!core.S;
  if (WB.npcs[id]) return true;
  if (WB.items[id]) return true;
  if (WB.locations[id]) return true;
  if (WB.factions[id]) return true;
  /* 委托定义是世界的静态内容：start_quest 的目标在玩家接取前也应当算「存在」 */
  if ((WB.quests as Record<string, unknown>)[id]) return true;
  const s = core.S;
  if (!s) return false;
  return !!(s.npcs[id] || s.rep[id] !== undefined || s.player.quests[id]);
}

const NUMERIC_GUARDS: Record<string, (v: number) => boolean> = {
  amount: (v) => Number.isFinite(v) && Math.abs(v) <= 1e6,
  delta: (v) => Number.isFinite(v) && Math.abs(v) <= 1000,
  reputation: (v) => Number.isFinite(v) && Math.abs(v) <= 200,
  priority: (v) => Number.isFinite(v) && v >= 0 && v <= 100,
  /* handlers 真的消费、却没有上游守卫的三个键（审查 §数值通道）：
     qty 是物品件数（下游只做 Math.max(0, round())，无上界）、
     dv 是势力↔势力关系增量、delayDays 决定计划事件推迟多久。 */
  qty: (v) => Number.isInteger(v) && v >= 0 && v <= 999,
  dv: (v) => Number.isFinite(v) && Math.abs(v) <= 100,
  delayDays: (v) => Number.isInteger(v) && v >= 0 && v <= 30,
};

export interface PermissionContext {
  /** 本次计划内已出现的动作签名（§16 是否重复执行） */
  applied: Set<string>;
  /** 允许动作的来源事件 id（缺省时校验放宽为仅存在性） */
  triggerEvent?: string;
}

const signature = (a: ConsequenceAction) => a.action + '|' + (a.actor ?? '') + '|' + (a.target ?? '');

/**
 * 单条后果校验。通过返回 null，拒绝返回原因。
 * 关键设计：动作必须已被某个系统注册为能力（§20），否则世界不知道该由谁执行它。
 */
export function validateAction(a: ConsequenceAction, ctx: PermissionContext, index: number): string | null {
  const at = '第 ' + index + ' 条后果';

  /* 两道分明的拒绝（审计整改）：未登记 ≠ 已登记但没接执行器。
     后者此前能通过验证、直到执行期才报「无处理器」——白名单在撒谎。 */
  if (!capabilities.exists(a.action)) return at + ' 的动作未注册：' + a.action;
  if (!capabilities.executable(a.action)) return at + ' 的动作未接入执行器：' + a.action;
  if (ctx.triggerEvent && a.triggerEvent && a.triggerEvent !== ctx.triggerEvent) {
    return at + ' 的 triggerEvent 与计划不一致';
  }

  const sig = signature(a);
  if (ctx.applied.has(sig)) return at + ' 重复执行：' + sig;

  if (a.target && !entityExists(a.target)) return at + ' 的目标实体不存在：' + a.target;
  if (a.actor && !entityExists(a.actor)) return at + ' 的发起实体不存在：' + a.actor;
  if (a.source && !entityExists(a.source)) return at + ' 的依据实体不存在：' + a.source;
  if (!a.reason) return at + ' 缺少因果依据（reason）';

  /* §16 时空条件（二期 H-07）：约束由动作的归属系统声明，未声明即不受限。 */
  const cw = constraintViolation(a.action);
  if (cw) return at + ' ' + cw;

  for (const [k, v] of Object.entries(a.params ?? {})) {
    const guard = NUMERIC_GUARDS[k];
    if (!guard) continue;
    /* 数值参数必须**是数字**：此前的 typeof 前置条件让 "999999999" / "abc" 这类
       字符串完全跳过守卫，而 handler 侧的 Number() 又把它还原成数字写进世界。 */
    if (typeof v !== 'number' || !Number.isFinite(v)) return at + ' 的参数 ' + k + ' 必须是有限数值';
    if (!guard(v)) return at + ' 的参数 ' + k + ' 越界：' + v;
  }
  return null;
}

/**
 * 时空约束校验（§16 / 二期 H-07）。
 * 约束从动作的**归属系统**取（capabilities.owner → plugins.get(owner).constraints），
 * 因此新增约束只需在 systems.ts 声明一条，不必改验证器。
 * 未开局时放行：那时还没有「玩家在哪、什么时辰」可言。
 * 边界：本函数只作用于**后果计划**通道；internal（玩家操作）不经 Validator，
 * 给它们加时空校验需要接在 dispatch 入口，属下一期。
 */
export function constraintViolation(action: string): string | null {
  const owner = capabilities.owner(action);
  if (!owner) return null;
  const c = plugins.get(owner)?.constraints?.[action];
  if (!c) return null;
  const s = core.S;
  if (!s) return null;
  if (c.locations && !c.locations.includes(s.player.loc)) {
    return '的动作在此地不可做：' + action + '（当前在 ' + s.player.loc + '）';
  }
  if (c.periods) {
    const p = sceneTime(s).period;
    if (!c.periods.includes(p)) return '的动作在此刻不可做：' + action + '（当前 ' + p + '）';
  }
  if (c.minLevel !== undefined && s.player.level < c.minLevel) {
    return '的动作需要更高境界：' + action + '（需要 Lv.' + c.minLevel + '）';
  }
  return null;
}

export function permissionContext(): PermissionContext {
  return { applied: new Set<string>() };
}

export function markApplied(ctx: PermissionContext, a: ConsequenceAction): void {
  ctx.applied.add(signature(a));
}

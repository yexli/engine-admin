/* ============================================================
   存档结构校验（F-02 · 导入/载入的统一关口）
   分工：本模块拒绝**结构错乱**（类型不符 / 取值越界 / 引用不存在 /
   未授权脏键 / 带标签字符的姓名）；**字段缺失**不在此拒绝——由
   state.hydrate 按 §4「旧档可读」补默认。两者互补，缺一不可。
   返回 null 表示通过；返回字符串为拒绝原因（供调试与 toast 定位）。
   任何输入都不抛异常：调用方按 null/字符串分支即可。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { affixById } from '@/systems/inventory/Equip';
import { validatePlanShape } from './SchemaValidator';
import { markApplied, permissionContext, validateAction } from './PermissionValidator';
import { runLog } from '@/devlog/RunLog';
import type { ConsequencePlan } from '@/execution/PlanSchema';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** 姓名禁用标签字符：显示安全边界（F-01）兼脏数据闸门 */
const TAG_CHARS = /[<>"'&]/;

/** 「存在即校验、缺失放行」——undefined/null 交给 hydrate 补默认 */
type Check = (v: unknown) => string | null;
const opt = (v: unknown, fn: Check): string | null => (v === undefined || v === null ? null : fn(v));

function checkBag(v: unknown): string | null {
  if (!isArr(v)) return '背包不是数组';
  for (const slot of v) {
    if (!isObj(slot)) return '背包条目不是对象';
    if (!isStr(slot.id) || !WB.items[slot.id]) return '背包含未知物品';
    if (!isNum(slot.qty) || slot.qty < 1) return '背包数量非法';
    /* 卡 I1：实例字段「存在即校验、缺失放行」（旧档 {id,qty} 仍合法） */
    if (slot.uid !== undefined) {
      if (!isStr(slot.uid) || !slot.uid) return '实例 id 非法';
      if (slot.qty !== 1) return '实例数量非法';
    }
    if (slot.q !== undefined && (!isNum(slot.q) || !Number.isInteger(slot.q) || slot.q < 0 || slot.q > 6)) return '品质档非法';
    if (slot.af !== undefined) {
      if (!isArr(slot.af) || !slot.af.every((a) => isStr(a) && !!affixById(a))) return '词缀表非法';
    }
  }
  return null;
}

/** 状态效果表：存在即校验（id 必需，数值字段若存在必须合法） */
function checkEffects(v: unknown, who: string): string | null {
  if (!isArr(v)) return who + '状态效果不是数组';
  for (const e of v) {
    if (!isObj(e) || !isStr(e.id) || !e.id) return who + '状态效果缺少 id';
    if (e.left !== undefined && !isNum(e.left)) return who + '状态效果时长非法';
    if (e.power !== undefined && !isNum(e.power)) return who + '状态效果强度非法';
  }
  return null;
}

/**
 * NPC 条目校验。
 * 原先只查「npcs 是个对象」——条目内部（好感 / 金钱 / 物品栏 / 状态效果）完全不看，
 * 手改存档塞个字符串进来也能过闸。新接入点（gold / bag / effects）在这里补齐形状约束。
 */
function checkNpcs(v: unknown): string | null {
  if (!isObj(v)) return 'npc 状态非法';
  for (const [id, dy] of Object.entries(v)) {
    if (!isObj(dy)) return 'npc 条目非法：' + id;
    if (dy.att !== undefined && !isNum(dy.att)) return 'npc 好感非法：' + id;
    if (dy.gold !== undefined && (!isNum(dy.gold) || dy.gold < 0)) return 'npc 金钱非法：' + id;
    if (dy.bag !== undefined && !isArr(dy.bag)) return 'npc 物品栏非法：' + id;
    if (dy.effects !== undefined) {
      const why = checkEffects(dy.effects, 'npc ' + id + ' 的');
      if (why) return why;
    }
  }
  return null;
}

/** 记忆表：容器 + 逐条最小形状。此前只判容器（同文件对 npcs / bag 是逐条校验的），
    而一条 null 会在日结算的 memoryTick 里抛 TypeError，把当天后续 13 步全部带走。 */
function checkMemories(v: unknown): string | null {
  if (!isObj(v)) return '记忆表非法';
  for (const [owner, list] of Object.entries(v)) {
    if (!isArr(list)) return '记忆列表非法：' + owner;
    for (const m of list) {
      if (!isObj(m)) return '记忆条目非法：' + owner;
      if (!isStr(m.id) || !m.id) return '记忆缺少 id：' + owner;
      if (!isStr(m.status)) return '记忆缺少 status：' + owner;
      if (!isNum(m.createdAt)) return '记忆 createdAt 非法：' + owner;
    }
  }
  return null;
}

/** 信念表：容器 + 逐条最小形状（formBeliefs 每次日结算都要重建并读 proposition） */
function checkBeliefs(v: unknown): string | null {
  if (!isObj(v)) return '信念表非法';
  for (const [owner, list] of Object.entries(v)) {
    if (!isArr(list)) return '信念列表非法：' + owner;
    for (const b of list) {
      if (!isObj(b)) return '信念条目非法：' + owner;
      if (!isStr(b.proposition)) return '信念缺少 proposition：' + owner;
    }
  }
  return null;
}

function checkRepKeys(v: unknown): string | null {
  if (!isObj(v)) return '声望表非法';
  for (const [k, val] of Object.entries(v)) {
    /* 神殿拆五（2026-09）：旧档里的 'temple' 不是脏键，是**拆分之前的合法势力**。
       放行它、让 hydrate 把那笔声望分摊进五殿——这是迁移通道的一部分，
       不是放宽校验：除此之外的任何未知键仍然照拒。 */
    if (!(k in WB.factions) && k !== 'temple') return '未知势力声望：' + k;
    /* 值也要校验：字符串会在 mutate.rep 的 before + delta 里变成 NaN 并永久污染整张表，
       而 rep 过了导入闸之后没有第二道防线（审查 §数值通道）。 */
    if (!isNum(val)) return '声望值非法：' + k;
  }
  return null;
}

export function validateState(raw: unknown): string | null {
  if (!isObj(raw)) return '存档不是对象';
  if (!isNum(raw.ver) || raw.ver < 1) return '缺少版本号';

  const p = raw.player;
  if (!isObj(p)) return '缺少玩家数据';
  if (!isStr(p.name) || p.name.length < 1 || p.name.length > 12 || TAG_CHARS.test(p.name)) return '玩家姓名非法';
  /* 基座字段（loc / race / cls / t）刻意**仍走缺失放行**——§4「旧档可读」是契约，
     校验层不是拦它们的合适位置（有 8 条旧档用例钉着这条）。
     它们的兜底在 hydrate：缺了会补成 plaza / human / warrior / 16，
     「导入一份 {ver, player:{name}} 的档 → 世界以 loc=undefined 启动 → 舞台崩在
     WB.locations[undefined].color 上」那条链路因此断在补默认这一步（2026-09 实测修复）。 */

  const playerChecks: [unknown, string, Check][] = [
    [p.race, '种族非法', (v) => (isStr(v) && WB.races[v] ? null : '种族非法')],
    [p.cls, '职业非法', (v) => (isStr(v) && WB.classes[v] ? null : '职业非法')],
    [p.loc, '所在地点非法', (v) => (isStr(v) && WB.locations[v] ? null : '所在地点非法')],
    [p.level, '等级越界', (v) => (isNum(v) && v >= 1 && v <= 6 ? null : '等级越界')],
    [p.exp, '经验非法', (v) => (isNum(v) ? null : '经验非法')],
    [p.gold, '金币非法', (v) => (isNum(v) && v >= 0 ? null : '金币非法')],
    [p.wanted, '通缉值非法', (v) => (isNum(v) && v >= 0 ? null : '通缉值非法')],
    [p.stats, '属性表非法', (v) => (isObj(v) && Object.values(v).every(isNum) ? null : '属性表非法')],
    [p.equip, '装备栏非法', (v) => (isObj(v) ? null : '装备栏非法')],
    [p.quests, '任务表非法', (v) => (isObj(v) ? null : '任务表非法')],
    [p.flags, '标记表非法', (v) => (isObj(v) ? null : '标记表非法')],
    [p.skills, '技能表非法', (v) => (isArr(v) && v.every((k) => isStr(k) && !!WB.skills[k]) ? null : '技能表非法')],
    [p.bag, '背包非法', checkBag],
    [p.effects, '玩家状态效果非法', (v) => checkEffects(v, '玩家')],
  ];
  for (const [v, , fn] of playerChecks) {
    const why = opt(v, fn);
    if (why) return why;
  }

  const stateChecks: [unknown, Check][] = [
    [raw.t, (v) => (isNum(v) && v >= 0 ? null : '时间非法')],
    [raw.rep, checkRepKeys],
    [raw.npcs, checkNpcs],
    [raw.econ, (v) => (isObj(v) ? null : '经济状态非法')],
    [raw.killed, (v) => (isObj(v) ? null : '击杀表非法')],
    [raw.qf, (v) => (isObj(v) ? null : '标记表非法')],
    [raw.events, (v) => (isArr(v) ? null : '事件表非法')],
    [raw.knowledge, (v) => (isObj(v) ? null : '感知表非法')],
    [raw.memories, checkMemories],
    /* Phase 6 分频记账：存在即校验（旧档没有该键 → 放行，由 hydrate 补） */
    [raw.memTickAt, (v) => (isObj(v) && Object.values(v).every(isNum) ? null : '记忆记账表非法')],
    [raw.beliefs, checkBeliefs],
    [raw.cases, (v) => (isArr(v) ? null : '案件表非法')],
    [raw.history, (v) => (isArr(v) ? null : '历史表非法')],
    [raw.log, (v) => (isArr(v) ? null : '日志表非法')],
  ];
  for (const [v, fn] of stateChecks) {
    const why = opt(v, fn);
    if (why) return why;
  }
  return null;
}

/* ============================================================
   后果计划统一验证入口（《插件化世界模拟架构方案》§16 / §47）
   两道闸串联：形状（SchemaValidator）→ 权限与合法（PermissionValidator）。
   任一不过 = 整份计划拒绝执行，不做部分猜测执行（§42）。
   ============================================================ */
export type PlanVerdict = { ok: true; plan: ConsequencePlan } | { ok: false; error: string; rejectedAt?: number };

export function validatePlan(raw: unknown): PlanVerdict {
  const shape = validatePlanShape(raw);
  if (!shape.ok) {
    runLog.warn('valid', '计划形状不合法，整份拒绝', { why: shape.error });
    return { ok: false, error: shape.error };
  }
  const ctx = permissionContext();
  ctx.triggerEvent = shape.plan.triggerEvent;
  for (let i = 0; i < shape.plan.consequences.length; i++) {
    const a = shape.plan.consequences[i];
    const why = validateAction(a, ctx, i);
    if (why) {
      runLog.warn('valid', '后果未通过校验，整份拒绝', { why, at: i, action: a.action, plan: shape.plan.planId });
      return { ok: false, error: why, rejectedAt: i };
    }
    markApplied(ctx, a);
  }
  return { ok: true, plan: shape.plan };
}

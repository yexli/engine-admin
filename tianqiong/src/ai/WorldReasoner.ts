/* ============================================================
   World Reasoner（《插件化世界模拟架构方案》§12 / §13 / §18 / §35 / §47）
   —— 世界推演器：观察世界 → 理解事件 → 找相关实体 → 分析因果 → 提出后果。
   它不修改世界：产出的 Consequence Plan 必须过 Validator 再交 Executor（§18）。
   缺省不推演：未注入 ReasonerPort 时本模块完全空转，零副作用。
   ============================================================ */
import { withReasonerOrigin, worldBus } from '@/events/EventBus';
import { isNamedPerson } from '@/events/EventSchema';
import { perception } from '@/events/Perception';
import lawRaw from '@/data/world/law.json';
import { world } from '@/world/WorldAPI';
import { core } from '@/world/WorldState';
import { runLog } from '@/devlog/RunLog';
import { memoriesOf } from '@/memory/MemoryStore';
import { persistVectorIndex, warmMemories, warmQuery } from '@/memory/embedding/EmbeddingCache';
import { buildContext, type ContextOptions, type ReasonerContext } from './ContextBuilder';
import { planFrom } from './ConsequencePlanner';
import type { ExecResult } from '@/execution/PlanSchema';
import type { WorldEvent } from '@/events/EventSchema';

export interface ReasonerPort {
  readonly id: string;
  /** 返回 Consequence Plan 原始对象（未验证）；无法推演时返回 null */
  reason(ctx: ReasonerContext): Promise<unknown | null> | unknown | null;
}

let port: ReasonerPort | null = null;

export function setReasonerPort(p: ReasonerPort | null): void {
  port = p;
}

/** 推演通道的自检读数（§30：护栏拦了多少、跳了多少，要能查到） */
export function reasonerStats(): { inflight: number; dropped: number; max: number; aiThisTick: number; budget: number; budgetSkipped: number } {
  return { inflight, dropped, max: MAX_INFLIGHT, aiThisTick, budget: MAX_AI_PER_TICK, budgetSkipped };
}

/**
 * §12 升格表：分级是**默认值**，不是天花板。
 * 玩家砍翻一头野狼是局部事件；有名有姓的人死了会牵出家属、势力、委托、治安与声望——
 * 正是 §23 完整行动示例要求进 World Reasoner 的那类事实。
 * 只对 L2 生效：L0/L1 明确不需要推演，L3 本来就进。
 */
/** 罪案等级（S>A>B>C>D）：S/A/B 够重，C/D 留给订阅者与立案系统 */
const HEAVY_CRIME_GRADES = new Set(['S', 'A', 'B']);
const CRIME_GRADES = (lawRaw as unknown as { crimes?: Record<string, { grade?: string }> }).crimes ?? {};

const ESCALATIONS: Record<string, (e: WorldEvent) => boolean> = {
  /* 名人之死是**接线位**：机制与测试齐备（arch-integration 覆盖立案/亲族/目击者三路），
     但现有玩法里战斗只打怪物（isNamedPerson 恒为假），事件表也还没有发布
     npc_assassinated 的暗杀 / 下毒玩法——链路齐了，等一个产生者。 */
  character_died: (e) => isNamedPerson(e.target, core.S?.npcs),
  npc_missing: (e) => isNamedPerson(e.target, core.S?.npcs),
  /* §12/§34：重罪且有目击者时必须进推演——「目击者所属势力的敌意落到肇事者头上」
     正是 §23 完整行动示例要求的后果链。轻罪与无人目击的罪行留给订阅者与立案系统，
     推演不该被每一起顺手牵羊唤起（§12 的分层不是全量上调）。
     目击名单由感知层判定（事件产生方刻意留空），所以这里读感知表，与 ruleReasoner 同源。 */
  crime_committed: (e) => {
    const grade = CRIME_GRADES[e.target ?? '']?.grade;
    return !!grade && HEAVY_CRIME_GRADES.has(grade) && perception.knowers(e.id, core.S).length > 0;
  },
};

export function isEscalated(e: WorldEvent): boolean {
  return (ESCALATIONS[e.type] ?? (() => false))(e);
}

/** §12 事件分级：Level 3 直接进推演；L2 里「死的是有名有姓的人」这类事实升格进推演 */
export function shouldReason(e: WorldEvent): boolean {
  if (e.level >= 3) return true;
  return e.level >= 2 && isEscalated(e);
}

/**
 * §47 单向闭环：事件 → Context Builder → Reasoner → 计划解析 → Validator → Executor → 新事件。
 * 任一环失败返回 null（拒绝执行），不做部分猜测。
 */
/**
 * §39：推演前预热向量缓存。
 * 检索是同步的、只读缓存——不预热只会退化成关键词召回，不会算出错误结果；
 * 预热本身失败（未配向量模型 / 端点不通）也照常继续，只是没有语义那一维。
 */
async function warmFor(ctx: ReasonerContext): Promise<void> {
  const s = core.S;
  if (!s) return;
  const q = [ctx.trigger.type, ctx.trigger.cause, ctx.trigger.target].filter((x): x is string => !!x).join(' ');
  await warmQuery(q);
  const items: { id: string; ownerId: string; content: string }[] = [];
  for (const ent of ctx.entities) {
    for (const m of memoriesOf(ent.id, s)) {
      if (m.status === 'active') items.push({ id: m.id, ownerId: ent.id, content: m.content });
    }
  }
  await warmMemories(items, ctx.trigger.day);
  /* 预热完顺手落盘：下次启动不必重算（介质没实现向量通道时是空操作） */
  persistVectorIndex();
}

/**
 * 同时进行的推演轮数上限（异步叠加的第二道闸）。
 * 端口自身有超时（配置里的 timeoutMs），所以悬挂的调用不会永久占位；
 * 这里防的是「多轮同时飞」造成的成本叠加。
 */
const MAX_INFLIGHT = 3;
let inflight = 0;
/** 因排队已满被跳过的轮数——静默丢弃和「悄悄不推演」是一回事，得留痕 */
let dropped = 0;

/* ---------------- AI 预算（《NPC 规模化与事件通道方案》改进版 §15 / Phase 5） ----------------
   事件配额与 AI 配额必须分账：处理 64 条事件是廉价的，让 64 条都进 LLM 不是。
   方案给的例子是 Event Budget 64 / AI Budget 10——这里就按这个量级来。
   预算是**按 tick 计**的，用事件自带的 tick 做键，所以不需要外部 hook 进来复位。 */
const MAX_AI_PER_TICK = 10;
let aiTickKey = -1;
let aiThisTick = 0;
/** 因 AI 预算耗尽被跳过的轮数 */
let budgetSkipped = 0;

export async function reasonAbout(e: WorldEvent, opts: ContextOptions = {}): Promise<ExecResult | null> {
  const p = port;
  if (!p || !shouldReason(e)) return null;
  /* §30 推演侧护栏：**推演自己造出来的事实不再触发推演**（一跳即止）。
     判定按事件的 origin 而不是「执行期因果深度」——后者两头都不准：
       · 漏：schedule_event 排的延迟事件隔天才发布，那时深度早归零，跨日自激拦不住；
       · 误杀：外部脚本经 world.execute 注入的 L3 事实不带标记，本不该被拒。
     少了这道闸，模型可以用 create_event 自造一条合格事件、在自己的执行期再次唤起模型。 */
  if (e.origin === 'reasoner') return null;
  if (inflight >= MAX_INFLIGHT) {
    dropped++;
    /* §18/§42：AI 层不写世界状态。这条提示原本落进见闻录（世界状态的一部分），
       玩家可见面改由运行日志面板承担，世界状态里不再出现 AI 模块的写入。 */
    runLog.warn('ai', '推演排队已满，本轮跳过', { trigger: e.type, dropped });
    return null;
  }
  /* Phase 5：本 tick 的 AI 预算。它与事件配额是两本账——
     事件多不代表值得把每一条都送进模型（成本与延迟都在这一侧）。 */
  if (e.tick !== aiTickKey) {
    aiTickKey = e.tick;
    aiThisTick = 0;
  }
  if (aiThisTick >= MAX_AI_PER_TICK) {
    budgetSkipped++;
    runLog.warn('ai', '本 tick 的 AI 预算已用完，本轮跳过', { trigger: e.type, budget: MAX_AI_PER_TICK, skipped: budgetSkipped });
    return null;
  }
  aiThisTick++;
  inflight++;
  /* 关闭日志时连 label 拼接都不做：观测通道不该给热路径留下任何固定开销 */
  const done = runLog.enabled ? runLog.timer('ai', '推演 ' + e.type) : () => 0;
  try {
    /* 先拿一次上下文取得相关角色与查询词，预热后再重建——第二次才带语义召回 */
    await warmFor(buildContext(e, opts));
    const ctx = buildContext(e, opts);
    if (runLog.enabled) {
      runLog.debug('ai', '上下文已装配', {
        trigger: e.type,
        entities: ctx.entities.length,
        witnesses: ctx.witnesses.length,
        capabilities: ctx.capabilities.reduce((n, c) => n + c.capabilities.length, 0),
      });
    }
    const raw = await p.reason(ctx);
    if (!raw) {
      done({ result: 'empty' });
      return null;
    }
    const plan = planFrom(raw);
    if (!plan) {
      runLog.warn('ai', '模型输出未能成为合法计划，本轮不执行', { trigger: e.type });
      done({ result: 'invalid' });
      return null;
    }
    /* 这一轮推演产出的所有事实都带上来源标记（含它安排的延迟事件） */
    const res = withReasonerOrigin(() => world.plan(plan));
    runLog.info('ai', '推演落地', {
      trigger: e.type,
      plan: res.planId,
      executed: res.executed,
      rejected: res.rejected,
      newEvents: res.newEvents.length,
    });
    done({ result: 'executed', executed: res.executed });
    return res;
  } finally {
    inflight--;
  }
}

/** 可选自动接管：订阅全部事件，只对够格的事件（L3 或 L2 升格）触发推演。
 *  缺省不启用，避免隐式异步副作用。推演产物不会再次触发推演（见 reasonAbout 的护栏）。 */
export function attachReasoner(opts: ContextOptions = {}): () => void {
  return worldBus.on(
    '*',
    (e) => {
      void reasonAbout(e, opts);
    },
    'world-reasoner',
  );
}

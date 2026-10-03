/* ============================================================
   Evolution Context Builder（方案 §四：Observation → Context Builder；P4 收口）
   ------------------------------------------------------------
   把引擎的权威事实（World Truth）组装成结构化上下文。与 worldagent
   的 buildWorldContext（给聊天模型的一段散文）不同：演化上下文是
   **结构化数据**——AI 要读字段做跨系统推演，不是陪聊。

   Trigger（P3）决定「谁被唤醒」，本模块决定「被唤醒后看到什么」：
     Global（时间/天气/玩家）+ 当前事件（触发段）
     + 当前地点 + 相关实体（在场实体完整字段，被唤醒者优先）
     + 直接关系 + 近期事件 + 相关记忆（P7 接入位）+ 当前目标（P5 接入位）
   其余实体只进轻量名册（id/type/location）——AI 看得见世界有哪些人，
   但只有眼前的实体的细节可读。世界时间以引擎刻度换算（1 天 = 48 刻）。

   P4 预算（方案 §七）：maxTokens / maxEntities / maxEvents /
   maxRelations / maxMemoryItems。裁剪优先级：当前事件 > 当前位置 >
   相关实体 > 直接关系 > 近期事件 > 长期记忆 > 全局信息——
   触发事件永远保留；实体超限降级名册（不丢名字）；token 超限自
   优先序低处向高处裁：全局名册 → 长期记忆 → 近期事件（最旧先）。
   每一步裁剪计入 budgetReport（失败必须可见：AI 实际看到了什么、
   被裁了什么）。

   纪律：只陈述引擎里有的字段，一个字都不编；读不到就留空，
   不用缺省值冒充事实。喂给 AI 的和 Admin 看到的必须是同一份事实。
   ============================================================ */
import type { EngineClient } from '../types.ts';
import type { ContextBudget, ContextBudgetReport, EvolutionContext, WakePlan } from './types.ts';
import { dayOfTick } from '../npc/calendar.ts';


/** token 估算（确定性、零依赖）：CJK 字符按 1 token、其余按 4 字符 1 token。
 *  只用于预算裁剪口径——不是模型分词器的精确值，误差偏保守（估多不估少）。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch >= '\u3000' && ch <= '\u9fff') cjk++;
    else if (ch >= '\uff00' && ch <= '\uffef') cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/* 引擎 GET /state 响应的最小读取面（允许字段缺失） */
interface StateView {
  t?: number;
  weather?: string;
  player?: { name?: string; loc?: string; bag?: unknown[]; attributes?: Record<string, unknown> };
  npcs?: Record<string, { att?: number; met?: boolean; type?: string; attributes?: Record<string, unknown> }>;
  relations?: { source: string; target: string; type: string; value?: number }[];
  locations?: Record<string, { id?: string; type?: string; attributes?: Record<string, unknown> }>;
}

interface EventView {
  id?: string;
  type?: string;
  day?: number;
  actor?: string;
  target?: string;
  location?: string;
  data?: Record<string, unknown>;
}

export interface BuildEvolutionContextOptions {
  /** 观察窗口：最近 N 条世界事实（缺省 20） */
  eventCount?: number;
  /** 上下文预算（P4）：传入即生效并产出 budgetReport；不传 = 不设限（行为与 P3 前一致） */
  budget?: ContextBudget;
  /** 唤醒计划（P3）：携带时产出 trigger 段，实体细节按「被唤醒者优先」排序 */
  wakePlan?: WakePlan;
  /** 当前目标（P5 Goals 接入位；调用方持有目标事实时传入） */
  goal?: string;
  /** 相关记忆（P7 Memory 接入位；调用方检索后传入，预算按 maxMemoryItems 裁剪） */
  memory?: { ref: string; summary: string; day?: number }[];
}

export async function buildEvolutionContext(
  engine: EngineClient,
  worldId: string,
  opts: BuildEvolutionContextOptions = {},
): Promise<{ ok: true; context: EvolutionContext } | { ok: false; status: number; error: string }> {
  const eventN = Math.max(1, Math.min(200, Math.floor(opts.eventCount ?? 20)));
  const [stateRes, eventsRes] = await Promise.all([engine.getState(worldId), engine.getEvents(worldId, eventN)]);
  if (!stateRes.ok) return { ok: false, status: stateRes.status, error: stateRes.error };
  if (!eventsRes.ok) return { ok: false, status: eventsRes.status, error: eventsRes.error };

  const s = (stateRes.state ?? {}) as StateView;
  const rawEvents = (eventsRes.events ?? []) as EventView[];

  const playerLoc = s.player?.loc ?? '';
  const woken = (opts.wakePlan?.wakes ?? []).filter((w) => w.grade === 'high').map((w) => w.entityId);
  const entities: EvolutionContext['entities'] = {};
  const otherEntities: EvolutionContext['otherEntities'] = [];
  for (const [id, n] of Object.entries(s.npcs ?? {})) {
    const loc = n.attributes?.['location'] !== undefined ? String(n.attributes['location']) : undefined;
    if (loc !== undefined && loc === playerLoc) {
      entities[id] = {
        att: typeof n.att === 'number' ? n.att : 0,
        met: n.met === true,
        ...(n.type !== undefined ? { type: n.type } : {}),
        location: loc,
        ...(n.attributes !== undefined ? { attributes: n.attributes } : {}),
      };
    } else {
      otherEntities.push({ id, ...(n.type !== undefined ? { type: n.type } : {}), ...(loc !== undefined ? { location: loc } : {}) });
    }
  }

  /* 关系边只保留涉及玩家或在场实体的（方案 §五：Relevant Relationships） */
  const relevant = new Set<string>(['player', ...Object.keys(entities)]);
  const relations = (s.relations ?? [])
    .filter((r) => relevant.has(r.source) || relevant.has(r.target))
    .map((r) => ({
      source: r.source,
      target: r.target,
      type: r.type,
      ...(r.value !== undefined ? { value: r.value } : {}),
    }));

  const locRec = playerLoc ? s.locations?.[playerLoc] : undefined;
  /* goal 段的真实来源（P5 · 方案 §八 Current Goal）：个体决策聚焦唯一唤醒实体时，
     取它在引擎里的 goal 属性（宿主约定的 NPC 目标事实）。多实体/无此属性不编造。 */
  let focusGoal: string | undefined;
  if (woken.length === 1) {
    const focusAttr = entities[woken[0]!]?.attributes;
    const g = focusAttr?.['goal'];
    if (typeof g === 'string' && g.trim()) focusGoal = g.trim();
  }
  const context: EvolutionContext = {
    worldId,
    builtAt: new Date().toISOString(),
    tick: typeof s.t === 'number' ? s.t : 0,
    day: typeof s.t === 'number' ? dayOfTick(s.t) : 0,
    weather: s.weather ?? '',
    player: {
      name: s.player?.name ?? 'player',
      loc: playerLoc,
      bagSize: Array.isArray(s.player?.bag) ? s.player.bag.length : 0,
      ...(s.player?.attributes !== undefined ? { attributes: s.player.attributes } : {}),
    },
    ...(playerLoc
      ? {
          location: {
            id: playerLoc,
            ...(locRec?.attributes?.['desc'] !== undefined ? { desc: String(locRec.attributes['desc']) } : {}),
          },
        }
      : {}),
    entities,
    otherEntities,
    relations,
    ...(focusGoal ? { goal: focusGoal } : {}),
    ...(opts.goal ? { goal: opts.goal } : {}),
    ...(opts.memory?.length ? { memory: opts.memory.map((m) => ({ ...m })) } : {}),
    ...(opts.wakePlan ? { trigger: { ...(opts.wakePlan.primaryEventId !== undefined ? { primaryEventId: opts.wakePlan.primaryEventId } : {}), ...(woken.length ? { woken } : {}) } } : {}),
    events: rawEvents
      .filter((e) => typeof e.id === 'string' && typeof e.type === 'string')
      .map((e) => ({
        id: e.id!,
        type: e.type!,
        day: typeof e.day === 'number' ? e.day : 0,
        ...(e.actor !== undefined ? { actor: e.actor } : {}),
        ...(e.target !== undefined ? { target: e.target } : {}),
        ...(e.location !== undefined ? { location: e.location } : {}),
        ...(e.data !== undefined ? { data: e.data } : {}),
      })),
  };

  if (opts.budget) applyContextBudget(context, opts.budget);
  return { ok: true, context };
}

/* ---------------- 预算执行（P4 · 方案 §七） ----------------
   优先级：当前事件 > 当前位置 > 相关实体 > 直接关系 > 近期事件 >
   长期记忆 > 全局信息。位置/玩家/触发段永不裁剪；
   实体超限降级名册；token 超限按 近期事件(最旧先) → 记忆 → 名册 裁。 */
function applyContextBudget(context: EvolutionContext, budget: ContextBudget): void {
  const report: ContextBudgetReport = {
    maxTokens: budget.maxTokens ?? Number.MAX_SAFE_INTEGER,
    estimatedTokens: 0,
    carried: { entities: Object.keys(context.entities).length, events: context.events.length, relations: context.relations.length, memory: context.memory?.length ?? 0 },
    dropped: { entitiesToRoster: 0, events: 0, relations: 0, memory: 0, rosterByTokens: 0 },
  };

  /* 1) maxEvents：触发事件（primary）永远保留，其余保最新（新 → 旧截断） */
  if (budget.maxEvents !== undefined && context.events.length > budget.maxEvents) {
    const primary = context.trigger?.primaryEventId;
    const primaryInList = primary !== undefined && context.events.some((e) => e.id === primary);
    const others = Math.max(0, budget.maxEvents - (primaryInList ? 1 : 0));
    const keepIds = new Set(context.events.slice(0, others).map((e) => e.id));
    if (primaryInList) keepIds.add(primary!);
    const before = context.events.length;
    context.events = context.events.filter((e) => keepIds.has(e.id));
    report.dropped.events = before - context.events.length;
  }

  /* 2) maxEntities：被唤醒者优先保留完整细节，其余降级名册（不丢名字） */
  if (budget.maxEntities !== undefined) {
    const ids = Object.keys(context.entities);
    if (ids.length > budget.maxEntities) {
      const wokenSet = new Set(context.trigger?.woken ?? []);
      const ordered = [...ids].sort((a, b) => Number(wokenSet.has(b)) - Number(wokenSet.has(a)));
      const keepIds = new Set(ordered.slice(0, budget.maxEntities));
      for (const id of ids) {
        if (keepIds.has(id)) continue;
        const e = context.entities[id]!;
        context.otherEntities.push({ id, ...(e.type !== undefined ? { type: e.type } : {}), ...(e.location !== undefined ? { location: e.location } : {}) });
        delete context.entities[id];
        report.dropped.entitiesToRoster++;
      }
    }
  }

  /* 3) maxRelations：涉及玩家/被唤醒实体的边优先 */
  if (budget.maxRelations !== undefined && context.relations.length > budget.maxRelations) {
    const wokenSet = new Set(context.trigger?.woken ?? []);
    const score = (r: { source: string; target: string }): number =>
      (r.source === 'player' || r.target === 'player' ? 2 : 0) + (wokenSet.has(r.source) || wokenSet.has(r.target) ? 1 : 0);
    const ordered = [...context.relations].sort((a, b) => score(b) - score(a));
    const kept = ordered.slice(0, budget.maxRelations);
    report.dropped.relations = context.relations.length - kept.length;
    context.relations = kept;
  }

  /* 4) maxMemoryItems：保最高分（调用方按检索排序传入，高分在前） */
  if (budget.maxMemoryItems !== undefined && context.memory && context.memory.length > budget.maxMemoryItems) {
    report.dropped.memory = context.memory.length - budget.maxMemoryItems;
    context.memory = context.memory.slice(0, budget.maxMemoryItems);
  }

  /* 5) maxTokens：token 压力下的裁剪顺序按方案 §七优先序自低向高——
     全局信息（名册）→ 长期记忆 → 近期事件（最旧先）。
     触发事件/位置/玩家段（最高优先级）永不因 token 裁剪。 */
  if (budget.maxTokens !== undefined) {
    enforceTokenBudget(context, budget.maxTokens, report);
  }

  report.carried = { entities: Object.keys(context.entities).length, events: context.events.length, relations: context.relations.length, memory: context.memory?.length ?? 0 };
  report.estimatedTokens = estimateTokens(renderContextFacts(context));
  context.budgetReport = report;
}

/** token 压力裁剪（可重入）：全局名册 → 记忆 → 近期事件最旧端。
 *  裁无可裁则如实超限（宁超限不撒谎，报告里见）。 */
function enforceTokenBudget(context: EvolutionContext, maxTokens: number, report: ContextBudgetReport): void {
  const primary = context.trigger?.primaryEventId;
  while (estimateTokens(renderContextFacts(context)) > maxTokens) {
    if (context.otherEntities.length > 0) {
      context.otherEntities.pop();
      report.dropped.rosterByTokens++;
      continue;
    }
    if (context.memory && context.memory.length > 0) {
      context.memory.pop(); /* 检索序尾部 = 得分最低 */
      report.dropped.memory++;
      continue;
    }
    const droppable = context.events.filter((e) => e.id !== primary);
    if (droppable.length > 1 || (droppable.length === 1 && context.events.length > 1)) {
      context.events.pop(); /* 最旧端裁一条（新 → 旧序的尾部） */
      report.dropped.events++;
      continue;
    }
    break;
  }
}

/** 记忆注入（P7 · 方案 §十：Retrieval → Ranking → Budget → NPC AI）。
 *  把为焦点实体检索到的记忆写进上下文（按 maxMemoryItems 截断 + token 预算
 *  全量重算）。预算报告缺失时补建——注入后的上下文与报告始终同源。 */
export function applyContextMemory(
  context: EvolutionContext,
  items: { ref: string; summary: string; day?: number }[],
  budget?: ContextBudget,
): void {
  const report: ContextBudgetReport = context.budgetReport ?? {
    maxTokens: budget?.maxTokens ?? Number.MAX_SAFE_INTEGER,
    estimatedTokens: 0,
    carried: { entities: Object.keys(context.entities).length, events: context.events.length, relations: context.relations.length, memory: 0 },
    dropped: { entitiesToRoster: 0, events: 0, relations: 0, memory: 0, rosterByTokens: 0 },
  };
  context.memory = items.map((m) => ({ ...m }));
  if (budget?.maxMemoryItems !== undefined && context.memory.length > budget.maxMemoryItems) {
    report.dropped.memory += context.memory.length - budget.maxMemoryItems;
    context.memory = context.memory.slice(0, budget.maxMemoryItems);
  }
  if (budget?.maxTokens !== undefined) enforceTokenBudget(context, budget.maxTokens, report);
  report.carried.memory = context.memory.length;
  report.estimatedTokens = estimateTokens(renderContextFacts(context));
  context.budgetReport = report;
}

/** 上下文 → 驱动提示词的**事实陈述**段（驱动负责包装自己的指令）。
 *  只做序列化，不做任何叙事加工——喂给 AI 的和 Admin 看到的必须是同一份事实。
 *  段序即方案 §七优先级：当前事件 → 全局/位置 → 实体 → 关系 → 记忆/目标 → 近期事实。 */
export function renderContextFacts(context: EvolutionContext): string {
  const lines: string[] = [];
  if (context.trigger) {
    lines.push(
      `当前事件（触发评估）：${context.trigger.primaryEventId ?? '-'}${
        context.trigger.woken?.length ? `，被唤醒实体：${context.trigger.woken.join('、')}` : '，无实体达到唤醒线'
      }`,
    );
  }
  lines.push(`世界 ${context.worldId}：第 ${context.day} 天，刻度 ${context.tick}，天气 ${context.weather || '未知'}`);
  lines.push(
    `玩家 ${context.player.name} 在 ${context.player.loc || '未知'}（随身 ${context.player.bagSize} 项）${
      context.player.attributes ? ` attributes=${JSON.stringify(context.player.attributes)}` : ''
    }`,
  );
  if (context.location) lines.push(`当前地点：${context.location.id}${context.location.desc ? `（${context.location.desc}）` : ''}`);
  if (context.goal) lines.push(`当前目标：${context.goal}`);
  const ids = Object.keys(context.entities);
  if (ids.length) {
    lines.push(
      `在场实体（完整字段）：\n${ids
        .map((id) => {
          const e = context.entities[id]!;
          return `- ${id}（${e.type ?? 'entity'}）att=${e.att} ${e.met ? '已认识玩家' : '未见过玩家'}${
            e.attributes ? ` attributes=${JSON.stringify(e.attributes)}` : ''
          }`;
        })
        .join('\n')}`,
    );
  }
  if (context.otherEntities.length) {
    lines.push(
      `世界其余实体（名册，细节不可见）：\n${context.otherEntities
        .map((e) => `- ${e.id}${e.type ? `（${e.type}）` : ''}${e.location ? ` @ ${e.location}` : ''}`)
        .join('\n')}`,
    );
  }
  if (context.relations.length) {
    lines.push(
      `相关关系：\n${context.relations
        .map((r) => `- ${r.source} → ${r.target} [${r.type}]${r.value !== undefined ? ` = ${r.value}` : ''}`)
        .join('\n')}`,
    );
  }
  if (context.memory?.length) {
    lines.push(
      `相关记忆：\n${context.memory
        .map((m) => `- [${m.ref}]${m.day !== undefined ? ` D${m.day}` : ''} ${m.summary}`)
        .join('\n')}`,
    );
  }
  if (context.events.length) {
    lines.push(
      `最近世界事实（新 → 旧）：\n${context.events
        .map(
          (e) =>
            `- [${e.id}] D${e.day} ${e.type}${e.actor ? ` actor=${e.actor}` : ''}${e.target ? ` target=${e.target}` : ''}${
              e.location ? ` @ ${e.location}` : ''
            }${e.data ? ` data=${JSON.stringify(e.data)}` : ''}`,
        )
        .join('\n')}`,
    );
  }
  return lines.join('\n');
}

/* ============================================================
   Trigger Engine · Runtime（P3 · 方案 §六：平台内的自动触发循环）
   ------------------------------------------------------------
   P2 之前「High 事件 → 触发演化」的接线住在参考宿主（3s 轮询 +
   POST tick）；P3 把它收进平台进程，成为演化运行时的正式前置级：

     轮询世界事实（幂等消费去重）
       → 只认玩家发起的事实（AI 禁触玩家 ⇒ 玩家发起的事件绝不
          可能是演化产物——结构性断环，无「演化触发演化」）
       → 世界级分级（gradeEvents）：非 High 不打扰 AI
       → 逐实体唤醒评估（assessWake）：无人值得唤醒 → 零 AI 调用
       → evolution.tick(auto, 幂等键 auto:{world}:{eventId}, wakePlan)

   与宿主共存安全：平台与游戏方可能同时触发同一个事件——双方用
   同一幂等键约定（auto:{world}:{eventId}），演化运行时的幂等层
   （P1 封口）保证只执行一次，后到者拿到 deduplicated 结果。

   触发器自己不持任何状态写入口：它只会「决定要不要调 tick」，
   对世界的影响仍然全部走 Proposal → Rules → Mutation。
   ============================================================ */
import type { EngineClient } from '../types.ts';
import { gradeEvents } from './policy.ts';
import { assessWake, wakeEventsOf, wakeStateViewOf, type WakeOptions } from './wake.ts';
import { EvolutionCooldownError, type TriggerEventView, type WakePlan } from './types.ts';
import { createFingerprintTracker } from '../runtime/fingerprint.ts';

/** tick 的最小结构面（避免与 EvolutionRuntime 类型互相锁定；测试可注入假件） */
export interface TriggerEvolutionFacade {
  tick(worldId: string, trigger: 'auto', opts?: { idempotencyKey?: string; wakePlan?: WakePlan }): Promise<{ id: string; status: string; eventIds?: string[] }>;
}

export interface TriggerRuntimeOptions {
  engine: EngineClient;
  /** 演化运行时（只用到 tick；触发器无其他影响力） */
  evolution: TriggerEvolutionFacade;
  /** 要守护的世界（显式声明——平台是多世界托管面，不为所有世界默默烧 AI） */
  worlds: readonly string[];
  /** 轮询间隔毫秒（缺省 3000，下限 250） */
  intervalMs?: number;
  /** 每次读取的最近事件数（缺省 30） */
  eventWindow?: number;
  /** 消费者 id（多触发器各持各的 seen 集） */
  consumerId?: string;
  /** 唤醒评估参数（关系/态度阈值；分级覆盖表） */
  wake?: WakeOptions;
  /** 日志出口（缺省静默；dev-stack 注入 console） */
  log?: (line: string) => void;
  /** 多代世界指纹检测周期（每 N 轮轮询比对一次 seed；缺省 10，首轮必检） */
  fingerprintEvery?: number;
}

export interface TriggerWorldStatus {
  worldId: string;
  polls: number;
  lastPollAt?: string;
  lastEventId?: string;
  lastPlan?: WakePlan;
  ticksFired: number;
  skippedNotHigh: number;
  skippedNoWake: number;
  skippedNoPlayerEvent: number;
  cooldownSkips: number;
  errors: number;
  /** 世界重建检测并重置消费集的次数（P9 多代世界语义） */
  worldResets: number;
}

export interface TriggerRuntime {
  start(): void;
  stop(): void;
  running(): boolean;
  /** 各世界触发状态（观测；管理面/日志的同一个真相） */
  status(): { running: boolean; intervalMs: number; worlds: TriggerWorldStatus[] };
  /** 指定世界最近一次唤醒计划（未评估过 = null） */
  planOf(worldId: string): WakePlan | null;
  /** 立即轮询一轮（测试/手动触发用；不改变定时器） */
  pollOnce(): Promise<void>;
}

export function createTriggerRuntime(opts: TriggerRuntimeOptions): TriggerRuntime {
  const intervalMs = Math.max(250, Math.floor(opts.intervalMs ?? 3000));
  const eventWindow = Math.max(1, Math.min(200, Math.floor(opts.eventWindow ?? 30)));
  const log = opts.log ?? (() => {});
  const worlds = [...opts.worlds];

  interface WorldState extends TriggerWorldStatus {
    seen: Set<string>;
    seenOrder: string[];
    born: Set<string>; /* 演化产物事实 id（双保险：玩家归因过滤之外的第二道断环） */
    worldResets: number; /* 世界重建检测（指纹变更）：seen/born 重置计数（P9） */
  }
  const fingerprints = createFingerprintTracker(opts.engine);
  const fingerprintEvery = Math.max(1, Math.floor(opts.fingerprintEvery ?? 10));
  const states = new Map<string, WorldState>();
  for (const worldId of worlds) {
    states.set(worldId, { worldId, polls: 0, ticksFired: 0, skippedNotHigh: 0, skippedNoWake: 0, skippedNoPlayerEvent: 0, cooldownSkips: 0, errors: 0, seen: new Set(), seenOrder: [], born: new Set(), worldResets: 0 });
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let stopped = true;

  function markSeen(st: WorldState, id: string): boolean {
    if (st.seen.has(id)) return false;
    st.seen.add(id);
    st.seenOrder.push(id);
    if (st.seenOrder.length > 2000) {
      const drop = st.seenOrder.splice(0, st.seenOrder.length - 2000);
      for (const d of drop) st.seen.delete(d);
    }
    return true;
  }

  /** 玩家发起的事实才值得唤醒演化。AI 禁触玩家（NPC_EVOLUTION_POLICY）⇒
     玩家归因的事件不可能是演化产物；born 集合兜底非围栏装配。 */
  function playerAttributed(st: WorldState, e: TriggerEventView & { id?: string }): boolean {
    if (e.id !== undefined && st.born.has(e.id)) return false;
    return e.actor === 'player' || e.type === 'player_moved';
  }

  async function pollOnce(): Promise<void> {
    if (polling) return; /* 上一轮未结束不重入（慢模型/慢引擎不堆轮次） */
    polling = true;
    try {
      for (const st of states.values()) {
        st.polls++;
        st.lastPollAt = new Date().toISOString();
        try {
          /* 多代世界检测（P9）：世界重建 → 事件 id 复用，seen 集合需重置 */
          if (st.polls === 1 || st.polls % fingerprintEvery === 0) {
            const fp = await fingerprints.check(st.worldId);
            if (fp.changed) {
              st.seen.clear();
              st.seenOrder.length = 0;
              st.born.clear();
              st.worldResets++;
              log(`[trigger] ${st.worldId}：检测到世界重建（seed 变更），消费集已重置（第 ${st.worldResets} 次）`);
            }
          }
          const res = await opts.engine.getEvents(st.worldId, eventWindow);
          if (!res.ok) {
            st.errors++;
            continue;
          }
          const raw = (res.events ?? []) as (TriggerEventView & { id?: string; location?: string; target?: string; data?: Record<string, unknown> })[];
          const fresh = raw.filter((e) => {
            if (e.id === undefined) return true; /* 无 id 无法去重，按新事实处理 */
            return markSeen(st, e.id); /* 幂等：replay/重叠窗口不重复消费 */
          });
          if (!fresh.length) continue;
          st.lastEventId = fresh[0]?.id ?? st.lastEventId;

          const playerFresh = fresh.filter((e) => playerAttributed(st, e));
          if (!playerFresh.length) {
            st.skippedNoPlayerEvent++;
            continue; /* 只有 NPC/系统事实：演化产物或日程效果，不触发 */
          }
          const grade = gradeEvents(wakeEventsOf(playerFresh), opts.wake);
          if (grade !== 'high') {
            st.skippedNotHigh++;
            log(`[trigger] ${st.worldId}：新事实 ${fresh.length} 条（玩家发起 ${playerFresh.length}）分级 ${grade} —— 不打扰 AI`);
            continue;
          }

          /* 唤醒评估：需要世界状态投影（实体位置/关系/见过/态度） */
          const stateRes = await opts.engine.getState(st.worldId);
          if (!stateRes.ok) {
            st.errors++;
            continue;
          }
          const plan = assessWake(wakeStateViewOf(stateRes.state as Parameters<typeof wakeStateViewOf>[0]), wakeEventsOf(playerFresh), opts.wake);
          st.lastPlan = plan;
          if (!plan.worthWaking) {
            st.skippedNoWake++;
            const woken = plan.wakes.filter((w) => w.grade !== 'none').length;
            log(`[trigger] ${st.worldId}：High 事实（${plan.primaryEventId ?? '-'}）但无人值得唤醒（${plan.wakes.length} 实体中 ${woken} 个 low/medium）—— 零 AI 调用`);
            continue;
          }

          const woken = plan.wakes.filter((w) => w.grade === 'high').map((w) => w.entityId);
          /* P5 个体决策（方案 §八核心循环）：每个 HIGH 唤醒实体各跑一次聚焦 tick——
             wakePlan 只留它一个 HIGH（context.trigger.woken = [npc]，驱动器以它的
             视角判断），幂等键按事件+实体分键，冷却/指纹按焦点分域（runtime）。
             「100 个 NPC 存在 ≠ 100 个 NPC 同时思考」：只有真正被唤醒的才思考，
             一个事件至多产生 woken.length 次 AI 调用。 */
          const eventId = plan.primaryEventId ?? fresh[0]!.id ?? 'batch';
          /* 幂等键含世界实例指纹（P9）：不同代世界的同 id 事件互不串挡 */
          const gen = fingerprints.known(st.worldId) ?? 0;
          for (const npc of woken) {
            const npcPlan: typeof plan = {
              ...plan,
              wakes: plan.wakes.map((w) => (w.entityId === npc ? w : { ...w, grade: 'none' as typeof w.grade, reasons: [...w.reasons, 'not_this_focus'] })),
            };
            log(`[trigger] ${st.worldId}：High 事实 ${eventId} 唤醒 ${npc}（其余 ${plan.wakes.length - 1} 实体未唤醒）→ 个体演化 tick`);
            const key = `auto:${st.worldId}:${gen}:${eventId}:${npc}`;
            try {
              const run = await opts.evolution.tick(st.worldId, 'auto', { idempotencyKey: key, wakePlan: npcPlan });
              st.ticksFired++;
              for (const id of run.eventIds ?? []) st.born.add(id); /* 演化产物不再触发（双保险断环） */
              if (run.status === 'completed' || run.status === 'partially_applied' || run.status === 'rejected') {
                log(`[trigger] ${st.worldId}：run ${run.id} ${run.status}（${npc}）`);
              }
            } catch (e) {
              if (e instanceof EvolutionCooldownError) {
                st.cooldownSkips++;
                log(`[trigger] ${st.worldId}：${npc} 的个体演化冷却中，本批跳过（${Math.ceil(e.retryInMs / 1000)}s）`);
              } else {
                throw e;
              }
            }
          }
          if (woken.length === 0) {
            /* 不可达（worthWaking=true 蕴含存在 high）；防御性兜底 */
            log(`[trigger] ${st.worldId}：唤醒计划异常（worthWaking 无 high），跳过`);
          }
        } catch (e) {
          if (e instanceof EvolutionCooldownError) {
            st.cooldownSkips++;
            log(`[trigger] ${st.worldId}：演化冷却中，本批事实跳过（${Math.ceil(e.retryInMs / 1000)}s 后可再触发）`);
          } else {
            st.errors++;
            log(`[trigger] ${st.worldId}：轮询失败 —— ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    } finally {
      polling = false;
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setInterval(() => void pollOnce(), intervalMs);
      log(`[trigger] Trigger Runtime 已启动：守护 ${worlds.join(', ') || '（无世界）'}，间隔 ${intervalMs}ms`);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      log('[trigger] Trigger Runtime 已停止');
    },
    running: () => !stopped,
    status: () => ({
      running: !stopped,
      intervalMs,
      worlds: worlds.map((worldId) => {
        const st = states.get(worldId)!;
        return {
          worldId,
          polls: st.polls,
          ...(st.lastPollAt !== undefined ? { lastPollAt: st.lastPollAt } : {}),
          ...(st.lastEventId !== undefined ? { lastEventId: st.lastEventId } : {}),
          ...(st.lastPlan !== undefined ? { lastPlan: st.lastPlan } : {}),
          ticksFired: st.ticksFired,
          skippedNotHigh: st.skippedNotHigh,
          skippedNoWake: st.skippedNoWake,
          skippedNoPlayerEvent: st.skippedNoPlayerEvent,
          cooldownSkips: st.cooldownSkips,
          errors: st.errors,
          worldResets: st.worldResets,
        };
      }),
    }),
    planOf: (worldId) => states.get(worldId)?.lastPlan ?? null,
    pollOnce,
  };
}

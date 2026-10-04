/* ============================================================
   NPC Runtime · Schedule Runtime（P6 · 方案 §九：平台内的确定性作息循环）
   ------------------------------------------------------------
   方案 §九的分工：
     Engine   时间 / 时钟事实（advance_time / new_day / hour_advanced）
     Schedule 作息对齐（本模块：读权威状态 → 比对日程 → move_entity 命令）
     AI       异常行为 / 临时决定 / 复杂社交选择（Trigger → Context → AI）

   禁止「每分钟调用一次 AI」——本循环只做确定性对齐，**零 AI 调用**；
   AI 只在 Trigger 判定「真正需要判断」时被唤醒（P3 触发器，独立循环）。

   循环：轮询世界事实（幂等消费）→ 出现时间类新事实（new_day /
   hour_advanced / time_advanced）或启动 → applyNpcSchedule（幂等：
   已对齐零命令）。位置只能被命令改变，时间事实是对齐的唯一驱动——
   没有时间推进就不会有新的对齐需求，因此不做无意义的周期读状态。

   双驱动共存安全：宿主可在输入时立即对齐（快速反馈），本循环是
   权威兜底（为没有宿主循环的世界工作）。对齐天然幂等——已对齐
   零命令，双驱动的竞态窗口只会多读一次状态，不会重复移动。
   ============================================================ */
import type { EngineClient } from '../types.ts';
import { applyNpcSchedule, type NpcScheduleTable } from './schedule.ts';
import { syncNpcStates } from './state.ts';
import type { ScheduleStore } from './scheduleStore.ts';
import { createFingerprintTracker } from '../runtime/fingerprint.ts';

const TIME_EVENT_TYPES = new Set(['new_day', 'hour_advanced', 'time_advanced']);

export interface ScheduleRuntimeOptions {
  engine: EngineClient;
  /** 日程数据源（游戏方经管理面注册；无日程的世界自动跳过） */
  store: ScheduleStore;
  /** 限定守护的世界（缺省 = store 里注册过的全部世界） */
  worlds?: readonly string[];
  /** 轮询间隔毫秒（缺省 3000，下限 250） */
  intervalMs?: number;
  /** 日程对齐是游戏数据 → 找不到实体等拒绝只记录不重试 */
  log?: (line: string) => void;
  /** 多代世界指纹检测周期（缺省 10，首轮必检） */
  fingerprintEvery?: number;
}

export interface ScheduleWorldStatus {
  worldId: string;
  scheduledNpcs: number;
  polls: number;
  alignments: number;
  movedTotal: number;
  rejectedTotal: number;
  lastAlignAt?: string;
  lastTickOfDay?: number;
  errors: number;
  /** 世界重建检测并重置消费集的次数（P9 多代世界语义） */
  worldResets: number;
}

export interface ScheduleRuntime {
  start(): void;
  stop(): void;
  running(): boolean;
  status(): { running: boolean; intervalMs: number; worlds: ScheduleWorldStatus[] };
  /** 立即轮询一轮（测试/手动；不改定时器） */
  pollOnce(): Promise<void>;
  /** 立即对齐一个世界（启动/时间事件之外的显式入口） */
  align(worldId: string): Promise<void>;
}

export function createScheduleRuntime(opts: ScheduleRuntimeOptions): ScheduleRuntime {
  const intervalMs = Math.max(250, Math.floor(opts.intervalMs ?? 3000));
  const log = opts.log ?? (() => {});
  const worlds = opts.worlds ?? opts.store.worlds();

  const fingerprints = createFingerprintTracker(opts.engine);
  const fingerprintEvery = Math.max(1, Math.floor(opts.fingerprintEvery ?? 10));

  interface WorldState extends ScheduleWorldStatus {
    seen: Set<string>;
    seenOrder: string[];
  }
  const states = new Map<string, WorldState>();
  for (const worldId of worlds) {
    const table = opts.store.get(worldId);
    states.set(worldId, {
      worldId,
      scheduledNpcs: table ? Object.keys(table).length : 0,
      polls: 0,
      alignments: 0,
      movedTotal: 0,
      rejectedTotal: 0,
      errors: 0,
      seen: new Set(),
      seenOrder: [],
      worldResets: 0,
    });
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let stopped = true;

  /* 动态纳管：游戏方可在运行中注册日程（PUT 管理面端点）——每轮轮询前
     与 store 对齐世界集（显式声明 worlds 时世界集固定）。 */
  function syncWorlds(): void {
    if (opts.worlds) return;
    for (const worldId of opts.store.worlds()) {
      if (states.has(worldId)) continue;
      const table = opts.store.get(worldId);
      states.set(worldId, {
        worldId,
        scheduledNpcs: table ? Object.keys(table).length : 0,
        polls: 0,
        alignments: 0,
        movedTotal: 0,
        rejectedTotal: 0,
        errors: 0,
        seen: new Set(),
        seenOrder: [],
        worldResets: 0,
      });
      log(`[schedule] ${worldId}：日程已注册，纳入守护（${Object.keys(table ?? {}).length} 个 NPC）`);
    }
  }

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

  async function align(worldId: string): Promise<void> {
    const st = states.get(worldId);
    const table: NpcScheduleTable | null = opts.store.get(worldId);
    if (!st || !table || Object.keys(table).length === 0) return;
    const result = await applyNpcSchedule(opts.engine, worldId, table);
    st.alignments++;
    st.movedTotal += result.moved.length;
    st.rejectedTotal += result.rejected.length;
    st.lastTickOfDay = result.tickOfDay;
    st.lastAlignAt = new Date().toISOString();
    for (const m of result.moved) log(`[schedule] ${worldId}：${m.id} 按日程归位 ${m.from} → ${m.to}（事实 ${m.eventIds.join(',')}）`);
    for (const r of result.rejected) log(`[schedule] ${worldId}：${r.id} → ${r.to} 被拒绝：${r.reason}`);
    /* V2.4-04：状态视图同步（确定性推导，幂等——同态零命令，零 AI） */
    const sync = await syncNpcStates(opts.engine, worldId, table);
    for (const tr of sync.transitions) log(`[schedule] ${worldId}：${tr.id} 状态 ${tr.from ?? '（无）'} → ${tr.to}（事实 ${tr.eventIds.join(',')}）`);
    for (const r of sync.rejected) log(`[schedule] ${worldId}：${r.id} 状态同步被拒：${r.reason}`);
  }

  async function pollOnce(): Promise<void> {
    if (polling) return; /* 上一轮未结束不重入 */
    polling = true;
    try {
      syncWorlds();
      for (const st of states.values()) {
        st.polls++;
        try {
          /* 多代世界检测（P9）：世界重建 → 时间事实 id 复用 */
          if (st.polls === 1 || st.polls % fingerprintEvery === 0) {
            const fp = await fingerprints.check(st.worldId);
            if (fp.changed) {
              st.seen.clear();
              st.seenOrder.length = 0;
              st.worldResets++;
              log(`[schedule] ${st.worldId}：检测到世界重建（seed 变更），消费集已重置（第 ${st.worldResets} 次）`);
            }
          }
          const res = await opts.engine.getEvents(st.worldId, 30);
          if (!res.ok) {
            st.errors++;
            continue;
          }
          let hasTimeEvent = false;
          for (const e of res.events ?? []) {
            const id = (e as { id?: string }).id;
            if (typeof id !== 'string') continue;
            if (!markSeen(st, id)) continue;
            if (TIME_EVENT_TYPES.has((e as { type?: string }).type ?? '')) hasTimeEvent = true;
          }
          /* 启动后的首轮：无论有无新时间事实都对齐一次（引擎刚重启/世界刚建好） */
          if (hasTimeEvent || st.alignments === 0) {
            await align(st.worldId);
          }
        } catch (e) {
          st.errors++;
          log(`[schedule] ${st.worldId}：轮询失败 —— ${e instanceof Error ? e.message : String(e)}`);
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
      log(`[schedule] Schedule Runtime 已启动：守护 ${[...states.keys()].join(', ') || '（无世界）'}，间隔 ${intervalMs}ms（确定性对齐，零 AI 调用）`);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      log('[schedule] Schedule Runtime 已停止');
    },
    running: () => !stopped,
    status: () => ({
      running: !stopped,
      intervalMs,
      worlds: worlds.map((worldId) => {
        const st = states.get(worldId)!;
        return {
          worldId,
          scheduledNpcs: st.scheduledNpcs,
          polls: st.polls,
          alignments: st.alignments,
          movedTotal: st.movedTotal,
          rejectedTotal: st.rejectedTotal,
          ...(st.lastAlignAt !== undefined ? { lastAlignAt: st.lastAlignAt } : {}),
          ...(st.lastTickOfDay !== undefined ? { lastTickOfDay: st.lastTickOfDay } : {}),
          errors: st.errors,
          worldResets: st.worldResets,
        };
      }),
    }),
    pollOnce,
    align,
  };
}

/* ============================================================
   Memory Runtime（P7 · 方案 §十：平台内的记忆摄取循环）
   ------------------------------------------------------------
   Event → Memory Candidate → Memory Store：轮询世界事实（幂等），
   读一次世界状态快照（派生感知边界），按世界摄取进 world-memory。
   new_day 事实触发世界日推进（衰减 + 遗忘）。

   **零 AI 调用**：摄取是确定性的记录行为——「谁看见了什么就记住
   什么」；记忆如何影响行为是检索侧（evolution 个 体决策的
   context.memory）与 Rules 的事。

   双驱动共存安全：宿主/其它进程亦可喂记忆（服务按事实 id 幂等）；
   平台循环是权威兜底（为没有宿主记忆管线的世界工作）。
   ============================================================ */
import type { EngineClient } from '../types.ts';
import type { WorldMemoryService } from './service.ts';

export interface MemoryRuntimeOptions {
  engine: EngineClient;
  service: WorldMemoryService;
  /** 要守护的世界（显式声明；缺省 = 服务里已有数据的世界） */
  worlds?: readonly string[];
  /** 轮询间隔毫秒（缺省 3000，下限 250） */
  intervalMs?: number;
  /** 每次读取的最近事件数（缺省 30） */
  eventWindow?: number;
  log?: (line: string) => void;
}

export interface MemoryWorldStatus {
  worldId: string;
  polls: number;
  ingestedTotal: number;
  duplicatesTotal: number;
  dayTicks: number;
  lastDay?: number;
  errors: number;
  /** 世界重建检测并重置消费集的次数（P9 多代世界语义） */
  worldResets: number;
}

export interface MemoryRuntime {
  start(): void;
  stop(): void;
  running(): boolean;
  status(): { running: boolean; intervalMs: number; worlds: MemoryWorldStatus[] };
  /** 立即轮询一轮（测试/手动；不改定时器） */
  pollOnce(): Promise<void>;
}

export function createMemoryRuntime(opts: MemoryRuntimeOptions): MemoryRuntime {
  const intervalMs = Math.max(250, Math.floor(opts.intervalMs ?? 3000));
  const eventWindow = Math.max(1, Math.min(200, Math.floor(opts.eventWindow ?? 30)));
  const log = opts.log ?? (() => {});
  const worlds = [...(opts.worlds ?? opts.service.worlds())];

  const worldSeeds = new Map<string, number>();
  interface WorldState extends MemoryWorldStatus {
    seen: Set<string>;
    seenOrder: string[];
  }
  const states = new Map<string, WorldState>();
  for (const worldId of worlds) {
    states.set(worldId, { worldId, polls: 0, ingestedTotal: 0, duplicatesTotal: 0, dayTicks: 0, errors: 0, seen: new Set(), seenOrder: [], worldResets: 0 });
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

  async function pollOnce(): Promise<void> {
    if (polling) return; /* 上一轮未结束不重入 */
    polling = true;
    try {
      for (const st of states.values()) {
        st.polls++;
        try {
          const res = await opts.engine.getEvents(st.worldId, eventWindow);
          if (!res.ok) {
            st.errors++;
            continue;
          }
          const raw = (res.events ?? []) as { id?: string; type?: string; day?: number; actor?: string; target?: string; location?: string; witnesses?: string[]; data?: Record<string, unknown> }[];
          const fresh = raw.filter((e) => e.id !== undefined && e.type !== undefined && markSeen(st, e.id!));
          if (!fresh.length) continue;

          /* 感知边界派生需要世界状态快照：每批读一次（摄取侧只读） */
          const stateRes = await opts.engine.getState(st.worldId);
          if (!stateRes.ok) {
            st.errors++;
            continue;
          }
          const s = stateRes.state as { seed?: number; player?: { loc?: string }; npcs?: Record<string, { attributes?: Record<string, unknown> }> };
          /* 多代世界检测（P9）：状态快照里顺手比对 seed（零额外读取）。
             setWorldSeed 把种子持久化到服务去重账旁——平台重启后仍能识别代际。 */
          if (typeof s.seed === 'number') {
            const prev = worldSeeds.get(st.worldId);
            worldSeeds.set(st.worldId, s.seed);
            opts.service.setWorldSeed(st.worldId, s.seed);
            if (prev !== undefined && prev !== s.seed) {
              st.seen.clear();
              st.seenOrder.length = 0;
              opts.service.resetSeen(st.worldId);
              st.worldResets++;
              log(`[memory] ${st.worldId}：检测到世界重建（seed 变更），消费集已重置（第 ${st.worldResets} 次）`);
            }
          }
          const npcLocations: Record<string, string> = {};
          for (const [id, n] of Object.entries(s.npcs ?? {})) {
            const loc = n.attributes?.['location'];
            if (typeof loc === 'string') npcLocations[id] = loc;
          }

          const created = opts.service.ingest(
            st.worldId,
            fresh.map((e) => ({ id: e.id, type: e.type, day: e.day, actor: e.actor, target: e.target, location: e.location, witnesses: e.witnesses, data: e.data })),
            { ...(s.player?.loc !== undefined ? { playerLoc: s.player.loc } : {}), npcLocations },
          );
          st.ingestedTotal += created;
          if (created > 0) log(`[memory] ${st.worldId}：摄取 ${created} 条记忆（事实 ${fresh.length} 条）`);

          /* new_day → 世界日推进（衰减 + 遗忘；幂等：同日重复推进为 0） */
          const dayEvent = fresh.filter((e) => e.type === 'new_day').sort((a, b) => (b.day ?? 0) - (a.day ?? 0))[0];
          if (dayEvent && typeof dayEvent.day === 'number') {
            const forgotten = opts.service.dayTick(st.worldId, dayEvent.day);
            st.dayTicks++;
            st.lastDay = dayEvent.day;
            if (forgotten > 0) log(`[memory] ${st.worldId}：D${dayEvent.day} 衰减完成，遗忘 ${forgotten} 条`);
          }
        } catch (e) {
          st.errors++;
          log(`[memory] ${st.worldId}：轮询失败 —— ${e instanceof Error ? e.message : String(e)}`);
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
      log(`[memory] Memory Runtime 已启动：守护 ${worlds.join(', ') || '（无世界）'}，间隔 ${intervalMs}ms（确定性摄取，零 AI 调用）`);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      log('[memory] Memory Runtime 已停止');
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
          ingestedTotal: st.ingestedTotal,
          duplicatesTotal: st.duplicatesTotal,
          dayTicks: st.dayTicks,
          ...(st.lastDay !== undefined ? { lastDay: st.lastDay } : {}),
          errors: st.errors,
          worldResets: st.worldResets,
        };
      }),
    }),
    pollOnce,
  };
}

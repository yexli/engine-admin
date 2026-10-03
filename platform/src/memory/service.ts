/* ============================================================
   World Memory Service（P7 · 方案 §十：Memory 与 NPC Runtime 联动）
   ------------------------------------------------------------
   平台内的角色记忆服务：把 world-memory 引擎（独立包，4 因子召回）
   按世界装配起来，并向两侧各提供一个窄口子——

     写侧（Event → Memory Candidate → Store）：
       ingest(worldId, facts, snapshot) —— 引擎事实按**感知边界**
       派生目击者（引擎 coreRules 不填 witnesses 时：actor/target +
       事实地点的同场实体），逐目击者建亲历记忆；幂等（事实 id
       去重，持久化）；绝不写世界状态。
     读侧（Retrieval → Ranking → Budget → NPC AI）：
       recallFor(worldId, ownerId, query, limit) —— 4 因子召回
       （置信/重要/新近/词面），投影为上下文记忆段形状。

   纪律（方案 §十）：
     World State = 世界实际上是什么；Memory = 某个实体知道/记得什么。
     Memory 不是第二个 World State——本服务对引擎只有读，摄取不产生
     任何命令；记忆内容只能经 AI 提案 → Rules 影响世界（是否成立
     由 Rules 裁决，记忆文本永不直接成为事实）。
   ============================================================ */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryEngine, type EmbedHook, type MemoryConfig, type MemorySavePort, type WorldFact } from 'world-memory';

/** 引擎事实的最小读取面（允许缺字段） */
export interface MemoryFactView {
  id?: string;
  type?: string;
  day?: number;
  actor?: string;
  target?: string;
  location?: string;
  witnesses?: string[];
  data?: Record<string, unknown>;
}

/** 世界状态快照的最小面（感知边界派生用；摄取侧只读） */
export interface MemoryStateSnapshot {
  playerLoc?: string;
  /** 实体 id → 当前位置（attributes.location 投影） */
  npcLocations?: Record<string, string>;
}

export interface WorldMemoryServiceOptions {
  /** 持久化目录（每世界两个文件：{worldId}.memory.json + {worldId}.seen.json）；不传 = 仅内存 */
  dir?: string;
  /** 记忆引擎配置（衰减/遗忘/容量；缺省 = world-memory 缺省） */
  config?: MemoryConfig;
  /** 感知边界派生：同场实体纳入目击者（缺省 true；false = 只认事实自带 witnesses/actor） */
  deriveCoPresence?: boolean;
  /** 每世界摄取去重集合容量（缺省 2000） */
  seenCap?: number;
  /** 语义召回钩子（P8）：注入后 4 因子召回并入向量相似度；失败静默回词面。
   *  运行期可经 setEmbed 热替换（如 Admin 配置 embedding 通道后）。 */
  embed?: EmbedHook;
}

export interface MemoryServiceStats {
  worldId: string;
  entries: number;
  forgotten: number;
  owners: number;
  ingested: number;
  duplicates: number;
  days: number;
}

export interface WorldMemoryService {
  /** 摄取一批事实（幂等：同事实 id 只摄取一次）；返回新建记忆条数 */
  ingest(worldId: string, facts: MemoryFactView[], snapshot?: MemoryStateSnapshot): number;
  /** 世界日推进（new_day 时调用）：线性衰减 + 遗忘；返回遗忘条数 */
  dayTick(worldId: string, day: number): number;
  /** 为一个实体召回记忆（4 因子排序；投影为上下文记忆段） */
  recallFor(worldId: string, ownerId: string, query: string, limit?: number): Promise<{ ref: string; summary: string; day?: number }[]>;
  stats(worldId: string): MemoryServiceStats | null;
  /** 清除某世界的摄取去重账（P9 多代世界：世界重建后同 id 事实应重新记忆；
   *  已存记忆条目保留——旧世界的经历对新世界仍是这个角色的过去） */
  resetSeen(worldId: string): void;
  /** 记录世界实例种子（P9 跨重启：种子持久化在去重账旁；种子变更 = 世界重建
   *  → 自动清去重账。运行时每批状态读取后调用，零额外开销。） */
  setWorldSeed(worldId: string, seed: number): void;
  /** 热替换语义召回钩子（P8；null = 回纯词面） */
  setEmbed(worldId: string, hook: EmbedHook | null): void;
  /** 有记忆数据的世界（含磁盘恢复） */
  worlds(): string[];
  /** 从磁盘装载全部世界（启动时调用一次）；返回 { worlds, skippedCorrupt } */
  loadAll(): { worlds: number; skippedCorrupt: number };
  writeFailures(): number;
}

/** 感知边界派生（方案 §八 witnesses 语义的记忆侧落地）：
 *  事实自带 witnesses → 原样采用；否则 actor/target + 事实地点同场实体。
 *  事实地点：事件 location 字段 → data.location → actor 为玩家时玩家位置。 */
export function deriveWitnesses(fact: MemoryFactView, snapshot: MemoryStateSnapshot | undefined, coPresence: boolean): string[] {
  if (fact.witnesses?.length) return fact.witnesses;
  const base = new Set<string>();
  if (fact.actor) base.add(fact.actor);
  if (fact.target) base.add(fact.target);
  const loc = fact.location ?? (typeof fact.data?.['location'] === 'string' ? (fact.data['location'] as string) : undefined) ?? (fact.actor === 'player' ? snapshot?.playerLoc : undefined);
  if (coPresence && loc) {
    for (const [id, l] of Object.entries(snapshot?.npcLocations ?? {})) {
      if (l === loc) base.add(id);
    }
    if (snapshot?.playerLoc === loc) base.add('player');
  }
  return [...base];
}

function sanitizeWorldId(worldId: string): string {
  return worldId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'world';
}

export function createWorldMemoryService(opts: WorldMemoryServiceOptions = {}): WorldMemoryService {
  const dir = opts.dir;
  const coPresence = opts.deriveCoPresence ?? true;
  const seenCap = Math.max(100, Math.floor(opts.seenCap ?? 2000));
  const engines = new Map<string, MemoryEngine>();
  const seen = new Map<string, Set<string>>();
  const seenOrder = new Map<string, string[]>();
  const days = new Map<string, number>();
  const seeds = new Map<string, number>();
  const counters = new Map<string, { ingested: number; duplicates: number }>();
  let failures = 0;

  function persistSeen(worldId: string): void {
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${sanitizeWorldId(worldId)}.seen.json`);
      const tmp = `${file}.tmp`;
      const payload: Record<string, unknown> = { seen: seenOrder.get(worldId) ?? [], day: days.get(worldId) };
      if (seeds.has(worldId)) payload['seed'] = seeds.get(worldId);
      writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      renameSync(tmp, file);
    } catch {
      failures++;
    }
  }

  function loadSeen(worldId: string): void {
    if (!dir) return;
    const file = join(dir, `${sanitizeWorldId(worldId)}.seen.json`);
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { seen?: unknown; day?: unknown; seed?: unknown };
      if (Array.isArray(raw.seen)) {
        const ids = raw.seen.filter((x): x is string => typeof x === 'string').slice(-seenCap);
        seen.set(worldId, new Set(ids));
        seenOrder.set(worldId, ids);
      }
      if (typeof raw.day === 'number') days.set(worldId, raw.day);
      if (typeof raw.seed === 'number') seeds.set(worldId, raw.seed);
    } catch {
      failures++; /* 去重账损坏：宁可重复摄取候选（记忆可衰减淘汰），不炸进程 */
    }
  }

  function engineFor(worldId: string): MemoryEngine {
    let e = engines.get(worldId);
    if (!e) {
      const save: MemorySavePort | undefined = dir
        ? {
            load: () => {
              const file = join(dir, `${sanitizeWorldId(worldId)}.memory.json`);
              if (!existsSync(file)) return null;
              try {
                return JSON.parse(readFileSync(file, 'utf8')) as ReturnType<MemoryEngine['snapshot']>;
              } catch {
                return null; /* 载失败返回 null（端口纪律），不静默覆盖 */
              }
            },
            save: (snapshot) => {
              try {
                mkdirSync(dir, { recursive: true });
                const file = join(dir, `${sanitizeWorldId(worldId)}.memory.json`);
                const tmp = `${file}.tmp`;
                writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
                renameSync(tmp, file);
              } catch {
                failures++;
              }
            },
            clear: () => {
              try {
                const file = join(dir, `${sanitizeWorldId(worldId)}.memory.json`);
                if (existsSync(file)) writeFileSync(file, JSON.stringify({ seq: 0, entries: [] }), 'utf8');
              } catch {
                failures++;
              }
            },
          }
        : undefined;
      e = new MemoryEngine({ ...(save ? { save } : {}), ...(opts.config ? { config: opts.config } : {}), ...(opts.embed ? { embed: opts.embed } : {}) });
      engines.set(worldId, e);
      loadSeen(worldId);
    }
    return e;
  }

  return {
    ingest(worldId, facts, snapshot) {
      const engine = engineFor(worldId);
      if (!seen.has(worldId)) seen.set(worldId, new Set());
      if (!seenOrder.has(worldId)) seenOrder.set(worldId, []);
      if (!counters.has(worldId)) counters.set(worldId, { ingested: 0, duplicates: 0 });
      const worldSeen = seen.get(worldId)!;
      const order = seenOrder.get(worldId)!;
      const c = counters.get(worldId)!;
      let created = 0;
      for (const fact of facts) {
        if (!fact.id || !fact.type) continue; /* 无 id 无法去重、无 type 无从记忆 */
        if (worldSeen.has(fact.id)) {
          c.duplicates++;
          continue;
        }
        worldSeen.add(fact.id);
        order.push(fact.id);
        if (order.length > seenCap) {
          const drop = order.splice(0, order.length - seenCap);
          for (const d of drop) worldSeen.delete(d);
        }
        const enriched: WorldFact = {
          id: fact.id,
          type: fact.type,
          day: typeof fact.day === 'number' ? fact.day : 0,
          ...(fact.actor !== undefined ? { actor: fact.actor } : {}),
          ...(fact.target !== undefined ? { target: fact.target } : {}),
          ...(fact.location !== undefined ? { location: fact.location } : {}),
          witnesses: deriveWitnesses(fact, snapshot, coPresence),
          ...(fact.data !== undefined ? { data: fact.data } : {}),
        };
        created += engine.ingestFact(enriched).length;
        if (typeof fact.day === 'number' && fact.day > (days.get(worldId) ?? 0)) days.set(worldId, fact.day);
      }
      c.ingested += created;
      if (created > 0) persistSeen(worldId);
      return created;
    },

    dayTick(worldId, day) {
      const engine = engineFor(worldId);
      const forgotten = engine.tickDay(day);
      if (day > (days.get(worldId) ?? 0)) {
        days.set(worldId, day);
        persistSeen(worldId);
      }
      return forgotten;
    },

    async recallFor(worldId, ownerId, query, limit) {
      const engine = engineFor(worldId);
      const day = days.get(worldId) ?? 0;
      const entries = await engine.recall(ownerId, query, { limit, day });
      return entries.map((e) => ({ ref: e.id, summary: e.text, ...(e.day !== undefined ? { day: e.day } : {}) }));
    },

    setEmbed(worldId, hook) {
      engineFor(worldId).setEmbed(hook);
    },

    resetSeen(worldId) {
      seen.delete(worldId);
      seenOrder.delete(worldId);
      persistSeen(worldId);
    },

    setWorldSeed(worldId, seed) {
      const prev = seeds.get(worldId);
      if (prev === seed) return;
      seeds.set(worldId, seed);
      if (prev !== undefined && seen.has(worldId)) {
        /* 种子变更 = 世界重建：去重账跨重启仍残留旧代事实 id → 清账重记忆 */
        seen.delete(worldId);
        seenOrder.delete(worldId);
      }
      persistSeen(worldId);
    },

    stats(worldId) {
      const engine = engines.get(worldId);
      if (!engine) return null;
      const s = engine.stats();
      const c = counters.get(worldId) ?? { ingested: 0, duplicates: 0 };
      return { worldId, entries: s.total, forgotten: s.forgotten, owners: s.owners, ingested: c.ingested, duplicates: c.duplicates, days: days.get(worldId) ?? 0 };
    },

    worlds() {
      return [...engines.keys()];
    },

    loadAll() {
      if (!dir || !existsSync(dir)) return { worlds: 0, skippedCorrupt: 0 };
      let worlds = 0;
      let skippedCorrupt = 0;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.memory.json')) continue;
        const worldId = f.replace(/\.memory\.json$/, '');
        try {
          const snapshot = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { seq?: number; entries?: unknown };
          if (!snapshot || !Array.isArray(snapshot.entries)) {
            skippedCorrupt++;
            continue;
          }
          engineFor(worldId); /* 构造即从 save port 载入 */
          worlds++;
        } catch {
          skippedCorrupt++;
        }
      }
      return { worlds, skippedCorrupt };
    },

    writeFailures: () => failures,
  };
}

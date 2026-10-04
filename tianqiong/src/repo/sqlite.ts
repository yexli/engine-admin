/* ============================================================
   SqliteRepository（§8/§9）：GameCore → Repository → SQLite。
   仅在 Tauri 壳内动态加载（Web 构建运行时不触此文件）。
   SavePort 是同步契约，SQLite 是异步 IO —— 采用「内存镜像 + 写穿队列」：
   load() 读启动时预载的镜像；save() 立即更新镜像并串行落库。
   F-20：入队前固化 payload 快照 + 队列合并（pending 只留最后一次）；
         写失败不再静默——记 lastError、保留脏标记待重试、经 onError 报一次（30s 节流）。
   ============================================================ */
import type { PortShards, PortVectorRow, SavePort } from '@/plugins/PluginInterface';
import { validateState } from '@/validation/RuleValidator';
import { SHARD_KEYS, isShardedMain, mergeShards } from '@/world/Shards';
import type { MainShard } from '@/plugins/PluginInterface';
import type { Belief, CaseState, Memory, NpcDynamic, PerceivedFact, WorldState } from '@/types/world';

/** @tauri-apps/plugin-sql 的 Database 最小面（便于测试注入） */
export interface SqlDb {
  execute(sql: string, args?: unknown[]): Promise<unknown>;
  select<T>(sql: string, args?: unknown[]): Promise<T>;
}

import type { WorldEvent } from '@/events/EventSchema';

const ROW_ID = 'main';
/** 向量索引独立成表（记忆方案 §29/§30：事实与向量分开存） */
const VEC_TABLE =
  'CREATE TABLE IF NOT EXISTS vector_index (' +
  'id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, fp TEXT NOT NULL, vec TEXT NOT NULL, ' +
  'model TEXT, dim INTEGER, lastUsed INTEGER NOT NULL)';
/** 世界史独立成表（二期 H-10）：上限 500 条的数组整段存一行，逐行 upsert 没有收益 */
const WLOG_TABLE = 'CREATE TABLE IF NOT EXISTS world_log (id TEXT PRIMARY KEY, payload TEXT NOT NULL)';
/* 分片表（《剩余工作实施方案》§3）：一行一个分片，id ∈ main/npcs/mind/know。
   用一张表而不是一张表一个分片：介质是 SQLite，行级 UPSERT 本来就是分片式写入，
   表结构再拆一遍只会让迁移与清理多出四处需要同步的地方。 */
const SHARD_TABLE = 'CREATE TABLE IF NOT EXISTS save_shards (id TEXT PRIMARY KEY, payload TEXT NOT NULL)';
const UPSERT_SHARD =
  'INSERT INTO save_shards (id, payload) VALUES ($1, $2) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload';
const UPSERT =
  'INSERT INTO saves (id, ver, updated_at, payload) VALUES ($1, $2, $3, $4) ' +
  'ON CONFLICT(id) DO UPDATE SET ver = excluded.ver, updated_at = excluded.updated_at, payload = excluded.payload';
/** 错误提示节流窗口：同一次故障不刷屏（30s） */
const NOTIFY_GAP_MS = 30_000;

export class SqliteRepository implements SavePort {
  readonly medium = 'sqlite' as const;
  private cache: WorldState | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** 待写快照（F-20）：入队即固化，后续 save 覆盖它即可合并 */
  private pending: { ver: number; payload: string } | null = null;
  private lastError: string | null = null;
  private lastNotifyAt = 0;
  /** 落盘错误通道（组合根注入 → toast；repo 层不依赖 UI） */
  onError?: (msg: string) => void;
  /** 各分片上次成功落库的原文（只写变化过的依据）+ 待写批次 */
  private shardStored: Record<string, string> = {};
  private shardPending = new Map<string, string>();
  /** 旧整档行是否已清（迁移收尾只做一次） */
  private legacyPurged = false;
  /**
   * 在途批次：key → 正在写下去的那份原文。
   * 在途期间 `shardStored` **不代表介质里现在是什么**——那一批还没落库，介质马上会变成它的内容。
   * 粒度必须是 per-key：用「正在排空」这种全局标志，会把没变的片也一起重写
   * （mind 分片动辄几 MB，一次空转就是一次写入放大）。
   */
  private shardInFlight = new Map<string, string>();
  /**
   * 世界世代：`clear()` 递增。在途批次的回填/记账只对同世代有效——
   * 否则「重置世界」之后，上一局的脏分片会被回填进队列，新局第一次 saveShards 就顺带写回介质。
   */
  private gen = 0;
  /** 分片介质不可用（建表失败）：不无限重试，静默退化为整档写入 */
  private shardBroken = false;

  constructor(private db: SqlDb) {}

  /** Tauri 环境打开连接并预载存档（含 plugin-sql 迁移执行） */
  static async open(): Promise<SqliteRepository> {
    const { default: Database } = await import('@tauri-apps/plugin-sql');
    const db = await Database.load('sqlite:tianqiong.db');
    const repo = new SqliteRepository(db as unknown as SqlDb);
    await repo.ensureVectorTable();
    await repo.ensureWorldLogTable();
    await repo.ensureShardTable();
    /* 读时兼容：分片档优先，没有分片再读旧整档（写时一律新格式） */
    if (!(await repo.prefetchShards())) await repo.prefetch();
    await repo.prefetchVectors();
    await repo.prefetchWorldLog();
    return repo;
  }

  private async prefetch(): Promise<void> {
    try {
      const rows = await this.db.select<{ payload: string }[]>('SELECT payload FROM saves WHERE id = $1', [ROW_ID]);
      const first = (rows as { payload: string }[])[0];
      if (first) {
        /* F-02：镜像同样是"进运行时"的入口，必须过同一道校验 */
        const st: unknown = JSON.parse(first.payload);
        if (!validateState(st)) this.cache = st as WorldState;
      }
    } catch {
      this.cache = null;
    }
  }

  /* ---------------- 向量索引（§13/§29：派生数据，与主存档分开） ---------------- */

  private vecCache: PortVectorRow[] | null = null;
  private vecPending: PortVectorRow[] | null = null;
  private wlogCache: WorldEvent[] | null = null;
  private wlogPending: WorldEvent[] | null = null;

  async ensureVectorTable(): Promise<void> {
    try {
      await this.db.execute(VEC_TABLE);
    } catch (e) {
      /* 建表失败只影响向量持久化，不该拦住整个存档层 */
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  private async prefetchVectors(): Promise<void> {
    try {
      const rows = await this.db.select<
        { id: string; ownerId: string; fp: string; vec: string; model: string | null; dim: number | null; lastUsed: number }[]
      >('SELECT id, ownerId, fp, vec, model, dim, lastUsed FROM vector_index');
      this.vecCache = rows.map((r) => ({
        id: r.id,
        ownerId: r.ownerId,
        fp: r.fp,
        vec: JSON.parse(r.vec) as number[],
        model: r.model ?? undefined,
        dim: r.dim ?? undefined,
        lastUsed: r.lastUsed,
      }));
    } catch {
      this.vecCache = null;
    }
  }

  loadVectors(): PortVectorRow[] | null {
    return this.vecCache;
  }

  saveVectors(rows: PortVectorRow[]): void {
    this.vecCache = rows;
    this.vecPending = rows;
    this.queue = this.queue.then(() => this.drainVectors());
  }

  /** 全量重写：向量条数受字节预算约束（几十条量级），比逐行 upsert 简单且不易出错 */
  private async drainVectors(): Promise<void> {
    while (this.vecPending) {
      const job = this.vecPending;
      this.vecPending = null;
      try {
        await this.db.execute('DELETE FROM vector_index');
        for (const r of job) {
          await this.db.execute(
            'INSERT INTO vector_index (id, ownerId, fp, vec, model, dim, lastUsed) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [r.id, r.ownerId, r.fp, JSON.stringify(r.vec), r.model ?? null, r.dim ?? null, r.lastUsed],
          );
        }
        this.lastError = null;
      } catch (e) {
        this.vecPending = job;
        /* 向量是派生数据：写不进去不值得惊动玩家。
           这是与主存档 F-20 红线**刻意**不同的标准，不是漏了错误通道。 */
        this.lastError = e instanceof Error ? e.message : String(e);
        return;
      }
    }
  }

  /** 建表失败不该把 open() 拖挂：世界史是可降级的派生数据（与 ensureVectorTable 同一策略，审查 Minor） */
  async ensureWorldLogTable(): Promise<void> {
    try {
      await this.db.execute(WLOG_TABLE);
    } catch {
      /* 介质不支持 → loadWorldLog() 返回 null → 退化为内存 */
    }
  }

  private async prefetchWorldLog(): Promise<void> {
    try {
      const rows = await this.db.select<{ payload: string }[]>('SELECT payload FROM world_log WHERE id = $1', [ROW_ID]);
      const first = (rows as { payload: string }[])[0];
      this.wlogCache = first ? (JSON.parse(first.payload) as WorldEvent[]) : null;
    } catch {
      this.wlogCache = null;
    }
  }

  loadWorldLog(): WorldEvent[] | null {
    return this.wlogCache;
  }

  saveWorldLog(rows: WorldEvent[]): void {
    this.wlogCache = rows;
    this.wlogPending = rows;
    this.queue = this.queue.then(() => this.drainWorldLog());
  }

  /** 整段重写：世界史上限 500 条，一行 JSON 比逐行 upsert 简单且不易出错 */
  private async drainWorldLog(): Promise<void> {
    while (this.wlogPending) {
      const job = this.wlogPending;
      this.wlogPending = null;
      try {
        await this.db.execute(
          'INSERT INTO world_log (id, payload) VALUES ($1, $2) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
          [ROW_ID, JSON.stringify(job)],
        );
        this.lastError = null;
      } catch (e) {
        this.wlogPending = job;
        /* 世界史是可重放的派生数据：写不进去只影响重启后能否追溯，不惊动玩家 */
        this.lastError = e instanceof Error ? e.message : String(e);
        return;
      }
    }
  }

  load(): WorldState | null {
    return this.cache;
  }

  save(s: WorldState): void {
    this.cache = s;
    /* F-20：先固化快照再入队——原实现把 core.S 的同一引用入队，
       序列化推迟到执行时，一条操作链 N 次 save 就是 N 次全量 UPSERT。 */
    this.pending = { ver: s.ver, payload: JSON.stringify(s) };
    this.queue = this.queue.then(() => this.drain());
  }

  /* ---------------- 存档分片（《剩余工作实施方案》§3 · 第二杠杆） ----------------
     整档每次都要把 npcs / memories / knowledge 一起序列化落库，这三张表随 NPC 规模
     线性膨胀。分片后主档小且每次都写，三张增长表只在**内容真的变了**时写。
     脏标记用「上次成功落库的原文」而不是对象引用：mutate 系列是就地改字段，
     引用永远不变，拿引用当脏标记会静默漏写。 */

  async ensureShardTable(): Promise<void> {
    try {
      await this.db.execute(SHARD_TABLE);
      this.shardBroken = false;
    } catch (e) {
      /* 建表失败 = 这个介质没有分片能力 → saveShards 退回整档（方案 §3.2 的「静默退化」），
         读路径则由 loadShards() 返回 null 落到旧整档。只记 lastError，不打扰玩家：
         存档本身还是写下去了，只是每次都写全量。 */
      this.shardBroken = true;
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  /** 预载分片全集；返回是否成功用它填上了镜像 */
  private async prefetchShards(): Promise<boolean> {
    try {
      const rows = await this.db.select<{ id: string; payload: string }[]>('SELECT id, payload FROM save_shards');
      const stored: Record<string, string> = {};
      for (const r of rows) stored[r.id] = r.payload;
      /* 四片齐全才算一份完整的分片档。只写了一半就崩的话，缺的那张表会被 merge 成空表——
         那不是降级，那是丢数据；此时必须回落到旧整档（它的删除被推迟到「四片全写过」之后）。 */
      if (!SHARD_KEYS.every((k) => k in stored)) return false;
      this.shardStored = stored;
      const shards = this.loadShards();
      if (!shards) {
        this.shardStored = {};
        return false;
      }
      /* 唯一闸门：拼出来的完整档走同一道 validate，分片层不另开一道 */
      const st = mergeShards(shards);
      if (validateState(st)) {
        /* 过不了闸说明这批分片本身可疑，别拿它当「已落库」的基准——
           否则后续 enqueueShard 会拿坏数据比对，跳过本该写下去的分片。 */
        this.shardStored = {};
        return false;
      }
      this.cache = st;
      return true;
    } catch {
      this.shardStored = {};
      return false;
    }
  }

  loadShards(): PortShards | null {
    /* 缺片 = 没有一份完整的分片档可还原（写入方每次都写全四个键） */
    if (!SHARD_KEYS.every((k) => k in this.shardStored)) return null;
    try {
      /* 主档坏 = 整份分片档不可信（它一归零，玩家连名字都没了）→ 回落整档 */
      const main = this.parseShard<MainShard>('main');
      /* 主档里还有 npcs = 旧整档：不能把它的表当成「分片缺失」清空 */
      if (!main || !isShardedMain(main)) return null;
      const mind = this.parseShard<{ memories?: Record<string, Memory[]>; beliefs?: Record<string, Belief[]> }>('mind');
      const know = this.parseShard<{ knowledge?: Record<string, PerceivedFact[]>; cases?: CaseState[] }>('know');
      return {
        main,
        npcs: this.parseShard<Record<string, NpcDynamic>>('npcs') ?? undefined,
        memories: mind?.memories,
        beliefs: mind?.beliefs,
        knowledge: know?.knowledge,
        cases: know?.cases,
      };
    } catch {
      return null;
    }
  }

  saveShards(shards: PortShards): void {
    /* 介质没有分片能力（建表失败）→ 整档写入。无限重试一个不存在的表只会刷错误提示，
       而且方案要的就是「不支持就静默退化」。 */
    if (this.shardBroken) {
      this.save(mergeShards(shards));
      return;
    }
    /* 镜像即时可读（与 save 的同步契约一致：load() 不许等到落库完成） */
    this.cache = mergeShards(shards);
    this.enqueueShard('main', shards.main);
    this.enqueueShard('npcs', shards.npcs);
    this.enqueueShard('mind', { memories: shards.memories, beliefs: shards.beliefs });
    this.enqueueShard('know', { knowledge: shards.knowledge, cases: shards.cases });
    if (!this.shardPending.size) return;
    this.queue = this.queue.then(() => this.drainShards());
  }

  /** 内容没变就不入队：写穿队列里因此只留真正变化过的分片 */
  private enqueueShard(key: string, value: unknown): void {
    const raw = JSON.stringify(value ?? null);
    /* 「介质最终会变成什么」= 待写队列里的最新值 > 在途批次里的值 > 已落库的值。
       少算任何一层，await 窗口里的那次 saveShards 都会被判成「内容没变」而丢掉——
       介质于是停在更旧的一份，内存与落库静默分叉。 */
    const settled = this.shardPending.get(key) ?? this.shardInFlight.get(key) ?? this.shardStored[key];
    if (settled === raw) return;
    this.shardPending.set(key, raw);
  }

  private parseShard<T>(key: string): T | null {
    const raw = this.shardStored[key];
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null; // 单个分片损坏 → 该表归零，不拖垮整档
    }
  }

  /** 串行排空待写分片；失败回填整批（UPSERT 幂等，重放安全） */
  private async drainShards(): Promise<void> {
    const gen = this.gen;
    while (this.shardPending.size) {
      const job = [...this.shardPending.entries()];
      this.shardPending.clear();
      for (const [key, raw] of job) this.shardInFlight.set(key, raw);
      try {
          for (const [key, raw] of job) await this.db.execute(UPSERT_SHARD, [key, raw]);
          /* 世界在这批写完之前被重置了：留痕与后续都作废（介质那三行已经被 clear 删掉，
             此时把 shardStored 记成「已落库」会让新局同内容的分片永远不写）。 */
          if (gen !== this.gen) return;
          for (const [key, raw] of job) this.shardStored[key] = raw;
          this.lastError = null;
          await this.purgeLegacyBlob();
        } catch (e) {
          /* 同上：这批属于上一局，丢掉而不是回填——回填等于把上一局的分片塞进新局队列 */
          if (gen !== this.gen) return;
          for (const [key, raw] of job) if (!this.shardPending.has(key)) this.shardPending.set(key, raw);
          this.fail(e);
          return;
        } finally {
        /* 在途登记按值清：这段时间里可能已经有更新的值也登记进来了 */
        for (const [key, raw] of job) if (this.shardInFlight.get(key) === raw) this.shardInFlight.delete(key);
      }
    }
  }

  /**
   * 迁移收尾：分片写成功之后删掉旧的整档行。
   * 只做一次；失败也无害——读时以分片为准，旧行只是死数据（但留着等于存档体积翻倍）。
   */
  private async purgeLegacyBlob(): Promise<void> {
    if (this.legacyPurged) return;
    this.legacyPurged = true;
    try {
      await this.db.execute('DELETE FROM saves WHERE id = $1', [ROW_ID]);
    } catch {
      /* 死数据清不掉不影响任何行为 */
    }
  }

  /** 串行排空待写快照；失败则保留脏标记（下次 save/flush 自动重试） */
  private async drain(): Promise<void> {
    while (this.pending) {
      const job = this.pending;
      this.pending = null;
      try {
        await this.db.execute(UPSERT, [ROW_ID, job.ver, Date.now(), job.payload]);
        this.lastError = null;
      } catch (e) {
        this.pending = job;
        this.fail(e);
        return;
      }
    }
  }

  private fail(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e);
    const now = Date.now();
    if (now - this.lastNotifyAt < NOTIFY_GAP_MS) return;
    this.lastNotifyAt = now;
    this.onError?.(this.lastError);
  }

  /** 最近一次落库错误（供系统面板与测试读取） */
  errorState(): string | null {
    return this.lastError;
  }

  clear(): void {
    this.cache = null;
    this.pending = null;
    this.vecCache = null;
    this.vecPending = null;
    this.wlogCache = null;
    this.wlogPending = null;
    this.shardStored = {};
    this.shardPending.clear();
    this.shardInFlight.clear();
    this.legacyPurged = false;
    this.gen += 1; // 在途批次从这一刻起属于上一局
    /* 表行也要删：只清内存的话，下次 continueSave 会把上一局的世界史灌回新档（二期审查 I4）；
       分片同理——留着分片行，新局第一次写分片之前 loadShards() 会把上一局的 npcs 拼回来。 */
    this.queue = this.queue.then(() => this.db.execute('DELETE FROM save_shards')).catch(() => undefined);
    this.queue = this.queue.then(() => this.db.execute('DELETE FROM world_log WHERE id = $1', [ROW_ID])).catch(() => undefined);
    this.queue = this.queue
      .then(() => this.db.execute('DELETE FROM saves WHERE id = $1', [ROW_ID]))
      .then(() => this.db.execute('DELETE FROM vector_index'));
  }

  /** 等待写穿队列排空（退出前/测试用）；返回时若仍有脏数据会再试一次 */
  async flush(): Promise<void> {
    await this.queue;
    if (this.pending) await this.drain();
    /* 分片同理：这一条漏了的话，「退出前最后一次改动」会在失败一次之后永远留在队列里，
       直到下一次 saveShards 才被顺带写出去——而进程可能已经退出了。 */
    if (this.shardPending.size) await this.drainShards();
  }
}

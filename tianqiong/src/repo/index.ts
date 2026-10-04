/* ============================================================
   Repository 模式（§9）：GameCore → Repository → 存储介质。
   第一阶段：localStorage（Web）+ memory（测试）。
   预留位：Tauri 阶段接入 SQLite（Drizzle ORM），仅需新增一个
   实现 SavePort 的 SqliteRepository，core 与 UI 零改动。
   F-23：localStorage 写失败（配额/隐私模式）不再静默——记 lastError
   并经 onError 报一次（30s 节流），与 SqliteRepository 同一错误通道。
   ============================================================ */
import type { PortShards, PortVectorRow, SavePort } from '@/plugins/PluginInterface';
import { validateState } from '@/validation/RuleValidator';
import { hash32 } from '@/events/Sampling';
import { isShardedMain, mergeShards } from '@/world/Shards';
import type { MainShard } from '@/plugins/PluginInterface';
import type { Belief, CaseState, Memory, NpcDynamic, PerceivedFact, WorldState } from '@/types/world';
import type { WorldEvent } from '@/events/EventSchema';

export const SAVE_KEY = 'tq2_world_v1';
const NOTIFY_GAP_MS = 30_000;

/** 向量索引的独立存储键（与主存档分开，见 PortVectorRow 的说明） */
const VEC_KEY = 'tq2_vec_v1';

/** 世界史存储键（二期 H-10）：与主存档、向量索引都分开，三者淘汰策略不同 */
const WLOG_KEY = 'tq2_wlog_v1';

/* ---- 分片键（《剩余工作实施方案》§3）----
   主档**刻意不复用 SAVE_KEY**：SAVE_KEY 里那份旧整档要留着当回落源——
   介质写了一半（配额写满、进程被杀）时，四片不全的分片档必须能退回上一份完整的档，
   而如果把新主档写回 SAVE_KEY，这份唯一可回落的档会在第一次保存时就被覆盖掉。
   「主档里没有 npcs」本身就是「这是分片档」的标记（见 world/Shards.ts 的 isShardedMain）；
   追加语义的两张表各自并成一片：记忆与信念同生共死，感知表与案件同生共死。 */
const SHARD_MAIN_KEY = 'tq2_main_v1';
const SHARD_NPCS_KEY = 'tq2_npcs_v1';
const SHARD_MIND_KEY = 'tq2_mind_v1'; // memories + beliefs
const SHARD_KNOW_KEY = 'tq2_know_v1'; // knowledge + cases
/** 四个存储键（顺序对应 world/Shards.ts 的 SHARD_KEYS）：四片齐了才敢删旧整档 */
const SHARD_STORE_KEYS = [SHARD_MAIN_KEY, SHARD_NPCS_KEY, SHARD_MIND_KEY, SHARD_KNOW_KEY];
/** 同代指纹键：记录「这一代四片长什么样」。
 *  为什么不能只靠「四键齐全」判完整——见 loadShards 与 saveShards 的注释。 */
const SHARD_META_KEY = 'tq2_meta_v1';

/** 四片内容的同代指纹：内容 → 稳定整数（FNV-1a，与确定性采样同一个哈希） */
const fpOf = (raws: Record<string, string>): string =>
  [raws.main, raws.npcs, raws.mind, raws.know].map((r) => hash32(r ?? '').toString(36)).join('.');

export class LocalSaveRepository implements SavePort {
  readonly medium = 'localStorage' as const;
  private lastError: string | null = null;
  private lastNotifyAt = 0;
  /** 落盘错误通道（组合根注入 → toast） */
  onError?: (msg: string) => void;

  load(): WorldState | null {
    try {
      /* 分片档优先后回落旧整档（「读时兼容、写时新格式」）：
         同时存在时以分片为准——它才是最近写下的那份。 */
      const shards = this.loadShards();
      if (shards) {
        /* 唯一闸门：分片拼出来的完整档仍走同一道校验，分片层不另开一道 */
        const st = mergeShards(shards);
        return validateState(st) ? null : st;
      }
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      /* F-02：损坏档返回 null（走"没有可用的存档"分支），不交出半成品状态 */
      const st: unknown = JSON.parse(raw);
      return validateState(st) ? null : (st as WorldState);
    } catch {
      return null;
    }
  }

  /** 全量整档写入（介质不实现分片时的降级路径；也是分片档残缺时唯一能回落的那一份） */
  save(s: WorldState): void {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(s));
      this.lastError = null;
    } catch (e) {
      this.fail(e);
    }
  }

  /* ---------------- 存档分片（《剩余工作实施方案》§3 · 第二杠杆） ----------------
     为什么值得单开一条通道：整档每次都要把 npcs / memories / knowledge 一起序列化落盘，
     这三张表随 NPC 规模线性膨胀（200 NPC 时每次几 MB），而浏览器配额是按源算的 5MB。
     分片后主档小且每次都写，三张增长表只在**内容真的变了**时写。
     记账刻意用「上次成功写入的原文」而不是「上次传入的对象引用」：
     mutate 系列是就地改字段，引用永远不变，拿引用当脏标记会漏写。 */

  /** 每个键上次成功落盘的原文（分片只写变化过的依据） */
  private shardStored: Record<string, string> = {};
  /** 各键落盘原文的 hash36 缓存（与 shardStored 同生同改）：指纹按片增量拼接，
      未变的片不再逐字符重跑 FNV——几 MB 级字符串上是主线程几十毫秒。 */
  private shardFp: Record<string, string> = {};
  /** 旧整档是否已清（四片全写过才清，只做一次） */
  private legacyPurged = false;

  loadShards(): PortShards | null {
    try {
      const raw = {
        main: localStorage.getItem(SHARD_MAIN_KEY),
        npcs: localStorage.getItem(SHARD_NPCS_KEY),
        mind: localStorage.getItem(SHARD_MIND_KEY),
        know: localStorage.getItem(SHARD_KNOW_KEY),
        meta: localStorage.getItem(SHARD_META_KEY),
      };
      /* 四片齐全才算一份完整的分片档：写入方每次都写全四个（空表也写 '{}'），
         所以「缺键」精确等于「上一批没写完」（崩了 / 配额写满）。
         缺片时把缺的那张表 merge 成空表不是降级，是丢数据——宁可回落到整档路径。 */
      const mainRaw = raw.main;
      const npcsRaw = raw.npcs;
      const mindRaw = raw.mind;
      const knowRaw = raw.know;
      if (mainRaw === null || npcsRaw === null || mindRaw === null || knowRaw === null) return null;
      const main = this.parseShard<MainShard>(mainRaw);
      /* 主档坏 = 整份分片档不可信；主档里还有 npcs = 这是旧整档。两种都回落。
         （主档不参与「单张坏了就归零」——它一归零，玩家连名字都没了。） */
      if (!main || !isShardedMain(main)) return null;
      const mind = this.parseShard<{ memories?: Record<string, Memory[]>; beliefs?: Record<string, Belief[]> }>(mindRaw);
      const know = this.parseShard<{ knowledge?: Record<string, PerceivedFact[]>; cases?: CaseState[] }>(knowRaw);
      const npcs = this.parseShard<Record<string, NpcDynamic>>(npcsRaw);
      /* 同代校验（审查 §跨代拼接）：**「四键齐全」不等于「四片同代」**。
         四片分四次写，中途失败会留下「新主档 + 旧 npcs」这种半新档；旧键仍留在原地，
         所以「缺键 = 上一批没写完」这条判据看不见它——指纹对不上就整份作废。
         **作废的前提是"还回得去"**：写入侧如今保证「写失败即抹指纹」（见 saveShards 的
         catch），且主档与指纹排在最后写，所以这条判废只会打在两处：
           · 外部篡改，或上一版遗留的跨代残骸（真残骸，该拒）；
           · 首代之后旧整档已删、而四片真的跨了代——写入侧的抹指纹已不再产生这种局面。
         **只在四片都还解析得出来时才判**：某片解析失败说明是残骸（外部改坏 / 写残），
         那种情形按既有契约处置（该表归零、其余照读），不该升级成整档报废。 */
      const meta = this.parseShard<{ fp?: string }>(raw.meta);
      if (mind !== null && know !== null && npcs !== null && meta?.fp && meta.fp !== fpOf({ main: mainRaw, npcs: npcsRaw, mind: mindRaw, know: knowRaw })) return null;
      return {
        main,
        npcs: npcs ?? undefined,
        memories: mind?.memories,
        beliefs: mind?.beliefs,
        knowledge: know?.knowledge,
        cases: know?.cases,
      };
    } catch {
      return null;
    }
  }

  /** 单张分片解析失败 → null（该表归零成空表，由 hydrate 再兜一遍），不拖垮整份档 */
  private parseShard<T>(raw: string | null): T | null {
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  saveShards(shards: PortShards): void {
    try {
      /* 本代四片的原文。指纹必须在**写入之前**定下来——若拿「写入之后的存储现状」算，
         中途失败时指纹会跟着退化成半新半旧的样子，什么都验证不出来。 */
      const raws: Record<string, string> = {
        main: JSON.stringify(shards.main ?? null),
        npcs: JSON.stringify(shards.npcs ?? null),
        mind: JSON.stringify({ memories: shards.memories, beliefs: shards.beliefs }),
        know: JSON.stringify({ knowledge: shards.knowledge, cases: shards.cases }),
      };
      /* ① 指纹先行（审查 §跨代拼接）：写在最前面，失败时存储还停在上一代、自洽；
         写在最后则会出现「四片是新的、指纹是旧的」——既过不了同代校验，
         又不一定有整档可回落（整档在上一代四片齐全时就被删了）。 */
      /* 四片：内容没变的片跳过（这条通道存在的理由就是「只改 npcs → 只写 npcs」）。
         顺序与失败面见文件上方 saveShards 的注释：main 与指纹排在最后。 */
      const fpNpcs = this.writeShardRaw(SHARD_NPCS_KEY, raws.npcs);
      const fpMind = this.writeShardRaw(SHARD_MIND_KEY, raws.mind);
      const fpKnow = this.writeShardRaw(SHARD_KNOW_KEY, raws.know);
      /* 主档最后写：它承载玩家的位置/时间/背包/任务/声望，任何一片写失败时
         它都还停在上一代的完整值上，附表最多超前一点——这是"写坏了也能读回"的关键。 */
      const fpMain = this.writeShardRaw(SHARD_MAIN_KEY, raws.main);
      /* 指纹：语义是「这四片是同代写下来的」，与四片同生共死，见 catch。
         拼接顺序与 fpOf 一致、逐字节等值（各片 hash 由 writeShardRaw 缓存），
         loadShards 侧仍用 fpOf 对盘上原文重算——两式恒等，旧档不受影响。 */
      this.writeShardRaw(SHARD_META_KEY, JSON.stringify({ fp: [fpMain, fpNpcs, fpMind, fpKnow].join('.') }));
      /* ③ 四片与指纹都在盘上，才敢删旧整档 */
      this.purgeLegacyBlob();
      this.lastError = null;
    } catch (e) {
      /* 写失败（多半是配额满）：四片可能只写了一半。**不删**旧整档——
         它正是下次启动时唯一能回落的完整档；指纹与四片对不上则让读取侧主动回落。 */
      this.dropShardMeta();
      this.fail(e);
    }
  }

  /** 抹掉同代指纹（写失败时调，见 saveShards 的 catch）：
      「指纹存在」等价于「这一代四片完整且同代」，写坏了就不该留下一个会误判的凭据。 */
  private dropShardMeta(): void {
    try {
      localStorage.removeItem(SHARD_META_KEY);
    } catch {
      /* 删不掉也无妨：读取侧只在「指纹与四片不符」时判废，而那一刻四片本就不在同一代 */
    }
    delete this.shardStored[SHARD_META_KEY];
  }

  /** 四片全部写成功之后才删旧整档：删早了，一份残缺的分片档就无处可回落 */
  private purgeLegacyBlob(): void {
    if (this.legacyPurged) return;
    if (!SHARD_STORE_KEYS.every((k) => k in this.shardStored)) return;
    /* 指纹没落盘就不删整档：删早了，「四片是新的、指纹是旧的」那份分片档会
       既过不了同代校验、又没有整档可回落。 */
    if (!(SHARD_META_KEY in this.shardStored)) return;
    /* 删旧整档之前先**读回校验**一次：分片档要证明自己真的读得回来，才配把唯一一份
       完整旧档删掉。此前只判「四片都写成功了」——而写成功不等于读得回（指纹算错、
       某片被外部截断、配额写到一半），读不回的后果是启动时「没有可用的存档」，
       玩家的进度再无回落可救。实测复现过（2026-09：记忆表涨到 4.8MB 后配额写满 →
       指纹与四片跨代 → load() 返回 null → 旧整档已被删）。
       代价只有一次：legacyPurged 置位后本函数直接返回，之后每次 save 不再读回。 */
    if (!this.loadShards()) return;
    this.legacyPurged = true;
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* 死数据清不掉不影响行为：读时以分片为准 */
    }
  }

  /** 内容没变就不写：这条通道存在的理由就是「只改 npcs → 只写 npcs」。
      序列化由调用方完成——saveShards 要先算同代指纹，不重复 stringify 整档。
      返回该片落盘原文的 hash36，供指纹增量拼接（见 saveShards）。 */
  private writeShardRaw(key: string, raw: string): string {
    if (this.shardStored[key] === raw) {
      return (this.shardFp[key] ??= hash32(raw).toString(36));
    }
    localStorage.setItem(key, raw); // 抛了就落到 fail()，且不记账
    this.shardStored[key] = raw;
    return (this.shardFp[key] = hash32(raw).toString(36));
  }



  /** 向量索引走**独立键**：塞进主存档会把它挤爆，而两者生命周期本就不同 */
  loadVectors(): PortVectorRow[] | null {
    try {
      const raw = localStorage.getItem(VEC_KEY);
      return raw ? (JSON.parse(raw) as PortVectorRow[]) : null;
    } catch {
      return null;
    }
  }

  saveVectors(rows: PortVectorRow[]): void {
    try {
      localStorage.setItem(VEC_KEY, JSON.stringify(rows));
      this.lastError = null;
    } catch (e) {
      /* 配额不足时静默放弃：向量是可重算的派生数据，不该因此报「存档失败」吓人 */
      this.lastError = '向量索引写入失败（配额不足，下次进入会重算）';
      void e;
    }
  }

  /** §29/§44 世界史：独立键读写（重启后仍能回答「为什么发生这件事」） */
  loadWorldLog(): WorldEvent[] | null {
    try {
      const raw = localStorage.getItem(WLOG_KEY);
      return raw ? (JSON.parse(raw) as WorldEvent[]) : null;
    } catch {
      return null;
    }
  }

  saveWorldLog(rows: WorldEvent[]): void {
    try {
      localStorage.setItem(WLOG_KEY, JSON.stringify(rows));
      this.lastError = null;
    } catch {
      /* 与向量索引同一条约定：这是可重放的派生数据，写不进去只影响"重启后还能不能查"，
         不该报成「存档失败」吓人 */
      this.lastError = '世界史写入失败（配额不足，重启后无法追溯）';
    }
  }

  private fail(e: unknown): void {
    const quota = typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'QuotaExceededError';
    this.lastError = quota
      ? '浏览器存档空间已满——请在系统面板导出存档后清理'
      : '浏览器拒绝写入（隐私模式或存储被禁用），本局进度不会保存';
    const now = Date.now();
    if (now - this.lastNotifyAt < NOTIFY_GAP_MS) return;
    this.lastNotifyAt = now;
    this.onError?.(this.lastError);
  }

  /** 最近一次写入错误（供系统面板与测试读取） */
  errorState(): string | null {
    return this.lastError;
  }

  clear(): void {
    try {
      localStorage.removeItem(SAVE_KEY);
      localStorage.removeItem(WLOG_KEY);
      /* 分片键也要清：只清主档的话，新局第一次 save 之前，
         旧分片还在原地，load() 会认定「分片档」并把上一局的 npcs 灌回新档。 */
      localStorage.removeItem(SHARD_MAIN_KEY);
      localStorage.removeItem(SHARD_NPCS_KEY);
      localStorage.removeItem(SHARD_MIND_KEY);
      localStorage.removeItem(SHARD_KNOW_KEY);
      localStorage.removeItem(SHARD_META_KEY);
      this.legacyPurged = false;
      /* 向量索引也在这一步清（内存侧由 WorldRuntime.resetWorld 的 clearEmbeddingCache 负责）：
         新档的记忆 id 从头重排，留着旧向量只会靠指纹碰运气——两侧必须一起清。 */
      localStorage.removeItem(VEC_KEY);
      this.shardStored = {};
    } catch {
      /* ignore */
    }
  }
}

/** 内存版（测试与 SSR 环境） */
export class MemorySaveRepository implements SavePort {
  readonly medium = 'memory' as const;
  private blob: string | null = null;
  private wlog: WorldEvent[] | null = null;
  loadWorldLog(): WorldEvent[] | null {
    return this.wlog;
  }
  saveWorldLog(rows: WorldEvent[]): void {
    this.wlog = rows;
  }
  load(): WorldState | null {
    const st: unknown = this.blob ? JSON.parse(this.blob) : null;
    return st && !validateState(st) ? (st as WorldState) : null;
  }
  save(s: WorldState): void {
    this.blob = JSON.stringify(s);
  }
  clear(): void {
    this.blob = null;
  }
}

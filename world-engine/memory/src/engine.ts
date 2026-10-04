/* ============================================================
   Memory Engine 本体（V0.8 · 方案 §16）
   ------------------------------------------------------------
   事实摄取（感知边界）→ 衰减遗忘 → 检索（词面 + 可注入向量）
   → 持久化端口。

   数据流契约（§16）：宿主把世界事实喂进来（worldBus.on('*') 或
   HTTP events 轮询），宿主的 AI 拿检索结果组织**建议**，再经宿主的
   Command 通道落地——本包只读事实，没有写世界的任何口子。
   ============================================================ */
import {
  DEFAULT_MEMORY_CONFIG,
  type EmbedHook,
  type MemoryConfig,
  type MemoryEngineConfigAll,
  type MemoryEntry,
  type MemorySavePort,
  type MemorySnapshot,
  type MemoryVia,
  type RecallOptions,
  type WorldFact,
} from './types.ts';

export class MemoryEngine {
  private cfg: MemoryEngineConfigAll;
  private seq = 0;
  private entries: MemoryEntry[] = [];
  private save: MemorySavePort | null;
  private embed: EmbedHook | null;

  constructor(opts: { save?: MemorySavePort; config?: MemoryConfig; embed?: EmbedHook } = {}) {
    this.cfg = { ...DEFAULT_MEMORY_CONFIG, ...(opts.config ?? {}) };
    this.save = opts.save ?? null;
    this.embed = opts.embed ?? null;
    const restored = this.save?.load() ?? null;
    if (restored) {
      this.seq = restored.seq;
      this.entries = restored.entries;
    }
  }

  /* ---------------- 摄取（W8.2） ---------------- */

  /**
   * 摄取一条世界事实：按**感知边界**给每个目击者建一条亲历记忆（置信 1）。
   * 没有目击者时，actor（若有）自记一条。返回新建的记忆条目。
   */
  ingestFact(fact: WorldFact): MemoryEntry[] {
    const witnesses = fact.witnesses?.length ? fact.witnesses : fact.actor ? [fact.actor] : [];
    const created: MemoryEntry[] = [];
    for (const owner of witnesses.slice(0, 64)) {
      created.push(
        this.remember({
          ownerId: owner,
          text: this.describe(fact, owner),
          day: fact.day,
          kind: fact.type,
          via: 'witness',
          importance: this.importanceOf(fact),
          entities: [fact.actor, fact.target, fact.location].filter((x): x is string => !!x),
          sourceEventId: fact.id,
        }),
      );
    }
    return created;
  }

  /** 传闻：把一条事实以改写文本传给若干 owner（置信按配置衰减）——传播方向由宿主决定 */
  spreadRumor(fact: WorldFact, toOwners: readonly string[], account?: string): MemoryEntry[] {
    return toOwners.slice(0, 64).map((owner) =>
      this.remember({
        ownerId: owner,
        text: account ?? this.describe(fact, owner),
        day: fact.day,
        kind: fact.type,
        via: 'rumor',
        importance: this.importanceOf(fact),
        entities: [fact.actor, fact.target].filter((x): x is string => !!x),
        sourceEventId: fact.id,
      }),
    );
  }

  /** 自记（AI / 角色主动记住一段结论；文本由宿主给） */
  remember(spec: {
    ownerId: string;
    text: string;
    day: number;
    kind?: string;
    via?: MemoryVia;
    importance?: number;
    confidence?: number;
    entities?: string[];
    sourceEventId?: string;
  }): MemoryEntry {
    const via: MemoryVia = spec.via ?? 'self';
    const confidence =
      spec.confidence ?? (via === 'witness' ? 1 : via === 'rumor' ? this.cfg.rumorConfidence : 0.9);
    const entry: MemoryEntry = {
      id: `mem_${spec.ownerId}_${++this.seq}`,
      ownerId: spec.ownerId,
      kind: spec.kind ?? 'note',
      text: spec.text.slice(0, 2000),
      day: spec.day,
      via,
      confidence,
      importance: Math.max(0, Math.min(1, spec.importance ?? 0.3)),
      entities: spec.entities ?? [],
      ...(spec.sourceEventId ? { sourceEventId: spec.sourceEventId } : {}),
      recallCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.enforceCap(spec.ownerId);
    this.persist();
    return entry;
  }

  /* ---------------- 生命周期（衰减 + 遗忘 + 容量） ---------------- */

  /** 推进世界日：线性衰减（重要度越高越慢），低于阈值遗忘。返回本次遗忘条数。 */
  tickDay(currentDay: number): number {
    let forgotten = 0;
    const elapsed = Math.max(0, Math.min(3650, currentDay - (this.lastTickDay ?? currentDay)));
    this.lastTickDay = currentDay;
    if (elapsed === 0) return 0;
    for (const e of this.entries) {
      if (e.forgotten) continue;
      e.confidence = Math.max(0, e.confidence - this.cfg.decayPerDay * (1 - e.importance / 2) * elapsed);
      if (e.confidence < this.cfg.forgetBelow) {
        e.forgotten = true;
        forgotten++;
      }
    }
    this.persist();
    return forgotten;
  }
  private lastTickDay?: number;

  private enforceCap(ownerId: string): void {
    const own = this.entries.filter((e) => e.ownerId === ownerId && !e.forgotten);
    if (own.length <= this.cfg.maxPerOwner) return;
    const victims = own.sort((a, b) => a.confidence - b.confidence || a.importance - b.importance).slice(0, own.length - this.cfg.maxPerOwner);
    for (const v of victims) v.forgotten = true;
  }

  /* ---------------- 检索（W8.3） ---------------- */

  /**
   * 热替换向量钩子（0.8.2）：管理面配置嵌入模型后无需重建引擎——
   * null = 回纯词面检索。已存条目无持久化向量，语义分在检索时现场计算。
   */
  setEmbed(hook: EmbedHook | null): void {
    this.embed = hook;
  }

  /**
   * 召回（带评分）：词面分（查询词命中）+ 新近度 + 重要度 + 置信度加权；
   * 注入了向量钩子且可用时，语义相似度并入总分（失败静默回词面——渐进增强）。
   * 召回会强化记忆（recallCount++ / lastRecalledDay，衰减的对价）。
   * 调试/观测面用：返回条目与真实评分；recall = 本方法的条目投影。
   */
  async recallScored(ownerId: string, query: string, options: RecallOptions = {}): Promise<{ entry: MemoryEntry; score: number }[]> {
    const limit = options.limit ?? this.cfg.defaultLimit;
    const day = options.day ?? 0;
    const includeForgotten = options.includeForgotten === true;
    const pool = this.entries.filter((e) => e.ownerId === ownerId && (includeForgotten || !e.forgotten));
    if (!pool.length) return [];

    const terms = query.split(/[\s，。,.!?？!？、;；]+/).filter((t) => t.length > 0);
    let vectors: number[][] | null = null;
    if (this.embed) {
      try {
        vectors = await this.embed.embed([query, ...pool.map((e) => e.text)]);
      } catch {
        vectors = null; // 渐进增强：向量失败回词面
      }
    }
    const qv = vectors?.[0];

    const scored = pool.map((e, i) => {
      let score = e.confidence * 0.4 + e.importance * 0.3;
      if (day > 0) score += Math.max(0, 1 - (day - e.day) / 360) * 0.2; // 新近度（一年窗口）
      for (const t of terms) {
        if (e.text.includes(t) || e.kind.includes(t)) score += 0.15;
      }
      if (qv && vectors) {
        const ev = vectors[1 + i];
        if (ev?.length) score += cosine(qv, ev) * 0.2;
      }
      return { entry: e, score };
    });

    const hits = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, limit);

    for (const h of hits) {
      h.entry.recallCount++;
      if (day > 0) h.entry.lastRecalledDay = day;
    }
    this.persist();
    return hits;
  }

  /** 召回：recallScored 的条目投影（既有公开 API，形状不变） */
  async recall(ownerId: string, query: string, options: RecallOptions = {}): Promise<MemoryEntry[]> {
    const hits = await this.recallScored(ownerId, query, options);
    return hits.map((h) => h.entry);
  }

  /* ---------------- 观测与持久化（W8.4） ---------------- */

  all(ownerId?: string): readonly MemoryEntry[] {
    return ownerId ? this.entries.filter((e) => e.ownerId === ownerId) : this.entries;
  }

  stats(): { total: number; forgotten: number; owners: number } {
    const live = this.entries.filter((e) => !e.forgotten);
    return { total: live.length, forgotten: this.entries.length - live.length, owners: new Set(live.map((e) => e.ownerId)).size };
  }

  snapshot(): MemorySnapshot {
    return { seq: this.seq, entries: this.entries };
  }

  restore(s: MemorySnapshot): void {
    this.seq = s.seq;
    this.entries = s.entries;
  }

  private persist(): void {
    this.save?.save(this.snapshot());
  }

  /* ---------------- 文案（事实 → 记住的版本） ---------------- */

  private describe(fact: WorldFact, owner: string): string {
    const who = fact.actor ? (fact.actor === owner ? '你' : fact.actor) : '有人';
    const whom = fact.target ? (fact.target === owner ? '你' : fact.target) : '';
    const where = fact.location ? `（在${fact.location}）` : '';
    return `${who} ${fact.type}${whom ? ` → ${whom}` : ''}${where}`.trim();
  }

  private importanceOf(fact: WorldFact): number {
    const v = fact.data?.['importance'];
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.3;
  }
}

/** 余弦相似度（向量钩子的评分件） */
function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

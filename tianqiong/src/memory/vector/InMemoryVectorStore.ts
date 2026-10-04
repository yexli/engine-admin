/* ============================================================
   VectorStore 的默认实现（内存 + 容量上限 + LRU）
   —— §13 的契约落地；规模上限来自「每角色记忆 80 条」，
      全量遍历算余弦在千级条目下完全够用，不需要 HNSW 之类的索引结构
      （§46 明确把「大型独立 Vector DB」列进第一阶段不做的事）。
   ============================================================ */
import { cosine } from './Similarity';
import type { SearchOptions, SearchResult, VectorItem, VectorStore } from './VectorStore';

/** 总容量上限：超出按 lastUsed 淘汰最旧的 */
const DEFAULT_CAP = 2000;

export class InMemoryVectorStore implements VectorStore {
  private items = new Map<string, VectorItem>();

  constructor(private cap = DEFAULT_CAP) {}

  upsert(item: VectorItem): void {
    this.items.set(item.id, item);
    this.enforceCap();
  }

  upsertMany(items: VectorItem[]): void {
    for (const it of items) this.items.set(it.id, it);
    /* 必须 while 而不是 if：批量插入一次可能超出多件（warmMemories 每批上限 32），
       只淘汰一条的话上限在生产路径上等于不存在 */
    this.enforceCap();
  }

  get(id: string): VectorItem | undefined {
    return this.items.get(id);
  }

  search(query: number[], options: SearchOptions = {}): SearchResult[] {
    const { ownerIds, limit = 20, minScore = 0 } = options;
    const ownerSet = ownerIds?.length ? new Set(ownerIds) : null;
    const out: SearchResult[] = [];
    for (const it of this.items.values()) {
      if (ownerSet && !ownerSet.has(it.ownerId)) continue;
      const score = cosine(query, it.vec);
      if (score >= minScore) out.push({ id: it.id, ownerId: it.ownerId, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  touch(id: string, day: number): void {
    const it = this.items.get(id);
    if (it) it.lastUsed = day;
  }

  remove(id: string): boolean {
    return this.items.delete(id);
  }

  size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  export(limit: number): VectorItem[] {
    return [...this.items.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, limit);
  }

  restore(items: VectorItem[]): void {
    for (const it of items) this.items.set(it.id, it);
    this.enforceCap();
  }

  /** 把容量拉回上限内（批量路径必须循环淘汰） */
  private enforceCap(): void {
    while (this.items.size > this.cap) {
      let oldestId: string | null = null;
      let oldestDay = Number.POSITIVE_INFINITY;
      for (const [id, it] of this.items) {
        if (it.lastUsed < oldestDay) {
          oldestDay = it.lastUsed;
          oldestId = id;
        }
      }
      if (oldestId === null) break;
      this.items.delete(oldestId);
    }
  }
}

/** 进程内单例：检索路径同步读取它 */
export const vectorStore: VectorStore = new InMemoryVectorStore();

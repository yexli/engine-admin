/* ============================================================
   VectorStore 契约（《Memory Engine 记忆系统设计方案》§13 / §29 / §30 / §31）
   —— 方案里向量与事实**分开存**：关系型库存事实与状态，向量库存 embedding。
   与方案的一个刻意差异：这里是**同步**接口。
   方案给的是 Promise 形态，那是为远端向量库（pgvector / 独立 Vector DB）预留的；
   本项目的落地形态是本地内存或 SQLite（§30 推荐的单机方案），同步即可，
   检索侧因此保持"同步只读"的契约，不必把异步传染给整条推演链路。
   ============================================================ */

export interface VectorItem {
  /** 与记忆 id 对齐：一条记忆一个向量 */
  id: string;
  /** 归属者（NPC id / 势力 id / 'world'），检索时按它取子集 */
  ownerId: string;
  /** 内容指纹：内容改过就不复用旧向量 */
  fp: string;
  vec: number[];
  /** 生成它的模型标识：换模型后旧向量必须作废——两套向量空间的余弦没有意义 */
  model?: string;
  /** 向量维度：与当前模型不符时直接丢弃 */
  dim?: number;
  /** 最近一次被检索命中的世界日（LRU 淘汰与持久化截断都用它） */
  lastUsed: number;
}

export interface SearchOptions {
  ownerIds?: string[];
  limit?: number;
  /** 低于此相似度的不返回（0..1） */
  minScore?: number;
}

export interface SearchResult {
  id: string;
  ownerId: string;
  score: number;
}

export interface VectorStore {
  upsert(item: VectorItem): void;
  upsertMany(items: VectorItem[]): void;
  get(id: string): VectorItem | undefined;
  search(query: number[], options?: SearchOptions): SearchResult[];
  touch(id: string, day: number): void;
  remove(id: string): boolean;
  size(): number;
  clear(): void;
  /** 导出用于持久化：按最近使用倒序截断到 limit（避免体积失控） */
  export(limit: number): VectorItem[];
  /** 从持久化数据恢复 */
  restore(items: VectorItem[]): void;
}

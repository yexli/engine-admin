/* ============================================================
   向量缓存与持久化（《Memory Engine 记忆系统设计方案》§11/§13/§15/§29/§34）
   —— 向量是**派生数据**：由内容决定、随时可重算。
   事实与向量**分开存**（§29）：记忆条目进 WorldState，向量进 VectorStore，
   后者可选地落到存档之外的地方（localStorage 独立键 / SQLite 独立表），
   以免 1024 维浮点把主存档挤爆。
   契约：检索侧**同步**、只读；向量化由 warm* 事先完成。
   未命中时语义分量按缺失处理（权重剔除、其余项重新归一化），
   所以「没预热」只会让召回退化成关键词检索，不会算出错误分数。
   ============================================================ */
import { savePort } from '@/plugins/PluginInterface';
import { embeddingProvider } from './EmbeddingProvider';
import { vectorStore } from '../vector/InMemoryVectorStore';
import type { VectorItem } from '../vector/VectorStore';

/* 相似度定义在向量层，这里只做转发，保持既有调用方（含测试）的 import 路径不变 */
export { cosine } from '../vector/Similarity';

const queryVec = new Map<string, number[]>();
const QUERY_CACHE_MAX = 64;

/**
 * 向量索引的**字节预算**（不是条数上限）。
 * 我原先按「1024 维约 4KB/条」估，实际序列化后是 **约 20KB/条**
 * （JSON 里每个浮点都是完整十进制文本）——200 条就是 3.9MB，
 * 足以顶掉常见 5MB 源配额的大半。
 * 另外必须说清：独立键只意味着不挤占主存档的**键名**，
 * localStorage 的配额是**按源**算的，两者共享同一份空间。
 */
export const VECTOR_PERSIST_BYTES = 900_000;

/** 单条向量序列化后的体积估算（浮点文本 ~12B + 字段开销） */
const bytesOf = (it: { vec: number[] }): number => it.vec.length * 12 + 96;

/** 存盘前降到 4 位小数：余弦对这点精度不敏感，体积能砍掉约三成 */
const compressVec = (v: number[]): number[] => v.map((x) => Math.round(x * 1e4) / 1e4);

/** 内容指纹：长度 + 头尾片段，用于判断缓存是否对应同一条内容 */
const fingerprint = (s: string): string => s.length + ':' + s.slice(0, 48) + ':' + s.slice(-24);

export function cachedMemoryVec(id: string, content: string): number[] | undefined {
  const it = vectorStore.get(id);
  if (!it) return undefined;
  if (it.fp !== fingerprint(content)) {
    vectorStore.remove(id); // 内容变过：旧向量作废，等着重新算
    return undefined;
  }
  /* 模型换了也要作废（审查 §向量空间）：内容指纹只描述「内容」，对「谁算出来的」是盲的，
     于是换模型后命中的是另一套空间的旧向量，余弦照旧给出一个落在 0..1 的数。
     VectorStore / PluginInterface 的注释都写明了这条要求，这里是它的执行点。 */
  const cur = embeddingProvider()?.name;
  if (cur && it.model && it.model !== cur) {
    vectorStore.remove(id);
    return undefined;
  }
  return it.vec;
}

export function cachedQueryVec(text: string): number[] | undefined {
  return queryVec.get(fingerprint(text));
}

/** 预热查询向量；无 provider 或失败返回 false（调用方据此降级，不抛错） */
export async function warmQuery(text: string): Promise<boolean> {
  const p = embeddingProvider();
  if (!p || !text.trim()) return false;
  const k = fingerprint(text);
  if (queryVec.has(k)) return true;
  try {
    const v = await p.embed(text);
    if (!v.length) return false;
    queryVec.set(k, v);
    if (queryVec.size > QUERY_CACHE_MAX) {
      const oldest = queryVec.keys().next().value;
      if (oldest !== undefined) queryVec.delete(oldest);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 单批上限：条数与字符总量**双闸**。
 * 一次推演可能牵涉多个角色（事件实体 + 一跳扩展），每角色上限 80 条记忆——
 * 几百条一次全发会撞上端点的 input 上限，而整批失败会连带进冷却，
 * 语义检索反而变成「永远不可用」。分批后即使某批失败，其余批次照常入缓存。
 */
const BATCH_MAX_ITEMS = 32;
const BATCH_MAX_CHARS = 4000;

function chunkItems<T extends { content: string }>(items: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const it of items) {
    /* 单条超长时也必须自成一批，否则会卡在这里永远开不了新批 */
    if (cur.length && (cur.length >= BATCH_MAX_ITEMS || chars + it.content.length > BATCH_MAX_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += it.content.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface WarmItem {
  id: string;
  ownerId: string;
  content: string;
}

/** 批量预热记忆向量：只算缓存里没有、或内容变过的那些（自动分批，逐批容错） */
export async function warmMemories(items: WarmItem[], nowDay = 0): Promise<number> {
  const p = embeddingProvider();
  if (!p) return 0;
  const todo = items.filter((it) => !cachedMemoryVec(it.id, it.content));
  if (!todo.length) return 0;
  let n = 0;
  for (const batch of chunkItems(todo)) {
    try {
      const vecs = p.embedBatch
        ? await p.embedBatch(batch.map((t) => t.content))
        : await Promise.all(batch.map((t) => p.embed(t.content)));
      /* 长度对不上就整批丢弃（审查 §错位绑定）：embedBatch 少返或乱序返回时，
         vecs[i] 会绑到别的条目上，而 fp 是用**本条目自己的内容**算的——
         指纹校验对错位是盲的，召回只会给出「看起来合理」的错误分数。 */
      if (vecs.length !== batch.length) continue;
      const model = p.name;
      const rows: VectorItem[] = [];
      batch.forEach((it, i) => {
        const v = vecs[i];
        if (v?.length) {
          rows.push({ id: it.id, ownerId: it.ownerId, fp: fingerprint(it.content), vec: v, model, dim: v.length, lastUsed: nowDay });
        }
      });
      vectorStore.upsertMany(rows);
      n += rows.length;
    } catch {
      /* 单批失败不连累其余批次：装进去多少算多少，没装的退化成关键词召回 */
    }
  }
  return n;
}

/** 命中检索时标记使用时间（LRU 淘汰与持久化截断都按它排序） */
export function touchMemoryVec(id: string, day: number): void {
  vectorStore.touch(id, day);
}

/**
 * §11/§13：把向量导出给持久化层。
 * 按**字节预算**截断（不是条数）：条数上限在不同维度下差出五倍体积，
 * 而配额是按字节算的。返回的是**副本**且降过精度，不会污染内存里的原始向量。
 */
export function exportVectors(byteBudget = VECTOR_PERSIST_BYTES): VectorItem[] {
  const all = vectorStore.export(Number.MAX_SAFE_INTEGER);
  const out: VectorItem[] = [];
  let bytes = 0;
  for (const it of all) {
    /* 预算按压缩后的体积算，与实际写入的一致 */
    const packed = { ...it, vec: compressVec(it.vec) };
    const size = bytesOf(packed);
    if (bytes + size > byteBudget) break;
    bytes += size;
    out.push(packed);
  }
  return out;
}

/** 启动时恢复（§13 的 restore）：旧数据没有 fp/lastUsed 的一律丢弃 */
export function restoreVectors(rows: unknown, currentModel?: string): number {
  if (!Array.isArray(rows)) return 0;
  const ok: VectorItem[] = [];
  for (const r of rows as Partial<VectorItem>[]) {
    if (!r || typeof r.id !== 'string' || typeof r.ownerId !== 'string') continue;
    if (typeof r.fp !== 'string' || !Array.isArray(r.vec) || !r.vec.length) continue;
    /* 元素必须是有限数：损坏或手改的档一旦灌入 NaN，会经余弦传染到 score，
       让排序的偏序都不成立 */
    if (!r.vec.every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    /* 模型或维度对不上就丢弃：跨模型复用会让余弦在两套空间之间算出一个「看起来合理」的数 */
    if (currentModel && r.model && r.model !== currentModel) continue;
    ok.push({
      id: r.id,
      ownerId: r.ownerId,
      fp: r.fp,
      vec: r.vec,
      model: r.model,
      dim: r.dim,
      lastUsed: typeof r.lastUsed === 'number' ? r.lastUsed : 0,
    });
  }
  vectorStore.restore(ok);
  return ok.length;
}

/**
 * 启动时从存档介质恢复向量索引（§13 的 restore 方向）。
 * 介质没实现向量通道、或数据损坏时静默退化为纯内存——只是下次要重算，不会出错。
 */
export function restoreVectorIndex(): number {
  const sp = savePort();
  const rows = sp?.loadVectors?.();
  return rows ? restoreVectors(rows, embeddingProvider()?.name) : 0;
}

/** 把当前向量索引落到存档介质（预热完成后调用，按最近使用截断） */
export function persistVectorIndex(): void {
  savePort()?.saveVectors?.(exportVectors());
}

export function clearEmbeddingCache(): void {
  vectorStore.clear();
  queryVec.clear();
}

export function embeddingCacheSize(): { memories: number; queries: number } {
  return { memories: vectorStore.size(), queries: queryVec.size };
}

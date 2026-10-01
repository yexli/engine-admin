/** Memory 管理客户端（M1.1 起真实：world-memory HTTP 适配层 /memory-api）
 *  契约：world-engine/memory/src/http/protocol.ts（只读 + 检索面；
 *  写世界的口子不存在，记录删除不在 API 内——诚实原则）
 *  字段与 MemoryEntry 对齐：entity=ownerId、type=kind、content=text；
 *  createdAt 为摄取时刻（旧快照条目为 null，不编造时间）。
 */
import { http } from "@/utils/http";

/* ---------- Stores ---------- */
export interface MemoryStoreRow {
  id: string;
  name: string;
  /** 进程内纯库；持久化介质由宿主 SavePort 决定 */
  provider: string;
  /** 无向量通道时为 0 */
  dimension: number;
  documentCount: number;
  status: string;
  description: string;
  stats: { total: number; forgotten: number; owners: number };
  embed: { attached: boolean; name?: string; dimension?: number };
}

export const listMemoryStores = () => {
  return http.request<{ stores: MemoryStoreRow[] }>(
    "get",
    "/memory-api/v1/memory/stores"
  );
};

/* ---------- Records ---------- */
export interface MemoryRecordRow {
  id: string;
  store: string;
  entity: string;
  type: string;
  content: string;
  importance: number;
  confidence: number;
  /** 世界日（与宿主时钟同源） */
  day: number;
  /** witness / rumor / self */
  via: string;
  entities: string[];
  recallCount: number;
  lastRecalledDay?: number;
  /** ISO 8601；旧快照条目无 → null */
  createdAt: string | null;
  forgotten: boolean;
}

export interface MemoryRecordPage {
  total: number;
  page: number;
  pageSize: number;
  list: MemoryRecordRow[];
}

export const listMemoryRecords = (params?: Record<string, unknown>) => {
  return http.request<MemoryRecordPage>("get", "/memory-api/v1/memory/records", {
    params
  });
};

/* ---------- Retrieval ---------- */
export interface RetrievalResultRow {
  id: string;
  content: string;
  /** 真实评分：词面 + 新近度 + 重要度 + 置信度（+向量，如已注入） */
  score: number;
  via: string;
  confidence: number;
  importance: number;
  day: number;
  metadata: {
    owner: string;
    kind: string;
    entities: string[];
    recallCount: number;
  };
}

export interface RetrievalResponse {
  query: string;
  store: string;
  entity: string | null;
  took: number;
  results: RetrievalResultRow[];
}

export const searchMemory = (data: {
  query: string;
  store?: string;
  entity?: string;
  topK?: number;
  day?: number;
}) => {
  return http.request<RetrievalResponse>(
    "post",
    "/memory-api/v1/memory/retrieval",
    { data }
  );
};

/* ---------- Embedding（向量通道声明 + 检索统计，诚实口径） ---------- */
export interface EmbeddingInfo {
  channels: Array<{
    store: string;
    attached: boolean;
    name?: string;
    dimension?: number;
  }>;
  /** 覆盖经本 HTTP 服务的检索调用；引擎内嵌向量调用细节不编造 */
  stats: {
    total: number;
    last24h: number;
    avgLatencyMs: number;
    failureRate: number;
  };
}

export const getEmbeddingInfo = () => {
  return http.request<EmbeddingInfo>("get", "/memory-api/v1/memory/embedding");
};

/** Memory 管理（当前 Mock；memory/ 为纯库，HTTP API 待建，见 ADMIN-API-GAP.md） */
import { http } from "@/utils/http";
import type { PageResult } from "./event";

/* ---------- Stores ---------- */
export interface MemoryStoreRow {
  id: string;
  name: string;
  provider: string;
  dimension: number;
  documentCount: number;
  status: string;
  description: string;
}

export const listMemoryStores = () => {
  return http.request<{
    success: boolean;
    data: { list: MemoryStoreRow[]; total: number };
  }>("get", "/admin-api/memory/stores");
};

/* ---------- Records ---------- */
export interface MemoryRecordRow {
  id: string;
  store: string;
  entity: string;
  type: string;
  content: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
}

export const listMemoryRecords = (params?: Record<string, unknown>) => {
  return http.request<{ success: boolean; data: PageResult<MemoryRecordRow> }>(
    "get",
    "/admin-api/memory/records",
    { params }
  );
};

export const deleteMemoryRecord = (id: string) => {
  return http.request<{ success: boolean }>(
    "delete",
    `/admin-api/memory/records/${id}`
  );
};

/* ---------- Retrieval ---------- */
export interface RetrievalResultRow {
  id: string;
  content: string;
  score: number;
  source: string;
  metadata: Record<string, unknown>;
}

export interface RetrievalResponse {
  query: string;
  took: number;
  results: RetrievalResultRow[];
}

export const searchMemory = (data: {
  query: string;
  entity?: string;
  topK?: number;
}) => {
  return http.request<{ success: boolean; data: RetrievalResponse }>(
    "post",
    "/admin-api/memory/retrieval",
    { data }
  );
};

/* ---------- Embedding ---------- */
export interface EmbeddingInfo {
  models: Array<{
    name: string;
    provider: string;
    dimension: number;
    status: string;
  }>;
  stats: {
    totalEmbeddings: number;
    last24h: number;
    avgLatencyMs: number;
    failureRate: number;
  };
}

export const getEmbeddingInfo = () => {
  return http.request<{ success: boolean; data: EmbeddingInfo }>(
    "get",
    "/admin-api/memory/embedding"
  );
};

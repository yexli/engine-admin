/* ============================================================
   结构化检索（《Memory Engine 记忆系统设计方案》§15）
   —— 按 owner / 时间 / 实体 / 类型 / 重要度 / 置信度 过滤。
   权限过滤（§36）在此层执行：检索前先按 visibility 划边界。
   ============================================================ */
import type { Memory, MemoryType, WorldState } from '@/types/world';

export interface MemoryQuery {
  ownerId: string;
  /** 自然语言查询（关键词 / 未来接向量） */
  query?: string;
  limit?: number;
  timeRange?: { fromDay?: number; toDay?: number };
  entityIds?: string[];
  memoryTypes?: MemoryType[];
  minImportance?: number;
  minConfidence?: number;
  /** 默认排除归档与已遗忘（§26/§35） */
  includeArchived?: boolean;
}

/** §36 权限边界：非本人记忆一律不可见（当前 ownerId 即检索者本人） */
export function visibleTo(m: Memory, viewerId: string): boolean {
  if (m.ownerId !== viewerId) return false;
  return m.status !== 'forgotten';
}

export function structuredFilter(list: Memory[], q: MemoryQuery): Memory[] {
  return list.filter((m) => {
    if (!visibleTo(m, q.ownerId)) return false;
    if (!q.includeArchived && m.status === 'archived') return false;
    if (q.timeRange) {
      const from = q.timeRange.fromDay ?? Number.NEGATIVE_INFINITY;
      const to = q.timeRange.toDay ?? Number.POSITIVE_INFINITY;
      if (m.createdAt < from || m.createdAt > to) return false;
    }
    if (q.memoryTypes?.length && !q.memoryTypes.includes(m.type)) return false;
    if (q.minImportance !== undefined && m.importance < q.minImportance) return false;
    if (q.minConfidence !== undefined && m.confidence < q.minConfidence) return false;
    if (q.entityIds?.length && !q.entityIds.some((id) => (m.entities ?? []).includes(id))) return false;
    return true;
  });
}

export const memoriesOfOwner = (s: WorldState, ownerId: string): Memory[] => s.memories?.[ownerId] ?? [];

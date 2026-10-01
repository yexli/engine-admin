/* ============================================================
   用量查询（纯函数；M2.2）
   ------------------------------------------------------------
   输入全量 UsageEntry + 查询条件，输出过滤 / 汇总 / 分组 / 分页。
   JSONL 量级内全内存扫描即够；SQLite 迁移（平台 Phase 8）只换本层
   数据源，形状不变。
   ============================================================ */
import type { UsageEntry } from './recorder.ts';

export interface UsageQuery {
  /** ISO 时间下/上界（含）；非法 ISO 由调用方（HTTP 层）先挡 400 */
  from?: string;
  to?: string;
  keyId?: string;
  worldId?: string;
  /** 归属游戏方过滤（G3）：'' = 平台钥匙（无 gameId）；其余精确匹配 */
  gameId?: string;
  /** 匹配请求模型或 world-agent 实际模型 */
  model?: string;
  capability?: string;
  kind?: 'chat' | 'worlds';
  status?: 'success' | 'error';
  route?: 'world-agent' | 'proxy';
  page?: number;
  pageSize?: number;
  groupBy?: 'day' | 'key' | 'model' | 'capability' | 'world' | 'game';
}

export interface UsageSummary {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 0-100，一位小数；无记录时为 100（空集全部成功，不假装有失败） */
  successRate: number;
}

export interface UsageGroupRow {
  key: string;
  requests: number;
  totalTokens: number;
  errors: number;
}

export interface UsageQueryResult {
  total: number;
  page: number;
  pageSize: number;
  /** ts 降序 */
  list: UsageEntry[];
  /** 覆盖全部过滤结果（不只是当前页） */
  summary: UsageSummary;
  groups: UsageGroupRow[] | null;
}

export const PAGE_SIZE_CAP = 500;

export function queryUsage(entries: readonly UsageEntry[], q: UsageQuery): UsageQueryResult {
  const from = q.from !== undefined ? Date.parse(q.from) : undefined;
  const to = q.to !== undefined ? Date.parse(q.to) : undefined;

  const filtered = entries.filter((e) => {
    const t = Date.parse(e.ts);
    if (from !== undefined && !(Number.isNaN(t) === false && t >= from)) return false;
    if (to !== undefined && !(Number.isNaN(t) === false && t <= to)) return false;
    if (q.keyId !== undefined && e.keyId !== q.keyId) return false;
    if (q.worldId !== undefined && (e.worldId ?? '') !== q.worldId) return false;
    if (q.gameId !== undefined && (e.gameId ?? '') !== q.gameId) return false;
    if (q.model !== undefined && e.model !== q.model && e.modelUsed !== q.model) return false;
    if (q.capability !== undefined && (e.capability ?? '') !== q.capability) return false;
    if (q.kind !== undefined && e.kind !== q.kind) return false;
    if (q.route !== undefined && (e.route ?? '') !== q.route) return false;
    if (q.status !== undefined) {
      const ok = e.status < 400;
      if (q.status === 'success' && !ok) return false;
      if (q.status === 'error' && ok) return false;
    }
    return true;
  });

  filtered.sort((a, b) => (a.ts === b.ts ? (a.requestId < b.requestId ? 1 : -1) : a.ts < b.ts ? 1 : -1));

  const summary: UsageSummary = {
    requests: filtered.length,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    successRate: 100,
  };
  let errors = 0;
  for (const e of filtered) {
    summary.promptTokens += e.promptTokens ?? 0;
    summary.completionTokens += e.completionTokens ?? 0;
    summary.totalTokens += e.totalTokens ?? 0;
    if (e.status >= 400) errors++;
  }
  if (filtered.length > 0) {
    summary.successRate = Number((((filtered.length - errors) / filtered.length) * 100).toFixed(1));
  }

  let groups: UsageGroupRow[] | null = null;
  if (q.groupBy) {
    const map = new Map<string, UsageGroupRow>();
    for (const e of filtered) {
      const key = groupKeyOf(e, q.groupBy);
      const row = map.get(key) ?? { key, requests: 0, totalTokens: 0, errors: 0 };
      row.requests++;
      row.totalTokens += e.totalTokens ?? 0;
      if (e.status >= 400) row.errors++;
      map.set(key, row);
    }
    groups = [...map.values()].sort((a, b) => b.requests - a.requests || (a.key < b.key ? 1 : -1));
  }

  const page = q.page && q.page > 0 ? Math.floor(q.page) : 1;
  const pageSize = q.pageSize && q.pageSize > 0 ? Math.min(Math.floor(q.pageSize), PAGE_SIZE_CAP) : 50;
  const start = (page - 1) * pageSize;

  return {
    total: filtered.length,
    page,
    pageSize,
    list: filtered.slice(start, start + pageSize),
    summary,
    groups,
  };
}

/** day 分组按 UTC 日（ISO 串前缀），与记录时间戳同源无时区歧义 */
function groupKeyOf(e: UsageEntry, groupBy: NonNullable<UsageQuery['groupBy']>): string {
  switch (groupBy) {
    case 'day':
      return e.ts.slice(0, 10);
    case 'key':
      return e.keyId;
    case 'model':
      return e.modelUsed ?? e.model ?? '—';
    case 'capability':
      return e.capability ?? '—';
    case 'world':
      return e.worldId ?? '—';
    case 'game':
      return e.gameId ?? '(平台)';
  }
}

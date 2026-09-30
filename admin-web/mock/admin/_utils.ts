/** mock 分页工具：列表端点统一返回 { success, data: { list, total, page, pageSize } } */
export function paginate<T>(list: T[], query: Record<string, unknown> = {}) {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? 20) || 20));
  const start = (page - 1) * pageSize;
  return {
    list: list.slice(start, start + pageSize),
    total: list.length,
    page,
    pageSize
  };
}

/** 相对当前时间的 ISO 时间串（分钟偏移），保证 mock 数据看起来新鲜 */
export function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

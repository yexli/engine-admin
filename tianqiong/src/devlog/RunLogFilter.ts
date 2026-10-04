/* ============================================================
   运行日志的筛选与格式化（纯函数）
   —— 从面板里抽出来单独放，是因为面板要在浏览器里跑，而过滤规则值得被自动验证。
   ============================================================ */
import type { RunChan, RunEntry, RunLvl } from './RunLog';

export const RUN_LVL_ORDER: RunLvl[] = ['debug', 'info', 'warn', 'error'];

/** 载荷的一行摘要（面板与搜索都用它，保证「看到什么」与「搜到什么」一致） */
export function fmtRunData(d?: Record<string, unknown>): string {
  if (!d) return '';
  return Object.entries(d)
    .map(([k, v]) => k + '=' + String(v))
    .join('  ');
}

export interface RunFilterOptions {
  /** 空集 = 不按通道过滤 */
  chans?: Set<RunChan>;
  /** 级别门槛：只显示 >= 该级别 */
  minLvl?: RunLvl;
  /** 关键字（消息与载荷一起搜，大小写不敏感） */
  q?: string;
}

export function filterRunEntries(rows: RunEntry[], opts: RunFilterOptions = {}): RunEntry[] {
  const chans = opts.chans && opts.chans.size ? opts.chans : null;
  const min = RUN_LVL_ORDER.indexOf(opts.minLvl ?? 'debug');
  const q = (opts.q ?? '').trim().toLowerCase();
  if (!chans && min <= 0 && !q) return rows.slice();
  return rows.filter((r) => {
    if (chans && !chans.has(r.chan)) return false;
    if (RUN_LVL_ORDER.indexOf(r.lvl) < min) return false;
    if (q && !(r.msg + ' ' + fmtRunData(r.data)).toLowerCase().includes(q)) return false;
    return true;
  });
}

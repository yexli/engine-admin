/* 跨系统直调审计（《架构深化方案》二期 H-08 的统计部分）
   —— 报告里的数字必须能重算，否则「102 条」只是个不可复核的说法（审查 Minor）。
   用法：node scripts/audit-direct-calls.mjs [--json] */
import { readdirSync, readFileSync, statSync } from 'node:fs';

const ROOT = 'src/systems';

const walk = (d, out = []) => {
  for (const n of readdirSync(d)) {
    const p = d + '/' + n;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
};

const edges = [];
for (const f of walk(ROOT)) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@\/systems\/([^']+)'/g)) {
    edges.push({
      from: f.replace(/\\/g, '/'),
      to: m[2],
      symbols: m[1].replace(/\s+/g, '').split(',').filter(Boolean),
    });
  }
}

const byTarget = new Map();
for (const e of edges) {
  const cur = byTarget.get(e.to) ?? { count: 0, symbols: new Set() };
  cur.count++;
  for (const s of e.symbols) cur.symbols.add(s);
  byTarget.set(e.to, cur);
}

const rows = [...byTarget.entries()]
  .map(([to, v]) => ({ to, count: v.count, symbols: [...v.symbols].sort() }))
  .sort((a, b) => b.count - a.count || a.to.localeCompare(b.to));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: edges.length, modules: rows.length, rows }, null, 2));
} else {
  console.log('跨系统直调边数：' + edges.length + '（目标模块 ' + rows.length + ' 个）');
  for (const r of rows) console.log('  ' + String(r.count).padStart(3) + '  ' + r.to + '   ' + r.symbols.join(', '));
}

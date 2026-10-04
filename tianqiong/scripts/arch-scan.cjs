/* 架构关系扫描：把 src 的依赖与事件订阅关系提取成结构化 JSON（供 HTML 单页渲染）。
   一次性脚本：只读源码、只打印统计，不写任何仓库文件。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.cwd(), 'src');
const SRC = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) SRC.push(p);
  }
})(ROOT);

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/** 归属层/系统：systems/<name> 精确到系统，其余按顶层目录 */
function unitOf(r) {
  const parts = r.split('/');
  if (parts[0] === 'systems' && parts.length > 2) return 'systems/' + parts[1];
  return parts[0];
}

const units = new Map();          // unit -> { files, lines }
const edges = new Map();          // from -> to -> count
const subs = [];                  // 事件订阅（worldBus.on）
const sysSubs = [];               // plugins.register 的 subscribes
const filesByUnit = new Map();    // unit -> [file]

for (const f of SRC) {
  const r = rel(f);
  if (r.startsWith('tests/')) continue;
  const src = fs.readFileSync(f, 'utf8');
  const u = unitOf(r);
  const st = units.get(u) || { files: 0, lines: 0 };
  st.files++;
  st.lines += src.split('\n').length;
  units.set(u, st);
  const list = filesByUnit.get(u) || [];
  list.push(r);
  filesByUnit.set(u, list);

  const seen = new Set();
  const re = /from\s+'@\/([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const t = unitOf(m[1]);
    if (t === u || seen.has(t)) continue;
    seen.add(t);
    const k = u + '\u0000' + t;
    edges.set(k, (edges.get(k) || 0) + 1);
  }

  /* 世界事件订阅：允许跨行（多数调用是 `worldBus.on(
  '*',
  fn,
  'owner'
)`） */
  const onRe = /worldBus\.on\(([\s\S]{0,240}?)\);/g;
  while ((m = onRe.exec(src))) {
    const body = m[1];
    const t = (body.match(/'([^']+)'/) || [])[1];
    const owner = (body.match(/,\s*'([^']+)'\s*$/) || body.match(/,\s*'([^']+)'\s*,?\s*$/) || [])[1];
    if (t) subs.push({ unit: u, type: t, owner: owner || '(匿名)', file: r });
  }

  /* 业务系统订阅（registerSystemSubscriptions 里的 subscribe(id, [types])） */
  const subRe = /subscribe\('([a-z]+)',\s*\[([^\]]*)\]/g;
  while ((m = subRe.exec(src))) {
    const types = m[2].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    sysSubs.push({ system: m[1], types });
  }
}

const out = {
  units: [...units.entries()].map(([unit, v]) => ({ unit, ...v, files: filesByUnit.get(unit) })).sort((a, b) => b.lines - a.lines),
  edges: [...edges.entries()].map(([k, count]) => { const [from, to] = k.split('\u0000'); return { from, to, count }; }).sort((a, b) => b.count - a.count),
  subs,
  sysSubs,
};
fs.writeFileSync(path.join(process.cwd(), 'scripts', 'arch-scan.json'), JSON.stringify(out, null, 1));
console.log('units=' + out.units.length + ' edges=' + out.edges.length + ' subs=' + out.subs.length + ' sysSubs=' + out.sysSubs.length);

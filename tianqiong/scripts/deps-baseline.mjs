/* 跨系统依赖基线生成器（卡 J4）
 * 用法：node scripts/deps-baseline.mjs
 *
 * 为什么需要它：arch-deps.test.ts 的 FROZEN_BASELINE 是一张手写清单，
 * 清理存量边或新增受认可的依赖后要同步更新；靠人肉数会出错。
 * 扫描用 TypeScript AST（不是正则）——正则漏掉动态 import 与副作用导入，
 * 且会把 import type 误计成运行时耦合（独立审查 M-5 实证）。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = 'src';
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
})(ROOT);

const norm = (f) => path.relative(ROOT, f).replace(/\\/g, '/').replace(/\.(ts|tsx)$/, '');
const sysOf = (p) => {
  const m = p.match(/^systems\/([^/]+)\//);
  return m ? 'systems/' + m[1] : null;
};

/** 一个文件里的全部导入说明符：静态 import / re-export / 动态 import() / 副作用 import */
function specsOf(file, src) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const m = node.moduleSpecifier;
      if (m && ts.isStringLiteral(m)) {
        const typeOnly = ts.isImportDeclaration(node)
          ? !!(node.importClause && node.importClause.isTypeOnly)
          : !!node.isTypeOnly;
        out.push({ spec: m.text, typeOnly });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = node.arguments[0];
      if (a && ts.isStringLiteral(a)) out.push({ spec: a.text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const resolveSpec = (fromFile, spec) => {
  if (spec.startsWith('@/')) return spec.slice(2).replace(/\.tsx?$/, '');
  if (spec.startsWith('.')) return norm(path.relative(process.cwd(), path.resolve(path.dirname(fromFile), spec)));
  return null;
};

/** 内核模块白名单：事实上的标准库，被大面积依赖是设计预期 */
const KERNEL = [
  'systems/character/Gains',
  'systems/character/Derived',
  'systems/character/Sheet',
  'systems/economy/Money',
  'systems/npc/Lod',
];
const isKernel = (to) => KERNEL.some((k) => to === k || to.startsWith(k + '/'));

const runtime = new Set();
const typeOnly = new Set();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const from = norm(f);
  for (const { spec, typeOnly: t } of specsOf(f, src)) {
    const to = resolveSpec(f, spec);
    if (!to) continue;
    const a = sysOf(from);
    const b = sysOf(to);
    if (!a || !b || a === b) continue;
    if (isKernel(to)) continue;
    (t ? typeOnly : runtime).add(from + ' -> ' + to);
  }
}

const arr = [...runtime].sort();
console.log('运行时跨系统边 ' + arr.length + ' 条 | 仅类型边 ' + typeOnly.size + ' 条（类型边不计入冻结判定）');
if (typeOnly.size) {
  console.log('--- 仅类型边 ---');
  for (const e of [...typeOnly].sort()) console.log('  ' + e);
}
console.log('--- 可直接粘贴进 FROZEN_BASELINE ---');
console.log(arr.map((e) => "  '" + e + "',").join('\n'));

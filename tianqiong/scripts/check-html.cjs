/* 生成物自检：JS 语法、容器齐全、标签配平、数据可解析 */
const fs = require('fs');
const s = fs.readFileSync('docs/架构总览.html', 'utf8');
const script = s.match(/<script>([\s\S]*)<\/script>/);
if (!script) { console.log('未找到 <script>'); process.exit(1); }
try { new Function(script[1]); console.log('JS 语法: OK'); }
catch (e) { console.log('JS 语法错误: ' + e.message); process.exit(1); }

const ids = ['kpis', 'tabs', 'flow', 'buses', 'cognition', 'levels', 'layers', 'matrix', 'edges', 'systems', 'subs', 'review', 'revmore'];
const miss = ids.filter((i) => !s.includes('id="' + i + '"'));
console.log('缺失容器: ' + (miss.length ? miss.join(',') : '无'));

const open = (s.match(/<div/g) || []).length;
const close = (s.match(/<\/div>/g) || []).length;
console.log('div 开/闭: ' + open + '/' + close + (open === close ? ' ✓' : ' ✗'));

const mk = s.match(/const DATA = ([\s\S]*?);\nconst REVIEW/);
const rk = s.match(/const REVIEW = ([\s\S]*?);\nconst \$/);
if (!mk || !rk) { console.log('数据占位未替换'); process.exit(1); }
const D = JSON.parse(mk[1]), R = JSON.parse(rk[1]);
console.log('DATA: units=' + D.units.length + ' edges=' + D.edges.length + ' systems=' + D.systems.length + ' levels=' + D.levels.length + ' layers=' + D.layers.length + ' flow=' + D.flow.length + ' subs=' + D.subs.length);
console.log('REVIEW: items=' + R.items.length + ' notes=' + R.notes.length + ' tests=' + (R.stats ? R.stats.tests : '-'));
console.log('页面大小: ' + (s.length / 1024).toFixed(1) + ' KB');

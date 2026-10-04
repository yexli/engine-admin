import { readFileSync } from 'node:fs';
const f = process.argv[2];
const src = readFileSync(f, 'utf8');
const VOID = new Set(['img','br','hr','input','meta','link','source','path','circle']);
const stack = [];
const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
let m, line = 1, last = 0, bad = 0;
while ((m = re.exec(src))) {
  line += (src.slice(last, m.index).match(/\n/g) || []).length;
  last = m.index;
  const close = m[1] === '/', tag = m[2].toLowerCase(), self = m[3] === '/';
  if (VOID.has(tag) || self) continue;
  if (!close) stack.push({ tag, line });
  else {
    if (!stack.length) { console.log('EXTRA CLOSE </' + tag + '> at line ' + line); bad++; continue; }
    const top = stack[stack.length - 1];
    if (top.tag !== tag) {
      console.log('MISMATCH: </' + tag + '> at line ' + line + ' but <' + top.tag + '> opened at line ' + top.line);
      bad++;
      const idx = stack.map((s) => s.tag).lastIndexOf(tag);
      if (idx >= 0) stack.length = idx;
    } else stack.pop();
  }
}
for (const s of stack) { console.log('UNCLOSED <' + s.tag + '> at line ' + s.line); bad++; }
console.log(bad === 0 ? 'BALANCED' : ('ISSUES: ' + bad));

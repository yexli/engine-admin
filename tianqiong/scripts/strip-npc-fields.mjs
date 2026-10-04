/* 一次性清理：删除 NpcDef 中已确认无消费者的字段
   用法：node scripts/strip-npc-fields.mjs --dry   预检（不改文件）
        node scripts/strip-npc-fields.mjs         执行
   删除：tier（旧重要度档，语义已被 worldImportance × LOD 取代）、owner（档案"所属"原文，全库零消费者）
   幂等：已删过的文件不会被再动；格式与行尾按原文件保持，往返无损才写。 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';

const FIELDS = ['tier', 'owner'];
const NPC_ROOT = 'src/data/npc';
const PEOPLE = 'src/data/world/people.json';
const DRY = process.argv.includes('--dry');

function serialize(raw, obj) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const out = JSON.stringify(obj, null, 2) + '\n';
  return eol === '\r\n' ? out.replaceAll('\n', '\r\n') : out;
}

let files = 0, removed = 0;
const skipped = [];
function strip(file, pick) {
  const raw = readFileSync(file, 'utf8');
  let obj;
  try { obj = JSON.parse(raw); } catch { skipped.push(file + '（JSON 解析失败）'); return; }
  const targets = pick(obj);
  let hit = 0;
  for (const t of targets) for (const f of FIELDS) if (t && Object.prototype.hasOwnProperty.call(t, f)) { delete t[f]; hit++; }
  if (!hit) return;
  // 往返预检：先还原一次，确认序列化器与原文件字节一致（否则会重排/改格式，宁可不动）
  const probe = JSON.parse(raw);
  if (serialize(raw, probe) !== raw) { skipped.push(file + '（序列化往返不一致，跳过以免重排整份文件）'); return; }
  files++; removed += hit;
  if (!DRY) writeFileSync(file, serialize(raw, obj), 'utf8');
}

for (const sector of readdirSync(NPC_ROOT)) {
  const sp = NPC_ROOT + '/' + sector;
  if (!statSync(sp).isDirectory()) continue;
  for (const id of readdirSync(sp)) {
    const fp = sp + '/' + id + '/npc.json';
    if (existsSync(fp)) strip(fp, (o) => [o]);
  }
}
strip(PEOPLE, (o) => Object.values(o.npcs ?? {}));

console.log((DRY ? '[预检] ' : '[执行] ') + '命中文件 ' + files + ' 个，删除字段 ' + removed + ' 处');
if (skipped.length) console.log('跳过 ' + skipped.length + ' 个：\n  ' + skipped.slice(0, 10).join('\n  '));

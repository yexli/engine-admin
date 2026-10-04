/* 素材缺口探针（F-31）：数据层需求 vs public/assets 现有 webp 的差集。
   命名规则与 src/ui/art/ArtImage.tsx 的 artPath() 一致：
   {loc|npc|mob}-{数据层主键}.webp
   用法：node scripts/assets-probe.mjs
   退出码：0 = 清单与实况一致（仅报告）；1 = 有缺口（便于 CI/人工核对） */
import { readdirSync, readFileSync } from 'node:fs';

const geo = JSON.parse(readFileSync('src/data/world/geo.json', 'utf8'));
const people = JSON.parse(readFileSync('src/data/world/people.json', 'utf8'));
const tables = JSON.parse(readFileSync('src/data/world/tables.json', 'utf8'));

const groups = [
  ['场景 loc-', Object.keys(geo.locations).map((id) => 'loc-' + id)],
  ['NPC npc-', Object.keys(people.npcs).map((id) => 'npc-' + id)],
  ['魔物 mob-', Object.keys(tables.monsters).map((id) => 'mob-' + id)],
];

const have = new Set(
  readdirSync('public/assets')
    .filter((f) => f.endsWith('.webp'))
    .map((f) => f.replace(/\.webp$/, '')),
);

let totalNeed = 0;
let totalHave = 0;
const missing = [];
console.log('== 素材需求清单（数据层 × artPath 命名规则）==');
for (const [label, ids] of groups) {
  const miss = ids.filter((id) => !have.has(id));
  totalNeed += ids.length;
  totalHave += ids.length - miss.length;
  missing.push(...miss);
  console.log(`${label}: 需求 ${ids.length} · 已有 ${ids.length - miss.length} · 缺口 ${miss.length}`);
}
console.log(`合计：需求 ${totalNeed} 张 · 已有 ${totalHave} 张 · 缺口 ${missing.length} 张`);
console.log('—— 缺口明细 ——');
console.log(missing.join('\n'));
process.exit(missing.length ? 1 : 0);

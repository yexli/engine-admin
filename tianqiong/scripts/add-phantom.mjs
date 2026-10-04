/* 一次性：为星演场无伤比斗追加一个幻影魔物（幂等） */
import { readFileSync, writeFileSync } from 'node:fs';
const P = 'src/data/world/tables.json';
const t = JSON.parse(readFileSync(P, 'utf8'));
if (!t.monsters.phantom) {
  t.monsters.phantom = {
    name: '星演幻影',
    sv: '影',
    color: '#7aa2ff',
    hp: 24,
    ac: 13,
    atk: 2,
    dmg: [2, 5],
    xp: 0,
    loot: [],
  };
  writeFileSync(P, JSON.stringify(t, null, 2) + '\n', 'utf8');
  console.log('added phantom; monsters now', Object.keys(t.monsters).length);
} else {
  console.log('phantom already present');
}

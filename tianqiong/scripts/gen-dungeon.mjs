/* ============================================================
   卡 H4 · 地下城 100 层数据生成器（模板化生成，确定性可复现）
   用法：node scripts/gen-dungeon.mjs
   产出：src/data/world/dungeon.json
   依据：《项目方案》§26 地下城 / §45 层级分布 / §46 魔物来源 / §62 冒险经济
   分层：浅 1–20 手工 / 中 21–50 模板 / 深 51–80 模板 / 最深 81–99 模板 / 深渊 100 手工
   data 层零逻辑：本脚本只拼装静态数据，不含任何判定规则。
   ============================================================ */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let _s = 20260920 >>> 0;
const next = () => ((_s = (_s * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(next() * a.length)];
const uniq = (a) => [...new Set(a)];

/* ---------------- 五主题 ---------------- */
const themes = {
  shallow: {
    id: 'shallow', name: '浅层 · 苔岩洞窟', range: [1, 20], dcBase: 9, tier: 1, corruption: 0,
    monsters: ['goblin', 'bat', 'rabbit', 'wolf'],
    traps: ['pit', 'rockfall', 'poison_needle', 'webbing'],
    loot: ['bread', 'herb_paste', 'moonherb', 'rabbit_meat', 'wolf_pelt'],
    desc: '湿滑岩壁与苔藓荧光，哥布林与洞窟蝠群在暗处窥伺——冒险者的第一课。',
  },
  mid: {
    id: 'mid', name: '中层 · 古代砌道', range: [21, 50], dcBase: 13, tier: 2, corruption: 0,
    monsters: ['spider', 'skeleton', 'bandit'],
    traps: ['rockfall', 'poison_needle', 'gas', 'rune_blast'],
    loot: ['herb_paste', 'potion_moon', 'moonherb', 'venom_gland', 'scrap_blade'],
    desc: '古代文明的砌道从碎石中露出棱角，岩甲蛛与骷髅兵守着无人记得的走廊。',
  },
  deep: {
    id: 'deep', name: '深层 · 地脉熔窟', range: [51, 80], dcBase: 17, tier: 3, corruption: 1,
    monsters: ['skeleton', 'bandit', 'ghoul'],
    traps: ['gas', 'rune_blast', 'rockfall', 'guillotine'],
    loot: ['potion_moon', 'antidote', 'holy_water', 'blade_blank', 'star_shard'],
    desc: '地脉的热气从裂缝里涌上来，尸鬼祭司的祭坛一座接一座——这里已经不是活人的地界。',
  },
  deepest: {
    id: 'deepest', name: '最深 · 星矿断层', range: [81, 99], dcBase: 21, tier: 4, corruption: 1,
    monsters: ['ghoul', 'templar'],
    traps: ['rune_blast', 'guillotine', 'gas'],
    loot: ['potion_moon', 'holy_water', 'star_shard', 'dust_dream', 'platinum', 'blade_blank'],
    desc: '星髓在断层里泛着冷光，古代英灵的残影仍在巡行——它们不认活人，只认星枢的印记。',
  },
  abyss: {
    id: 'abyss', name: '深渊 · 魔界裂隙', range: [100, 100], dcBase: 26, tier: 5, corruption: 1,
    monsters: ['abyss_spawn'],
    traps: ['rune_blast', 'guillotine'],
    loot: ['void_essence', 'star_marrow', 'seal_rune', 'platinum'],
    desc: '魔界之门开了一线。空气本身在腐烂，裂隙另一侧的东西正在回望你。',
  },
};

/* ---------------- 陷阱目录（非魔物危害：走 check 判定，不产战斗） ---------------- */
const traps = [
  { id: 'pit', name: '陷坑', stat: '敏捷', dcMod: 0, dmgPct: 8, seed: '脚下的石板忽然塌了半边——你下意识地抓住岩棱。' },
  { id: 'rockfall', name: '落石', stat: '敏捷', dcMod: -1, dmgPct: 12, seed: '头顶传来碎石摩擦声，接着是整片岩层倾泻而下。' },
  { id: 'poison_needle', name: '毒针', stat: '感知', dcMod: 1, dmgPct: 6, seed: '壁龛里一枚细针无声弹出，针尖泛着暗绿。' },
  { id: 'webbing', name: '蛛网缠足', stat: '力量', dcMod: 0, dmgPct: 5, seed: '黏稠的白网缠住脚踝，越挣越紧。' },
  { id: 'gas', name: '地脉毒气', stat: '体质', dcMod: 2, dmgPct: 14, seed: '一股甜腥的气味从裂缝里漫出来，喉咙立刻发紧。' },
  { id: 'rune_blast', name: '古代符爆', stat: '智力', dcMod: 2, dmgPct: 16, seed: '地上的六芒星纹忽然亮起，符文在你眼前炸开。' },
  { id: 'guillotine', name: '断头石闸', stat: '敏捷', dcMod: 2, dmgPct: 20, seed: '走廊尽头传来石闸滑落的闷响——它开始动了。' },
];

/* ---------------- 手工层（浅 1–20 + 深渊 100） ---------------- */
const hand = {
  1: ['苔痕入口', ['goblin', 'rabbit'], ['pit']],
  2: ['湿骨甬道', ['bat', 'bat'], ['poison_needle']],
  3: ['倒悬蝠巢', ['bat', 'bat', 'goblin'], ['webbing']],
  4: ['断刃坑', ['goblin', 'rabbit'], ['rockfall']],
  5: ['萤苔阶', ['rabbit', 'wolf'], ['pit']],
  6: ['塌方回廊', ['goblin', 'goblin'], ['rockfall']],
  7: ['硝石池', ['bat', 'goblin'], ['gas']],
  8: ['弃矿车辙', ['rabbit', 'goblin'], ['rockfall']],
  9: ['蛛网天井', ['spider', 'spider'], ['webbing']],
  10: ['碎颅岩厅', ['goblin', 'goblin'], ['rockfall']],
  11: ['地下暗渠', ['bat', 'spider'], ['pit']],
  12: ['白垩裂隙', ['goblin', 'wolf'], ['rockfall']],
  13: ['火把尽处', ['bat', 'bat', 'bat'], ['webbing']],
  14: ['腐水潭', ['spider', 'rabbit'], ['gas']],
  15: ['骨堆回音', ['goblin', 'spider'], ['poison_needle']],
  16: ['幽蓝石笋', ['bat', 'spider'], ['rockfall']],
  17: ['石桥残段', ['wolf', 'wolf'], ['pit']],
  18: ['旧哨所', ['goblin', 'goblin', 'bat'], ['poison_needle']],
  19: ['地脉断层', ['spider', 'wolf'], ['rockfall']],
  20: ['古代砌道门', ['goblin', 'spider'], ['rune_blast']],
  100: ['魔界裂隙·星渊之门', ['abyss_spawn'], ['rune_blast']],
};

/* ---------------- 模板层名池 ---------------- */
const namePool = {
  mid: [
    ['青铜', '断裂', '沉钟', '铭文', '干涸', '霜蚀', '铁锈', '虚空', '石纹', '苔封'],
    ['回廊', '石阶', '井道', '地宫', '前庭', '甬道', '长廊', '圆厅', '拱桥', '石室'],
  ],
  deep: [
    ['熔渣', '地火', '岩浆', '黑铁', '灼痕', '硫磺', '赤砂', '熔炉', '焦岩', '沸腾'],
    ['熔窟', '裂隙', '深渊道', '石殿', '火口', '暗河', '矿床', '断崖', '熔池', '熔洞'],
  ],
  deepest: [
    ['星尘', '陨铁', '星髓', '断层', '古星', '星辉', '沉星', '星轨', '裂隙'],
    ['星矿脉', '陨坑', '星穹厅', '星纹台', '沉星阶', '星轨桥', '星髓井', '星核廊', '星辉殿'],
  ],
};

/* ---------------- BOSS 层（每 10 层一座） ---------------- */
/* F-41：hp/ac 显式随层数单调递增——只借 WB.monsters 的形象与掉落，
   强度不再跟着"用哪只怪当皮"上下翻。core/dungeon.ts 会用它覆盖战斗实例。 */
const bossAt = {
  10: { mid: 'ghoul', name: '尸鬼祭司', hp: 50, ac: 13, reward: { gold: [120, 200], item: 'star_shard' } },
  20: { mid: 'skeleton', name: '骷髅统领', hp: 66, ac: 14, reward: { gold: [180, 300], item: 'blade_blank' } },
  30: { mid: 'templar', name: '古代英灵·守门者', hp: 85, ac: 14, reward: { gold: [260, 420], item: 'holy_water' } },
  40: { mid: 'bandit', name: '劫掠者头目', hp: 108, ac: 15, reward: { gold: [340, 520], item: 'dagger_black' } },
  50: { mid: 'ghoul', name: '地脉尸王', hp: 135, ac: 15, reward: { gold: [420, 640], item: 'star_shard' } },
  60: { mid: 'templar', name: '星枢古代守卫', hp: 166, ac: 16, reward: { gold: [500, 760], item: 'dust_dream' } },
  70: { mid: 'abyss_spawn', name: '深渊行者', hp: 200, ac: 16, reward: { gold: [600, 900], item: 'star_marrow' } },
  80: { mid: 'abyss_spawn', name: '裂隙看门者', hp: 238, ac: 17, reward: { gold: [700, 1050], item: 'seal_rune' } },
  90: { mid: 'templar', name: '古代英灵·末席', hp: 280, ac: 18, reward: { gold: [820, 1200], item: 'platinum' } },
  100: { mid: 'abyss_spawn', name: '魔界守门者·星渊之影', hp: 330, ac: 19, reward: { gold: [1200, 2000], item: 'void_essence' } },
};

const themeOf = (f) => Object.values(themes).find((t) => f >= t.range[0] && f <= t.range[1]);

/* 模板层名：用互质步长在二维名池上走样，保证 100 层内不重复 */
function tmplName(themeId, idx) {
  const [A, B] = namePool[themeId];
  const a = A[idx % A.length];
  const b = B[(idx * 7 + Math.floor(idx / A.length) * 3) % B.length];
  return a + b;
}

const floors = [];
for (let f = 1; f <= 100; f++) {
  const th = themeOf(f);
  const boss = bossAt[f];
  let name, monsters, trapIds;
  if (hand[f]) {
    [name, monsters, trapIds] = hand[f];
  } else if (th.id === 'shallow') {
    // 浅层其余层（本生成器已手工覆盖 1–20，此分支为扩展预留）
    name = '苔岩支道·' + f;
    monsters = [pick(th.monsters), pick(th.monsters)];
    trapIds = uniq([pick(th.traps)]);
  } else if (th.id === 'abyss') {
    name = '魔界裂隙';
    monsters = ['abyss_spawn'];
    trapIds = ['rune_blast'];
  } else {
    name = tmplName(th.id, f - th.range[0]);
    const n = 1 + Math.floor(next() * 2);
    monsters = Array.from({ length: n }, () => pick(th.monsters));
    trapIds = uniq([pick(th.traps)]);
  }
  if (boss) monsters = uniq([...monsters, boss.mid]).slice(0, 3);

  const lootPool = th.loot;
  const loot = uniq([pick(lootPool), pick(lootPool)]);
  const seed = th.desc + '（' + name + '）';
  floors.push({
    id: f,
    name,
    theme: th.id,
    monsters: uniq(monsters),
    traps: trapIds,
    loot,
    ...(boss ? { boss } : {}),
    loreRef: f <= 50 ? 's45' : f <= 80 ? 's46' : 's13', // F-30：中层→s45、深层→s46、最深→s13（原 s26/s27 与分层语义错配）
    seed,
  });
}

const out = {
  version: 1,
  loreRefs: ['s45', 's46', 's62', 's13'], // 与 core/dungeon.ts 顶部声明的引用集合一致
  themes,
  traps,
  floors,
  entries: [
    { id: 'entry_cave', locId: 'cave', name: '浅层洞窟·一层', startFloor: 1, unlockFloor: 1, desc: '枯藤后的洞口——地下城网络最浅的一层。' },
    { id: 'entry_cave2', locId: 'cave2', name: '浅层洞窟·二层', startFloor: 21, unlockFloor: 21, desc: '断裂下陷的岩层，古代砌道的残迹从这里开始。' },
    { id: 'entry_cave3', locId: 'cave3', name: '浅层洞窟·三层', startFloor: 51, unlockFloor: 51, desc: '地下河与地脉熔窟相通，越往下，活人的气味越淡。' },
    { id: 'entry_abyss', locId: 'star6', name: '星渊之门', startFloor: 81, unlockFloor: 81, require: 'flag.leak_3', desc: '星渊魔气侵蚀成患后，六塔之底裂开的一条直通最深处的路。' },
  ],
  rules: {
    retreatTicks: 2,
    corruptionFrom: 81,
    corruptionHpPct: 0.04,
    corruptionFlag: 'dungeon_corruption',
    bossEvery: 10,
    /* F-41：只留 encounter.npc 一处来源——原 rules.npcChance 与它同值双写，改一处必漏另一处 */
    encounter: { monster: 0.55, trap: 0.15, loot: 0.2, npc: 0.07, none: 0.03 },
    firstClear: { gold: [40, 160], exp: 20 },
    lootGold: { shallow: [10, 40], mid: [40, 120], deep: [120, 300], deepest: [300, 700], abyss: [700, 1500] },
    abyssFloor: 100,
    abyssChainFlag: 'dungeon_abyss_reached',
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'data', 'world', 'dungeon.json');
writeFileSync(target, JSON.stringify(out, null, 1) + '\n', 'utf8');
const byTheme = {};
for (const f of floors) byTheme[f.theme] = (byTheme[f.theme] || 0) + 1;
console.log('written', target);
console.log('floors', floors.length, JSON.stringify(byTheme), 'bosses', floors.filter((f) => f.boss).length);

/* 卡 A：职业树数据落地（五系十九分支骨架）。
   幂等：读取 tables.json → 给 4 原型补 path/skillPath/lineage/axis（不动 name/main/stats/gear/skill/desc 以保测试）→
   追加 19 条世界书分支（locked 占位）→ 写回。WorldState 形状不变，无需存档迁移。 */
import { readFileSync, writeFileSync } from 'node:fs';
const P = 'src/data/world/tables.json';
const t = JSON.parse(readFileSync(P, 'utf8'));

// —— 原型四职：仅补可加字段，严格保留既有 name/main/stats/gear/skill/desc ——
const protoPatch = {
  warrior: { lineage: '物理', axis: '肉体', path: ['战士', '剑士', '剑师', '剑圣', '圣剑士', '【剑神降临】'], skillPath: ['heavy_slash', 'guard_break', 'guard_break', 'guard_break', 'guard_break', 'guard_break'] },
  mage: { lineage: '法师', axis: '灵魂', path: ['法师', '元素使', '大元素使', '元素领主', '元素大君', '【元素之神】'], skillPath: ['firebolt', 'arcane_ward', 'arcane_ward', 'arcane_ward', 'arcane_ward', 'arcane_ward'] },
  ranger: { lineage: '物理', axis: '肉体', path: ['游侠', '射手', '神射手', '风行者', '穿云手', '【逐日之弓】'], skillPath: ['aimed_shot', 'wind_flurry', 'wind_flurry', 'wind_flurry', 'wind_flurry', 'wind_flurry'] },
  priest: { lineage: '辅助', axis: '灵魂', path: ['侍僧', '治愈师', '圣愈师', '大祭司', '生命圣女', '【生命神使】'], skillPath: ['holy_light', 'blessing', 'blessing', 'blessing', 'blessing', 'blessing'] },
};
for (const [id, patch] of Object.entries(protoPatch)) Object.assign(t.classes[id], patch);

// —— 19 分支骨架（locked 占位；真实分支技能/装备在阶段 3 解锁时补）——
// 元组：id, lineage, name, main, statKey, gear[wpn,arm], seedSkill, axis, path6
const B = (id, lineage, name, main, sk, gear, skill, axis, path) => ({
  id, lineage, axis, name, main, stats: { [sk]: 2 }, gear, skill, desc: `${name}之路（${path[5]}），暂未在圣辉城开放。`,
  path, skillPath: [skill, skill, skill, skill, skill, skill], locked: true,
});
const branches = [
  B('ph_tank', '物理', '盾卫', '力量', '力量', ['sword_iron', 'armor_chain'], 'heavy_slash', '肉体', ['战士', '盾卫', '铁壁卫士', '不动要塞', '圣骑士', '【神之盾壁】']),
  B('ph_special', '物理', '拳师', '体质', '体质', ['axe_steel', 'armor_leather'], 'heavy_slash', '肉体', ['战士', '拳师', '斗师', '霸者', '武圣', '【武神化身】']),
  B('ph_assassin', '物理', '刺客', '敏捷', '敏捷', ['knife_hunt', 'cloth'], 'aimed_shot', '肉体', ['战士', '刺客', '影杀者', '虚空行者', '死神代行者', '【夜之终焉】']),
  B('fs_arcane', '法师', '术士', '智力', '智力', ['staff_appr', 'cloth'], 'firebolt', '灵魂', ['法师', '术士', '大术士', '贤者', '大贤者', '【万法之源】']),
  B('fs_rune', '法师', '符文学徒', '智力', '智力', ['staff_appr', 'cloth'], 'firebolt', '灵魂', ['法师', '符文学徒', '符文师', '符文大师', '原初解读者', '【原初刻印者】']),
  B('fs_time', '法师', '时间学徒', '智力', '智力', ['staff_appr', 'cloth'], 'firebolt', '灵魂', ['法师', '时间学徒', '时法师', '时间支配者', '时空旅者', '【时间之主】']),
  B('sm_beast', '召唤', '召唤师', '智力', '感知', ['staff_appr', 'cloth'], 'firebolt', '灵魂', ['召唤师', '契约者', '兽主', '万兽之王', '生命编织者', '【创世生灵】']),
  B('sm_construct', '召唤', '傀儡师', '智力', '智力', ['staff_appr', 'cloth'], 'firebolt', '灵魂', ['召唤师', '傀儡师', '魔像使', '军团长', '机械主宰', '【永恒工坊】']),
  B('sm_undead', '召唤', '亡灵学徒', '智力', '智力', ['staff_appr', 'cloth'], 'firebolt', '灵魂', ['召唤师', '亡灵学徒', '死灵法师', '亡灵支配者', '死亡君主', '【冥界之主】']),
  B('sm_hero', '召唤', '英灵学徒', '感知', '感知', ['staff_appr', 'cloth'], 'holy_light', '灵魂', ['召唤师', '英灵学徒', '英灵使', '英雄召唤者', '传说编织者', '【英灵殿之主】']),
  B('au_buff', '辅助', '颂唱者', '魅力', '魅力', ['staff_appr', 'cloth'], 'blessing', '灵魂', ['侍僧', '颂唱者', '祝福师', '神启者', '神恩使徒', '【神之恩宠】']),
  B('au_divine', '辅助', '巫女', '感知', '感知', ['staff_appr', 'cloth'], 'holy_light', '灵魂', ['侍僧', '巫女', '神姬', '现人神', '神之化身', '【神之代行者】']),
  B('au_curse', '辅助', '诅咒师', '智力', '智力', ['staff_appr', 'cloth'], 'firebolt', '灵魂', ['侍僧', '诅咒师', '灾厄术士', '诅咒大法师', '命运编织者', '【灾厄之源】']),
  B('pr_forge', '生产', '铁匠', '力量', '力量', ['axe_steel', 'armor_leather'], 'heavy_slash', '肉体', ['工匠', '铁匠', '锻造师', '锻神', '造物主', '【神匠】']),
  B('pr_alchemy', '生产', '炼金学徒', '智力', '智力', ['knife_hunt', 'cloth'], 'firebolt', '灵魂', ['工匠', '炼金学徒', '炼金术师', '大炼金术师', '真理追寻者', '【真理探求者】']),
  B('pr_inscribe', '生产', '铭刻工匠', '感知', '感知', ['knife_hunt', 'cloth'], 'aimed_shot', '肉体', ['工匠', '铭刻工匠', '古代工匠', '遗迹修复者', '文明继承者', '【世界锻造者】']),
];
for (const b of branches) {
  const { id, ...rest } = b;
  if (!t.classes[id]) t.classes[id] = rest;
}

writeFileSync(P, JSON.stringify(t, null, 2) + '\n', 'utf8');
const all = Object.entries(t.classes);
console.log('classes total:', all.length, '| unlocked:', all.filter(([, c]) => !c.locked).map(([k]) => k).join(','), '| locked:', all.filter(([, c]) => c.locked).length);

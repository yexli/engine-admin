/* ============================================================
   人物档案 → NPC 数据转换器
   用法：node scripts/gen-npcs-from-md.mjs
   输入：docs/设定源/天穹纪-人物.md（109 条，体例统一）
   输出：src/data/npc/<大陆>/<id>.json

   为什么要有它：档案是**叙事设定**（10 字段：身份/种族·年龄·性别/境界/外貌/
   性格/能力/过往/现状与目标/弱点与把柄/持有物），游戏要的是**机制数据**。
   本脚本只做机械搬运与格式固化——不改一个字的内容，不推测任何缺失字段。
   机制字段（loc/hours/greet/topics/rels）本脚本**不生成**，留给人工与后续步骤。

   幂等：重复运行覆盖同名文件，不产生副本。
   ============================================================ */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'docs/设定源/天穹纪-人物.md';
const OUT = 'src/data/npc';

/** 档案编号 → 英文 id（稳定键：存档以此为索引，定下不再改） */
const ID_MAP = {
  '001': 'herman', '002': 'seris', '003': 'kael', '004': 'duke', '005': 'brone',
  '006': 'haran', '007': 'sigur', '008': 'tira', '009': 'vian', '010': 'lain',
  // 011/092/095 与现有街头 NPC 同名：现有方改名保留 id，档案方取描述性 id
  '011': 'lita_verdant', '012': 'amir', '013': 'yuso', '014': 'dulan', '015': 'regar',
  '016': 'tok', '017': 'nur', '018': 'kuge', '019': 'klo', '020': 'dara',
  '021': 'frey', '022': 'dar', '023': 'alkas', '024': 'veronika', '025': 'elena',
  '026': 'nox', '027': 'loki', '028': 'oran', '029': 'balo', '030': 'owen',
  '031': 'iden', '032': 'mir', '033': 'vini', '034': 'kami', '035': 'ange',
  '036': 'jonah', '037': 'oser', '038': 'moro', '039': 'mel', '040': 'zera',
  '041': 'kerr', '042': 'grey', '043': 'karn', '044': 'hain', '045': 'lind',
  '046': 'sadi', '047': 'born', '048': 'glenn', '049': 'sog', '050': 'firi',
  '051': 'weber', '052': 'novi', '053': 'kavin', '054': 'finn', '055': 'raymon',
  '056': 'yexiao', '057': 'kaz', '058': 'lis', '059': 'heiya', '060': 'miur',
  '061': 'hilan', '062': 'warren', '063': 'set', '064': 'hol', '065': 'duin',
  '066': 'sailo', '067': 'mailon', '068': 'mosi', '069': 'xiyin', '070': 'lundo',
  '071': 'vagro', '072': 'iser', '073': 'viros', '074': 'vilan', '075': 'solas',
  '076': 'rog', '077': 'molsa', '078': 'talo', '079': 'savi', '080': 'og',
  '081': 'sag', '082': 'vik', '083': 'chuyao', '084': 'oris', '085': 'gavin',
  '086': 'selan', '087': 'naya', '088': 'dann', '089': 'mong', '090': 'zien',
  '091': 'siya', '092': 'galon_ii', '093': 'ilai', '094': 'gwei', '095': 'mia_elder',
  '096': 'leon', '097': 'ailin', '098': 'toben', '099': 'deron', '100': 'luin',
  '101': 'mali', '102': 'ina', '103': 'elan', '104': 'lanyu', '105': 'nolan',
  '106': 'ser', '107': 'kalin', '108': 'milo', '109': 'dragon_god',
};

/** 大陆归属：先判非人间三类，再按 owner 里的地名归档 */
const CONTINENT_OF = [
  [/万神殿/, 'heavens'],
  [/魔界/, 'nether'],
  [/星渊|创世神话|传说人物|天界|古代英雄|古代造物/, 'past'],
  [/中央大陆/, 'central'],
  [/北方冻土/, 'frost'],
  [/东方群岛/, 'wind'],
  [/南方沙漠/, 'gold'],
  [/西方荒野/, 'blood'],
  [/地下深渊/, 'deep'],
  [/天空浮岛/, 'sky'],
];

function continentOf(owner) {
  for (const [re, dir] of CONTINENT_OF) if (re.test(owner)) return dir;
  return 'central'; // 跨大陆团体落在中央大陆（其总会所在地），后续可人工调整
}

function parse(md) {
  const lines = md.split(/\r?\n/);
  const items = [];
  let cur = null;
  let field = null;
  for (const ln of lines) {
    const h = ln.match(/^## (\d{3})\. (.+?)（(.+)）\s*$/);
    if (h) {
      if (cur) items.push(cur);
      cur = { no: h[1], name: h[2], title: h[3], keywords: [], owner: '', fields: {} };
      field = null;
      continue;
    }
    if (!cur) continue;
    const kw = ln.match(/^\*\*关键词\*\*[:：](.+)$/);
    if (kw) { cur.keywords = kw[1].split(/[、,，]/).map((s) => s.trim()).filter(Boolean); continue; }
    const ow = ln.match(/^> 所属[:：](.+)$/);
    if (ow) { cur.owner = ow[1].trim(); continue; }
    const f = ln.match(/^### (.+?)\s*$/);
    if (f) { field = f[1]; continue; }
    if (field && ln.trim() && !/^---$/.test(ln)) {
      if (!cur.fields[field]) cur.fields[field] = ln.trim();
    }
  }
  if (cur) items.push(cur);
  return items;
}

/**
 * 境界原文 → 六级台阶（1 信徒 · 2 见习 · 3 正式 · 4 主教 · 5 圣阶 · 6 神阶）。
 *
 * 为什么只看「（」之前的标题：档案的写法是「大档（注解）」，注解里常提到**别的**档位——
 * 「圣阶（人类极限·封神后为神官级）」当前是圣阶，若全文匹配会误判成神阶。
 * 神格层面（主神级／超主神级）不在六级台阶表内，返回 undefined——
 * 那不是「修行到的阶」，与「圣阶·极」并排会让神看起来只高一级。
 */
function realmTierOf(realm) {
  if (!realm) return undefined;
  const head = realm.split('（')[0];
  if (/主神/.test(head)) return undefined;
  if (/神阶|神官级|神将级|神王级/.test(head)) return 6;
  if (/圣阶|圣徒|法圣|战圣|匠圣|剑圣/.test(head)) return 5;
  if (/主教/.test(head)) return 4;
  if (/正式/.test(head)) return 3;
  if (/见习/.test(head)) return 2;
  if (/信徒/.test(head)) return 1;
  return undefined;
}

/** 种族·年龄·性别 → race / age / gender（缺项留空，不猜） */
function splitRAG(s) {
  const [raceRaw = '', ageRaw = '', genderRaw = ''] = s.split('/').map((x) => x.trim());
  const race = raceRaw.replace(/（.*$/, '').trim();
  const ageNum = ageRaw.match(/(\d+)/);
  const gender = genderRaw.startsWith('男') ? 'male' : genderRaw.startsWith('女') ? 'female' : '';
  return { race, age: ageNum ? Number(ageNum[1]) : null, gender };
}

const md = readFileSync(SRC, 'utf8');
const items = parse(md);

const report = { total: 0, missing: [], byContinent: {}, byTier: {}, noTier: [], ids: new Set() };
for (const it of items) {
  const id = ID_MAP[it.no];
  if (!id) { report.missing.push(it.no + ' ' + it.name + '（无 id 映射）'); continue; }
  if (report.ids.has(id)) { report.missing.push(it.no + ' ' + it.name + '（id 重复：' + id + '）'); continue; }
  report.ids.add(id);

  const f = it.fields;
  const rag = splitRAG(f['种族·年龄·性别'] || '');
  const dir = continentOf(it.owner);
  report.byContinent[dir] = (report.byContinent[dir] || 0) + 1;

  const realm = f['境界'] || '';
  const realmTier = realmTierOf(realm);
  if (realmTier) report.byTier[realmTier] = (report.byTier[realmTier] || 0) + 1;
  else report.noTier.push(it.no + ' ' + it.name + '（' + realm.split('（')[0] + '）');

  const out = {
    id,
    sourceNo: it.no,
    name: it.name,
    title: it.title,
    /* owner 不再产出：它只在**生成期**用于推导大陆归属（continentOf），
       进游戏后全库零消费者——留着会让后来者以为它有机制含义。 */
    race: rag.race,
    ...(rag.age !== null ? { age: rag.age } : {}),
    ...(rag.gender ? { gender: rag.gender } : {}),
    realm,
    ...(realmTier ? { realmTier } : {}),
    goal: f['现状与目标'] || '',
    lore: {
      keywords: it.keywords,
      identity: f['身份'] || '',
      appearance: f['外貌'] || '',
      personality: f['性格'] || '',
      abilities: f['能力'] || '',
      past: f['过往'] || '',
      flaw: f['弱点与把柄'] || '',
      belongings: f['持有物'] || '',
    },
  };

  /* 一 NPC 一文件夹：这个人的东西都在自己的目录里，将来加问候语/对话树/日程
     各开一个文件即可，不必去别人的文件里挤。 */
  mkdirSync(join(OUT, dir, id), { recursive: true });
  writeFileSync(join(OUT, dir, id, 'npc.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  report.total++;
}

console.log('转换条目: ' + report.total + ' / ' + items.length);
console.log('分区: ' + JSON.stringify(report.byContinent));
console.log('境界台阶分布: ' + JSON.stringify(report.byTier) + '（1信徒…6神阶）');
console.log('无台阶（神格层面）: ' + report.noTier.length + ' 人');
if (report.missing.length) console.log('异常: \n' + report.missing.join('\n'));

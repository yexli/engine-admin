/* 话题卡（talk.json）：草稿批量生成 + 分层校验 + 转正（N-E · 方案 §4.2/§4.4）
 *
 * 分工：
 *   --draft-all   为所有缺卡者产出**素材包式草稿**（落 outputs/npc-talk-draft/）：
 *                 每张卡带一版「人称安全」的初稿台词 + 该卡的档案素材原文（_material），
 *                 写作者照着改人称、加语气即可成稿。草稿**不许**直接进世界书。
 *   --draft <id>  单人草稿（同上）。
 *   --promote <id> 草稿转正：校验通过才写进正式目录（档案 → npc/<板块>/<id>/；街头 → src/data/talk/）。
 *   --check       校验正式卡（分层规则见下），并报告覆盖率。
 *
 * 为什么草稿是「素材包」而不是机器写的台词：lore 七项全是**第三人称**档案，
 * 机械替换人称会造出「我十四岁入宫为伴读」这种串味的台词；宁可给足素材、由人落笔。
 * 唯一例外是 say/inner：它们只用 interest/goal 这类名词短语与目标句，人称天生安全。
 *
 * 分层规则（方案 §4.4）：卡可以有 1–3 层——有 core 必须有 inner 与 gate；
 * facts ≥2 与 edge 对所有卡都必需（AI 的展开范围与边界）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NPC_ROOT = 'src/data/npc';
const STREET_TALK = 'src/data/talk';
const PEOPLE = 'src/data/world/people.json';
const DRAFT_DIR = 'outputs/npc-talk-draft';

const CHECK = process.argv.includes('--check');
const DRAFT_ALL = process.argv.includes('--draft-all');
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
const DRAFT_ID = argOf('--draft');
const PROMOTE_ID = argOf('--promote');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e === 'npc.json') out.push(p);
  }
  return out;
}

/** 名册：档案 109 + 街头 15；dir = npc.json 所在目录（转正时用） */
function roster() {
  const out = new Map();
  for (const f of walk(NPC_ROOT)) {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    out.set(d.id, { ...d, dir: f.slice(0, f.lastIndexOf(sep())), board: 'archive' });
  }
  const people = JSON.parse(readFileSync(PEOPLE, 'utf8'));
  for (const [id, v] of Object.entries(people.npcs || {})) out.set(id, { ...v, id, dir: null, board: 'street' });
  return out;
}
const sep = () => (process.platform === 'win32' ? '\\' : '/');
const idOfTalk = (p) => {
  const posix = p.replace(/\\/g, '/');
  const m = /\/talk\/([^/]+)\.json$/.exec(posix) ?? /\/([^/]+)\/talk\.json$/.exec(posix);
  return m ? m[1] : null;
};
const CN = (s) => [...String(s ?? '')].length;
const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return CN(t) <= n ? t : [...t].slice(0, n).join('') + '…';
};
/** 按句号/分号切句——素材要按**整句**取，截到词中间会写出「他想留给儿子的不是王…」这种半句 */
const sentences = (s) => String(s ?? '').split(/[。；;\n]/).map((x) => x.trim()).filter(Boolean);
const firstClause = (s, n = 42) => cut(sentences(s)[0] || s, n);

/** 正式卡的问题清单（分层） */
function problemsOf(card) {
  const bad = [];
  if (!card || typeof card !== 'object') return ['不是对象'];
  if (!card.l) bad.push('缺标签 l');
  if (CN(card.say) < 4) bad.push('say 太短（无模型时它就是全部应答）');
  if (CN(card.say) > 80) bad.push('say 超过 80 字');
  if (card.core && !card.inner) bad.push('有 core 却没有 inner（中间断了一层）');
  if (card.core && !card.gate) bad.push('有 core 却没有 gate（深水区会白送）');
  if (!Array.isArray(card.facts) || card.facts.length < 2) bad.push('facts 少于 2 条（AI 没有展开范围就会编）');
  if (!card.edge) bad.push('缺 edge（没写边界 = 模型自由发挥）');
  if (card.next && card.next.length > 3) bad.push('next 超过 3 条（chips 位不够）');
  if (card.tier && !['safe', 'warm', 'deep'].includes(card.tier)) bad.push('tier 非法：' + card.tier);
  if (card.gate && typeof card.gate !== 'object') bad.push('gate 不是对象');
  if (card._draft) bad.push('正式数据里不许留 _draft 标记');
  if (card._material) bad.push('正式数据里不许留 _material 素材');
  const hole = /\{[a-zA-Z_][a-zA-Z0-9_.]*\}/.exec(JSON.stringify(card));
  if (hole) bad.push('残留占位符 ' + hole[0]);
  return bad;
}

/* ---------------- 草稿：素材包 + 人称安全的初稿 ---------------- */

/** 每张卡用不同的档案字段组合，避免三张卡读起来是一个模子 */
const FIELD_ROTATION = [
  ['identity', 'interest', 'belongings'],
  ['past', 'goal', 'abilities'],
  ['flaw', 'bottomLine', 'personality'],
];

function draftCard(def, label, tier, idx) {
  const lore = def.lore || {};
  const pick = FIELD_ROTATION[idx % FIELD_ROTATION.length];
  const src = {
    identity: lore.identity,
    past: lore.past,
    flaw: lore.flaw,
    abilities: lore.abilities,
    belongings: lore.belongings,
    personality: lore.personality,
    appearance: lore.appearance,
    goal: def.goal,
    interest: def.interest,
    bottomLine: def.bottomLine,
    voice: def.voice,
  };
  const material = {};
  for (const k of pick) if (src[k]) material[k] = cut(src[k], 120);
  const interest = def.interest ? firstClause(def.interest, 22) : '';
  const goal = def.goal ? firstClause(def.goal, 40) : '';
  /* 三张卡用不同句式：同一个人连问三个话题却听到同一个开场白，比模板腔更出戏 */
  const SAY_FRAMES = [
    () => '「' + label + '？」' + def.name + '停下手里的活，「我这几日心思都在' + interest + '上。」',
    () => '「' + label + '——」' + def.name + '顿了一下，「你想听哪一段？」',
    () => def.name + '没有立刻答话。半晌才开口：「' + label + '这事，说来话长。」',
  ];
  /* inner 只用**人称安全**的句子：bottomLine 是规则句（"不违背圣光行邪术"），
     第一人称读起来天然通顺；goal 是第三人称叙述（"正推动殿权法三读…"），
     塞进台词会串味——它只进 facts 与 _material。 */
  const bottom = def.bottomLine ? firstClause(def.bottomLine, 34) : '';
  const INNER_FRAMES = [
    () => '「话说在前头：' + bottom + '。」',
    () => '（' + def.name + '把声音放低了半度）「我这人有一条规矩：' + bottom + '。」',
    () => '「你要真想听下去——先答应我一件事：' + bottom + '。」',
  ];
  const NEXT_FRAMES = [
    ['那你打算怎么办？', '这事卡在哪儿？'],
    ['最难的一步是什么？', '有人拦着你吗？'],
    ['你打算从哪儿下手？', '需要我做什么？'],
  ];
  /* 档案人物（109 份 npc.json）没有 interest/bottomLine——那两项只在 people.json 的街头 NPC 上。
     对档案侧改用 title 与「留一手」的叙述句：同样人称安全，且不假装有素材。 */
  const SAY_TITLE_FRAMES = [
    () => '「' + label + '？」' + def.name + '（' + (def.title || '') + '）把手上的东西放下，「你想听哪一段？」',
    () => '「' + label + '——」' + def.name + '顿了一下，「打听这个的人，通常不是为了听故事。」',
    () => def.name + '没有立刻答话。半晌才开口：「' + label + '这事，说来话长。」',
  ];
  const say = interest
    ? SAY_FRAMES[idx % SAY_FRAMES.length]()
    : SAY_TITLE_FRAMES[idx % SAY_TITLE_FRAMES.length]();
  return {
    l: label,
    tier: tier || 'safe',
    /* say/inner 只用人称安全的名词短语与目标句；core 与 edge 留给人写，素材见 _material */
    say: say,
    inner: bottom
      ? INNER_FRAMES[idx % INNER_FRAMES.length]()
      : '（' + def.name + '停顿了一下。这句话往下还有一层，而他没打算就这么讲给你。）',
    core: '',
    facts: [
      def.title ? def.title + ' · ' + (def.race || '') : '',
      src.identity ? '身份：' + firstClause(src.identity, 60) : '',
      src.past ? '过往：' + firstClause(src.past, 60) : '',
      src.abilities ? '能力：' + firstClause(src.abilities, 50) : '',
      goal ? '现状与目标：' + goal : '',
    ].filter(Boolean).slice(0, 4),
    edge: '边界（待写）：哪些话到此为止、被追问时怎么推、会不会撒谎——素材见 _material',
    next: goal ? NEXT_FRAMES[idx % NEXT_FRAMES.length] : ['你不想说就算了。', '换个话题？'],
    gate: { att: 45 },
    gain: { mem: '（待写）' },
    _material: material,
  };
}

function writeDraft(def) {
  const cards = (def.topics || []).map((t, i) => draftCard(def, t.l, t.tier, i));
  const draft = {
    id: def.id,
    _draft: true,
    _note: '草稿：由 scripts/gen-npc-talk.mjs --draft-all 生成。say/inner 是人称安全的初稿；core 与 edge 必须人写（素材见每张卡的 _material，均为档案原文，第三人称）。改完用 --promote ' + def.id + ' 转正。',
    topics: cards,
  };
  mkdirSync(DRAFT_DIR, { recursive: true });
  const out = join(DRAFT_DIR, def.id + '.talk.json');
  writeFileSync(out, JSON.stringify(draft, null, 2) + '\n', 'utf8');
  return out;
}

/* ---------------- 主流程 ---------------- */

/** 直接递归收集某类文件——**不锚在 npc.json 上**：
    锚在 npc.json 会漏掉「写错目录的卡」（实测踩过：两张卡落进了没有档案的目录里）。 */
function walkAll(dir, name) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walkAll(p, name));
    else if (e === name) out.push(p);
  }
  return out;
}

const all = roster();
const talkFiles = walkAll(NPC_ROOT, 'talk.json');
for (const f of talkFiles) {
  const dir = f.slice(0, f.lastIndexOf(sep()));
  if (!existsSync(join(dir, 'npc.json'))) {
    console.log('[孤儿卡] ' + f + ' 所在目录没有 npc.json —— 卡放错了地方（应与档案同住）');
    bad_orphan++;
  }
}
if (existsSync(STREET_TALK)) for (const f of readdirSync(STREET_TALK)) if (f.endsWith('.json')) talkFiles.push(join(STREET_TALK, f));
const have = new Set(talkFiles.map(idOfTalk));

let bad = 0;
let bad_orphan = 0;
for (const f of talkFiles) {
  const id = idOfTalk(f);
  const cards = JSON.parse(readFileSync(f, 'utf8')).topics || [];
  const topics = new Set((all.get(id)?.topics || []).map((t) => t.l));
  const issues = [];
  if (cards.length < 3) issues.push('话题卡少于 3 张');
  for (const c of cards) {
    for (const p of problemsOf(c)) issues.push(c.l + '：' + p);
    if (topics.size && !topics.has(c.l)) issues.push(c.l + '：标签不在 topics 索引里（界面上点不到）');
  }
  bad += issues.length;
  if (issues.length) {
    console.log('[不合规] ' + id);
    for (const i of issues) console.log('    - ' + i);
  } else console.log('[合规] ' + id + '（' + cards.length + ' 张）');
}

console.log('---');
console.log('名册 ' + all.size + '；有正式卡 ' + have.size + ' 人（' + Math.round((100 * have.size) / all.size) + '%）');
const missing = [...all.keys()].filter((id) => !have.has(id));
console.log('缺卡 ' + missing.length + ' 人');

if (DRAFT_ID || DRAFT_ALL) {
  const targets = DRAFT_ALL ? missing.map((id) => all.get(id)) : [all.get(DRAFT_ID)];
  if (!targets.length || targets.some((t) => !t)) {
    console.log('没有这个人：' + (DRAFT_ID || '(draft-all)'));
    process.exit(1);
  }
  let n = 0;
  for (const def of targets) {
    if (DRAFT_ALL && !(def.topics || []).length) {
      console.log('[跳过] ' + def.id + ' 没有 topics 索引（先补 npc.json 的 topics）');
      continue;
    }
    writeDraft(def);
    n++;
  }
  console.log('草稿已写 ' + n + ' 份 → ' + DRAFT_DIR + '/');
}

if (PROMOTE_ID) {
  const src = join(DRAFT_DIR, PROMOTE_ID + '.talk.json');
  if (!existsSync(src)) {
    console.log('没有草稿：' + src);
    process.exit(1);
  }
  const def = all.get(PROMOTE_ID);
  const data = JSON.parse(readFileSync(src, 'utf8'));
  data.topics = (data.topics || []).map((c) => {
    const { _material, ...keep } = c;
    return keep;
  });
  const out = def.board === 'street' ? join(STREET_TALK, PROMOTE_ID + '.json') : join(def.dir, 'talk.json');
  writeFileSync(out, JSON.stringify({ id: PROMOTE_ID, note: (data._note || '') + '（已转正）', topics: data.topics }, null, 2) + '\n', 'utf8');
  console.log('已转正：' + out + '（注意：转正只做结构清洗，正文质量仍需人审）');
}

if (CHECK) {
  if (bad || bad_orphan) {
    console.log('--check：不合规 ' + bad + ' 处；放错目录的卡 ' + bad_orphan + ' 张');
    process.exit(1);
  }
  console.log('--check：全部合规');
}

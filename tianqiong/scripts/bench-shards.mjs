/* ============================================================
   存档分片基准（《剩余工作实施方案》§3.4 · 本 Phase 唯一的量化目标）
   —— 200 NPC 合成档：整档 vs 分片，比落盘字节与写入量。
   为什么是脚本而不是用例：这是一次量化证据，不是回归断言——
   写进 vitest 只会得到一条对 CI 抖动敏感的脆弱用例（而且 200 NPC 的合成档
   本身就要几百毫秒）。可复跑：\`node scripts/bench-shards.mjs\`。

   合成档按 types/world.ts 的真实字段形状构造；分片字段清单与
   src/world/Shards.ts 的 SHARD_FIELDS 必须保持一致（改那边就同步这里）。
   ============================================================ */
import { readFileSync } from 'node:fs';

/* ---------------- 合成档 ---------------- */

const NPCS = 200;
const MEM_PER = 80; // 与方案 §1 的表格同参：200 × 80 = 16000 条/天
const FACTS_PER = 20;

const PEOPLE = Object.keys(JSON.parse(readFileSync('src/data/world/people.json', 'utf8')).npcs || {});

function mkNpc(i) {
  const id = i < PEOPLE.length ? PEOPLE[i] : 'bg_' + i + '_' + Math.random().toString(36).slice(2, 6);
  const rels = {};
  for (let k = 0; k < 6; k++) rels['bg_' + ((i * 7 + k) % NPCS)] = { type: 'peer', val: ((i * 13 + k) % 80) - 40 };
  return [
    id,
    {
      att: (i % 41) - 20,
      mem: [],
      met: i % 3 === 0,
      rels,
      chatDay: { day: 120 + i, gain: i % 3 },
      intimacy: i % 4,
      bondProg: { gifts: i % 5, chats: i % 7, quests: i % 2 },
      giftDay: { day: 120, n: i % 2, weekStart: 118, week: i % 6 },
      giftKnown: ['trinket', 'food'].slice(0, i % 3),
      goal: { kind: 'idle', since: 100 + (i % 20), note: '日常' },
      bag: [{ id: 'moonherb', qty: 1 + (i % 3) }],
      gold: 100 + i * 3,
      effects: [{ id: 'bless', left: 12, power: 1, source: 'evt_' + i }],
    },
  ];
}

function mkMemory(owner, j) {
  return {
    id: 'mem_' + (100 + j) + '_' + owner + '_' + j,
    ownerId: owner,
    type: ['observation', 'personal_event', 'rumor', 'knowledge'][j % 4],
    content: owner + ' 在第 ' + (100 + j) + ' 日听说：东市的粮价又涨了一成，行会门前排着长队。',
    source: j % 3 === 0 ? 'direct_observation' : 'received_information',
    sourceEventId: 'evt_1' + j + '_3',
    confidence: 0.3 + (j % 7) / 10,
    importance: (j % 10) / 10,
    emotion: { type: 'neutral', weight: 0.2 },
    createdAt: 100 + j,
    lastUpdatedAt: 100 + j,
    recalledCount: j % 5,
    decayRate: 0.01,
    visibility: j % 5 === 0 ? 'public' : 'private',
    status: j % 9 === 0 ? 'archived' : 'active',
    entities: ['player', 'plaza'],
    proposition: 'player|trade|grain',
  };
}

function mkFact(owner, j) {
  return { eventId: 'evt_2' + j + '_7', what: '有人在广场动了手', day: 100 + j, confidence: 0.8, source: owner, tick: j };
}

function mkState() {
  const npcs = {};
  const memories = {};
  const knowledge = {};
  const beliefs = {};
  for (let i = 0; i < NPCS; i++) {
    const [id, dyn] = mkNpc(i);
    npcs[id] = dyn;
    memories[id] = Array.from({ length: MEM_PER }, (_, j) => mkMemory(id, j));
    knowledge[id] = Array.from({ length: FACTS_PER }, (_, j) => mkFact(id, j));
    if (i % 2 === 0) {
      beliefs[id] = [{ proposition: 'player|trade|grain', subject: 'player', predicate: 'trade', object: 'grain', ownerId: id, confidence: 0.6, supporting: ['mem_100_' + id + '_0'], contradicting: [], lastActedDay: 99 }];
    }
  }
  const cases = Array.from({ length: 12 }, (_, j) => ({ id: 'case_' + j, faction: 'empire', crime: 'theft', day: 100 + j, evidence: [{ eventId: 'evt_' + j, witness: 'lita', conf: 0.8 }], stage: '取证', sev: 1 }));
  return {
    ver: 1,
    evtSeq: 90000,
    seed: 123456,
    isq: 400,
    t: 5760,
    weather: '晴',
    player: { name: '基准客', race: 'human', cls: 'warrior', level: 4, exp: 900, stats: { 力量: 14, 体质: 13, 敏捷: 12, 智力: 11, 感知: 12, 魅力: 13 }, hp: 80, mp: 20, gold: 4200, loc: 'plaza', bag: [], skills: ['cleave'], equip: { wpn: 'sword', arm: 'leather' }, quests: {}, wanted: 0, crimes: 0, flags: {}, wallet: { magicCrystal: 2, soulCrystal: 1 } },
    npcs,
    rep: { empire: 5, temple: 3, guild: 7, shadow: -2, study: 1, frost: 0, verdant: 0, sand: 0, blood: 0, deep: 0 },
    econ: { herb: 1.1, ore: 0.95 },
    events: [],
    history: Array.from({ length: 200 }, (_, j) => ({ day: j, text: '第 ' + j + ' 日：例行记录。' })),
    log: Array.from({ length: 70 }, (_, j) => ({ id: j + 1, cls: 'nar', text: '日志条目 ' + j, t: j })),
    logSeq: 900,
    killed: { wolf: 3 },
    qf: {},
    knowledge,
    cases,
    checks: [],
    memories,
    memSeq: 20000,
    memTickAt: Object.fromEntries(Object.keys(npcs).map((id) => [id, 120])),
    beliefs,
  };
}

/* ---------------- 分片（与 src/world/Shards.ts 的 SHARD_FIELDS 同源） ---------------- */

const SHARD_FIELDS = ['npcs', 'memories', 'beliefs', 'knowledge', 'cases'];

function splitShards(s) {
  const main = { ...s };
  for (const k of SHARD_FIELDS) delete main[k];
  return {
    main,
    npcs: s.npcs,
    mind: { memories: s.memories, beliefs: s.beliefs },
    know: { knowledge: s.knowledge, cases: s.cases },
  };
}

const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const mb = (n) => (n / 1024 / 1024).toFixed(2);

/* ---------------- 报告 ---------------- */

const s = mkState();
const whole = bytes(s);
const sh = splitShards(s);
const part = { main: bytes(sh.main), npcs: bytes(sh.npcs), mind: bytes(sh.mind), know: bytes(sh.know) };

console.log('== 合成档：' + NPCS + ' NPC · 每人 ' + MEM_PER + ' 条记忆 · 每人 ' + FACTS_PER + ' 条感知 ==');
console.log('整档 JSON            : ' + mb(whole) + ' MB  (' + whole + ' B)');
console.log('  main（每次必写）   : ' + mb(part.main) + ' MB  (' + part.main + ' B)');
console.log('  npcs               : ' + mb(part.npcs) + ' MB  (' + part.npcs + ' B)');
console.log('  mind（记忆+信念）  : ' + mb(part.mind) + ' MB  (' + part.mind + ' B)');
console.log('  know（感知+案件）  : ' + mb(part.know) + ' MB  (' + part.know + ' B)');
console.log('');

const pct = (a, b) => (100 * (1 - a / b)).toFixed(1) + '%';
console.log('== 单次落盘字节（整档 → 只写变化的分片）==');
console.log('只改主档（移动/战斗/买卖）: ' + mb(whole) + ' MB → ' + mb(part.main) + ' MB    省 ' + pct(part.main, whole));
console.log('只改 npcs（好感/目标/钱物）: ' + mb(whole) + ' MB → ' + mb(part.npcs) + ' MB    省 ' + pct(part.npcs, whole));
console.log('只改 mind（新记忆/信念）  : ' + mb(whole) + ' MB → ' + mb(part.mind) + ' MB    省 ' + pct(part.mind, whole));
console.log('只改 know（感知/立案）    : ' + mb(whole) + ' MB → ' + mb(part.know) + ' MB    省 ' + pct(part.know, whole));
console.log('什么都没变                : ' + mb(whole) + ' MB → 0 MB                     省 100.0%');
console.log('');

/* 一条典型操作链：一次命令链里 main 与某一张表都可能被改 */
const chain = { main: 12, npcs: 5, mind: 2, know: 1 };
const wholeChain = whole * Object.values(chain).reduce((a, b) => a + b, 0);
const shardChain = part.main * chain.main + part.npcs * chain.npcs + part.mind * chain.mind + part.know * chain.know;
console.log('== 20 次落盘的操作链（main×12 / npcs×5 / mind×2 / know×1）==');
console.log('整档累计写入 : ' + mb(wholeChain) + ' MB');
console.log('分片累计写入 : ' + mb(shardChain) + ' MB    省 ' + pct(shardChain, wholeChain));
console.log('');

/* 序列化耗时：收益在字节量，不在 CPU——如实报出来，避免拿分片冒充性能优化 */
function bench(fn, times = 30) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < times; i++) fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6 / times;
}
const tWhole = bench(() => JSON.stringify(s));
const tShards = bench(() => {
  JSON.stringify(sh.main);
  JSON.stringify(sh.npcs);
  JSON.stringify(sh.mind);
  JSON.stringify(sh.know);
});
console.log('== 序列化耗时（30 次均值）==');
console.log('整档 : ' + tWhole.toFixed(2) + ' ms');
console.log('分片 : ' + tShards.toFixed(2) + ' ms（拆四份之和——分片省的是 IO 字节，不是 CPU）');
console.log('');

/* ---------------- Phase 6 的成本模型 ----------------
   分层比例是**场景假设**，不是实测数字：
   L0=20 / L1=30 / L2=150 描述的是「NPC 规模化到 200 之后**新开一局**」的稳态——
   Phase 4.2 撤掉了位置物化 tick，新档只有与玩家交互过的 NPC 才会建档，L2 因此真实存在。
   存量档不是这样：4.2 之前每次 npcTick 都会给所有 tier≥1 的 NPC 建档，而世界书 15 个 NPC
   全部 tier≥1 → 老档实测分布是 {L0:0, L1:15, L2:0}，收益来自 L1 的 3 天周期（约 2/3）而非 L2 的 7 天。
   换句话说：这张表算的是**规模化目标态**，不是现有存档的即时收益。 */
console.log('== Phase 6 · 记忆分频（每 owner ' + MEM_PER + ' 条 · 分层为场景假设）==');
const L0 = 20, L1 = 30, L2 = NPCS - L0 - L1;
const before = NPCS * MEM_PER;
const after = L0 * MEM_PER + Math.ceil(L1 * MEM_PER / 3) + Math.ceil(L2 * MEM_PER / 7);
console.log('分层：L0=' + L0 + '  L1=' + L1 + '  L2=' + L2 + '（世界书有名有姓但玩家没碰过）');
console.log('改造前每天逐条衰减 : ' + before + ' 条');
console.log('改造后每天逐条衰减 : ' + Math.round(after) + ' 条    省 ' + pct(after, before));
console.log('（L2 只跑归并、不跑逐条衰减；归并的条数上限由 MEMORY_CAP 与 grouped≥3 约束）');

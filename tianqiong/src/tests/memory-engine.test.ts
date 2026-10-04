/* ============================================================
   Memory Engine 验收（《Memory Engine 记忆系统设计方案》§47）
   十条验收逐条对应；另补 §37 安全边界与旧档兼容。
   ============================================================ */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { bootstrapWorld } from '@/plugins/bootstrap';
import { capabilities } from '@/plugins/CapabilityRegistry';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { worldBus } from '@/events/EventBus';
import { makeEvent, resetEventSeq } from '@/events/EventSchema';
import { perception } from '@/events/Perception';
import { WB } from '@/data/worldBook';
import { addMem, npcDyn } from '@/systems/npc/Npcs';
import { mutate } from '@/world/WorldMutate';
import {
  buildMemoryContext,
  compress,
  decayTick,
  gossipTick,
  hybridRetrieve,
  CHARS_PER_TOKEN,
  CONTEXT_TOKENS,
  cachedMemoryVec,
  clearEmbeddingCache,
  cosine,
  memoryEngine,
  setEmbeddingProvider,
  beliefActionsFor,
  beliefsOf,
  believesIn,
  markBeliefActed,
  matchBeliefRules,
  memOf,
  memoriesOf,
  memoryCount,
  migrateLegacyMemories,
  partsOf,
  exportVectors,
  formBeliefs,
  propagateFromFaction,
  propagateToFaction,
  restoreVectors,
  vectorStore,
  warmMemories,
  warmQuery,
  memoryLodOf,
  memoryTick,
  propagate,
  strengthOf,
  validateMemoryProposal,
} from '@/memory';

const start = () => newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  worldBus.reset();
  resetEventSeq();
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  /* 与生产同一条装配路径：世界史 → 感知 → 记忆（顺序契约由 bootstrap 负责） */
  bootstrapWorld({ reasoner: ruleReasoner });
});

/** 让某事件被显式目击者「亲历」，其余在场者一概不察觉 */
function witness(event: Parameters<typeof worldBus.emit>[0], ids: string[]) {
  const e = { ...event, witnesses: ids };
  const restore = rng.inject(() => 0.99);
  worldBus.emit(e as typeof event);
  restore();
  return e;
}

describe('§47 · Memory Engine 验收', () => {
  it('测试 1 · 记忆创建：世界事件 → 感知 → 记忆', () => {
    start();
    witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    expect(memoryEngine.count(core.S!, 'lita'), '目击者应有记忆').toBeGreaterThan(0);
    const m = memoryEngine.of('lita', core.S!)[0];
    expect(m.source).toBe('direct_observation');
    expect(m.confidence).toBeGreaterThan(0.9);
  });

  it('测试 2 · 不同 NPC 获得不同记忆（没看见就没有）', () => {
    start();
    witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    expect(memoryEngine.count(core.S!, 'lita')).toBeGreaterThan(0);
    expect(memoryEngine.count(core.S!, 'otto'), '未目击者不应有记忆').toBe(0);
  });

  it('测试 3 · 语义检索基线：无 Embedding 时用关键词，且分数不被空维度稀释', () => {
    start();
    const s = core.S!;
    memoryEngine.create({ ownerId: 'lita', type: 'personal_event', content: '三年前玩家在王都救过我', source: 'direct_observation' }, s, 1);
    memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '东市的萝卜降价了', source: 'direct_observation' }, s, 2);
    const hits = hybridRetrieve({ ownerId: 'lita', query: '王都', limit: 5 }, s, 3);
    expect(hits[0].memory.content).toContain('王都');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('测试 4 · 结构化过滤：按时间 / 类型 / 重要度', () => {
    start();
    const s = core.S!;
    memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '第十日的琐事', source: 'direct_observation', importance: 0.1 }, s, 10);
    memoryEngine.create({ ownerId: 'lita', type: 'personal_event', content: '第一日的大事', source: 'direct_observation', importance: 0.9 }, s, 1);

    expect(hybridRetrieve({ ownerId: 'lita', timeRange: { toDay: 5 } }, s, 11)).toHaveLength(1);
    expect(hybridRetrieve({ ownerId: 'lita', memoryTypes: ['personal_event'] }, s, 11)).toHaveLength(1);
    expect(hybridRetrieve({ ownerId: 'lita', minImportance: 0.5 }, s, 11)).toHaveLength(1);
  });

  it('测试 5 · 混合检索：实体维度单独可判（不带关键词，只靠实体匹配区分）', () => {
    start();
    const s = core.S!;
    memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '在广场见到有人争执', source: 'direct_observation', entities: ['player', 'plaza'] }, s, 1);
    memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '在酒馆听到一首歌', source: 'direct_observation', entities: ['tavern'] }, s, 2);
    /* 不给 query：命中与否只能由 entityIds 决定，断言因此可证伪 */
    const hits = hybridRetrieve({ ownerId: 'lita', entityIds: ['tavern'] }, s, 3);
    expect(hits[0].memory.content).toBe('在酒馆听到一首歌');
    expect(hits[0].parts.entityMatch).toBe(1);
  });

  it('测试 6 · 记忆衰减：时间推进后强度下降', () => {
    start();
    const s = core.S!;
    const m = memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '琐事', source: 'direct_observation', importance: 0.1 }, s, 1);
    expect(strengthOf(m, 30)).toBeLessThan(strengthOf(m, 1));
    expect(decayTick(s, 400).forgotten, '久远琐事终将遗忘').toBeGreaterThan(0);
    expect(m.status).toBe('forgotten');
  });

  it('测试 7 · 重要记忆长期保留（衰减率为 0）', () => {
    start();
    const s = core.S!;
    const m = memoryEngine.create({ ownerId: 'lita', type: 'personal_event', content: '玩家救过我的命', source: 'direct_observation', importance: 0.95 }, s, 1);
    expect(m.decayRate, '人生重大事件不衰减').toBe(0);
    expect(strengthOf(m, 100000)).toBeCloseTo(m.importance * m.confidence);
  });

  it('测试 8 · 信息传播：A 告诉 B，B 得到新的二手记忆', () => {
    start();
    const s = core.S!;
    const m = memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '看到有人在广场动手', source: 'direct_observation' }, s, 1);
    const heard = propagate(m.id, 'lita', 'otto', s, 2);
    expect(heard).not.toBeNull();
    expect(heard!.ownerId).toBe('otto');
    expect(heard!.source).toBe('received_information');
    expect(heard!.sourceMemoryId).toBe(m.id);
    expect(heard!.confidence, '每传一手置信度下降').toBeLessThan(m.confidence);
  });

  it('测试 9 · 错误信息：传闻置信度低，且不覆盖亲历（§23/§25）', () => {
    start();
    const s = core.S!;
    /* 真闸：otto 已亲历同一事件，别人传来的说法不该覆盖它 */
    const own = memoryEngine.create({ ownerId: 'otto', type: 'observation', content: '我亲眼看见了', source: 'direct_observation', sourceEventId: 'evt_x' }, s, 1);
    const other = memoryEngine.create({ ownerId: 'lita', type: 'rumor', content: '听来的说法', source: 'rumor', sourceEventId: 'evt_x' }, s, 1);
    expect(propagate(other.id, 'lita', 'otto', s, 2), '已有的亲历不该被传闻覆盖').toBeNull();
    expect(own.source).toBe('direct_observation');
    expect(propagate(other.id, 'lita', 'lita', s, 2), '自己讲给自己也无意义').toBeNull();

    const rumor = memoryEngine.create({ ownerId: 'otto', type: 'rumor', content: '听说玩家杀了贵族', source: 'rumor' }, s, 1);
    expect(rumor.confidence).toBeLessThan(0.5);
    /* 传播链会自然衰减到传不动 */
    let cur = rumor;
    let hops = 0;
    for (let i = 0; i < 20; i++) {
      const next = propagate(cur.id, cur.ownerId, 'relay_' + i, s, 2 + i);
      if (!next) break;
      cur = next;
      hops++;
    }
    expect(hops, '多手之后谣言应当断链').toBeLessThan(20);
  });

  it('测试 10 · 权限边界：检索不到别人的私密记忆（§36）', () => {
    start();
    const s = core.S!;
    memoryEngine.create({ ownerId: 'lita', type: 'secret', content: '只属于我的秘密', source: 'direct_observation' }, s, 1);
    expect(hybridRetrieve({ ownerId: 'otto', query: '秘密' }, s, 2)).toHaveLength(0);
    expect(hybridRetrieve({ ownerId: 'lita', query: '秘密' }, s, 2)).toHaveLength(1);
  });
});

/* ---------------- 审查发现的缺陷：回归护栏 ---------------- */

describe('审查回归护栏', () => {
  it('C1 · 召回只加深印象，绝不改变置信度（§10：被想起 ≠ 被证实）', () => {
    start();
    const s = core.S!;
    const m = memoryEngine.create(
      { ownerId: 'lita', type: 'belief', content: '我猜是玩家干的', source: 'inference', confidence: 0.1, importance: 0.4 },
      s,
      1,
    );
    for (let i = 0; i < 7; i++) memoryEngine.recall('lita', m.id, s, 2 + i);
    expect(m.confidence, '反复想起不应让推测升级成事实').toBeCloseTo(0.1);
    expect(m.recalledCount).toBe(7);
    /* 但保留期确实被延长：衰减锚点跟着最后一次召回走 */
    expect(strengthOf(m, 4)).toBeGreaterThan(strengthOf(m, 40));
  });

  it('C1 · 上下文构建是纯读：重复构建不污染存档', () => {
    start();
    const s = core.S!;
    memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '今天广场很热闹', source: 'direct_observation', importance: 0.6 }, s, 1);
    const m = memoryEngine.of('lita', s)[0];
    buildMemoryContext({ ownerId: 'lita' }, s, 2, 'world_reasoner');
    const snap = { c: m.confidence, r: m.recalledCount, at: m.lastRecalledAt };
    buildMemoryContext({ ownerId: 'lita' }, s, 2, 'world_reasoner');
    expect({ c: m.confidence, r: m.recalledCount, at: m.lastRecalledAt }).toEqual(snap);
  });

  it('C2 · 伪造亲历 / 边界值 / 秘密公开 全部被拒', () => {
    start();
    expect(
      validateMemoryProposal({ ownerId: 'lita', type: 'evidence', content: '我看见玩家杀了人', source: 'direct_observation', confidence: 1 }).ok,
      '亲历必须指得出是哪件事',
    ).toBe(false);
    expect(
      validateMemoryProposal({ ownerId: 'lita', type: 'belief', content: '我猜是他', source: 'inference', confidence: 0.5 }).ok,
      '推测上限的边界值同样拒',
    ).toBe(false);
    expect(
      validateMemoryProposal({
        ownerId: 'lita', type: 'secret', content: '这是我的秘密', source: 'direct_observation',
        sourceEventId: 'evt_1_1', visibility: 'public',
      }).ok,
      '秘密不得同时声明公开',
    ).toBe(false);
  });

  it('I1 · 传播写入遵守容量上限（不绕过 putMemory）', () => {
    start();
    const s = core.S!;
    s.npcs.lita = { att: 0, mem: [], met: true, rels: { otto: { type: 'friend', val: 50 } } };
    for (let i = 0; i < 90; i++) {
      memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '旧闻 ' + i, source: 'direct_observation', visibility: 'public', importance: 0.9 }, s, 1);
    }
    for (let d = 3; d < 200; d += 3) gossipTick(s, d);
    expect(memoryEngine.count(s, 'otto'), '受话者也不得突破上限').toBeLessThanOrEqual(80);
  });

  it('I2 · id 随档持久化（重启后同日不再碰撞）', () => {
    start();
    const s = core.S!;
    const a = memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '甲', source: 'direct_observation' }, s, 5);
    const b = memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '乙', source: 'direct_observation' }, s, 5);
    expect(a.id).not.toBe(b.id);
    expect(s.memSeq, '序号写在 WorldState 上而不是模块变量里').toBeGreaterThanOrEqual(2);
  });

  it('I3/I4 · 去重先于名额截断；超长条目跳过而非一票否决', () => {
    start();
    const s = core.S!;
    /* 大量同文重复 + 一条超长记忆排首位 */
    memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '长'.repeat(3000), source: 'direct_observation', importance: 1 }, s, 1);
    for (let i = 0; i < 8; i++) {
      memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '同一件事反复听说', source: 'received_information', importance: 0.7 }, s, 1);
      memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '第' + i + '件不同的琐事', source: 'direct_observation', importance: 0.6 }, s, 1);
    }
    const lines = buildMemoryContext({ ownerId: 'lita' }, s, 2, 'world_reasoner');
    expect(lines.length, '不应被首条超长记忆清空').toBeGreaterThan(2);
    const texts = lines.map((l) => l.text);
    expect(new Set(texts).size, '不应出现重复行').toBe(texts.length);
  });

  it('I6 · 压缩不抹掉任何原文，摘要另立一条', () => {
    start();
    const s = core.S!;
    for (let i = 0; i < 5; i++) {
      memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '原件 ' + i, source: 'direct_observation', importance: 0.1 }, s, 1);
    }
    const before = memoryEngine.of('lita', s).map((m) => m.content);
    compress('lita', s, 20);
    const after = memoryEngine.of('lita', s);
    for (const c of before) {
      expect(after.some((m) => m.content === c), '原文「' + c + '」应仍留在记忆表里').toBe(true);
    }
    expect(after.some((m) => m.content.includes('往事泛黄'))).toBe(true);
  });

  it('I7 · 传播同时写感知表：同一 NPC 的认知不再分叉', () => {
    start();
    const s = core.S!;
    const e = witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    const mine = memoryEngine.of('lita', s);
    expect(mine.length).toBeGreaterThan(0);
    const heard = propagate(mine[0].id, 'lita', 'otto', s, 2);
    expect(heard).not.toBeNull();
    expect(perception.knowers(e.id, s), '调查系统读的感知表也应记下这次听说').toContain('otto');
  });

  it('I8 · 事件记忆带行动者，且不裸奔内部 id', () => {
    start();
    witness(makeEvent({ type: 'character_died', day: 1, level: 2, actor: 'player', target: 'bandit', location: 'plaza', cause: 'combat' }), ['lita']);
    const m = memoryEngine.of('lita', core.S!)[0];
    expect(m.content, '必须写出是谁干的').toContain('你');
    expect(m.content).not.toMatch(/^(有人|npc_|character_)/);
  });
});

describe('§11/§15 · 向量缓存与语义打分', () => {
  const stub = (f: (t: string) => number[]) => ({
    name: 'stub',
    getDimension: () => 2,
    embed: (t: string) => Promise.resolve(f(t)),
  });

  afterEach(() => {
    clearEmbeddingCache();
    setEmbeddingProvider(null);
  });

  it('未预热时语义项缺失，其余分量照常工作（不被空维度稀释）', () => {
    start();
    const s = core.S!;
    memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '广场上有人争执', source: 'direct_observation' }, s, 1);
    const hits = hybridRetrieve({ ownerId: 'lita', query: '广场' }, s, 2);
    expect(hits).toHaveLength(1);
    expect(hits[0].parts.semantic, '没预热就不该有语义分量').toBe(0);
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('预热后语义分量生效，并按余弦相似度重排', async () => {
    start();
    const s = core.S!;
    memoryEngine.create({ ownerId: 'lita', type: 'personal_event', content: '三年前玩家在王都救过我', source: 'direct_observation', importance: 0.5 }, s, 1);
    memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '东市的萝卜降价了', source: 'direct_observation', importance: 0.5 }, s, 1);

    setEmbeddingProvider(stub((t) => [t.includes('王都') ? 1 : 0.01, 0.2]));
    await warmQuery('王都');
    await warmMemories(memoryEngine.of('lita', s).map((m) => ({ id: m.id, ownerId: 'lita', content: m.content })));

    const hits = hybridRetrieve({ ownerId: 'lita', query: '王都' }, s, 2);
    expect(hits[0].parts.semantic, '命中缓存后语义分量应有值').toBeGreaterThan(0);
    expect(hits[0].memory.content).toContain('王都');
  });

  it('余弦相似度：同向为 1，反向截断为 0，空向量安全', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [-1, 0])).toBe(0);
    expect(cosine([], [1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it('缓存按内容指纹失效：内容变了就不复用旧向量', async () => {
    setEmbeddingProvider(stub(() => [1, 1]));
    await warmMemories([{ id: 'm1', ownerId: 'lita', content: '旧内容' }]);
    expect(cachedMemoryVec('m1', '旧内容')).toBeDefined();
    expect(cachedMemoryVec('m1', '换了内容'), '内容变过就不该命中').toBeUndefined();
  });
});

describe('§22/§36 · 关系网传话与私密边界', () => {
  it('传话走确定性节律：非节律日不传，且不消耗主随机序列', () => {
    start();
    const s = core.S!;
    s.npcs.lita = { att: 0, mem: [], met: true, rels: { otto: { type: 'friend', val: 50 } } };
    memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '广场上有人吵架', source: 'direct_observation', visibility: 'public' }, s, 1);
    expect(gossipTick(s, 2), '非节律日不传').toBe(0);
    expect(gossipTick(s, 3), '节律日沿关系网传开').toBeGreaterThan(0);
    expect(memoryEngine.count(s, 'otto')).toBeGreaterThan(0);
  });

  it('传话有节流：一轮只讲最近几件，不会把全部记忆倒出去', () => {
    start();
    const s = core.S!;
    s.npcs.lita = { att: 0, mem: [], met: true, rels: { otto: { type: 'friend', val: 50 } } };
    for (let i = 0; i < 12; i++) {
      memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '第' + i + '件事', source: 'direct_observation', visibility: 'public' }, s, 1);
    }
    const n = gossipTick(s, 3);
    expect(n).toBeGreaterThan(0);
    expect(n, '一轮最多传 3 件给 1 个关系人').toBeLessThanOrEqual(3);
  });

  it('秘密不外传（私家经历可以转述，秘密守口如瓶）', () => {
    start();
    const s = core.S!;
    const secret = memoryEngine.create({ ownerId: 'lita', type: 'secret', content: '我的秘密', source: 'direct_observation', visibility: 'secret' }, s, 1);
    expect(propagate(secret.id, 'lita', 'otto', s, 2), '秘密不该被讲出去').toBeNull();
    const pub = memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '广场贴了张公告', source: 'direct_observation', visibility: 'public' }, s, 1);
    expect(propagate(pub.id, 'lita', 'otto', s, 2), '公开记忆可以传').not.toBeNull();
  });
});

/* ---------------- 方案 §13 / §29：向量与事实分开存 ---------------- */

describe('§13/§29 · VectorStore 与持久化', () => {
  afterEach(() => {
    vectorStore.clear();
  });

  it('向量入 store：按 ownerIds 取子集并按相似度排序', () => {
    vectorStore.upsertMany([
      { id: 'a', ownerId: 'lita', fp: 'f1', vec: [1, 0], lastUsed: 1 },
      { id: 'b', ownerId: 'lita', fp: 'f2', vec: [0, 1], lastUsed: 1 },
      { id: 'c', ownerId: 'otto', fp: 'f3', vec: [1, 0], lastUsed: 1 },
    ]);
    /* 显式给阈值：正交向量（余弦 0）本来就不该算命中 */
    const hit = vectorStore.search([1, 0], { ownerIds: ['lita'], limit: 5, minScore: 0.1 });
    expect(hit.map((h) => h.id)).toEqual(['a']);
    expect(hit[0].score).toBeCloseTo(1);
    expect(vectorStore.search([1, 0], { limit: 5 }).length, '不限归属时三条都在').toBe(3);
  });

  it('容量上限触发 LRU 淘汰：最久未用的先走', () => {
    const small = new (vectorStore.constructor as new (cap: number) => typeof vectorStore)(2);
    small.upsert({ id: 'x', ownerId: 'o', fp: 'f', vec: [1], lastUsed: 1 });
    small.upsert({ id: 'y', ownerId: 'o', fp: 'f', vec: [1], lastUsed: 5 });
    small.upsert({ id: 'z', ownerId: 'o', fp: 'f', vec: [1], lastUsed: 9 });
    expect(small.size()).toBe(2);
    expect(small.get('x'), '最久未用的应被淘汰').toBeUndefined();
    expect(small.get('z')).toBeDefined();
  });

  it('导出按**字节预算**截断（不是条数上限）；恢复时丢弃残缺行', () => {
    vectorStore.upsertMany([
      { id: 'old', ownerId: 'o', fp: 'f', vec: [1, 0], lastUsed: 1 },
      { id: 'new', ownerId: 'o', fp: 'f', vec: [1, 0], lastUsed: 9 },
    ]);
    /* 二维单条约 120 字节：给 130 的预算恰好只装得下最近用的一条。
       用字节而不是条数，是因为同样条数在不同维度下体积差五倍，
       而 localStorage 的配额是按字节算的。 */
    const rows = exportVectors(130);
    expect(rows.map((r) => r.id)).toEqual(['new']);
    vectorStore.clear();
    const n = restoreVectors([
      { id: 'k', ownerId: 'o', fp: 'f', vec: [1], lastUsed: 3 },
      { id: 'bad' },
      { id: 'noVec', ownerId: 'o', fp: 'f', vec: [] },
    ]);
    expect(n, '只恢复完整行').toBe(1);
    expect(vectorStore.get('k')).toBeDefined();
  });
});

/* ---------------- 方案 §22：势力通道 ---------------- */

describe('§22 · 势力传播通道', () => {
  const npcWithFaction = () => Object.keys(WB.npcs).find((id) => (WB.npcs[id] as { faction?: string }).faction);

  it('NPC → 势力：个人所知进入集体记忆', () => {
    start();
    const s = core.S!;
    const npc = npcWithFaction();
    expect(npc, '世界书里应有隶属势力的 NPC').toBeTruthy();
    const faction = (WB.npcs[npc!] as { faction?: string }).faction!;
    memoryEngine.create({ ownerId: npc!, type: 'observation', content: '广场上有人动手', source: 'direct_observation' }, s, 1);

    const n = propagateToFaction(npc!, s, 2);
    expect(n).toBeGreaterThan(0);
    expect(memoryEngine.count(s, faction), '势力应获得集体记忆').toBeGreaterThan(0);
  });

  it('势力 → 成员：集体记忆知会成员（只对运行时已建档的 NPC）', () => {
    start();
    const s = core.S!;
    const npc = npcWithFaction()!;
    const faction = (WB.npcs[npc] as { faction?: string }).faction!;
    /* 玩家接触过才会有运行时档案——「世界书里有」不等于「这个世界里有」 */
    npcDyn(npc, s);

    memoryEngine.create({ ownerId: faction, type: 'faction_memory', content: '本部下达了新的盘查令', source: 'received_information' }, s, 1);
    const n = propagateFromFaction(faction, s, 2);
    expect(n).toBeGreaterThan(0);
    expect(memoryEngine.count(s, npc), '成员应被知会').toBeGreaterThan(0);
  });

  it('未建档的 NPC 不会被势力知会（不该为玩家从未见过的人写记忆）', () => {
    start();
    const s = core.S!;
    const npc = npcWithFaction()!;
    const faction = (WB.npcs[npc] as { faction?: string }).faction!;
    delete s.npcs[npc];
    memoryEngine.create({ ownerId: faction, type: 'faction_memory', content: '本部下达了新的盘查令', source: 'received_information' }, s, 1);
    expect(propagateFromFaction(faction, s, 2), '静态世界书里的 NPC 不属于这个世界版本').toBe(0);
  });
});

/* ---------------- 方案 §24 / §25：信念 ---------------- */

describe('§24/§25 · 信念系统', () => {
  it('同命题的记忆聚合成信念，置信度取最可信的一条 + 少量加成', () => {
    start();
    const s = core.S!;
    const e = witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    /* 再加一条同来源的二手说法：命题相同，置信度更低 */
    memoryEngine.create(
      { ownerId: 'lita', type: 'rumor', content: '听说玩家偷了东西', source: 'received_information', sourceEventId: e.id, confidence: 0.4 },
      s,
      2,
    );
    const n = formBeliefs('lita', s, 2);
    expect(n).toBeGreaterThan(0);
    const prop = 'player|crime_committed|theft';
    const b = beliefsOf('lita', s).find((x) => x.proposition === prop);
    expect(b, '命题应为 主体|事件类型|客体').toBeTruthy();
    expect(b!.supporting.length).toBe(2);
    expect(b!.confidence, '取最可信的一条（亲历 1.0）').toBe(1);
    expect(believesIn('lita', prop, s)).toBe(true);
  });

  it('同类记忆的加成确实生效（低置信度也能被同类佐证抬高，但有上限）', () => {
    start();
    const s = core.S!;
    for (let i = 0; i < 4; i++) {
      memoryEngine.create(
        { ownerId: 'lita', type: 'rumor', content: '听说玩家偷了东西 ' + i, source: 'received_information', confidence: 0.4, proposition: 'player|crime_committed|theft' },
        s,
        1 + i,
      );
    }
    formBeliefs('lita', s, 5);
    const b = beliefsOf('lita', s)[0];
    expect(b.confidence, '4 条同命题：0.4 起，加成 0.15 封顶').toBeCloseTo(0.55, 5);
    expect(b.confidence, '不得因为堆数量就越过 1').toBeLessThan(1);
  });

  it('§25 冲突保留：原始记忆不因观点改变而被覆盖', () => {
    start();
    const s = core.S!;
    const e = witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    const before = memoryEngine.of('lita', s).length;
    formBeliefs('lita', s, 2);
    expect(memoryEngine.of('lita', s).length, '形成信念不应改动记忆表').toBe(before);
    expect(memoryEngine.of('lita', s).some((m) => m.sourceEventId === e.id)).toBe(true);
  });

  it('命题拆出主谓宾（下游不必再解析字符串）', () => {
    start();
    const s = core.S!;
    witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    formBeliefs('lita', s, 2);
    const b = beliefsOf('lita', s)[0];
    expect([b.subject, b.predicate, b.object]).toEqual(['player', 'crime_committed', 'theft']);
    expect(partsOf('a|b|c')).toEqual({ subject: 'a', predicate: 'b', object: 'c' });
  });

  it('§23 行动规则表已填（卡 J2）：命中必须落在可执行白名单上', () => {
    start();
    const s = core.S!;
    witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    formBeliefs('lita', s, 2);
    expect(beliefsOf('lita', s).length, '前置：信念本身是有的').toBeGreaterThan(0);

    /* 卡 J2 之前，这条断言的是 toEqual([])，注释写着「规则表为空是刻意的」。
       data/world/memory.json 的 beliefActions.rules 现已填入，同一条信念必须命中行动。
       顺带把「规则写错名字」的失败模式提前挡住：动作必须已接入执行器
       （Validator 也会拒，但那时已经是执行期，报错离现场太远）。 */
    const hits = beliefActionsFor('lita', s);
    expect(hits.length, '规则表填好后这条信念该命中行动').toBeGreaterThan(0);
    for (const h of hits) {
      expect(capabilities.executableList(), h.action + ' 必须已接入执行器').toContain(h.action);
      expect(h.target, h.action + ' 必须解析出作用对象').toBeTruthy();
    }
  });

  it('§23 匹配机制可被合成规则验收（内容未填也能证明这一跳是通的）', () => {
    start();
    const s = core.S!;
    witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    formBeliefs('lita', s, 2);
    const mine = beliefsOf('lita', s);
    const rule = { match: { subject: 'player', predicate: 'crime_committed', minConfidence: 0.6 }, action: 'start_investigation' };

    expect(matchBeliefRules('lita', mine, [rule]).map((h) => h.action)).toEqual(['start_investigation']);
    expect(matchBeliefRules('lita', mine, [{ ...rule, match: { predicate: 'helped' } }]), '谓词不符不驱动').toEqual([]);
    expect(matchBeliefRules('lita', mine, [{ ...rule, match: { subject: 'otto' } }]), '主体不符不驱动').toEqual([]);
    const weak = [{ ...mine[0], confidence: 0.5 }];
    expect(matchBeliefRules('lita', weak, [rule]), '置信度不够不驱动').toEqual([]);
    expect(matchBeliefRules('lita', [{ ...mine[0], confidence: 0.6 }], [rule]).length, '恰好够线就驱动').toBe(1);
  });

  it('§23 once 规则：同一条信念不重复引发同一行动', () => {
    start();
    const s = core.S!;
    witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    formBeliefs('lita', s, 2);
    const prop = beliefsOf('lita', s)[0].proposition;
    const once = { match: { subject: 'player' }, action: 'start_investigation' };
    const always = { match: { subject: 'player' }, action: 'grumble', once: false };

    markBeliefActed('lita', prop, 'start_investigation', s, 5);
    /* 只把「刚被标记过的那条信念」喂进去：这个用例要验的是 once 语义，
       不该被同一个角色身上其它信念（例如目击罪行带来的好感变化）搅进来。 */
    const marked = beliefsOf('lita', s).filter((x) => x.proposition === prop);
    expect(marked).toHaveLength(1);
    const hit = matchBeliefRules('lita', marked, [once, always]).map((h) => h.action);
    expect(hit, 'once 的被挡下，once:false 的照旧').toEqual(['grumble']);
  });

  it('信念被据此行动后留下记录（once 规则据此不再重复驱动）', () => {
    start();
    const s = core.S!;
    witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    formBeliefs('lita', s, 2);
    const prop = beliefsOf('lita', s)[0].proposition;
    expect(beliefsOf('lita', s)[0].actedAt).toBeUndefined();
    markBeliefActed('lita', prop, 'start_investigation', s, 5);
    const b = beliefsOf('lita', s)[0];
    expect(b.actedAt).toBe(5);
    expect(b.actionKind).toBe('start_investigation');
  });

  it('幂等：重复形成不累积信念条目', () => {
    start();
    const s = core.S!;
    witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    const a = formBeliefs('lita', s, 2);
    const b = formBeliefs('lita', s, 3);
    expect(b).toBe(a);
    expect(beliefsOf('lita', s).length).toBe(a);
  });
});

describe('§37 · 记忆提案安全边界', () => {
  it('推测不得冒充事实（置信度上限）', () => {
    const bad = validateMemoryProposal({ ownerId: 'lita', type: 'belief', content: '我认为是玩家干的', source: 'inference', confidence: 0.9 });
    expect(bad.ok).toBe(false);
    const ok = validateMemoryProposal({ ownerId: 'lita', type: 'belief', content: '我猜是玩家干的', source: 'inference', confidence: 0.3 });
    expect(ok.ok).toBe(true);
  });

  it('归属者必须是已知实体；数值必须在单位区间', () => {
    expect(validateMemoryProposal({ ownerId: '不存在的人', type: 'observation', content: 'x', source: 'rumor' }).ok).toBe(false);
    expect(validateMemoryProposal({ ownerId: 'lita', type: 'observation', content: 'x', source: 'rumor', importance: 5 }).ok).toBe(false);
    expect(validateMemoryProposal({ ownerId: 'lita', type: '非法类型', content: 'x', source: 'rumor' }).ok).toBe(false);
  });

  it('提案落库走 propose（AI 不能直接写）', () => {
    start();
    const s = core.S!;
    const bad = memoryEngine.propose({ ownerId: 'lita', type: 'observation', content: 'x', source: 'rumor', importance: 9 }, s, 1);
    expect(bad.ok).toBe(false);
    expect(memoryEngine.count(s, 'lita')).toBe(0);
    const good = memoryEngine.propose({ ownerId: 'lita', type: 'observation', content: '玩家今天来过', source: 'conversation' }, s, 1);
    expect(good.ok).toBe(true);
    expect(memoryEngine.count(s, 'lita')).toBe(1);
  });
});

describe('§19/§26/§35 · 上下文与压缩', () => {
  it('上下文构建遵守 Token 预算并去重', () => {
    start();
    const s = core.S!;
    for (let i = 0; i < 40; i++) {
      memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '第' + i + '件琐事：广场上人来人往，风把告示吹得哗哗响。', source: 'direct_observation', importance: 0.6 }, s, 1);
    }
    const lines = buildMemoryContext({ ownerId: 'lita' }, s, 2, 'world_reasoner');
    expect(lines.length).toBeGreaterThan(0);
    const total = lines.reduce((a, l) => a + l.text.length, 0);
    expect(total, '总长必须落在 Token 预算换算的字数内').toBeLessThanOrEqual(CONTEXT_TOKENS * CHARS_PER_TOKEN);
    expect(lines.length, '不应倾泻全部记忆').toBeLessThan(40);
  });

  it('压缩把琐碎旧记忆聚成摘要，原始事实退出检索但不销毁', () => {
    start();
    const s = core.S!;
    for (let i = 0; i < 5; i++) {
      memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '琐事 ' + i, source: 'direct_observation', importance: 0.1 }, s, 1);
    }
    const merged = compress('lita', s, 20);
    expect(merged).toBeGreaterThan(0);
    const list = memoryEngine.of('lita', s);
    expect(list.filter((m) => m.status === 'archived').length).toBeGreaterThan(0);
    expect(list.some((m) => m.content.includes('往事泛黄'))).toBe(true);
  });

  it('日边界 tick 同时做衰减与压缩', () => {
    start();
    const s = core.S!;
    /* Phase 6 前提：逐条衰减是「相关 NPC」（L0/L1）的待遇——从未被投射过的 NPC
       只做归并，见 memory-lod.test.ts「L2 只归并、不逐条衰减」。
       要让这条用例继续验证**衰减语义**，就把 lita 构造成已接触的活人：
       用规则手段建条目（npcDyn 即唯一投影入口），而不是把断言放宽成恒真。 */
    mutate.npcMet('lita');
    expect(memoryLodOf('lita', s), '前置：场景必须是会衰减的那一层').not.toBe('L2');
    for (let i = 0; i < 4; i++) memoryEngine.create({ ownerId: 'lita', type: 'observation', content: '旧事 ' + i, source: 'direct_observation', importance: 0.1 }, s, 1);
    const r = memoryTick(s, 30);
    expect(r.compressed).toBeGreaterThan(0);
    /* 久远到足以真的被遗忘——原来是 typeof === 'number' 的恒真断言 */
    const far = memoryTick(s, 400);
    expect(far.forgotten).toBeGreaterThan(0);
  });
});

describe('§22/§29 · 传播不依赖事件日志', () => {
  it('读档后（世界史已空）传播仍登记感知：事实够不够记，不看日志还在不在', () => {
    start();
    const s = core.S!;
    const m = memoryEngine.create(
      {
        ownerId: 'lita',
        type: 'observation',
        content: '目睹老乔倒下了',
        source: 'direct_observation',
        sourceEventId: 'evt_999_1', // 指向一条早已不存在的世界事件（模拟读档后的日志）
        proposition: 'player|character_died|joe',
      },
      s,
      1,
    );
    const heard = propagate(m.id, 'lita', 'otto', s, 2);
    expect(heard, '记忆照样传得出去').not.toBeNull();
    expect(s.knowledge?.otto?.length ?? 0, '感知表也要登记（不再只写记忆）').toBeGreaterThan(0);
    expect(s.knowledge!.otto[0].via).toBe('rumor');
    expect(s.knowledge!.otto[0].type, '谓词从命题里还原').toBe('character_died');
  });
});

/* ============================================================
   认知层单源（审计整改）：老表 NpcDynamic.mem 退役
   —— 双真相来源的具体危害：同一个 NPC 对同一件事两处各存一份，
      衰减/遗忘/私密边界只在新表生效，老表由 AI 文本直接写入。
   ============================================================ */

describe('§21 · 认知层单源', () => {
  it('写入统一：addMem 落进唯一的记忆表，老字段不再增长', () => {
    start();
    const s = core.S!;
    const before = memoryCount(s, 'lita');
    addMem('lita', '他记得这件事', 2);
    expect(memoryCount(s, 'lita')).toBe(before + 1);
    expect(s.npcs.lita.mem.length, '老表已退役，不该再被写入').toBe(0);
    expect(memOf('lita', s).some((m) => m.event === '他记得这件事')).toBe(true);
  });

  it('旧档迁移：老表记忆搬进记忆表、保住私密档、重复调用不重复搬', () => {
    start();
    const s = core.S!;
    s.npcs.joe = {
      att: 10,
      met: true,
      mem: [
        { event: '旧档记忆甲', imp: 3, day: 2 },
        { event: '旧档记忆乙', imp: 1, day: 3, tier: 'secret' },
      ],
    };
    expect(migrateLegacyMemories(s)).toBe(2);
    expect(s.npcs.joe.mem, '搬完即清，不留双份').toEqual([]);
    expect(memoryCount(s, 'joe')).toBe(2);
    expect(memoriesOf('joe', s).find((m) => m.content === '旧档记忆乙')?.visibility, 'secret 是不可传播档，迁移不许降级').toBe('secret');
    expect(migrateLegacyMemories(s), '幂等：再调一次不重复搬').toBe(0);
    expect(memoryCount(s, 'joe')).toBe(2);
  });

  it('结构守卫：除迁移模块外，生产代码不再读写老记忆表（静态扫描）', () => {
    /** 老表访问的三种真实写法：npcs[x].mem / npcDyn(x).mem / dy.mem */
    const LEGACY_ACCESS = /(\bnpcs\s*\[[^\]]+\]\s*\.mem\b)|(\bnpcDyn\([^)]*\)\s*\.mem\b)|(\bdy\.mem\b)/;
    const bad: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === 'tests' || ent.name === 'node_modules') continue;
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(ent.name)) continue;
        if (p.endsWith('LegacyMemory.ts')) continue; // 旧档迁移是唯一允许碰老表的地方
        readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const code = line.split('//')[0];
            if (/^(\/\*|\*)/.test(code.trim())) return; // 纯注释行不算
            /* 只认「老表访问」的真实形态。裸的 `.mem` 会误伤 ctx.mem / r.mem / j.mem
               （AI 提示词与模型回包里的记忆字符串字段，与老表无关）。 */
            if (LEGACY_ACCESS.test(code)) bad.push(p + ':' + (i + 1) + ' ' + code.trim());
          });
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(bad, '新增读点若重新摸 npcs[id].mem，这里会红').toEqual([]);
  });

  it('读取投影 memOf 只回记忆表（老表即便有数据也不再被读）', () => {
    start();
    const s = core.S!;
    addMem('mia', '甲', 1);
    addMem('mia', '乙', 2);
    expect(memOf('mia', s).map((m) => m.event)).toEqual(['甲', '乙']);
    s.npcs.mia.mem = [{ event: '不该被读到的老表条目', imp: 3, day: 1 }];
    expect(memOf('mia', s).some((m) => m.event.includes('不该被读到')), '投影不读老表').toBe(false);
  });
});

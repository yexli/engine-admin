/* World Memory Engine：摄取（感知边界/传闻）/ 生命周期 / 检索 / 持久化 */
import { describe, expect, it } from 'vitest';
import { InMemoryMemoryStorage } from '../src/storage';
import { MemoryEngine } from '../src/engine';
import type { WorldFact } from '../src/types';

const fact = (over: Partial<WorldFact> = {}): WorldFact => ({
  id: 'evt_1_1',
  type: 'theft',
  day: 3,
  actor: 'petty_thief',
  target: 'grocer',
  location: 'market',
  witnesses: ['grocer', 'guard_a'],
  data: { importance: 0.7 },
  ...over,
});

describe('事实摄取（W8.2：感知边界）', () => {
  it('目击者各得一条亲历记忆（置信 1）；无目击者时 actor 自记', () => {
    const m = new MemoryEngine();
    const created = m.ingestFact(fact());
    expect(created.map((c) => c.ownerId)).toEqual(['grocer', 'guard_a']);
    expect(created[0].confidence).toBe(1);
    expect(created[0].via).toBe('witness');
    expect(created[0].importance).toBe(0.7);
    expect(created[0].entities).toContain('market');

    const solo = m.ingestFact(fact({ id: 'evt_1_2', witnesses: [] }));
    expect(solo.map((c) => c.ownerId)).toEqual(['petty_thief']);
  });

  it('传闻：保真度衰减（置信 = rumorConfidence），文案可由宿主改写', () => {
    const m = new MemoryEngine();
    const [rumor] = m.spreadRumor(fact(), ['barfly'], '听说市场有人被偷了');
    expect(rumor.via).toBe('rumor');
    expect(rumor.confidence).toBeLessThan(1);
    expect(rumor.text).toBe('听说市场有人被偷了');
  });
});

describe('生命周期（衰减 / 遗忘 / 容量）', () => {
  it('首个 tick 建立基线不衰减；之后逐日线性衰减（重要度高衰得慢）；同日重复 tick 不叠加', () => {
    const m = new MemoryEngine({ config: { decayPerDay: 0.1 } });
    /* via: witness → 基础置信 1 */
    m.remember({ ownerId: 'a', text: '大事', day: 1, importance: 1, via: 'witness' });
    m.remember({ ownerId: 'a', text: '小事', day: 1, importance: 0, via: 'witness' });

    m.tickDay(2); // 基线：首个 tick 不衰减
    expect(m.all('a').every((e) => e.confidence === 1)).toBe(true);

    m.tickDay(3); // 过去 1 日：大事衰 50%，小事全速
    const after = Object.fromEntries(m.all('a').map((e) => [e.text, e.confidence]));
    expect(after['大事']).toBeCloseTo(0.95, 5);
    expect(after['小事']).toBeCloseTo(0.9, 5);

    m.tickDay(3); // 同日重复不叠加
    expect(m.all('a').map((e) => e.confidence)).toEqual([after['大事'], after['小事']]);
  });

  it('低于遗忘线 → forgotten；检索默认不返回；显式 includeForgotten 可审计', async () => {
    const m = new MemoryEngine({ config: { decayPerDay: 0.6, forgetBelow: 0.5 } });
    m.remember({ ownerId: 'a', text: '转瞬即忘', day: 1, importance: 0, via: 'witness' });
    m.tickDay(2); // 基线
    m.tickDay(3); // 1.0 - 0.6 = 0.4 < 0.5 → 遗忘
    expect(m.all('a')[0].forgotten).toBe(true);
    expect(await m.recall('a', '转瞬').then((h) => h.length)).toBe(0);
    expect((await m.recall('a', '转瞬', { includeForgotten: true })).length).toBe(1);
  });

  it('容量上限：超出淘汰置信最低者', () => {
    const m = new MemoryEngine({ config: { maxPerOwner: 3 } });
    for (let i = 0; i < 5; i++) {
      m.remember({ ownerId: 'a', text: '条目' + i, day: 1, importance: 0, confidence: 0.2 + i * 0.1 });
    }
    expect(m.all('a').filter((e) => !e.forgotten)).toHaveLength(3);
  });
});

describe('检索（W8.3）', () => {
  it('词面命中 + 置信/新近度加权；召回强化（recallCount）', async () => {
    const m = new MemoryEngine();
    m.ingestFact(fact()); // grocer 亲历被偷（置信 1）
    m.remember({ ownerId: 'grocer', text: '守卫说过市场夜里不太平', day: 4, kind: 'rumor', importance: 0.5 });
    const hits = await m.recall('grocer', 'market 被偷', { day: 5 });
    expect(hits.length).toBe(2);
    expect(hits[0].text).toContain('petty_thief'); // 置信 1 的亲历排前
    expect(hits[0].recallCount).toBe(1);
  });

  it('向量钩子可用时并入语义分；钩子失败静默回词面（渐进增强）', async () => {
    const texts: string[] = [];
    const vecRow = [1, 0];
    const m = new MemoryEngine({
      embed: {
        embed: async (ts: string[]) => {
          texts.push(...ts);
          return ts.map((t) => (t.includes('被偷') || t.includes('query-stolen') ? vecRow : [0, 0]));
        },
      },
    });
    m.ingestFact(fact({ id: 'evt_1_1' }));
    const hits = await m.recall('grocer', 'query-stolen');
    expect(hits.length).toBe(1);
    expect(texts[0]).toBe('query-stolen');

    const broken = new MemoryEngine({ embed: { embed: async () => null } });
    broken.ingestFact(fact());
    expect((await broken.recall('grocer', 'theft')).length).toBe(1); // 回词面
  });
});

describe('持久化（W8.4）', () => {
  it('快照随端口往返；重启后序号续接不撞号；clear 后为空', () => {
    const store = new InMemoryMemoryStorage();
    const m = new MemoryEngine({ save: store });
    m.ingestFact(fact()); // grocer + guard_a
    m.ingestFact(fact({ id: 'evt_1_2', witnesses: ['guard_b'] })); // guard_b
    expect(store.load()!.entries).toHaveLength(3);

    /* 模拟重启：新引擎从同一端口恢复，序号续接不撞号 */
    const m2 = new MemoryEngine({ save: store });
    const e = m2.remember({ ownerId: 'guard_a', text: '重启后新记忆', day: 4 });
    const allIds = store.load()!.entries.map((x) => x.id);
    expect(allIds.filter((x) => x === e.id)).toHaveLength(1);
    expect(store.load()!.entries.length).toBe(4);

    store.clear();
    expect(store.load()).toBeNull();
  });
});

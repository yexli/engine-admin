/* ============================================================
   卡 Q3 · 可追溯性红队（《后续开发方案-阶段J》）
   —— 让「因果能够追溯」从口号变成可复现的断言。

   在此之前这句话是**不可验证**的：世界史在 src/ui/** 下消费点为 0，
   没人知道链到底能不能追。卡 J1 开了出口，本文件负责证明出口后面有货。

   四条不变量：
     ① 真实操作链上的关键事实确实进了世界史（且噪音被挡住）；
     ② 链不悬空：任何 parentId 都指向缓冲内真实存在的事实；
     ③ trace_event 不掺无关事件（宁缺毋滥）；
     ④ 追溯走的是**运行时因果**，不是 events.json 里剧本的静态依赖名。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, core, dispatch, eventMeta, newGame, resetWorld, rng, scheduler, world } from '@/world';
import { advance } from '@/world/WorldClock';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { worldBus } from '@/events/EventBus';
import { makeEvent, resetEventSeq } from '@/events/EventSchema';
import { worldEventLog } from '@/events/EventStore';
import { plugins } from '@/plugins/PluginRegistry';
import { worldExecutor } from '@/execution/WorldExecutor';
import { bootstrapWorld } from '@/plugins/bootstrap';
import { formBeliefs } from '@/memory/belief/BeliefSystem';
import { commitCrime } from '@/systems/law/Law';
import { playerAct, startCombat } from '@/systems/combat/Combat';
import { shopRows } from '@/systems/economy/Shop';
import lawRaw from '@/data/world/law.json';

const CRIME_IDS = Object.keys((lawRaw as unknown as { crimes?: Record<string, unknown> }).crimes ?? {});
const start = () => newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  worldBus.reset();
  plugins.clear();
  worldExecutor.clear();
  worldEventLog.clear();
  resetEventSeq();
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  bootstrapWorld({ reasoner: ruleReasoner });
});

afterEach(() => {
  core.S = null;
  resetWorld();
});

/** 走一遍真实操作链：走动 → 大额交易 → 犯罪 → 打完一场架 */
function playChain() {
  start();
  dispatch({ type: 'travel', loc: 'market' });
  core.S!.player.gold = 999999;
  core.curShop = 'grocer';
  const rows = shopRows('grocer');
  if (rows.length) {
    const top = rows.reduce((a, b) => (b.price > a.price ? b : a));
    dispatch({ type: 'shopBuy', id: top.iid, p: top.price });
  }
  commitCrime(CRIME_IDS[0]);
  startCombat(['rabbit']);
  for (let i = 0; i < 60 && core.CB; i++) playerAct('atk');
}

describe('卡 Q3 · 可追溯性红队', () => {
  it('真实操作链上的关键事实都进了世界史', () => {
    expect(CRIME_IDS.length, '世界书缺少罪行定义').toBeGreaterThan(0);
    playChain();
    const types = world.query.get_world_log(400).map((e) => e.type);
    expect(types, '犯罪没进世界史').toContain('crime_committed');
    expect(types, '击杀没进世界史').toContain('character_died');
  });

  it('链不悬空：任何 parentId 都指向缓冲内真实存在的事实', () => {
    playChain();
    const log = world.query.get_world_log(400);
    expect(log.length, '前置：世界史非空').toBeGreaterThan(0);
    expect(worldEventLog.size(), '前置：缓冲未溢出（溢出会让老父事件合法地消失）').toBeLessThan(500);

    const ids = new Set(log.map((e) => e.id));
    const dangling = log
      .filter((e) => e.parentId && !ids.has(e.parentId))
      .map((e) => e.type + ' → ' + e.parentId);
    expect(dangling, '有事实指向了缓冲里不存在的父——链断了').toEqual([]);
  });

  it('每一条有因果父的事实都能追到根', () => {
    playChain();
    const log = world.query.get_world_log(400);
    for (const e of log) {
      if (!e.parentId) continue;
      const chain = world.query.trace_event(e.id, 12);
      expect(chain[0].id, '链首必须是被查的那条').toBe(e.id);
      /* 链尾要么是根（parentId 为空），要么是深度到顶被截断——
         两种都合法，但不许出现「链尾还指向一个不存在的父」这种假根。 */
      const tail = chain[chain.length - 1];
      if (tail.parentId) {
        expect(chain.length, '链尾还有父时，必须是深度到顶而非断链').toBe(12);
      }
    }
  });

  it('trace_event 不掺无关事件（宁缺毋滥）', () => {
    start();
    worldEventLog.clear();
    const a1 = makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player' });
    worldBus.emit(a1);
    const a2 = makeEvent({ type: 'reputation_changed', day: 1, level: 2, parentId: a1.id });
    worldBus.emit(a2);
    const b1 = makeEvent({ type: 'city_at_war', day: 1, level: 3, actor: 'empire' });
    worldBus.emit(b1);

    const chain = world.query.trace_event(a2.id);
    expect(chain.map((e) => e.id)).toEqual([a2.id, a1.id]);
    expect(chain.map((e) => e.id), '另一条链上的事实不该出现').not.toContain(b1.id);
  });

  it('追溯走的是运行时因果，不是 events.json 的静态剧本依赖', () => {
    start();
    worldEventLog.clear();
    /* 造一条**任何剧本定义里都不存在**的父子关系：
       city_disaster（世界级灾祸）由 crime_committed（一桩盗窃）引发，
       events.json 里没有这条依赖。静态剧本永远给不出这条链，
       只有运行时记账能。 */
    const p = makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player' });
    worldBus.emit(p);
    const c = makeEvent({ type: 'city_disaster', day: 1, level: 3, parentId: p.id });
    worldBus.emit(c);

    const def = eventMeta('city_disaster');
    expect(def?.trigger.afterEvent, '前提：剧本里不该有这条静态依赖').not.toBe('crime_committed');

    expect(world.query.trace_event(c.id).map((e) => e.type)).toEqual(['city_disaster', 'crime_committed']);
  });

  it('信念派发是确定性的（同种子同操作 → 同一结果）', () => {
    /* 这条守的是**确定性**，不是「随机序列一字不动」。
       为什么后者不能作为断言：信念一旦真正参与世界，它产生的记忆与传闻就会进入
       memoryTick / gossipTick，而那两格本身消耗 rng 且**排在天气抽取之前**
       （daySettle 顺序表第 5/6 格 vs 第 9 格）——所以跨天的天气序列必然偏移。
       实测确认：带有信念与纯空跑相比，第 1 天的天气就已经不同。
       这是新玩法接入世界的正常后果，不是缺陷；真正要守的是可复现：
       同样的种子与操作序列必须得到同样的结果，谁在派发里用 Math.random 都会在这里红。 */
    const run = (withBelief: boolean): string[] => {
      core.S = null;
      core.CB = null;
      resetWorld();
      worldBus.reset();
      plugins.clear();
      worldExecutor.clear();
      worldEventLog.clear();
      resetEventSeq();
      rng.seed(42);
      bootstrapWorld({ reasoner: ruleReasoner });

      start();
      const s = core.S!;
      if (withBelief) {
        /* 用 rng.inject 让感知抽样必中——它临时替换随机源，不消耗主序列 */
        const restore = rng.inject(() => 0.99);
        worldBus.emit(
          makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza', witnesses: ['lita'] }),
        );
        restore();
        formBeliefs('lita', s, 1);
      }
      const seq: string[] = [];
      for (let i = 0; i < 20; i++) {
        advance(48);
        seq.push(s.weather);
      }
      return seq;
    };

    const a = run(true);
    const b = run(true);
    expect(a.length).toBe(20);
    expect(b, '同种子同操作应得到同一序列——不一致即意味着派发引入了非确定性').toEqual(a);

    /* 对照：不带信念的空跑也必须自洽（否则说明复位有问题，上一条的绿就是假绿） */
    const c = run(false);
    const d = run(false);
    expect(d, '无信念组的两次运行也必须一致').toEqual(c);
  });

  it('世界史只收 L1 以上：内部账目不会淹没因果链', () => {
    playChain();
    const types = world.query.get_world_log(400).map((e) => e.type);
    for (const noisy of ['damage_applied', 'heal_applied', 'mp_spent', 'cooldown_ticked', 'xp_gained']) {
      expect(types, noisy + ' 是 L0 内部账目，不该进世界史').not.toContain(noisy);
    }
  });
});

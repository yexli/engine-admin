/* ============================================================
   日结算顺序契约（《天穹纪元2.0 · 架构收口修复方案》G-08）
   —— WorldClock 只发布 new_day 事实，结算顺序由 daySettle 的顺序表显式声明。
   这个用例把「隐式契约」钉成机器可查的事实：调换经济回归与羁绊 tick 的次序，
   数值走向会变，而这里会先红。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { worldBus } from '@/events/EventBus';
import { plugins } from '@/plugins/PluginRegistry';
import { worldExecutor } from '@/execution/WorldExecutor';
import { registerCoreSystems } from '@/plugins/systems';
import { registerConsequenceHandlers } from '@/plugins/handlers';
import { daySettleOrder, registerDaySettle } from '@/plugins/daySettle';

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
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

afterEach(() => {
  core.S = null;
  resetWorld();
});

/* Phase 4.2：原第 13 格是「跨日刷新 NPC 自主位置（卡 D1）」。位置改成纯函数直算后
   （npcCurLoc = npcAt），这一步连同它的物化字段一起撤掉，顺序表因此从 14 格变成 13 格。 */
const EXPECTED = [
  'economy',
  'relationship',
  'dungeon',
  'law',
  'memory',
  'memory',
  'dungeon',
  'religion',
  'world',
  'world',
  'reputation',
  'world',
  'character',
  /* 卡 J2 新增第 14 格：信念驱动行动。刻意排在末尾——它会经 WorldExecutor
     触发后果，插在中间会改变后面各步的随机消耗，玩法数值静默漂移。 */
  'memory',
  /* 卡 L1 新增第 15 格：寿数检查（§80）。同样排末尾；它不掷骰，纯读年龄与境界。 */
  'timeslip',
  /* 卡 L3 新增第 16 格：身后事（§96）。必须紧跟寿数检查——它读的就是上一步置下的 flag。
     2026-09 收敛后 owner 为 customs（卡 L3 礼制 + 卡 N4 风俗合并）。 */
  'customs',
  /* 卡 G3 新增第 17 格：服役结算（§101）。不掷骰、不在服役期时一眼返回。 */
  'academy',
];

describe('§27 · 日结算顺序契约', () => {
  it('顺序表与改造前 newDay 的调用次序逐位一致', () => {
    expect(daySettleOrder().map((x) => x.owner)).toEqual(EXPECTED);
  });

  it('每一步的 why 也按序固定：17 步里有 3 步同属 world，只比 owner 换位看不出来', () => {
    /* 索引 8/9/11 是三个 world 步；索引 12 是原第 14 格（状态衰减），撤掉 npc 步后前移一位。 */
    /* owner 相同的步骤互换位置时，只比 owner 的断言会漏（审查 Minor）。 */
    const whys = daySettleOrder().map((x) => x.why);
    expect(whys[8]).toContain('天气');
    expect(whys[9]).toContain('氛围日志');
    expect(whys[11]).toContain('时间线');
    expect(whys[12]).toContain('状态');
  });

  it('经济回归必须排在羁绊日 tick 之前（R3 顺序）', () => {
    const order = daySettleOrder().map((x) => x.owner);
    expect(order.indexOf('economy')).toBeLessThan(order.indexOf('relationship'));
  });

  it('日边界发布 new_day 事实并驱动结算', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    const off = registerDaySettle();
    const seen: string[] = [];
    const offSpy = worldBus.on('new_day', () => seen.push('x'), 'test-spy');
    worldBus.beginTick();
    worldBus.emit({ id: 'evt_manual', type: 'new_day', day: 1, tick: 48, level: 2 });
    expect(seen).toEqual(['x']);
    offSpy();
    off();
  });

  it('未开局时订阅者不炸（组合根先于存档载入装配）', () => {
    const off = registerDaySettle();
    expect(() => worldBus.emit({ id: 'evt_x', type: 'new_day', day: 1, tick: 0, level: 2 })).not.toThrow();
    off();
  });
});

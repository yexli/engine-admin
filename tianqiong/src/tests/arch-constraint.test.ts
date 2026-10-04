/* ============================================================
   时空约束测试（《架构深化方案》二期 H-07）
   —— §16 的「是否违反时间/空间条件」此前一直是未实现：缺的是契约。
   契约现在由 SystemSpec.constraints 承载，验证器从动作的归属系统取。
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
import { world } from '@/world/WorldAPI';
import { mutate } from '@/world/WorldMutate';
import { constraintViolation } from '@/validation/PermissionValidator';
import { WB } from '@/data/worldBook';

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

describe('§16 · 时空约束（二期 H-07）', () => {
  const settle = () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
  };
  const mediate = () =>
    world.execute({
      action: 'change_faction_relation',
      target: 'empire',
      source: 'empire',
      reason: '联姻使节往来',
      params: { a: 'empire', b: 'temple_life', axis: 'religion', dv: 5 },
    });

  it('地点满足约束时放行（开局在 plaza，属允许集合）', () => {
    settle();
    expect(mediate().executed).toBe(1);
  });

  it('地点不符时整份计划被拒（零执行，理由是时空条件）', () => {
    settle();
    mutate.playerLoc('wild');
    const r = mediate();
    expect(r.executed).toBe(0);
    expect(r.outcomes[0].note).toContain('在此地不可做');
  });

  it('境界约束走同一条通道（真实玩法暂未用到，用临时插件验证）', () => {
    start();
    registerCoreSystems();
    plugins.register({
      id: 'probe-lv',
      version: '1.0.0',
      capabilities: ['probe_lv'],
      executable: ['probe_lv'],
      constraints: { probe_lv: { minLevel: 3 } },
    });
    expect(constraintViolation('probe_lv')).toContain('更高境界');
    /* 升到门槛之上后同一条约束放行——证明它读的是当前境界而不是静态表 */
    mutate.playerNum('level', () => 3);
    expect(constraintViolation('probe_lv')).toBeNull();
  });

  it('未声明约束的动作不受限（契约可选是刻意的）', () => {
    settle();
    const iid = Object.keys(WB.items)[0];
    expect(world.execute({ action: 'add_item', target: iid, source: iid, reason: '奖励', params: { qty: 1 } }).executed).toBe(1);
  });

  it('时段约束走同一条通道（真实玩法暂无时段约束，用临时插件验证契约）', () => {
    start();
    registerCoreSystems();
    plugins.register({
      id: 'probe',
      version: '1.0.0',
      capabilities: ['probe_action'],
      executable: ['probe_action'],
      constraints: { probe_action: { periods: ['不存在的时段'] } },
    });
    expect(constraintViolation('probe_action')).toContain('在此刻不可做');
    expect(constraintViolation('add_item'), '未声明的动作不受限').toBeNull();
    expect(constraintViolation('no_such_action'), '无主的动作不受限').toBeNull();
  });
});

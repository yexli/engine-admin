/* ============================================================
   门面收口测试（《天穹纪元2.0 · 架构收口修复方案》G-01 / G-02）
   —— 复核指出：批次一只有 grep 计数作证据，覆盖不了「UI 命令路径全部经门面」
   与「world.plan 转发正确」这两条验收标准。这里把它们钉成断言。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { useGame } from '@/store/useGame';
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
  vi.restoreAllMocks();
  core.S = null;
  resetWorld();
});

describe('§4.2 · 世界门面收口', () => {
  it('G-01：UI 的 cmd 落点经 world.command（没有第二条写入路径）', () => {
    start();
    const spy = vi.spyOn(world, 'command');
    useGame.getState().cmd({ type: 'travel', loc: 'tavern' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ type: 'travel', loc: 'tavern' });
    expect(core.S!.player.loc).toBe('tavern');
    spy.mockRestore();
  });

  it('G-01：多条命令逐条过门面', () => {
    start();
    const spy = vi.spyOn(world, 'command');
    useGame.getState().cmd({ type: 'sceneAction', k: 'observe' });
    useGame.getState().cmd({ type: 'travel', loc: 'market' });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('G-02：world.plan 转发到执行器，planId 与执行计数原样回传', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    const iid = Object.keys(WB.items)[0];
    const res = world.plan({
      planId: 'plan_probe',
      triggerEvent: 'evt_probe',
      consequences: [{ action: 'add_item', target: iid, reason: '门面转发测试', params: { qty: 2 } }],
    });
    expect(res.planId).toBe('plan_probe');
    expect(res.executed).toBe(1);
    expect(res.outcomes[0].ok).toBe(true);
  });

  it('G-02：world.plan 与 world.execute 共用同一道防火墙（非法计划零执行）', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    const bad = world.plan({
      planId: 'plan_bad',
      triggerEvent: 'evt_bad',
      consequences: [{ action: 'summon_dragon', reason: '不存在的动作' }],
    });
    expect(bad.executed).toBe(0);
    expect(bad.planId).toBe('(rejected)');
  });
});

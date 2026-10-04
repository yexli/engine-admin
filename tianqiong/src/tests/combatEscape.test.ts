/* ============================================================
   战斗的「出口」与战斗内用药（审查 §覆盖缺口）
   逃跑与战斗内用药此前在全部测试里 **0 引用**，而它们都是 UI 上可点的按钮：
   逃跑成功要清 core.CB、广播 combat 关闭、落盘；失败要走敌方回合、给明确反馈；
   用药要按持有量结算（core 权威，不信任 UI 的可用态）。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler } from '@/world';
import { newGame } from '@/world/WorldRuntime';
import { combatUseItem, flee, startCombat, useItem } from '@/systems/combat/Combat';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { MemorySaveRepository } from '@/repo';
import { addItem, itemCount } from '@/systems/character/Gains';
import { WB } from '@/data/worldBook';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(53);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '退场', race: 'human', cls: 'warrior' });
});

describe('脱离战斗', () => {
  it('成功：清空 core.CB 并广播关闭战斗（漏掉任何一条都是卡死）', () => {
    startCombat(['wolf']);
    expect(core.CB).not.toBeNull();
    const opened: boolean[] = [];
    const off = bus.on((e) => {
      if (e.type === 'combat') opened.push(e.open);
    });
    rng.inject(() => 0.999); // d20 = 20，必过 DC 13
    flee();
    off();
    expect(opened, '界面靠 combat 事件收起浮层').toContain(false);
    expect(core.CB, '失败时漏清 CB = 战斗卡死，什么也点不动').toBeNull();
  });

  it('失败：战斗继续，并给出明确反馈', () => {
    startCombat(['wolf']);
    rng.inject(() => 0); // d20 = 1，必败
    flee();
    expect(core.CB, '失败不该结束战斗').not.toBeNull();
    expect(
      core.CB!.log.some((e) => e.text.includes('却被拦住了去路')),
      '失败要有可见反馈，否则玩家不知道这一下白点了',
    ).toBe(true);
  });
});

describe('战斗内用药', () => {
  it('有药：回血并消耗一剂', () => {
    const s = core.S!;
    startCombat(['wolf']);
    expect(WB.items.potion_moon.heal, '前置：这个道具确实是恢复品').toBeGreaterThan(0);
    s.player.hp = 1;
    addItem('potion_moon');
    const have0 = itemCount('potion_moon', s);
    combatUseItem('potion_moon');
    expect(itemCount('potion_moon', s)).toBe(have0 - 1);
    expect(s.player.hp).toBeGreaterThan(1);
  });

  it('没药：不许凭空回血（持有量必须由 core 判）', () => {
    const s = core.S!;
    startCombat(['wolf']);
    expect(itemCount('potion_moon', s)).toBe(0);
    s.player.hp = 1;
    combatUseItem('potion_moon');
    expect(s.player.hp, 'UI 的可用态只是体验层，core 必须自己拦').toBe(1);
  });
});

describe('战斗外用药', () => {
  it('没药：同样不许凭空回血', () => {
    const s = core.S!;
    s.player.hp = 1;
    useItem('potion_moon');
    expect(s.player.hp).toBe(1);
  });

  it('未知 id：不抛错（防伪造命令把引擎打崩）', () => {
    expect(() => useItem('__不存在的物品__')).not.toThrow();
  });
});

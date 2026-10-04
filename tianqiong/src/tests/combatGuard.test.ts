/* ============================================================
   战斗动作权威校验（F-18）：MP 不足 / 冷却中的技能必须被 core 拒绝——
   UI 的 disabled 只是体验层，判定不可落在表现层。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler } from '@/world';
import { newGame } from '@/world/WorldRuntime';
import { playerAct, startCombat } from '@/systems/combat/Combat';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { MemorySaveRepository } from '@/repo';
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
  newGame({ name: '战斗', race: 'human', cls: 'mage' });
});

describe('战斗动作权威校验（F-18）', () => {
  it('MP 不足：技能被拒，不扣 MP、不写冷却、不推进回合', () => {
    const s = core.S!;
    startCombat(['wolf']);
    const CB = core.CB!;
    const key = s.player.skills[0];
    const sk = WB.skills[key];
    expect(sk.mp).toBeGreaterThan(0); // 前置：该职业技能确实耗蓝
    s.player.mp = sk.mp - 1;
    const hp0 = CB.foes[0].hp;
    const round0 = CB.round;
    playerAct('skill', key);
    expect(s.player.mp).toBe(sk.mp - 1);
    expect(CB.cds[key]).toBeUndefined();
    expect(CB.foes[0].hp).toBe(hp0);
    expect(CB.round).toBe(round0);
  });

  it('冷却中：技能被拒，MP 不动', () => {
    const s = core.S!;
    startCombat(['wolf']);
    const CB = core.CB!;
    const key = s.player.skills[0];
    s.player.mp = 99;
    CB.cds[key] = 2;
    playerAct('skill', key);
    expect(s.player.mp).toBe(99);
    expect(CB.cds[key]).toBe(2);
  });

  it('条件满足时技能正常结算（没被改死）', () => {
    const s = core.S!;
    startCombat(['wolf']);
    const CB = core.CB!;
    const key = s.player.skills[0];
    const sk = WB.skills[key];
    s.player.mp = 99;
    playerAct('skill', key);
    expect(s.player.mp).toBe(99 - sk.mp);
    expect(CB.cds[key]).toBeGreaterThan(0);
  });
});

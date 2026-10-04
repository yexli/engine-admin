/* 卡 A 回归：五系十九分支树数据不变量 + 境界称号链 + 技能逐阶解锁（确定性） */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { gainExp } from '@/systems/character/Gains';
import { rankName } from '@/systems/character/Derived';
import { WB } from '@/data/worldBook';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  const restore = rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return restore;
});

describe('卡A · 职业树数据不变量', () => {
  it('每个职业 path/skillPath 长度为 6，skillPath[0] 等于初始 skill，且技能 key 均存在', () => {
    for (const [id, c] of Object.entries(WB.classes)) {
      expect(c.path, id).toHaveLength(6);
      expect(c.skillPath, id).toHaveLength(6);
      expect(c.skillPath![0], id).toBe(c.skill);
      for (const s of c.skillPath!) expect(WB.skills[s], id + ':' + s).toBeDefined();
      expect(c.lineage, id).toBeTruthy();
    }
  });
  it('新手村开放 4 原型 + 卡 I2 三个生产系，其余骨架 locked 隐藏', () => {
    /* 卡 I2：pr_forge / pr_alchemy / pr_inscribe 随技艺工坊落地解锁（原为"暂未开放"占位） */
    const open = Object.keys(WB.classes).filter((k) => !WB.classes[k].locked);
    expect(open.sort()).toEqual(['mage', 'pr_alchemy', 'pr_forge', 'pr_inscribe', 'priest', 'ranger', 'warrior']);
    // 五系覆盖：物理/法师/召唤/辅助/生产 都有条目
    const lineages = new Set(Object.values(WB.classes).map((c) => c.lineage));
    for (const l of ['物理', '法师', '召唤', '辅助', '生产']) expect(lineages.has(l)).toBe(true);
  });
});

describe('卡A · 境界称号链与技能解锁', () => {
  it('rankName 走职业 path（战士 level1=战士）', () => {
    newGame({ name: 'T', race: 'human', cls: 'warrior' });
    expect(rankName(core.S!)).toBe('战士');
  });
  it('升到 2 级按 skillPath 习得 guard_break（不再依赖硬编码表）', () => {
    newGame({ name: 'T', race: 'human', cls: 'warrior' });
    const s = core.S!;
    expect(s.player.skills).toEqual(['heavy_slash']);
    gainExp(60); // xpNeed[1]=60 → level2
    expect(s.player.level).toBe(2);
    expect(s.player.skills).toContain('guard_break');
    expect(rankName(s)).toBe('剑士'); // path[1]
  });
});

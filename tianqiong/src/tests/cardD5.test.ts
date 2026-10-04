/* ============================================================
   卡 D5 · 法律细化：罪名分级 + 司法审判 + 城法差异
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler, newGame, importState } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { arrest, commitCrime, crimeGrade, isJailed, isLawless, topCharge, trial } from '@/systems/law/Law';

beforeEach(() => {
  core.S = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  const r = rng.seed(9);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return r;
});
const start = () => newGame({ name: 'D5', race: 'human', cls: 'warrior' });

describe('卡 D5 · 立案与罪名分级', () => {
  it('commitCrime 记案底 + 累加通缉（wantedAdd 随等级）', () => {
    start();
    expect(commitCrime('petty_theft', 'market')).toBe(true); // D 级 +1
    expect(core.S!.player.wanted).toBe(1);
    expect(core.S!.legal!.charges).toContain('petty_theft');
    commitCrime('assault', 'plaza'); // C 级 +2
    expect(core.S!.legal!.charges).toContain('assault');
    expect(topCharge()!.def.grade).toBe('C'); // 取最高
  });
  it('法外之地不立案、不累加通缉', () => {
    start();
    expect(isLawless('alley')).toBe(true);
    expect(commitCrime('murder', 'alley')).toBe(false);
    expect(core.S!.legal!.charges.length).toBe(0);
    expect(core.S!.player.wanted).toBe(0);
  });
});

describe('卡 D5 · 审判处罚路径', () => {
  it('B 级重罪 → 监禁（设刑期、in jail）', () => {
    start();
    commitCrime('smuggling', 'market'); // B
    const r = trial();
    expect(r).toBe('jail');
    expect(core.S!.legal!.jailedUntil).toBeGreaterThan(core.S!.t);
    expect(isJailed()).toBe(true);
  });
  it('A 级极恶罪 → 流放（离开城市、exiledTo）', () => {
    start();
    /* 卡 T3：A 级改用「屠杀平民」。原用例用 murder，而世界书 §88 把谋杀归 B 级
       （B 级=谋杀/重大盗窃/走私禁品），A 级是屠杀平民/神殿亵渎/叛国——
       罪级对齐后 murder 不再产生流放，这正是本次修正要锁住的行为。 */
    commitCrime('massacre', 'plaza'); // A
    expect(trial()).toBe('exile');
    expect(core.S!.player.loc).toBe('wild');
    expect(core.S!.legal!.exiledTo).toBe('wild');
  });
  it('谋杀按世界书 §88 归 B 级 → 监禁而非流放（卡 T3 行为变更）', () => {
    start();
    expect(crimeGrade('murder')).toBe('B');
    commitCrime('murder', 'plaza');
    expect(trial()).toBe('jail');
  });
  it('S 级灭世罪 → 处决标记', () => {
    start();
    commitCrime('deicide', 'plaza');
    expect(trial()).toBe('death');
    expect(core.S!.legal!.executed).toBe(true);
  });
  it('D/C 轻中罪 → 罚金路径（wanted 归零）', () => {
    start();
    commitCrime('petty_theft', 'market');
    expect(trial()).toBe('fine');
    expect(core.S!.player.wanted).toBe(0);
  });
});

describe('卡 D5 · 逮捕转审判 + 兼容旧路径', () => {
  it('arrest 有案底走 trial 并清结案底', () => {
    start();
    commitCrime('smuggling', 'market'); // B 有案底
    const r = arrest();
    expect(r).toBe('jail');
    expect(core.S!.legal!.charges.length).toBe(0); // 审结清空
  });
  it('旧档无 legal → hydrate 补空案底', () => {
    start();
    const legacy = JSON.parse(JSON.stringify(core.S));
    delete legacy.legal;
    legacy.ver = 1;
    expect(importState(JSON.stringify(legacy))).toBe(true);
    expect(core.S!.legal).toEqual({ charges: [] });
  });
});

/* ============================================================
   卡 R1 · 种族双轴（世界书 §26 绑定类型与效率% / §27 聚居地 / §28 力量双轴）
   —— 把「种族只影响六维」升级为「种族影响职业选择与成长速度」，
   这些用例钉住三条规则：专属线门禁、效率倍率、双轴对 HP/MP 的派生。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { WB } from '@/data/worldBook';
import { axisAffinity, axisOfClass, exclusiveOwner, lineageOf, raceAllowsClass, raceEff } from '@/systems/character/Race';

describe('卡 R1 · 种族绑定与专属线（§26）', () => {
  it('每个可玩种族都声明了绑定类型与亲和说明', () => {
    for (const [k, r] of Object.entries(WB.races)) {
      expect(['soft', 'strong'], k).toContain(r.bind);
      expect(r.affinityNote, k).toBeTruthy();
    }
  });

  it('强绑定的专属线只对该种族开放，且自己全部可走', () => {
    /* 判据：exclusive[] 是该种族**独占**的职业名单——它在名单内即可走，
       不在名单内的种族一律不可走。世界书 §26 的「矮人：生产系专属／其他种族无法学习
       矮人专属职业」「精灵：巫女路线专属」「巨人：物理系重装路线专属」都按这条落。 */
    for (const cls of ['pr_forge', 'pr_alchemy', 'pr_inscribe']) {
      expect(raceAllowsClass('dwarf', cls), '矮人·' + cls).toBe(true);
      expect(raceAllowsClass('human', cls), '人类·' + cls).toBe(false);
      expect(raceAllowsClass('elf', cls), '精灵·' + cls).toBe(false);
    }
    expect(raceAllowsClass('elf', 'au_divine')).toBe(true);
    expect(raceAllowsClass('human', 'au_divine')).toBe(false);
    expect(raceAllowsClass('giant', 'ph_special')).toBe(true);
    expect(raceAllowsClass('orc', 'ph_special')).toBe(false);
    /* 两层门禁各司其职：本函数管「种族专属」，职业自身的 locked 由创角页先一步过滤。
       重装（ph_tank）同时是「巨人专属」与「locked」，所以对人类是双重不可走；
       这里断言的是**种族那一层**为 false。 */
    expect(raceAllowsClass('human', 'ph_tank')).toBe(false);
    expect(exclusiveOwner('ph_tank')).toBe('giant');
    expect(exclusiveOwner('warrior')).toBeNull();
  });

  it('软绑定种族不设专属门禁：人类可走全部**未列入他人专属**的线', () => {
    for (const cls of ['warrior', 'mage', 'ranger', 'priest']) {
      expect(raceAllowsClass('human', cls), cls).toBe(true);
    }
    /* 反面：写进任何种族 exclusive[] 的线，对非本族一律关闭 */
    for (const cls of ['pr_forge', 'au_divine', 'ph_special']) {
      expect(raceAllowsClass('human', cls), cls).toBe(false);
    }
  });
});

describe('卡 R1 · 效率倍率（§26）', () => {
  it('精灵学法系 ×1.2、兽人学法师 ×0.7、地精学生产 ×1.3、元素裔 ×1.25', () => {
    expect(raceEff('elf', '法师')).toBe(1.2);
    expect(raceEff('orc', '法师')).toBe(0.7);
    expect(raceEff('orc', '物理')).toBe(1.15);
    expect(raceEff('gnome', '生产')).toBe(1.3);
    expect(raceEff('elemental', '法师')).toBe(1.25);
    expect(raceEff('halforc', '物理')).toBe(1.1);
  });

  it('未声明的组合回落 1（缺数据不惩罚玩家）', () => {
    expect(raceEff('human', '物理')).toBe(1);
    expect(raceEff('elf', '生产')).toBe(1);
    expect(raceEff('不存在的种族', '物理')).toBe(1);
  });

  it('血缘函数与 ClassDef.lineage 对齐（改名不会让效率静默失效）', () => {
    for (const [k, c] of Object.entries(WB.classes)) expect(lineageOf(k), k).toBe(c.lineage);
  });
});

describe('卡 R1 · 力量双轴（§28）', () => {
  it('法师/召唤/辅助走灵魂，物理/生产走肉体', () => {
    expect(axisOfClass('mage')).toBe('灵魂');
    expect(axisOfClass('priest')).toBe('灵魂');
    expect(axisOfClass('warrior')).toBe('肉体');
    expect(axisOfClass('pr_forge')).toBe('肉体');
  });

  it('轴向亲和取自同为所长的效率表：兽人肉体 ≥1、精灵灵魂 ≥1', () => {
    expect(axisAffinity('orc', '肉体')).toBeGreaterThanOrEqual(1.15);
    expect(axisAffinity('elf', '灵魂')).toBeGreaterThanOrEqual(1.2);
    expect(axisAffinity('human', '肉体')).toBe(1);
  });
});

describe('卡 R1 · 聚居地（§27）', () => {
  it('龙族栖居极东龙脊山脉、元素裔在熔岩山脉、巨人居极北冰原', () => {
    expect(WB.races.dragon.homeland).toContain('龙脊山脉');
    expect(WB.races.elemental.homeland).toContain('熔岩山脉');
    expect(WB.races.giant.homeland).toContain('极北冰原');
  });
  it('十三族全部登记 homeland', () => {
    for (const [k, r] of Object.entries(WB.races)) expect(r.homeland, k).toBeTruthy();
  });
});

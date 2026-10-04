/* ============================================================
   卡 E1b · 分支专属机制（世界书 §32–§35）
   shadow（暗杀·阴影值）/ conservation（时空·时间守恒）/
   curseStack（诅咒·配比）/ soulLoad（亡灵·灵魂负荷）/ summonRatio（英灵·来源）
   判定边界：五套机制**只对走在同名职业线上**的角色生效（branchActive），
   初阶职业（战士/法师/游侠/神官）一律不生效——这是"路线"二字的落点。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import tablesRaw from '@/data/world/tables.json';
import { core, newState } from '@/world/WorldState';
import { bus, rng, scheduler } from '@/events/EventBus';
import { branchActive, soulLoad } from '@/systems/character/Derived';
import { currentSummonSource, playerAct, startCombat } from '@/systems/combat/Combat';
import { mutate } from '@/world/WorldMutate';
import { newGame } from '@/world/WorldRuntime';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { MemorySaveRepository } from '@/repo';
import { newGame as _newGame } from '@/world/WorldRuntime';

void _newGame;

/* 与 Combat/Derived 同源：直读数据文件，不经 WB 聚合 */
const MECH = (tablesRaw as unknown as { classMechanics?: Record<string, unknown> }).classMechanics ?? {};

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  rng.seed(47);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  core.S = newState({ name: 'E1b', race: 'human', cls: 'mage' });
});

/** 改职业：分支判定读的就是这个字段 */
const setCls = (id: string) => {
  (core.S!.player as unknown as { cls: string }).cls = id;
};

/** 起一场可观察的战斗：目标加厚血不致死、玩家血厚不被打死、怪出手打不中 */
const setupBattle = (cls: string, seed = 83) => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(seed);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: 'E1b', race: 'human', cls: 'warrior' });
  const s = core.S!;
  setCls(cls);
  s.player.skills = ['curse_weak', 'time_fold', 'soul_bind'];
  mutate.playerMp(999);
  mutate.playerHp(999);
  startCombat(['goblin'], {});
  const CB = core.CB!;
  CB.foes[0].hp = 9999;
  CB.foes[0].mhp = 9999;
  CB.foes[0].ac = -50; // 打不中玩家，也不会被玩家秒
  return { s, CB };
};

describe('卡 E1b · 五套机制的数据契约', () => {
  it('五套机制齐备，且各自挂到一条分支上', () => {
    for (const k of ['shadow', 'conservation', 'summonRatio', 'curseStack', 'soulLoad']) {
      expect(MECH[k], k).toBeTruthy();
    }
  });

  it('每套机制都登记了归属分支（branch 字段是判定的入口）', () => {
    for (const k of ['shadow', 'conservation', 'summonRatio', 'curseStack', 'soulLoad']) {
      const m = MECH[k] as { branch?: string };
      expect(m.branch, k).toBeTruthy();
      expect(typeof m.branch).toBe('string');
    }
  });

  it('世界书点名的比例都在数据里（60/30/10 与 40/30/20/10）', () => {
    const sr = MECH.summonRatio as { ancient: number; hero: number; self: number };
    expect(sr.ancient).toBe(0.6);
    expect(sr.hero).toBe(0.3);
    expect(sr.self).toBe(0.1);
    const cs = MECH.curseStack as { weights: Record<string, number> };
    expect(Object.values(cs.weights).sort((a, b) => b - a)).toEqual([0.4, 0.3, 0.2, 0.1]);
  });
});

describe('卡 E1b · 分支判定（§32–§35 的"路线"边界）', () => {
  it('初阶职业对五条分支一律不生效（转职前不该拿到分支机制）', () => {
    setCls('warrior');
    for (const b of ['ph_assassin', 'fs_time', 'sm_hero', 'au_curse', 'sm_undead']) {
      expect(branchActive(b), b).toBe(false);
    }
  });

  it('处于分支本身、或已升入该线的上位职业，都算生效', () => {
    setCls('ph_assassin');
    expect(branchActive('ph_assassin')).toBe(true);
    setCls('fs_time');
    expect(branchActive('fs_time')).toBe(true);
    /* 未知职业 id 不臆造血缘 */
    setCls('not_a_class');
    expect(branchActive('ph_assassin')).toBe(false);
  });
});

describe('卡 E1b · 灵魂负荷（§34 亡灵）：召唤越多自身越脆', () => {
  it('未学亡灵系技能时负荷为 1（不惩罚）', () => {
    setCls('sm_undead');
    expect(soulLoad(core.S!)).toBe(1);
  });

  it('同技能数：只有亡灵线吃负荷，非亡灵线恒为 1', () => {
    const s = core.S!;
    s.player.skills = ['soul_bind', 'undead_legion', 'curse_weak'];
    setCls('warrior');
    expect(soulLoad(s)).toBe(1);
    setCls('sm_undead');
    expect(soulLoad(s)).toBeLessThan(1);
  });

  it('每掌握一门亡灵系技能，负荷按比例下降且封顶', () => {
    const s = core.S!;
    setCls('sm_undead');
    s.player.skills = ['soul_bind'];
    const one = soulLoad(s);
    expect(one).toBeLessThan(1);
    s.player.skills = ['soul_bind', 'undead_legion', 'curse_weak'];
    const three = soulLoad(s);
    expect(three).toBeLessThan(one);
    const mech = MECH.soulLoad as { maxLoad: number };
    expect(three).toBeGreaterThanOrEqual(1 - mech.maxLoad - 1e-9);
  });
});

describe('卡 E1b · 阴影值在实战里真的累积（§32 不是只读的键）', () => {
  it('暗杀线：回合末累积、出手清零，且按上限封顶', () => {
    const { CB } = setupBattle('ph_assassin');
    const m = MECH.shadow as { max: number };
    expect(CB.shadow).toBe(0);
    playerAct('atk');
    expect(CB.shadow).toBeGreaterThan(0);
    playerAct('atk');
    expect(CB.shadow).toBeLessThanOrEqual(m.max);
  });

  it('非暗杀线：走完同样两轮，阴影值恒为 0（数值分毫不动）', () => {
    const { CB } = setupBattle('warrior');
    playerAct('atk');
    playerAct('atk');
    expect(CB.shadow).toBe(0);
  });
});

describe('卡 E1b · 时间守恒在实战里真的扣自己（§33）', () => {
  /* 时间守恒的自身代价与"迟缓落地"是同一次施法里的两件事：
     世界书 §33 说的是"你拉长了对手的一息，自己的表也走快一格"。 */
  const castTimeFold = (cls: string) => {
    const { s, CB } = setupBattle(cls);
    const t0 = s.t;
    playerAct('skill', 'time_fold');
    const slowed = !!CB.foes[0].status?.some((x) => x.id === 'slow');
    return { drift: s.t - t0, slowed };
  };

  it('时空线：迟缓落地的同一次施法里，自己多走了 1 刻', () => {
    const r = castTimeFold('fs_time');
    expect(r.slowed, '迟缓未落地，测试前提不成立').toBe(true);
    expect(r.drift).toBe(1);
  });

  it('非时空线：同样的技能不产生自身时间代价（分支机制不外溢）', () => {
    const r = castTimeFold('warrior');
    expect(r.slowed, '迟缓未落地，测试前提不成立').toBe(true);
    expect(r.drift).toBe(0);
  });
});

describe('卡 E1b · 诅咒配比在实战里改强度（§35）', () => {
  const CURSE_ST = (tablesRaw as unknown as { skills: Record<string, { status?: { id: string; dur: number; power: number } }> })
    .skills.curse_weak.status!;

  /** 掷到诅咒落地为止（cd 期间本就打不出，与分支无关，故循环里清 cd） */
  const castCurse = (cls: string) => {
    const { CB } = setupBattle(cls);
    CB.foes[0].status = [];
    playerAct('skill', 'curse_weak');
    let got = CB.foes[0].status?.find((x) => x.id === CURSE_ST.id) || null;
    for (let i = 0; i < 12 && !got; i++) {
      CB.foes[0].status = [];
      CB.cds.curse_weak = 0;
      playerAct('skill', 'curse_weak');
      got = CB.foes[0].status?.find((x) => x.id === CURSE_ST.id) || null;
    }
    return got;
  };

  it('权重分布在两档之间（≥0.3 延时长 / ≤0.1 换强度）', () => {
    const cs = MECH.curseStack as { weights: Record<string, number> };
    const vals = Object.values(cs.weights);
    expect(vals.some((v) => v >= 0.3)).toBe(true);
    expect(vals.some((v) => v <= 0.1)).toBe(true);
    expect(cs.weights.vuln).toBe(0.1);
  });

  it('诅咒线：权重最低的 vuln 以强度换稀有（power +1）', () => {
    const got = castCurse('au_curse');
    expect(got, '诅咒从未命中，测试前提不成立').toBeTruthy();
    expect(got!.power).toBe(CURSE_ST.power + 1);
  });

  it('非诅咒线：同一次命中只吃原始强度（分支机制不外溢）', () => {
    const got = castCurse('warrior');
    expect(got, '诅咒从未命中，测试前提不成立').toBeTruthy();
    expect(got!.power).toBe(CURSE_ST.power);
  });
});

describe('卡 E1b · 英灵来源与时间守恒的数据接线', () => {
  it('英灵线：开战时定下来源（60/30/10 三档之一）', () => {
    setupBattle('sm_hero');
    expect(['古代英灵', '传说英灵', '自身投影']).toContain(currentSummonSource());
  });

  it('非英灵线：来源不臆造（保持 null）', () => {
    setupBattle('warrior');
    expect(currentSummonSource()).toBeNull();
  });

  it('时间守恒登记了自身代价（§33 时间不会凭空产生）', () => {
    const c = MECH.conservation as { selfCostPerSlow: number };
    expect(c.selfCostPerSlow).toBeGreaterThan(0);
  });
});

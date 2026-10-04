/* ============================================================
   卡 L2 · §101「入学要求」的完整落地
   世界书写的是四条：年龄（12-25 岁）· 资质测试（魔力/体能/智慧三选一）·
   出身（不限，贵族优先是潜规则）· 学费与寒门通道（奖学金/公会代偿/神殿资助/军工定向）。
   此前 enrollCheck 只做金币/境界/种族三项——本卡补齐其余三条，
   年龄直接取卡 L1 的 birthTick 派生，与寿数同源。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import academyRaw from '@/data/world/academy.json';
import { core } from '@/world/WorldState';
import { newGame } from '@/world/WorldRuntime';
import { TICKS_PER_YEAR } from '@/world/WorldClock';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { bus, rng, scheduler } from '@/events/EventBus';
import {
  academyView,
  aidFor,
  enroll,
  enrollCheck,
  ensureAcademy,
  graduate,
  payableDue,
  tuitionDue,
} from '@/systems/academy/Academy';

const s = () => core.S!;
const setAge = (y: number) => {
  s().player.birthTick = s().t - y * TICKS_PER_YEAR;
};
const setStats = (v: number) => {
  for (const k of ['力量', '体质', '敏捷', '智力', '感知', '魅力'] as const) s().player.stats[k] = v;
};
const courses = (id: string): string[] =>
  (academyRaw.academies.find((x) => x.id === id)!.curriculum as { courseId: string }[]).map((c) => c.courseId);

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(41);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: 'L2', race: 'human', cls: 'warrior' });
});

describe('卡 L2 · §101 入学要求 · 年龄（12-25 岁）', () => {
  it('创角 16 岁，落在区间内', () => {
    expect(enrollCheck('imperial', s()).reason, '16 岁不该被年龄拦下').not.toMatch(/年龄/);
  });

  it('太小被拒（11 岁）', () => {
    setAge(11);
    const g = enrollCheck('imperial', s());
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/年龄/);
    expect(g.reason).toContain('12');
  });

  it('太老被拒（26 岁）——学院不是终身收容所', () => {
    setAge(26);
    const g = enrollCheck('imperial', s());
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/年龄/);
    expect(g.reason).toContain('25');
  });

  it('边界包含：12 岁与 25 岁都在内，11 岁与 26 岁都在外', () => {
    for (const [y, ok] of [[12, true], [25, true], [11, false], [26, false]] as [number, boolean][]) {
      setAge(y);
      expect(enrollCheck('imperial', s()).reason.includes('年龄'), y + ' 岁').toBe(!ok);
    }
  });

  it('年龄取自卡 L1：与寿数同一个派生量，不会各算各的', () => {
    setAge(30);
    expect(enrollCheck('imperial', s()).reason).toMatch(/年龄不符（30 岁/);
  });
});

describe('卡 L2 · §101 入学要求 · 资质测试（三选一）', () => {
  it('三轴里有一门达门槛即可入（一门通即可，正合「三选一」）', () => {
    setStats(1);
    s().player.stats['感知'] = 10;
    expect(enrollCheck('imperial', s()).reason).not.toMatch(/资质/);
  });

  it('三轴全不达门槛 → 拒，并说清最高的那一项差多少', () => {
    setStats(1);
    const g = enrollCheck('imperial', s());
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/资质未过/);
    expect(g.reason).toContain('10');
  });

  it('学院按 s100 专长收窄候选轴：霜锚武馆只认力量与体质', () => {
    setStats(1);
    s().player.level = 2; // 武馆门槛「见习」；境界要够才测得到资质那一条
    s().player.stats['智力'] = 20; // 智力再高，也不在武馆的候选轴里
    expect(enrollCheck('frosthold', s()).reason).toMatch(/资质未过/);
    s().player.stats['体质'] = 20;
    expect(enrollCheck('frosthold', s()).reason, '体质到位后就该卡在矮人专属那一条').toMatch(/种族/);
  });

  it('金砂商院看智力与魅力（商业），深井学院看智力与感知（符文）', () => {
    setStats(1);
    s().player.stats['魅力'] = 12;
    expect(enrollCheck('goldveil', s()).reason).not.toMatch(/资质/);
    setStats(1);
    s().player.stats['魅力'] = 12;
    expect(enrollCheck('deepwell', s()).reason, '魅力不在深井的候选轴里').toMatch(/资质未过/);
  });

  it('浮岛观星台（八年制最高学府）门槛抬到 12', () => {
    setStats(10);
    s().player.level = 4;
    expect(enrollCheck('skycap', s()).reason, '十点资质进不了观星台').toMatch(/资质未过/);
    s().player.stats['智力'] = 12;
    expect(enrollCheck('skycap', s()).ok, '十二点智力 + 主教境界 + 学费够 → 该放行').toBe(true);
  });
});

describe('卡 L2 · §101 寒门通道（学费与出身）', () => {
  it('声望不够时没有资助，全额自付', () => {
    expect(aidFor('imperial', s())).toBeNull();
    expect(payableDue('imperial', s()).pay).toBe(tuitionDue('imperial', s()));
    expect(payableDue('imperial', s()).owe).toBe(0);
  });

  it('公会声望 ≥20 → 公会在学籍册上作保，实缴 0、待偿全额', () => {
    s().rep['guild'] = 20;
    const pd = payableDue('imperial', s());
    expect(pd.aid?.id).toBe('guild_advance');
    expect(pd.pay).toBe(0);
    expect(pd.owe).toBe(1000);
  });

  it('奖学金与寒门通道叠加：30% 奖学金之后，公会垫的是剩下的那部分', () => {
    s().rep['guild'] = 20;
    s().player.stats['智力'] = 14; // 帝国圣学院 30% 奖学金
    const pd = payableDue('imperial', s());
    expect(pd.base, '奖学金后的应缴').toBe(700);
    expect(pd.pay).toBe(0);
    expect(pd.owe).toBe(700);
  });

  it('神殿资助与军工定向各按自己的声望开门，先满足先得', () => {
    s().rep['temple_life'] = 20;
    expect(aidFor('windport', s())?.id).toBe('temple_sponsor');
    s().rep['temple_life'] = 0;
    s().rep['empire'] = 30;
    expect(aidFor('windport', s())?.id).toBe('military_bond');
  });

  it('免费学院不走资助——冒险者训练营本来就免费（s100：免费但需通过测试）', () => {
    s().rep['guild'] = 99;
    expect(aidFor('camp', s())).toBeNull();
    expect(payableDue('camp', s()).owe).toBe(0);
  });

  it('入学真的记债，且日志说明是谁垫的', () => {
    s().rep['guild'] = 20;
    s().player.level = 3;
    const a = ensureAcademy(s());
    expect(enroll('imperial')).toBe(true);
    expect(a.debt).toBe(1000);
    expect(a.debtFrom).toBe('guild_advance');
    expect(a.enrolled).toBe('imperial');
  });

  it('毕业时账清掉：钱够则扣款归零', () => {
    const a = ensureAcademy(s());
    a.enrolled = 'imperial';
    a.completed = courses('imperial');
    a.startedAt = s().t - 5 * 3 * 1440 - 1;
    a.debt = 700;
    a.debtFrom = 'guild_advance';
    s().player.gold = 1000;
    expect(graduate()).toBe(true);
    expect(a.debt).toBe(0);
    expect(s().player.gold).toBe(300);
  });

  it('毕业时钱不够 → 账继续挂着，毕业不等于清账', () => {
    const a = ensureAcademy(s());
    a.enrolled = 'imperial';
    a.completed = courses('imperial');
    a.startedAt = s().t - 5 * 3 * 1440 - 1;
    a.debt = 700;
    s().player.gold = 10;
    expect(graduate()).toBe(true);
    expect(a.debt, '账不能被毕业抹掉').toBe(700);
  });
});

describe('卡 L2 · 五档判定的顺序与口径', () => {
  it('年龄排在资质与境界之前：三样都不符时先说实话的那一条', () => {
    setAge(30);
    setStats(1);
    expect(enrollCheck('skycap', s()).reason).toMatch(/年龄/);
  });

  it('年龄资质都过、境界也够、钱不够 → 报学费，且报的是实缴口径', () => {
    s().player.level = 3; // 帝国圣学院门槛「正式」
    s().player.gold = 0;
    const g = enrollCheck('imperial', s());
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/学费不足/);
    expect(g.due).toBe(1000);
  });

  it('有资助时学费那一条不再拦人（实缴为 0）', () => {
    s().player.level = 3;
    s().player.gold = 0;
    s().rep['guild'] = 20;
    expect(enrollCheck('imperial', s()).ok, '公会垫付之后，兜里没钱也能入学').toBe(true);
  });

  it('面板与判定同一口径：catalog 的 due 就是实缴，owe 标出垫付方', () => {
    s().rep['guild'] = 20;
    const row = academyView(s()).catalog.find((x) => x.id === 'imperial')!;
    expect(row.due).toBe(0);
    expect(row.owe).toBe(1000);
    expect(row.aidName).toBe('冒险者公会签约代偿');
    expect(row.ageMin).toBe(12);
    expect(row.ageMax).toBe(25);
    expect(row.aptitude).toContain('智力');
    expect(row.aptitudeMin).toBe(10);
  });
});

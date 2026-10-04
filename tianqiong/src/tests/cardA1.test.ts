/* ============================================================
   卡 A1 · 四条成长线（世界书 §99/§102/§103）
   学院制（既有）/ 师徒制 / 神殿培养 / 自学
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { core, newState } from '@/world/WorldState';
import { bus, rng, scheduler } from '@/events/EventBus';
import { npcDyn } from '@/systems/npc/Npcs';
import { advance } from '@/world/WorldClock';
import {
  apprentice,
  graduate,
  growthView,
  masterTick,
  mentorCandidates,
  pathOf,
  paths,
  selfStudy,
  templeCandidates,
  templeEnroll,
} from '@/systems/academy/Growth';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  rng.seed(23);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  core.S = newState({ name: 'A1', race: 'human', cls: 'warrior' });
});

describe('卡 A1 · 四路径数据契约（§99）', () => {
  it('四条路径齐全，各有周期/费用/优劣/产出', () => {
    expect(paths().map((p) => p.id)).toEqual(['college', 'mentor', 'temple', 'self']);
    for (const p of paths()) {
      expect(p.name, p.id).toBeTruthy();
      expect(p.cycle, p.id).toBeTruthy();
      expect(p.cost, p.id).toBeTruthy();
      expect(p.pros.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.cons.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.yields.length, p.id).toBeGreaterThan(0);
    }
  });

  it('pathOf 可按 id 取到（面板直读）', () => {
    expect(pathOf('mentor')?.name).toBe('师徒制');
    expect(pathOf('nope')).toBeUndefined();
  });
});

describe('卡 A1 · 师徒制（§102）', () => {
  it('好感不足时拜不了师，且给出门槛', () => {
    const s = core.S!;
    s.player.gold = 99999;
    npcDyn('galon', s).att = 0;
    expect(apprentice('galon', s)).toBe(false);
    expect(core.S!.player.growth?.master).toBeUndefined();
  });

  it('好感够 + 拜师礼够 → 拜师成功，状态落库', () => {
    const s = core.S!;
    s.player.gold = 99999;
    npcDyn('galon', s).att = 30;
    expect(apprentice('galon', s)).toBe(true);
    expect(s.player.growth?.master).toBe('galon');
    expect(s.player.growth?.masterSinceDay).toBeGreaterThan(0);
  });

  it('一门不事二师：已拜师后再拜被拒', () => {
    const s = core.S!;
    s.player.gold = 99999;
    npcDyn('galon', s).att = 30;
    npcDyn('brendan', s).att = 30;
    apprentice('galon', s);
    expect(apprentice('brendan', s)).toBe(false);
  });

  it('随师授业：够 teachEvery 日才授，且授的是 mentor 通道可达的技能', () => {
    const s = core.S!;
    s.player.gold = 99999;
    npcDyn('galon', s).att = 30;
    apprentice('galon', s);
    expect(masterTick(s), '当日不该立刻授业').toBeNull();
    advance(3 * 48);
    const got = masterTick(s);
    expect(got, '满 3 日应授一技').toBeTruthy();
    expect(s.player.skills).toContain(got as string);
  });

  it('出师：随师满 3 日 + 谢礼够 → 授师门称号并清空师承', () => {
    const s = core.S!;
    s.player.gold = 99999;
    npcDyn('galon', s).att = 30;
    apprentice('galon', s);
    advance(3 * 48); // 卡 A1：随师满 minDays(3) 才准出师
    const before = s.titles?.length ?? 0;
    expect(graduate(s)).toBe(true);
    expect(s.player.growth?.master).toBeUndefined();
    expect(s.player.growth?.graduated?.length).toBe(1);
    expect(s.titles?.length ?? 0).toBeGreaterThan(before);
  });

  it('未拜师时出师被拒', () => {
    expect(graduate(core.S!)).toBe(false);
  });

  it('mentorCandidates 列出候选并标出可否', () => {
    const s = core.S!;
    const c = mentorCandidates(s);
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((x) => typeof x.ok === 'boolean')).toBe(true);
  });
});

describe('卡 A1 · 神殿培养与自学（§103/§99）', () => {
  it('templeCandidates 给出各神殿的偏好门槛', () => {
    const s = core.S!;
    const c = templeCandidates(s);
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((x) => typeof x.faith === 'number')).toBe(true);
  });

  it('偏好不足时入不了神殿修业', () => {
    const s = core.S!;
    s.favor = { life: { favor: 0, rank: '信仰者' } };
    const c = templeCandidates(s);
    if (c.length) expect(templeEnroll(c[0].name, s)).toBe(false);
  });

  it('自学：耗刻累领悟点，且有每日上限', () => {
    const s = core.S!;
    const t0 = s.t;
    expect(selfStudy(s)).toBe(true);
    expect(s.t).toBeGreaterThan(t0);
    expect(s.insight!.pts).toBeGreaterThan(0);
    selfStudy(s);
    expect(selfStudy(s), '第三次应被日上限拦住').toBe(false);
  });

  it('growthView 汇总师承/神殿/自学进度', () => {
    const s = core.S!;
    const v = growthView(s);
    expect(v.paths.length).toBe(4);
    expect(v.master).toBeNull();
    expect(v.selfMax).toBeGreaterThan(0);
  });
});

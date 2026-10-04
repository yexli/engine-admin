/* ============================================================
   卡 R3 · 技能学习四通道（世界书 §44）
   师傅传授（主流）/ 技能书·卷轴（补充）/ 实战领悟（突破）/ 信仰神赐（特殊）
   原状态只有「按境界自动习得」一条路，本用例钉住另外三条的判据与边界。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { WB } from '@/data/worldBook';
import { core, newState } from '@/world/WorldState';
import { bus, rng, scheduler } from '@/events/EventBus';
import {
  battleInsight,
  canLearn,
  divineGrant,
  faithLearn,
  FAITH_NEED,
  learnView,
  learnWays,
  mentorLearn,
  readTome,
  studyTome,
  wayName,
} from '@/systems/character/Learn';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  rng.seed(7);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  core.S = newState({ name: 'R3', race: 'human', cls: 'warrior' });
});

describe('卡 R3 · 通道数据契约（§44）', () => {
  it('四通道在数据里有载体，且每条技能都能经境界自觉获得', () => {
    const ways = new Set<string>();
    for (const id of Object.keys(WB.skills)) {
      const w = learnWays(id);
      expect(w, id).toContain('level');
      for (const x of w) ways.add(x);
    }
    for (const expect_ of ['level', 'mentor', 'tome', 'insight', 'faith']) {
      expect([...ways], '缺通道 ' + expect_).toContain(expect_);
    }
  });

  it('低阶技能可找师傅，高阶技能必须靠领悟（终局技能不靠读本）', () => {
    expect(learnWays('heavy_slash')).toContain('mentor'); // lv1
    expect(learnWays('mountain_fall')).not.toContain('mentor'); // lv6 终局
    expect(learnWays('mountain_fall')).toContain('insight');
  });

  it('五本残卷各教一门技能，且该技能确实登记了 tome 通道', () => {
    const tomes = Object.entries(WB.items).filter(([, v]) => (v as { teach?: string }).teach);
    expect(tomes.length).toBe(5);
    for (const [iid, it] of tomes) {
      const sid = (it as unknown as { teach: string }).teach;
      expect(WB.skills[sid], iid).toBeTruthy();
      expect(learnWays(sid), iid).toContain('tome');
    }
  });

  it('通道中文名可直出', () => {
    expect(wayName('mentor')).toBe('师傅传授');
    expect(wayName('insight')).toBe('实战领悟');
  });
});

describe('卡 R3 · 越线保护（只能学本职业线的技能）', () => {
  it('战士学不了法师的火焰箭——即便有卷轴', () => {
    const s = core.S!;
    expect(canLearn('mentor', 'firebolt', s).ok).toBe(false);
    expect(canLearn('mentor', 'firebolt', s).why).toMatch(/职业线/);
  });

  it('已学会的技能不再重复授出', () => {
    const s = core.S!;
    s.player.skills.push('heavy_slash');
    expect(canLearn('mentor', 'heavy_slash', s).ok).toBe(false);
    expect(canLearn('mentor', 'heavy_slash', s).why).toMatch(/已会/);
  });
});

describe('卡 R3 · 师傅传授（主流方式）', () => {
  it('境界够、束脩够才教；费用随技能层数递增', () => {
    const s = core.S!;
    s.player.level = 2;
    s.player.gold = 999999;
    /* 注意：战士开局自带 heavy_slash，拿它试「能不能学」永远为 false（已会）。
       这里用尚未习得的 guard_break（lv3）作为低阶样本。 */
    const low = mentorLearn('guard_break', s); // lv3 → 门槛 max(1, 2)=2
    expect(low.ok, low.why).toBe(true);
    /* 门槛 = max(1, 技能 lv - 1)：warcry 在表里是 lv4 → 需 Lv.3 */
    const warcry = mentorLearn('warcry', s);
    expect(warcry.ok, 'Lv.1 学不到 lv4 的技艺').toBe(false);
    expect(warcry.why).toMatch(/境界不足/);
    s.player.level = 3;
    const at3 = mentorLearn('warcry', s);
    expect(at3.ok, 'Lv.3 应可学 lv4 的技艺；实得：' + at3.why).toBe(true);
    expect(at3.fee).toBeGreaterThan(low.fee);
  });

  it('束脩不足时给出可读原因与所需金额', () => {
    const s = core.S!;
    s.player.level = 3;
    s.player.gold = 0;
    const r = mentorLearn('warcry', s);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/束脩/);
    expect(r.fee).toBeGreaterThan(0);
  });
});

describe('卡 R3 · 技能书通道（补充方式）', () => {
  it('读本授技：能教的学得会，不能教的给可读理由', () => {
    const s = core.S!;
    s.player.bag.push({ id: 'tome_craft', qty: 1 }); // 教 forge_strike（生产系）
    const r = readTome('tome_craft', s);
    /* 战士不在生产系，故被越线保护拦下——这一条同时验证了技能书不能越职业线 */
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/职业线/);
  });

  it('同系卷轴可学：法师读位面残卷学时空褶皱（不在其线则拒）', () => {
    core.S = newState({ name: 'R3m', race: 'elf', cls: 'mage' });
    const s = core.S!;
    s.player.bag.push({ id: 'tome_planar', qty: 1 });
    const r = readTome('tome_planar', s);
    /* time_fold 在 mage.skillPath 中 → 应当可学 */
    expect(r.ok, r.why).toBe(true);
    const before = s.player.bag.length;
    studyTome('tome_planar', s);
    expect(s.player.skills).toContain('time_fold');
    /* 卡 R3：授技函数**不消耗**物品（消耗交给 Codex.readTome 的唯一那条 removeItem） */
    expect(s.player.bag.length).toBe(before);
  });

  it('非技能书不给学（只是文献）', () => {
    expect(readTome('bread', core.S!).ok).toBe(false);
  });
});

describe('卡 R3 · 实战领悟（突破方式）', () => {
  it('攒够点数从本职业线最早未学者授出，且不越级', () => {
    const s = core.S!;
    const sp: string[] = (WB.classes[s.player.cls].skillPath ?? []) as string[];
    /* 先把前四个学掉，逼领悟只能落在第 5 个（lv5+ 才有 insight 通道） */
    for (const id of sp.slice(0, 4)) if (!s.player.skills.includes(id)) s.player.skills.push(id);
    let got: string | null = null;
    for (let i = 0; i < 20 && !got; i++) got = battleInsight(s);
    expect(got).toBeTruthy();
    expect(sp.indexOf(got as string)).toBeGreaterThanOrEqual(4);
    expect(s.player.skills).toContain(got as string);
  });

  it('无线可学时不空转：点数压在阈值上（转职后立刻能用）', () => {
    const s = core.S!;
    for (const id of ((WB.classes[s.player.cls].skillPath ?? []) as string[])) s.player.skills.push(id);
    for (let i = 0; i < 20; i++) battleInsight(s);
    expect(s.insight!.pts).toBeGreaterThanOrEqual(24);
    expect(s.insight!.learned).toEqual([]);
  });
});

describe('卡 R3 · 信仰神赐（特殊方式）', () => {
  it('偏好不足时拒，且原因指向「去祈祷」而不是「去练级」', () => {
    core.S = newState({ name: 'R3p', race: 'human', cls: 'priest' });
    const s = core.S!;
    s.favor = { life: { favor: 0, rank: '信仰者' } };
    const r = faithLearn('hymn', 'life', s);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/垂目/);
  });

  it('偏好达标后由神殿授出（且仍受职业线约束）', () => {
    core.S = newState({ name: 'R3p2', race: 'human', cls: 'priest' });
    const s = core.S!;
    s.favor = { life: { favor: FAITH_NEED + 1, rank: '信仰者' } };
    expect(divineGrant('hymn', 'life', s)).toBe(true);
    expect(s.player.skills).toContain('hymn');
    /* 越线保护仍然生效：牧师拿不到战士的裂地斩 */
    s.favor.life!.favor = FAITH_NEED + 1;
    expect(divineGrant('cleave', 'life', s)).toBe(false);
  });
});

describe('卡 R3 · 面板视图', () => {
  it('learnView 覆盖本职业线，并标出已会/可学', () => {
    const s = core.S!;
    const rows = learnView(s);
    const path: string[] = (WB.classes[s.player.cls].skillPath ?? []) as string[];
    expect(rows.length).toBe(path.length);
    expect(rows.every((r) => r.ways.length > 0)).toBe(true);
    expect(rows.some((r) => r.known)).toBe(true); // 开局自带重斩
  });
});

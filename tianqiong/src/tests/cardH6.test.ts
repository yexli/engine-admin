/* ============================================================
   卡 H6 · 培养学院 + 神明系统
   确定性：种子随机 + 同步调度器 + 内存存档；canon 一致性（lore.json 逐字）+ 幂等/旧档断言。
   注：本用例不 import '@/core' 索引（避免拉起并行开发中的 engine.ts），只取具体模块路径。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import loreRaw from '@/data/lore/lore.json';
import academyRaw from '@/data/world/academy.json';
import deitiesRaw from '@/data/world/deities.json';
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { bus, rng, scheduler } from '@/events/EventBus';
import { core, hydrate, newState } from '@/world/WorldState';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { maxHp, maxMp } from '@/systems/character/Derived';
import {
  academyMenu,
  academyView,
  allMentors,
  canGraduate,
  enroll,
  enrollCheck,
  ensureAcademy,
  graduate,
  mentorOf,
  study,
  tuitionDue,
} from '@/systems/academy/Academy';
import {
  DEITY_IDS,
  ascendCandidate,
  deityMenu,
  deityRank,
  deityView,
  divineIntervene,
  ensureFavor,
  favorOf,
  pray,
} from '@/systems/religion/Deity';
import { dlgAct, dlgOpts } from '@/systems/dialogue/Dialogue';
import { MemorySaveRepository } from '@/repo';
import { ruleSim } from '@/ai/ruleSim';

const LORE = loreRaw as unknown as { id: string; num: number; name: string; canon: string }[];
const canonOf = (num: number) => LORE.find((x) => x.num === num)?.canon || '';
const ACAD = academyRaw as unknown as {
  paths: string[];
  terms: { years: number; termsPerYear: number; ticksPerTerm: number; studyTicks: number; degrees: { name: string }[] };
  exam: { baseDc: number; perCourseDc: number; stat: string };
  academies: {
    id: string;
    name: string;
    continent: string;
    city: string;
    specialty: string;
    years: number;
    tuition: number;
    focus: string;
    path: string;
    curriculum: { courseId: string; duration: number }[];
    graduateReward: { skills: string[]; title: string };
    mentor: { npcId: string; goal: string; interest: string; bottomLine: string; greet: { cold: string; neutral: string; warm: string } };
  }[];
};
const DEI = deitiesRaw as unknown as {
  pantheon: Record<string, string>;
  pantheonTitle: Record<string, string>;
  ranks: string[];
  rankDetail: { name: string; headcount: string; duty: string; source: string }[];
  faithTiers: { needFavor: number }[];
  faithClasses: Record<string, string[]>;
  noFaithRank: string;
  domains: Record<string, string[]>;
  attitudes: { common: string; byDeity: Record<string, string> };
  pray: { dailyCap: number; favorMax: number };
  intervene: { needFavor: number; costFavor: number; effects: Record<string, { name: string; text: string }> };
  ascension: { rank: string; history: string; seeds: string[]; tale: string };
  favorMax: number;
};
const acadDef = (id: string) => ACAD.academies.find((a) => a.id === id)!;

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(6);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  core.S = newState({ name: 'H6', race: 'human', cls: 'warrior' });
  core.S.player.hp = 40;
  core.S.player.mp = 20;
});

/* ================= canon 一致性（卡 H6 风险项：世界观漂移） ================= */

describe('卡 H6 · canon 一致性（lore.json 逐字）', () => {
  it('六主神神名 / 神号与 s2 逐字一致', () => {
    const s2 = canonOf(2);
    for (const line of [
      '战争之主·阿尔卡斯',
      '万典之主·维罗妮卡',
      '生命之源·伊莲娜',
      '冥府之主·诺克斯',
      '归墟之主·洛基',
      '第六主神·龙神',
      '超然于万神殿议事之外',
    ]) {
      expect(s2, line).toContain(line);
    }
    expect(DEI.pantheon).toEqual({
      war: '阿尔卡斯',
      wisdom: '维罗妮卡',
      life: '伊莲娜',
      death: '诺克斯',
      chaos: '洛基',
      dragon: '龙神',
    });
    expect(DEI.pantheonTitle.war).toBe('战争之主');
    expect(DEI.pantheonTitle.wisdom).toBe('万典之主');
    expect(DEI.pantheonTitle.life).toBe('生命之源');
    expect(DEI.pantheonTitle.death).toBe('冥府之主');
    expect(DEI.pantheonTitle.chaos).toBe('归墟之主');
    expect(DEI.pantheonTitle.dragon).toBe('第六主神');
    expect(DEITY_IDS).toEqual(['war', 'wisdom', 'life', 'death', 'chaos', 'dragon']);
  });

  it('神界五级 ranks / rankDetail 与 s3 逐条一致', () => {
    const s3 = canonOf(3);
    expect(DEI.ranks).toEqual(['候补', '侍神', '神官', '从神', '主神']);
    expect(DEI.ranks[0]).toBe(DEI.ascension.rank); // ascendCandidate 用 ranks[0]
    for (const r of DEI.rankDetail) {
      for (const field of [r.name, r.headcount, r.duty, r.source]) expect(s3, field).toContain(field);
    }
  });

  it('信仰职业四级路线与 s37 逐字一致；终极称号带书名号；龙神殿空数组', () => {
    const s37 = canonOf(37);
    for (const line of [
      '信仰者→神恩骑士→圣战使徒',
      '【神之右臂】',
      '信仰者→神谕祭司→启示先知',
      '【真理之眼】',
      '信仰者→神愈圣女→救赎天使',
      '【神之悲悯】',
      '信仰者→终焉使者→轮回看守',
      '【冥河渡者】',
      '信仰者→狂信者→末日先驱',
      '【神罚执行者】',
      '独立于五系之外，需神明认可',
    ]) {
      expect(s37, line).toContain(line);
    }
    expect(DEI.faithClasses.war).toEqual(['信仰者', '神恩骑士', '圣战使徒', '【神之右臂】']);
    expect(DEI.faithClasses.wisdom).toEqual(['信仰者', '神谕祭司', '启示先知', '【真理之眼】']);
    expect(DEI.faithClasses.life).toEqual(['信仰者', '神愈圣女', '救赎天使', '【神之悲悯】']);
    expect(DEI.faithClasses.death).toEqual(['信仰者', '终焉使者', '轮回看守', '【冥河渡者】']);
    expect(DEI.faithClasses.chaos).toEqual(['信仰者', '狂信者', '末日先驱', '【神罚执行者】']);
    expect(DEI.faithClasses.dragon).toEqual([]); // canon 仅五大神殿有信仰职业路线
    expect(DEI.noFaithRank).toContain('龙神殿');
  });

  it('神系态度与 s12 逐字一致', () => {
    const s12 = canonOf(12);
    expect(s12).toContain(DEI.attitudes.common);
    for (const id of DEITY_IDS) {
      const a = DEI.attitudes.byDeity[id];
      expect(a, id).toBeTruthy();
      expect(s12, id).toContain(a);
    }
  });

  it('academy.json 七所学院（+训练营）名称 / 大陆 / 城市 / 专长 / 学制 / 年费与 s100 逐字一致', () => {
    const s100 = canonOf(100);
    const canon7 = ['imperial', 'windport', 'goldveil', 'frosthold', 'bloodhold', 'deepwell', 'skycap'];
    for (const id of canon7) {
      const a = acadDef(id);
      const row = a.name + ' ' + a.continent + ' ' + a.city + ' ' + a.specialty + ' ' + a.years + '年 ' + a.tuition + '金币';
      expect(s100, row).toContain(row);
    }
    const camp = acadDef('camp');
    expect(s100).toContain('冒险者训练营');
    expect(s100).toContain('免费但需通过测试');
    expect(camp.tuition).toBe(0);
    expect(ACAD.paths).toEqual(['战士学院', '法师学院', '神殿学院', '生产学院']);
    for (const a of ACAD.academies) {
      expect(ACAD.paths, a.id).toContain(a.path);
      expect(['warrior', 'mage', 'temple', 'craft'], a.id).toContain(a.focus);
      expect(a.curriculum.length, a.id).toBe(a.years); // 课程数 = 学制年数
    }
  });

  it('学位等级与 s101 一致；学院毕业称号取自四学位', () => {
    const s101 = canonOf(101);
    expect(ACAD.terms.degrees.map((d) => d.name)).toEqual(['学徒', '学士', '大师', '贤者']);
    for (const d of ACAD.terms.degrees) expect(s101).toContain(d.name);
    for (const a of ACAD.academies) {
      expect(ACAD.terms.degrees.map((d) => d.name), a.id).toContain(a.graduateReward.title);
    }
  });
});

/* ================= 学院：入学前置三档 ================= */

describe('卡 H6 · 学院入学前置（金币 / 境界 / 种族）', () => {
  it('金币不足 → 拒入（帝国圣学院首年 1000）', () => {
    const s = core.S!;
    expect(s.player.gold).toBe(5000); // 卡 T3：起始资金 600 → 5000
    /* 卡 R2：境界六阶对齐世界书 §29（见习=2／正式=3），「正式」门槛由 Lv.2 升到 Lv.3 */
    s.player.level = 3; // 先过境界门，专测金币门
    /* 起点 5000 已高于首年学费 1000 —— 想复现「金币门」，得先把钱花掉。
       扣到 500 后仍低于 1000，断言与拒绝理由保持原样。 */
    s.player.gold = 500;
    expect(enrollCheck('imperial', s).ok).toBe(false);
    expect(enrollCheck('imperial', s).reason).toMatch(/学费/);
    expect(enroll('imperial')).toBe(false);
    expect(ensureAcademy(s).enrolled).toBeUndefined();
    expect(s.player.gold).toBe(500); // 未扣款
  });

  it('境界不足 → 拒入（翠风学园要求「正式」= Lv.3）', () => {
    const s = core.S!;
    s.player.gold = 5000;
    s.player.level = 1;
    expect(enrollCheck('windport', s).reason).toMatch(/境界/);
    expect(enroll('windport')).toBe(false);
    s.player.level = 3; // 卡 R2：通用表「正式」= Lv.3（见习=2）
    expect(enroll('windport')).toBe(true);
    expect(s.player.gold).toBe(5000 - acadDef('windport').tuition);
  });

  it('种族不符 → 拒入（霜锚武馆矮人专属，s36 锻造路线）', () => {
    const s = core.S!;
    s.player.gold = 5000;
    s.player.level = 3; // 卡 R2：世界书 §29 六阶——正式=3
    expect(enrollCheck('frosthold', s).reason).toMatch(/种族/);
    expect(enroll('frosthold')).toBe(false);
    // 换矮人：可入
    core.S = newState({ name: 'H6d', race: 'dwarf', cls: 'pr_forge' });
    core.S.player.gold = 5000;
    core.S.player.level = 3; // 卡 R2：新建角色默认 Lv.1（信徒），仍需过「正式」门槛
    expect(enroll('frosthold')).toBe(true);
    expect(core.S.academy!.enrolled).toBe('frosthold');
  });

  it('免费训练营可入；重复报名 / 二次学籍被拒；奖学金按 s101 减免', () => {
    const s = core.S!;
    /* 卡 R2：训练营门槛「见习」= Lv.2（世界书 §29 六阶：信徒=1、见习=2） */
    s.player.level = 2;
    expect(enroll('camp')).toBe(true);
    expect(enroll('camp')).toBe(false); // 已在读
    expect(enroll('bloodhold')).toBe(false); // 学籍不可两处
    expect(tuitionDue('imperial', s)).toBe(1000);
    s.player.stats['智力'] = 14;
    expect(tuitionDue('imperial', s)).toBe(700); // s101：帝国圣学院 30% 奖学金
  });
});

/* ================= 学院：修业与考核 ================= */

describe('卡 H6 · 修业（时间推进 + 考核两路）', () => {
  it('study 推进一个学期（studyTicks 刻）并累计 progress；三次结业一门课', () => {
    const s = core.S!;
    s.player.level = 2; // 卡 R2：训练营门槛「见习」= Lv.2
    s.player.stats['体质'] = 40; // mod +15 → 考核必过（dc 10）
    expect(enroll('camp')).toBe(true);
    expect(s.academy!.term).toBe(1); // 入学即第 1 学期
    const t0 = s.t;
    study();
    expect(s.t - t0).toBe(ACAD.terms.studyTicks);
    expect(s.academy!.progress).toBe(ACAD.terms.studyTicks);
    expect(s.academy!.term).toBe(2); // 修满一学期即入第 2 学期
    study();
    expect(s.academy!.progress).toBe(ACAD.terms.studyTicks * 2);
    study();
    expect(s.academy!.completed).toContain('camp_y1');
    expect(s.academy!.progress).toBe(0);
    expect(s.academy!.course).toBeUndefined(); // 课程全清
    expect(s.t - t0).toBe(ACAD.terms.ticksPerTerm * ACAD.terms.termsPerYear);
  });

  it('考核失败 → progress 不增、failed +1、时间照常推进（不驱逐学籍）', () => {
    const s = core.S!;
    s.player.level = 2; // 卡 R2：训练营门槛「见习」= Lv.2
    s.player.stats['体质'] = 1; // mod -5：dc 10 需 roll ≥ 15
    expect(enroll('camp')).toBe(true);
    let failedSeed = -1;
    for (let i = 0; i < 60 && failedSeed < 0; i++) {
      rng.seed(1000 + i * 7);
      s.academy!.completed = [];
      s.academy!.course = 'camp_y1';
      s.academy!.progress = 0;
      s.academy!.failed = 0;
      const t0 = s.t;
      study();
      expect(s.t - t0).toBe(ACAD.terms.studyTicks); // 成/败都推进时间
      if ((s.academy!.failed || 0) > 0) {
        failedSeed = i;
        expect(s.academy!.progress).toBe(0); // 失败不累进度
        expect(s.academy!.enrolled).toBe('camp'); // 学籍仍在
      }
    }
    expect(failedSeed).toBeGreaterThanOrEqual(0);
  });
});

/* ================= 学院：毕业授予 ================= */

describe('卡 H6 · 毕业（课程全清 + 学制满 → skills + title）', () => {
  it('训练营 1 年制：结业 + 学制满（4320 刻）→ 授予技能与「学徒」称号', () => {
    core.S = newState({ name: 'H6m', race: 'human', cls: 'mage' }); // 法师初始无 heavy_slash，便于验证授予
    const s = core.S;
    s.player.level = 2; // 卡 R2：训练营门槛「见习」= Lv.2
    s.player.stats['体质'] = 40;
    expect(s.player.skills).not.toContain('heavy_slash');
    expect(enroll('camp')).toBe(true);
    for (let i = 0; i < 3; i++) study();
    expect(s.t - (s.academy!.startedAt || 0)).toBe(ACAD.terms.ticksPerTerm * ACAD.terms.termsPerYear);
    expect(s.academy!.completed).toEqual(['camp_y1']);
    expect(canGraduate(s).ok).toBe(true);
    expect(graduate()).toBe(true);
    expect(s.player.skills).toContain('heavy_slash');
    expect(s.academy!.titles).toContain('冒险者训练营·学徒');
    expect(s.academy!.graduated).toContain('camp');
    expect(s.academy!.enrolled).toBeUndefined();
    expect(s.history.some((h) => h.c.includes('冒险者训练营'))).toBe(true);
  });

  it('帝国圣学院 5 年制：课程全清 + 学制满 → 授予 arcane_ward + 「大师」', () => {
    const s = core.S!;
    s.player.gold = 5000;
    s.player.level = 3; // 卡 R2：世界书 §29 六阶——正式=3
    expect(enroll('imperial')).toBe(true);
    const a = s.academy!;
    a.completed = acadDef('imperial').curriculum.map((c) => c.courseId);
    expect(canGraduate(s).reason).toMatch(/学制未满/);
    s.t = (a.startedAt || 0) + 5 * ACAD.terms.termsPerYear * ACAD.terms.ticksPerTerm;
    expect(canGraduate(s).ok).toBe(true);
    expect(graduate()).toBe(true);
    expect(s.player.skills).toContain('arcane_ward');
    expect(a.titles).toContain('帝国圣学院·大师');
  });

  it('课程未清或学制未满 → 拒毕业（不授予任何东西）', () => {
    const s = core.S!;
    s.player.gold = 5000;
    s.player.level = 3; // 卡 R2：世界书 §29 六阶——正式=3
    expect(enroll('imperial')).toBe(true);
    const titles0 = s.academy!.titles.length;
    expect(graduate()).toBe(false);
    expect(s.academy!.titles.length).toBe(titles0);
    expect(s.academy!.enrolled).toBe('imperial');
  });
});

/* ================= 学院：视图 / 菜单 / 导师 ================= */

describe('卡 H6 · 学院视图与导师（验收二 · NPC 独立性）', () => {
  it('academyView 名录完备、可入学标记与拒绝理由正确；菜单可开', () => {
    core.S!.player.level = 3; // 卡 R2：排除境界门（正式=3）
    /* 卡 T3：起始资金 600 → 5000 后，1000 学费的帝国圣学院变成「可入学」，
       于是本用例不再能验「学费不足的理由」。把钱花到 500，恢复它原本要断言的状态。 */
    core.S!.player.gold = 500;
    const v = academyView(core.S!);
    expect(v.catalog.length).toBe(ACAD.academies.length);
    expect(v.paths).toEqual(['战士学院', '法师学院', '神殿学院', '生产学院']);
    expect(v.catalog.find((c) => c.id === 'camp')!.canEnroll).toBe(true);
    const imperial = v.catalog.find((c) => c.id === 'imperial')!;
    expect(imperial.canEnroll).toBe(false);
    expect(imperial.reason).toMatch(/学费/);
    expect(imperial.mentor!.npcId).toBe('vandel');
    expect(() => academyMenu()).not.toThrow();
    expect(() => academyView(core.S!)).not.toThrow();
  });

  it('导师逐院独立：goal / interest / bottomLine 齐备且互不相同（F-27：人设单一取自 people.json）', () => {
    const ms = allMentors();
    expect(ms.length).toBe(ACAD.academies.length);
    expect(new Set(ms.map((m) => m.goal)).size).toBe(ms.length);
    expect(new Set(ms.map((m) => m.bottomLine)).size).toBe(ms.length);
    expect(new Set(ms.map((m) => m.interest)).size).toBe(ms.length);
    for (const m of ms) {
      const known = WB.npcs[m.npcId];
      expect(known, m.npcId).toBeTruthy();
      expect((m.goal ?? '').length, m.npcId).toBeGreaterThan(6);
      expect((m.bottomLine ?? '').length, m.npcId).toBeGreaterThan(6);
      const g = m.greet;
      expect((g?.cold.length ?? 0) + (g?.neutral.length ?? 0) + (g?.warm.length ?? 0), m.npcId).toBeGreaterThan(6);
      expect(m.loc, m.npcId).toBeTruthy();
      /* F-27：学院侧不得再自持一份人设——三档口吻与三项目标必须与世界书逐字一致 */
      expect(m.goal).toBe(known.goal);
      expect(m.interest).toBe(known.interest);
      expect(m.bottomLine).toBe(known.bottomLine);
      expect(g).toEqual(known.greet);
      expect(m.title, m.npcId).toBeTruthy(); // 学院侧头衔显式覆盖世界书头衔
    }
    /* 卡 H6 集成：4 位 tutor_* 已由主线播种进 people.json，8 位导师全部落地为可交互 NPC
       （验收二·NPC 独立性要求导师是真实 NPC，而非仅数据行） */
    expect(allMentors().every((m) => !m.pending)).toBe(true);
    expect(mentorOf('imperial')!.pending).toBe(false); // 复用 people.json 的 vandel
    expect(mentorOf('skycap')!.pending).toBe(false); // tutor_skycap 已播种
    expect(mentorOf('nope')).toBeNull();
    expect(mentorOf('imperial')!.name).toBe(WB.npcs.vandel.name);
    expect(mentorOf('skycap')!.name).toBe(WB.npcs.tutor_skycap.name); // 播种后姓名以世界书为准
    expect(mentorOf('skycap')!.loc).toBe(WB.npcs.tutor_skycap.loc);
  });

  it('旧档（无 academy 字段）ensureAcademy / academyView 不崩', () => {
    const legacy = { ver: 1, t: 0, player: { gold: 0 } } as unknown as WorldState;
    expect(() => ensureAcademy(legacy)).not.toThrow();
    expect(ensureAcademy(legacy).progress).toBe(0);
  });
});

/* ================= 神明：祈祷 / 阶位 / 神迹 ================= */

describe('卡 H6 · 祈祷（日限 + favor 累积）', () => {
  it('每日 3 次上限；第 4 次拒绝且不推进时间；跨日重置', () => {
    const s = core.S!;
    const f0 = favorOf('war', s);
    expect(pray('war')).toBe(true);
    expect(pray('war')).toBe(true);
    expect(pray('war')).toBe(true);
    expect(favorOf('war', s)).toBeGreaterThanOrEqual(f0 + 3); // 每次 +1..4（pray.favorMin/Max）
    expect(s.favorDay!.n).toBe(3);
    const t1 = s.t;
    expect(pray('war')).toBe(false); // 超限
    expect(s.t).toBe(t1); // 拒绝时不耗刻
    expect(s.favorDay!.n).toBe(3);
    expect(favorOf('war', s)).toBeLessThanOrEqual(DEI.favorMax);
    s.t += 48; // 次日
    expect(pray('war')).toBe(true);
    expect(s.favorDay!.n).toBe(1);
    expect(s.favor!.war!.lastPrayDay).toBe(Math.floor(s.t / 48) + 1);
  });

  it('祈祷写日志（seed 直出，无占位符）并累积神殿声望', () => {
    const s = core.S!;
    /* 神殿拆五后，向生命之主祈祷记的是生命神殿的账（Deity 的主神→神殿映射）。 */
    const rep0 = s.rep.temple_life;
    expect(pray('life')).toBe(true);
    expect(s.rep.temple_life).toBeGreaterThan(rep0);
    expect(s.log[s.log.length - 1].text).not.toMatch(/\{[^}]+\}/);
    for (const line of (deitiesRaw as unknown as { pray: { seeds: string[]; prayLines: Record<string, string> } }).pray.seeds) {
      expect(line).not.toMatch(/\{[^}]+\}/);
    }
    for (const id of DEITY_IDS) {
      const l = (deitiesRaw as unknown as { pray: { prayLines: Record<string, string> } }).pray.prayLines[id];
      expect(l, id).toBeTruthy();
      expect(l).not.toMatch(/\{[^}]+\}/);
    }
  });

  it('信仰阶位按 s37 四级路线随 favor 自动晋阶并写回 rank；龙神殿无路线', () => {
    const s = core.S!;
    expect(deityRank('war', s)).toBe('信仰者');
    const T = DEI.faithTiers;
    for (const [i, name] of DEI.faithClasses.war.entries()) {
      s.favor!.war!.favor = T[i].needFavor;
      s.favor!.war!.rank = '信仰者';
      expect(deityRank('war', s)).toBe(name);
    }
    expect(s.favor!.war!.rank).toBe('【神之右臂】'); // 写回
    s.favor!.wisdom = { favor: T[2].needFavor, rank: '信仰者' };
    expect(deityRank('wisdom', s)).toBe('启示先知'); // 每殿称号不同
    s.favor!.life = { favor: T[1].needFavor, rank: '信仰者' };
    expect(deityRank('life', s)).toBe('神愈圣女');
    expect(deityRank('dragon', s)).toBe(DEI.noFaithRank); // canon 无信仰职业路线
    expect(DEI.domains.dragon.length).toBeGreaterThan(0); // 但仍有神职领域
  });
});

describe('卡 H6 · 神迹（favor 阈值 → D4 事件引擎 · seed 直出）', () => {
  it('favor < 阈值拒绝；≥ 阈值触发：扣偏好、计次、入事件簿、置 flag', () => {
    const s = core.S!;
    expect(divineIntervene('war')).toBe(false);
    expect(s.favor!.war!.intervened).toBeUndefined();
    ensureFavor(s)['war']!.favor = DEI.intervene.needFavor;
    const exp0 = s.player.exp;
    expect(divineIntervene('war')).toBe(true);
    expect(s.favor!.war!.favor).toBe(DEI.intervene.needFavor - DEI.intervene.costFavor);
    expect(s.favor!.war!.intervened).toBe(1);
    expect(s.player.exp).toBeGreaterThan(exp0);
    expect(s.player.flags.miracle_war).toBe(true);
    expect(s.events.some((e) => e.id === 'divine_war_1')).toBe(true); // 走 D4 fireEvent
    expect(s.log.some((l) => l.text === DEI.intervene.effects.war.text)).toBe(true); // seed 直出（关 AI 成立）
    // 冷却：同日不可再求
    s.favor!.war!.favor = 100;
    expect(divineIntervene('war')).toBe(false);
    // 冷却过后可再降（event id 带次数，不互相幂等）
    s.t += 20 * 48;
    s.favor!.war!.favor = 100;
    expect(divineIntervene('war')).toBe(true);
    expect(s.events.some((e) => e.id === 'divine_war_2')).toBe(true);
  });

  it('生命之源·群体治愈满血满蓝；全部神迹文本无 {占位符}', () => {
    const s = core.S!;
    s.player.hp = 1;
    s.player.mp = 0;
    ensureFavor(s)['life']!.favor = 80;
    expect(divineIntervene('life')).toBe(true);
    expect(s.player.hp).toBe(maxHp(s));
    expect(s.player.mp).toBe(maxMp(s));
    for (const id of DEITY_IDS) {
      const e = DEI.intervene.effects[id];
      expect(e, id).toBeTruthy();
      expect(e.text, id).not.toMatch(/\{[^}]+\}/);
      expect(e.name, id).toBeTruthy();
    }
    expect(DEI.intervene.effects.life.name).toBe('生命之源·群体治愈'); // canon 名称
  });

  it('deityView / deityMenu 可开（无 core.S 时菜单不抛错之外的路径）', () => {
    const v = deityView(core.S!);
    expect(v.rows.length).toBe(6);
    expect(v.dailyCap).toBe(DEI.pray.dailyCap);
    expect(v.prayLeft).toBe(DEI.pray.dailyCap);
    expect(v.rows.every((r) => r.domains.length > 0 && r.temple.length > 0)).toBe(true);
    expect(v.rows.find((r) => r.id === 'dragon')!.faithDisabled).toBe(true);
    expect(v.rows.find((r) => r.id === 'war')!.faithDisabled).toBe(false);
    expect(v.rows.find((r) => r.id === 'life')!.templeSchool!.direction).toBe('治疗/辅助'); // s103
    expect(() => deityMenu()).not.toThrow();
  });
});

/* ================= 神明：候补神晋升（H5 终局接线） ================= */

describe('卡 H6 · ascendCandidate（幂等 + 防御）', () => {
  it('幂等：重复调用不再产生副作用，仍返回 true', () => {
    const s = core.S!;
    expect(ascendCandidate('lita')).toBe(true);
    expect(s.player.flags['ascend_lita']).toBe(true);
    const ev0 = s.events.length;
    const hi0 = s.history.length;
    const lo0 = s.log.length;
    expect(ascendCandidate('lita')).toBe(true);
    expect(s.events.length).toBe(ev0);
    expect(s.history.length).toBe(hi0);
    expect(s.log.length).toBe(lo0);
    expect(s.history[0].c).toBe(DEI.ascension.history);
    expect(s.history[0].r).toContain(WB.npcs.lita.name);
    expect(s.history[0].r).toContain(DEI.ascension.rank);
  });

  it('防御：H5 未落地（无 theoselect）/ 未知 npcId / 非法入参 / core.S 未初始化 均不崩', () => {
    const s = core.S!;
    delete (s as unknown as Record<string, unknown>).theoselect;
    expect(() => ascendCandidate('nobody')).not.toThrow();
    expect(ascendCandidate('nobody')).toBe(true);
    expect(s.history[0].r).toContain('nobody');
    expect(ascendCandidate('')).toBe(false);
    expect(ascendCandidate('   ')).toBe(false);
    expect(ascendCandidate(undefined as unknown as string)).toBe(false);
    const keep = core.S;
    core.S = null;
    expect(ascendCandidate('x')).toBe(false);
    core.S = keep;
  });

  it('H5 联动：stage 神战 → 候补（ranks[0]），champion 定格为该 npcId', () => {
    const s = core.S!;
    s.theoselect = { enrolled: true, stage: '神战', score: 0 };
    expect(ascendCandidate('galon')).toBe(true);
    expect(s.theoselect.stage).toBe(DEI.ascension.rank);
    expect(s.theoselect.champion).toBe('galon');
  });
});

/* ================= 旧档迁移 + 分层铁律 ================= */

describe('卡 H6 · 旧档 hydrate 与分层铁律', () => {
  it('旧档（缺 academy / favor / favorDay）hydrate 兜底不崩，视图与菜单可渲染', () => {
    const legacy = JSON.parse(JSON.stringify(core.S)) as Record<string, unknown>;
    delete legacy.academy;
    delete legacy.favor;
    delete legacy.favorDay;
    const h = hydrate(legacy as unknown as WorldState);
    expect(h.academy!.progress).toBe(0);
    expect(h.academy!.completed).toEqual([]);
    expect(h.favor).toEqual({});
    expect(() => ensureAcademy(h)).not.toThrow();
    expect(() => ensureFavor(h)).not.toThrow();
    expect(ensureFavor(h).war!.favor).toBe(0);
    expect(() => deityView(h)).not.toThrow();
    expect(() => academyView(h)).not.toThrow();
    expect(() => deityMenu()).not.toThrow();
    expect(() => academyMenu()).not.toThrow();
  });

  it('分层铁律：academy.ts / deity.ts 不依赖 AI / UI / store / React（core 可在无 UI 环境运行）', () => {
    for (const f of ['../systems/academy/Academy.ts', '../systems/religion/Deity.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/from '@\/ai/);
      expect(src, f).not.toMatch(/from '@\/ui/);
      expect(src, f).not.toMatch(/from '@\/store/);
      expect(src, f).not.toMatch(/from 'react/);
      expect(src, f).not.toMatch(/from 'zustand/);
    }
  });
});

/* ============================================================
   卡 H6 集成 · NPC 交互面完整性（约束 §5「G10 新 NPC 零代码契约」）
   契约原文：people.json 字段（人设/topics/faction/likes/intimacyGate/
   reciprocate）齐备 → 请求 / 叙事 / 赠礼三个交互面自动可用
   （「聊天」已升为框架级的「深谈」页，不再逐人配置）。
   回归背景：dlgOpts 原为逐人 switch 且**无 default 分支**，任何新 NPC
   （如本卡播种的 4 位学院导师）都退化成「只有一个赠礼」——契约形同虚设。
   ============================================================ */
describe('卡 H6 集成 · NPC 交互面完整性（G10 零代码契约）', () => {
  it('people.json 的每一个 NPC 都至少具备 提出请求 / 赠礼 两个选项面', () => {
    const ids = Object.keys(WB.npcs);
    expect(ids.length).toBeGreaterThanOrEqual(15); // 11 原有 + 4 位学院导师
    for (const id of ids) {
      const acts = dlgOpts(id).map((o) => o.a);
      /* 「聊天」不再由 dlgOpts 提供：它已升为框架级入口（对话浮层的「深谈」页，
         含会话时间线与追问），对全部 NPC 统一可用，不再是逐人契约的一部分。 */
      expect(acts, id + ' 缺「提出请求」交互面').toContain('dreq');
      expect(acts, id + ' 缺「赠礼」交互面').toContain('gift');
      /* 选项必须带 npcId 与可读标签（空标签会让 UI 出现空按钮） */
      for (const o of dlgOpts(id)) {
        expect(o.n, id + ' 的选项缺 npcId').toBe(id);
        expect(o.l.trim().length, id + ' 存在空标签选项').toBeGreaterThan(0);
      }
    }
  });
  it('四位播种的学院导师各有专属交互面（学院入口 + 专属动作），不是通用兜底', () => {
    const ids = ['tutor_wind', 'tutor_deepwell', 'tutor_skycap', 'tutor_camp'];
    for (const id of ids) {
      expect(WB.npcs[id], id + ' 未播种进 people.json').toBeTruthy();
      const acts = dlgOpts(id).map((o) => o.a);
      expect(acts, id + ' 缺学院入口').toContain('ac_menu');
      expect(acts.length, id + ' 交互面过少').toBeGreaterThanOrEqual(4);
    }
    expect(dlgOpts('tutor_wind').map((o) => o.a)).toContain('lore_wind');
    expect(dlgOpts('tutor_deepwell').map((o) => o.a)).toContain('lore_deep');
    expect(dlgOpts('tutor_skycap').map((o) => o.a)).toContain('lore_sky');
    expect(dlgOpts('tutor_camp').map((o) => o.a)).toContain('train');
  });
  it('专属动作在 dlgAct 里有真实落点（不给死按钮）', () => {
    const src = readFileSync(new URL('../systems/dialogue/Dialogue.ts', import.meta.url), 'utf8');
    for (const a of ['lore_wind', 'lore_deep', 'lore_sky', 'train', 'ac_menu'])
      expect(src, 'dlgAct 缺 ' + a + ' 分支').toContain("case '" + a + "':");
    /* default 兜底分支必须存在，否则新增 NPC 会再次退化 */
    expect(src).toMatch(/default:\s*\n\s*\/\* G10/);
  });
  it('训练有实际收益且不空转（耗时 + 恢复体力）', () => {
    const s = core.S!;
    s.player.hp = 1;
    const t0 = s.t;
    dlgAct('tutor_camp', 'train');
    expect(s.t - t0).toBe(6);
    expect(s.player.hp).toBeGreaterThan(1);
    expect(s.player.hp).toBeLessThanOrEqual(maxHp(s));
  });
  it('未知 NPC id 不崩（手改档 / 内容缺失防御）', () => {
    expect(() => dlgOpts('nobody_here')).not.toThrow();
    const acts = dlgOpts('nobody_here').map((o) => o.a);
    expect(acts).toContain('gift'); // 至少保留赠礼，不抛错
  });
});


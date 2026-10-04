/* ============================================================
   卡 H6 · 培养学院（lore s99 四大培养路径 / s100 主要学院 / s101 学院学制 /
   s103 神殿培养 / s104 学院—公会—神殿关系 / s36 矮人专属锻造）
   - enroll：金币（首年学费）/ 境界（derived.rankName）/ 种族（如霜锚武馆矮人专属）三档前置
   - study：推进 studyTicks（一学期）→ 扣修业费 → check() 考核（d20）→ 累 progress / 记 failed
   - graduate：课程全清 + 学制（years × 3 学期 × 1440 刻）→ 授予 skills + 学位称号
   - mentorOf：学院导师 NPC 数据（goal/interest/bottomLine 独立），供 D1/D2/D3 接线
   铁律：一切状态改写只在本文件内完成；学院名/学制/学费/考核 DC 一律读 data/world/academy.json。
   ============================================================ */
import raw from '@/data/world/academy.json';
import { WB } from '@/data/worldBook';
import type { AcademyState, StatName, WorldState } from '@/types/world';
import { toast } from '@/events/EventBus';
import { check } from '@/dice/CheckResolver';
import { ageOf } from '@/systems/timeslip/Lifespan';
import { rankTierName } from '@/systems/character/Derived';
import { addRep, gainExp, gainGold, log } from '@/systems/character/Gains';
import { formatMoney } from '@/systems/economy/Money';
import { confirmSheet } from '@/systems/character/Sheet';
import { core, need, sync } from '@/world/WorldState';
import { advance } from '@/world/WorldClock';
import { TICKS_PER_YEAR } from '@/world/TimeBase';
import { addHistory } from '@/events/EventStore';

/* ---------------- 数据契约（academy.json） ---------------- */

export interface CourseDef {
  courseId: string;
  name: string;
  year: number;
  duration: number;
  skills: string[];
  goldCost: number;
  dc?: number;
  stat?: string;
}
export interface MentorDef {
  npcId: string;
  /** 未落世界书时的兜底姓名（★人设唯一真相源是 people.json） */
  name: string;
  /** 学院侧头衔：显式覆盖世界书头衔（如"古研会学者·帝国圣学院客座"） */
  title: string;
  race: string;
  loc: string;
  role: string;
  seeded: boolean;
  /* F-27：以下人设字段单一取自 people.json（mentorOf 注入）；
     仅在"NPC 尚未播种"的中间态下用作兜底，故为可选。 */
  goal?: string;
  interest?: string;
  bottomLine?: string;
  greet?: { cold: string; neutral: string; warm: string };
}
export interface AcademyDef {
  id: string;
  name: string;
  continent: string;
  city: string;
  specialty: string;
  years: number;
  terms: number;
  focus: string;
  path: string;
  tuition: number;
  entryReq: {
    gold: number;
    rank: string;
    race?: string;
    scholarship?: { rate: number; needStat?: Record<string, number>; note?: string };
    /** 卡 L2 · §101 资质三选一：本院的候选属性轴（缺省用 CFG.entry.aptitude.stats 三项） */
    aptitude?: StatName[];
    /** 卡 L2 · 资质门槛（缺省用 CFG.entry.aptitude.min） */
    aptitudeMin?: number;
    /** 卡 L2 · 年龄区间覆写（缺省用 CFG.entry.ageMin/ageMax；可供"只收幼童"一类的学院使用） */
    ageMin?: number;
    ageMax?: number;
  };
  curriculum: CourseDef[];
  graduateReward: { skills: string[]; title: string };
  mentor: MentorDef;
  note?: string;
  raceNote?: string;
  canonRef?: string;
}
interface AcademyCfg {
  paths: string[];
  focusPath: Record<string, string>;
  terms: {
    years: number;
    termsPerYear: number;
    ticksPerTerm: number;
    studyTicks: number;
    courseDuration: number;
    degrees: { name: string; equiv: string; career: string; atRatio: number }[];
    stageNames: string[];
    stageNamesNote: string;
  };
  exam: { baseDc: number; perCourseDc: number; stat: string; failExp: number; failExpGain: number };
  /** 卡 L2 · §101「入学要求」：年龄 · 资质 · 学费与寒门通道（全局缺省，学院可覆写） */
  entry: {
    ageMin: number;
    ageMax: number;
    ageNote?: string;
    aptitude: { stats: StatName[]; map?: Record<string, string>; min: number; note?: string };
    aid: {
      id: string;
      name: string;
      faction: string;
      rep: number;
      cover: number;
      debt: boolean;
      /** 卡 G3 · 偿还方式：coin 还钱 / service 服役（缺省 coin，旧数据不必改） */
      payback?: 'coin' | 'service';
      /** service 型的服役年数 */
      serviceYears?: number;
      /** service 型的年饷（铜） */
      servicePay?: number;
      note?: string;
    }[];
    aidNote?: string;
  };
  academies: AcademyDef[];
}

const CFG = raw as unknown as AcademyCfg;

const academyById = (id: string | undefined): AcademyDef | null => CFG.academies.find((a) => a.id === id) || null;

/* ---------------- 状态兜底（旧档可读；hydrate 之外再兜一道） ---------------- */

export function ensureAcademy(s: WorldState): AcademyState {
  if (!s.academy) s.academy = { progress: 0, completed: [], titles: [] };
  const a = s.academy;
  if (!Array.isArray(a.completed)) a.completed = [];
  if (!Array.isArray(a.titles)) a.titles = [];
  if (typeof a.progress !== 'number' || Number.isNaN(a.progress)) a.progress = 0;
  if (!Array.isArray(a.graduated)) a.graduated = [];
  return a;
}

const elapsedOf = (s: WorldState, a: AcademyState) => Math.max(0, s.t - (a.startedAt ?? s.t));
const termOf = (s: WorldState, a: AcademyState) => Math.floor(elapsedOf(s, a) / CFG.terms.ticksPerTerm) + 1;
const minTicksOf = (def: AcademyDef) => def.years * CFG.terms.termsPerYear * CFG.terms.ticksPerTerm;

/** 境界门槛 → 等级（在任意职业称号链或通用 ranks 表中查名；查不到视为无门槛） */
function rankIndexOf(name?: string): number | null {
  if (!name) return null;
  for (const k in WB.classes) {
    const p = WB.classes[k].path;
    if (p) {
      const i = p.indexOf(name);
      if (i >= 0) return i + 1;
    }
  }
  /* 卡 R2：ranks 由字符串数组升级为六阶对象数组（§29），这里同步取 name */
  const i = WB.ranks.findIndex((r) => r.name === name);
  return i >= 0 ? i + 1 : null;
}

/** 首年实缴学费（s101：帝国圣学院有 30% 奖学金） */
export function tuitionDue(defId: string, s: WorldState = need()): number {
  const def = academyById(defId);
  if (!def) return 0;
  const sch = def.entryReq.scholarship;
  if (!sch || !sch.rate) return def.tuition;
  const need = sch.needStat || {};
  for (const k in need) if ((s.player.stats[k as StatName] || 10) < need[k]) return def.tuition;
  return Math.max(0, Math.round(def.tuition * (1 - sch.rate)));
}

/* ============================================================
   卡 L2 · §101「入学要求」的另外三条
   此前 enrollCheck 只做金币/境界/种族三项（enrollNote 自己也这么写着），
   而 s101 的入学要求是四条：年龄 · 资质测试 · 出身 · 学费与寒门通道。
   —— 年龄取自卡 L1（同一个 birthTick 派生，不与寿数分家）；
   —— 资质三选一取**最高**轴（一门通即可入，正合「三选一」）；
   —— 寒门通道按势力声望开门，垫付的那部分记成一笔待偿的账。
   ============================================================ */

/** §101 寒门通道的一行（数据在 academy.json.entry.aid） */
export interface AidRow {
  id: string;
  name: string;
  faction: string;
  rep: number;
  cover: number;
  debt: boolean;
  payback?: 'coin' | 'service';
  serviceYears?: number;
  servicePay?: number;
  note?: string;
}

/** §101 年龄区间（12-25 岁）。学院可在 entryReq 覆写——数据留了这个口子，缺省走全局 */
export function ageGate(def: AcademyDef, s: WorldState = need()): { ok: boolean; age: number; min: number; max: number } {
  const age = ageOf(s);
  const min = def.entryReq.ageMin ?? CFG.entry.ageMin;
  const max = def.entryReq.ageMax ?? CFG.entry.ageMax;
  return { ok: age >= min && age <= max, age, min, max };
}

/** §101 资质三选一：本院候选属性轴里取最高者与会门槛（学院可按 s100 专长收窄候选轴） */
export function aptitudeGate(def: AcademyDef, s: WorldState = need()): { ok: boolean; best: StatName; bestV: number; min: number } {
  const axes = def.entryReq.aptitude ?? CFG.entry.aptitude.stats;
  const min = def.entryReq.aptitudeMin ?? CFG.entry.aptitude.min;
  let best: StatName = axes[0];
  let bestV = -1;
  for (const k of axes) {
    const v = s.player.stats[k] || 0;
    if (v > bestV) {
      bestV = v;
      best = k;
    }
  }
  return { ok: bestV >= min, best, bestV, min };
}

/** §101 寒门通道：按势力声望取第一条可用的资助（同一时刻只用一条）。学费为 0 的学院不资助 */
export function aidFor(defId: string, s: WorldState = need()): AidRow | null {
  const def = academyById(defId);
  if (!def || def.tuition <= 0) return null;
  for (const aid of CFG.entry.aid) {
    if ((s.rep[aid.faction] || 0) >= aid.rep) return aid;
  }
  return null;
}

/** 实缴与待偿：奖学金（学院字段）先行，寒门通道（势力声望）在其后再垫 */
export function payableDue(defId: string, s: WorldState = need()): { pay: number; owe: number; aid: AidRow | null; base: number } {
  const base = tuitionDue(defId, s);
  const aid = aidFor(defId, s);
  if (!aid || base <= 0) return { pay: base, owe: 0, aid: null, base };
  const covered = Math.round(base * aid.cover);
  return { pay: base - covered, owe: aid.debt ? covered : 0, aid, base };
}

/** 入学前置检查的返回（五档判定 + 本次可用的资助） */
export interface EnrollGate {
  ok: boolean;
  reason: string;
  /** 实缴（奖学金与寒门通道之后） */
  due: number;
  /** 待偿（寒门通道垫付的部分） */
  owe: number;
  aid: AidRow | null;
}

/** 入学前置检查（纯函数，供 enroll / 菜单 / 面板共用） */
export function enrollCheck(defId: string, s: WorldState = need()): EnrollGate {
  const def = academyById(defId);
  if (!def) return { ok: false, reason: '没有这所学院', due: 0, owe: 0, aid: null };
  const a = ensureAcademy(s);
  const pd = payableDue(defId, s);
  const no = (reason: string): EnrollGate => ({ ok: false, reason, due: pd.pay, owe: pd.owe, aid: pd.aid });
  if (a.enrolled === def.id) return no('在读');
  if ((a.graduated || []).includes(def.id)) return no('已毕业');
  if (a.enrolled) {
    const cur = academyById(a.enrolled);
    return no('学籍已在' + (cur ? cur.name : a.enrolled));
  }
  /* 卡 L2 · §101 入学要求①：年龄 12-25 岁 */
  const ag = ageGate(def, s);
  if (!ag.ok) {
    return no('年龄不符（' + Math.floor(ag.age) + ' 岁——' + def.name + '收 ' + ag.min + '–' + ag.max + ' 岁）');
  }
  /* 卡 L2 · §101 入学要求②：资质测试（候选轴里最高的一项达门槛即可） */
  const ap = aptitudeGate(def, s);
  if (!ap.ok) {
    const axes = (def.entryReq.aptitude ?? CFG.entry.aptitude.stats).join('/');
    return no('资质未过（' + axes + ' 中至少一项需达 ' + ap.min + '，你最高的是 ' + ap.best + ' ' + ap.bestV + '）');
  }
  const needLv = rankIndexOf(def.entryReq.rank);
  if (needLv !== null && s.player.level < needLv) {
    /* 卡 R2：门槛比对与提示都用**通用境界名**（§29 六阶）。原来这里显示 rankName——
       那是职业链称号（如「剑士」），玩家会看到「需『正式』以上，现为『剑士』」这种
       不可比对的话，既看不懂也判断不出差多少。 */
    return no('境界不足（需「' + def.entryReq.rank + '」以上，现为「' + rankTierName(s) + '」）');
  }
  if (def.entryReq.race && s.player.race !== def.entryReq.race) {
    const rn = WB.races[def.entryReq.race]?.name || def.entryReq.race;
    return no('种族不符（' + def.name + '仅收' + rn + '）');
  }
  if (s.player.gold < pd.pay) return no('学费不足（需 ' + formatMoney(pd.pay) + '）');
  return { ok: true, reason: '', due: pd.pay, owe: pd.owe, aid: pd.aid };
}

/* ---------------- 入学 ---------------- */

export function enroll(academyId: string): boolean {
  const s = core.S;
  if (!s) return false;
  const a = ensureAcademy(s);
  const def = academyById(academyId);
  if (!def) {
    toast('没有这所学院。', 'bad');
    return false;
  }
  const gate = enrollCheck(academyId, s);
  if (!gate.ok) {
    toast('入学被拒：' + gate.reason, 'bad');
    return false;
  }
  if (gate.due) gainGold(-gate.due);
  /* 卡 L2 · §101 寒门通道：垫付的那部分记成一笔待偿的账（毕业时结算） */
  if (gate.owe > 0 && gate.aid) {
    a.debt = (a.debt ?? 0) + gate.owe;
    a.debtFrom = gate.aid.id;
    log('学费由「' + gate.aid.name + '」垫付了 ' + formatMoney(gate.owe) + '——这笔账记在你名下，毕业前须还清。', 'sys', s);
  }
  a.enrolled = def.id;
  a.course = def.curriculum[0]?.courseId;
  a.progress = 0;
  a.startedAt = s.t;
  a.term = 1;
  a.failed = 0;
  log(
    '你在' +
      (WB.locations[s.player.loc]?.name || '公会') +
      '的柜台前按下手印——' + def.name + '（' + def.continent + '·' + def.city + '）的学籍册上多了你的名字。' +
      def.years + ' 年制·' + def.specialty + '，学费每年 ' + formatMoney(def.tuition) + '。',
    'gain',
    s,
  );
  log('（' + CFG.paths.length + ' 条培养路径中，你选了最系统的学院制：入学 → 学习 → 毕业 → 实战。）', 'sys', s);
  addRep('study', 1);
  addHistory('入学 · ' + def.name, def.path + '·' + def.years + '年制', 3);
  toast('✦ 入学：' + def.name, 'gain');
  sync();
  return true;
}

/* ---------------- 修业 ---------------- */

function awardSkill(id: string): void {
  const s = core.S;
  if (!s || !id || !WB.skills[id] || s.player.skills.includes(id)) return;
  s.player.skills.push(id);
  toast('习得技能：' + WB.skills[id].name, 'gain');
}

function nextCourse(def: AcademyDef, a: AcademyState): CourseDef | null {
  return def.curriculum.find((c) => !a.completed.includes(c.courseId)) || null;
}

export function study(courseId?: string): void {
  const s = core.S;
  if (!s) return;
  const a = ensureAcademy(s);
  const def = academyById(a.enrolled);
  if (!def) {
    toast('你尚未入学——先在学院名录里报名。', 'bad');
    return;
  }
  if (courseId) {
    const pick = def.curriculum.find((c) => c.courseId === courseId);
    if (!pick) {
      toast('这所学院没有这门课。', 'bad');
      return;
    }
    if (a.completed.includes(courseId)) {
      toast('这门课已经结业了。', '');
      return;
    }
    if (a.course !== courseId) {
      a.course = courseId;
      a.progress = 0;
      log('你重新排了课表——这一学期主修「' + pick.name + '」。', 'sys', s);
    }
  }
  if (!a.course) a.course = nextCourse(def, a)?.courseId;
  const cur = def.curriculum.find((c) => c.courseId === a.course);
  if (!cur) {
    toast('课程已全部修完——去申请毕业吧。', 'gain');
    return;
  }
  if (s.player.gold < cur.goldCost) {
    toast('修业费不足（需 ' + formatMoney(cur.goldCost) + '）', 'bad');
    return;
  }
  if (cur.goldCost) gainGold(-cur.goldCost);
  advance(CFG.terms.studyTicks); // 一个学期（1440 刻 = 30 日）的修业
  a.term = termOf(s, a);
  const stat = (cur.stat || CFG.exam.stat) as StatName;
  const dc = cur.dc ?? CFG.exam.baseDc + CFG.exam.perCourseDc * Math.max(0, def.curriculum.indexOf(cur));
  check(
    '学院考核 · ' + cur.name,
    stat,
    dc,
    (r) => {
      const ac = ensureAcademy(core.S!);
      if (r.ok) {
        ac.progress += CFG.terms.studyTicks;
        if (ac.progress >= cur.duration) {
          if (!ac.completed.includes(cur.courseId)) ac.completed.push(cur.courseId);
          ac.progress = 0;
          for (const sk of cur.skills) awardSkill(sk);
          log('考核通过。' + cur.name + ' 结业——教习在你的名册上画了一道横线。', 'gain', core.S!);
          toast('结业：' + cur.name, 'gain');
          const nxt = nextCourse(def, ac);
          if (nxt) {
            ac.course = nxt.courseId;
            toast('下一门：' + nxt.name, '');
          } else {
            ac.course = undefined;
            toast('全部课程修完——可以申请毕业了。', 'gain');
          }
        } else {
          log('考核通过。' + cur.name + ' 又推进了一学期（' + ac.progress + ' / ' + cur.duration + ' 刻）。', 'gain', core.S!);
        }
      } else {
        ac.failed = (ac.failed || 0) + 1;
        if (CFG.exam.failExp) gainExp(-CFG.exam.failExp);
        if (CFG.exam.failExpGain) gainExp(CFG.exam.failExpGain);
        log('考核失利——教习把卷子推回来：「重读这一章，下个学期再来。」（挂科 ' + ac.failed + ' 次）', 'bad', core.S!);
      }
      sync();
    },
    '（' + def.name + '·第 ' + cur.year + ' 年·DC ' + dc + '）',
  );
}

/* ---------------- 毕业 ---------------- */

/** 当前学位（按已结业课程刻数 / 学制总刻数 取 s101 四学位） */
export function degreeOf(defId: string, s: WorldState = need()): { name: string; equiv: string; career: string } | null {
  const def = academyById(defId);
  if (!def) return null;
  const a = ensureAcademy(s);
  const total = def.curriculum.reduce((n, c) => n + c.duration, 0) || 1;
  const done = a.completed.reduce((n, id) => {
    const c = def.curriculum.find((x) => x.courseId === id);
    return n + (c ? c.duration : 0);
  }, 0);
  const ratio = done / total;
  const ds = CFG.terms.degrees;
  let pick = ds[0];
  for (const d of ds) if (ratio >= d.atRatio - 1e-9) pick = d;
  return { name: pick.name, equiv: pick.equiv, career: pick.career };
}

export function canGraduate(s: WorldState = need()): { ok: boolean; reason: string } {
  const a = ensureAcademy(s);
  const def = academyById(a.enrolled);
  if (!def) return { ok: false, reason: '未在学' };
  const left = def.curriculum.filter((c) => !a.completed.includes(c.courseId));
  if (left.length) return { ok: false, reason: '尚有 ' + left.length + ' 门课程未结业' };
  const need = minTicksOf(def);
  const el = elapsedOf(s, a);
  if (el < need) {
    return { ok: false, reason: '学制未满（' + def.years + ' 年 = ' + need + ' 刻，已修 ' + el + ' 刻）' };
  }
  return { ok: true, reason: '' };
}

export function graduate(): boolean {
  const s = core.S;
  if (!s) return false;
  const a = ensureAcademy(s);
  const def = academyById(a.enrolled);
  if (!def) {
    toast('你尚未入学。', 'bad');
    return false;
  }
  const gate = canGraduate(s);
  if (!gate.ok) {
    toast('暂不能毕业：' + gate.reason, 'bad');
    return false;
  }
  const deg = degreeOf(def.id, s);
  const title = def.name + '·' + (def.graduateReward.title || (deg ? deg.name : '学士'));
  for (const sk of def.graduateReward.skills) awardSkill(sk);
  if (!a.titles.includes(title)) a.titles.push(title);
  if (!(a.graduated || []).includes(def.id)) (a.graduated || []).push(def.id);
  gainExp(120 * def.years);
  a.enrolled = undefined;
  a.course = undefined;
  a.progress = 0;
  a.term = 1;
  log(
    '答辩那天下着' + s.weather + '。你念完最后一段，台下的教习们沉默了片刻——然后有人先鼓了掌。' +
      def.name + ' 院长把一枚刻着院徽的铜牌按进你手心：「' + title + '。」',
    'gain',
    s,
  );
  log('（s101 学位：' + (deg ? deg.name + '　相当于' + deg.equiv + '　可就职：' + deg.career : def.graduateReward.title) + '）', 'sys', s);
  /* 卡 L2/G3：寒门通道垫的那笔账在此结算——按当初约定的方式还。
     公会代偿是生意，还钱；神殿预备役与军工定向不是借款，用人还（§101 的「资助」与「服役抵扣」）。 */
  if (a.debt && a.debt > 0) {
    const owed = a.debt;
    const aid = CFG.entry.aid.find((x) => x.id === a.debtFrom);
    const who = aid?.name ?? '垫付人';
    if (aid?.payback === 'service') {
      const years = aid.serviceYears ?? 2;
      a.service = {
        aid: aid.id,
        faction: aid.faction,
        years,
        startedAt: s.t,
        until: s.t + years * TICKS_PER_YEAR,
        paidYears: 0,
      };
      a.debt = 0;
      a.debtFrom = undefined;
      log('「' + who + '」垫的那笔钱不用还——按当初立的约，你要替他们做事 ' + years + ' 年。' + formatMoney(owed) + ' 换成的是年岁。', 'sys', s);
    } else if (s.player.gold >= owed) {
      gainGold(-owed);
      a.debt = 0;
      a.debtFrom = undefined;
      log('你到「' + who + '」的柜台前把账清了——' + formatMoney(owed) + '，一分不欠。', 'gain', s);
    } else {
      log('「' + who + '」的账房翻出你的名册：还挂着 ' + formatMoney(owed) + '。毕业不等于清账。', 'sys', s);
    }
  }
  addRep('study', 2);
  addHistory('毕业 · ' + def.name, title, 4);
  toast('✦ 毕业：' + title, 'gain');
  sync();
  return true;
}

/* ---------------- 学院导师（验收二 · NPC 独立性） ---------------- */

export interface MentorView extends MentorDef {
  /** true = 世界书尚无此 NPC，需主线在 D1/D2/D3 按本数据播种 */
  pending: boolean;
}

/** 取学院导师。F-27：学院侧只提供定位（loc/role）与院方头衔；
    人设（goal/interest/bottomLine/greet）**单一取自 people.json**——同一 NPC 在学院面板
    与聊天里必须是一个人。NPC 未落世界书时回落到学院数据里的内联人设（中间态兜底）。 */
export function mentorOf(academyId: string): MentorView | null {
  const def = academyById(academyId);
  if (!def || !def.mentor) return null;
  const m = def.mentor;
  const known = WB.npcs[m.npcId];
  return {
    ...m,
    name: known ? known.name : m.name,
    title: m.title || (known ? known.title : ''),
    race: known ? known.race : m.race,
    goal: known?.goal ?? m.goal,
    interest: known?.interest ?? m.interest,
    bottomLine: known?.bottomLine ?? m.bottomLine,
    greet: known?.greet ?? m.greet,
    seeded: m.seeded,
    pending: !known,
  };
}

/** 全导师名录（供主线批量播种 / 面板展示） */
export function allMentors(): MentorView[] {
  return CFG.academies.map((a) => mentorOf(a.id)).filter((m): m is MentorView => !!m);
}

/* ---------------- 演出菜单（ConfirmSheet；动作 key 前缀 ac_） ---------------- */

export function academyCoursesMenu(): void {
  const s = need();
  const a = ensureAcademy(s);
  const def = academyById(a.enrolled);
  if (!def) {
    toast('你尚未入学。', 'bad');
    return;
  }
  const lines = def.curriculum.map(
    (c, i) =>
      (a.completed.includes(c.courseId) ? '✔ ' : c.courseId === a.course ? '▶ ' : '· ') +
      '第 ' + c.year + ' 年 · ' + c.name + '　（' + c.duration + ' 刻 · DC ' + (c.dc ?? CFG.exam.baseDc + CFG.exam.perCourseDc * i) + ' · ' + formatMoney(c.goldCost) + '）',
  );
  confirmSheet('课程表 · ' + def.name, lines.join('<br>') + '<br>' + CFG.terms.stageNamesNote, [
    ...(a.course ? [{ l: '修业当前课程', a: 'ac_study', id: a.course }] : []),
    { l: '（回去）', a: 'ac_menu' },
    { l: '（退开）', a: 'close' },
  ]);
}

/** 学院总菜单（engine 路由：ac_menu / ac_courses / ac_enroll+id / ac_study(+id) / ac_graduate） */
export function academyMenu(): void {
  const s = need();
  const a = ensureAcademy(s);
  const def = academyById(a.enrolled);
  if (!def) {
    const rows = CFG.academies.map((d) => {
      const g = enrollCheck(d.id, s);
      /* 卡 L2：这里显示的是**实缴**（奖学金与寒门通道之后），并标出是谁垫的——
         显示与判定必须同一口径，否则面板说 1000、报名时收 0。 */
      const fee = (g.due ? formatMoney(g.due) + (g.due < d.tuition ? '·奖学金' : '') : '免费') + (g.owe > 0 ? '·' + (g.aid?.name ?? '垫付') : '');
      return {
        l: d.name + '（' + d.continent + '·' + d.city + '｜' + d.years + ' 年｜' + fee + '）' + (g.ok ? ' 可报名' : ' —— ' + g.reason),
        a: 'ac_enroll',
        id: d.id,
        dg: !g.ok,
      };
    });
    confirmSheet(
      '学院名录 · 入学报名',
      '四大培养路径：师徒制（最传统）／学院制（最系统）／神殿制（最权威）／自学·野路（最艰难）。本处为学院制。' +
        '<br>报名经公会与星枢传讯办理，无需亲赴本院；考核与毕业任务赴本院完成。',
      [...rows, { l: '（退开）', a: 'close' }],
    );
    return;
  }
  const cur = def.curriculum.find((c) => c.courseId === a.course) || nextCourse(def, a);
  const deg = degreeOf(def.id, s);
  const gate = canGraduate(s);
  const left = def.curriculum.filter((c) => !a.completed.includes(c.courseId)).length;
  /* 卡 G3：服役中的人要看得见自己的义务还剩几年（§101 寒门通道的另一半） */
  const svc = a.service
    ? '服役：' + (WB.factions[a.service.faction] || a.service.faction) + '　' + Math.max(0, Math.ceil((a.service.until - s.t) / TICKS_PER_YEAR)) + ' 年未满<br>'
    : '';
  const body =
    svc +
    '学籍：' + def.name + '（' + def.path + ' · ' + def.specialty + '）<br>' +
    '学制：' + def.years + ' 年 × ' + CFG.terms.termsPerYear + ' 学期（每学期 ' + CFG.terms.ticksPerTerm + ' 刻）　第 ' + termOf(s, a) + ' 学期在读<br>' +
    '已修刻数：' + elapsedOf(s, a) + ' / ' + minTicksOf(def) + '　·　挂科 ' + (a.failed || 0) + ' 次<br>' +
    '课程：' + a.completed.length + ' / ' + def.curriculum.length + ' 结业' + (left ? '（余 ' + left + ' 门）' : '（全清）') + '<br>' +
    '学位：' + (deg ? deg.name + '（相当于' + deg.equiv + '）' : '—') + '<br>' +
    (cur ? '当前课程：' + cur.name + '（' + a.progress + ' / ' + cur.duration + ' 刻）' : '课程已全部结业');
  const btns: { l: string; a: string; dg?: boolean; id?: string }[] = [];
  if (cur) btns.push({ l: '修业一学期（' + CFG.terms.studyTicks + ' 刻 · ' + formatMoney(cur.goldCost) + '）', a: 'ac_study', id: cur.courseId });
  btns.push({ l: '申请毕业' + (gate.ok ? '' : '（' + gate.reason + '）'), a: 'ac_graduate', dg: !gate.ok });
  btns.push({ l: '查看课程表', a: 'ac_courses' });
  btns.push({ l: '（退开）', a: 'close' });
  confirmSheet('学院 · ' + def.name, body, btns);
}

/* ---------------- 卡 G3 · §101 服役（寒门通道的另一半） ---------------- */

/** 是否仍在服役期 */
export const serviceActive = (s: WorldState = need()): boolean => {
  const a = ensureAcademy(s);
  return !!a.service && s.t < a.service.until;
};

/**
 * 服役日步（挂 daySettle）：按年发军饷并积累该势力声望，期满入册。
 * 它让「服役抵扣」不再只是毕业时的一句台词——那几年是真要过的。
 */
export function serviceTick(s: WorldState): void {
  const a = ensureAcademy(s);
  const svc = a.service;
  if (!svc) return;
  const done = Math.floor(Math.max(0, s.t - svc.startedAt) / TICKS_PER_YEAR);
  if (s.t < svc.until && done > svc.paidYears) {
    svc.paidYears = done;
    const pay = CFG.entry.aid.find((x) => x.id === svc.aid)?.servicePay ?? 3000;
    gainGold(pay);
    addRep(svc.faction, 2);
    log('服役第 ' + done + ' 年——' + (WB.factions[svc.faction] || svc.faction) + '的军饷发了下来（' + formatMoney(pay) + '）。', 'gain', s);
  }
  if (s.t >= svc.until) {
    addRep(svc.faction, 5);
    log('服役期满。' + (WB.factions[svc.faction] || svc.faction) + '的名册上，你那一行后面添了两个字：「已了」。', 'gain', s);
    addHistory('服役期满', (WB.factions[svc.faction] || svc.faction) + '·' + svc.years + ' 年', 3);
    a.service = undefined;
  }
}

/* ---------------- 纯数据视图（供 UI 面板渲染；只读） ---------------- */

export interface AcademyCourseView {
  courseId: string;
  name: string;
  year: number;
  duration: number;
  dc: number;
  stat: string;
  goldCost: number;
  skills: string[];
  skillNames: string[];
  done: boolean;
  current: boolean;
  progress: number;
  ratio: number;
}

export interface AcademyCatalogRow {
  id: string;
  name: string;
  continent: string;
  city: string;
  specialty: string;
  years: number;
  focus: string;
  path: string;
  tuition: number;
  /** 实缴（奖学金与寒门通道之后） */
  due: number;
  /** 待偿（寒门通道垫付的部分） */
  owe: number;
  /** 垫付通道名（owe > 0 时有值） */
  aidName: string | null;
  scholarship: boolean;
  /** 卡 L2 · §101 入学要求：年龄区间 */
  ageMin: number;
  ageMax: number;
  /** 卡 L2 · §101 资质测试：本院候选属性轴与门槛 */
  aptitude: string;
  aptitudeMin: number;
  rankReq: string;
  raceReq: string | null;
  raceName: string | null;
  canEnroll: boolean;
  reason: string;
  enrolled: boolean;
  graduated: boolean;
  mentor: MentorView | null;
}

export interface AcademyView {
  enrolledId: string | null;
  name: string | null;
  focus: string | null;
  path: string | null;
  continent: string | null;
  city: string | null;
  specialty: string | null;
  years: number;
  termsTotal: number;
  term: number;
  ticksPerTerm: number;
  studyTicks: number;
  elapsedTicks: number;
  minTicks: number;
  progress: number;
  currentCourseId: string | null;
  currentCourseName: string | null;
  completedCount: number;
  totalCount: number;
  canGraduateNow: boolean;
  graduateReason: string;
  failed: number;
  titles: string[];
  graduated: string[];
  degree: string | null;
  degreeEquiv: string | null;
  courses: AcademyCourseView[];
  catalog: AcademyCatalogRow[];
  mentor: MentorView | null;
  paths: string[];
  termsNote: string;
  enrollNote: string;
}

export function academyView(s: WorldState = need()): AcademyView {
  const a = ensureAcademy(s);
  const def = academyById(a.enrolled);
  const deg = def ? degreeOf(def.id, s) : null;
  const gate = canGraduate(s);
  const catalog: AcademyCatalogRow[] = CFG.academies.map((d) => {
    const g = enrollCheck(d.id, s);
    return {
      id: d.id,
      name: d.name,
      continent: d.continent,
      city: d.city,
      specialty: d.specialty,
      years: d.years,
      focus: d.focus,
      path: d.path,
      tuition: d.tuition,
      due: g.due,
      owe: g.owe,
      aidName: g.aid?.name ?? null,
      scholarship: g.due < d.tuition,
      ageMin: d.entryReq.ageMin ?? CFG.entry.ageMin,
      ageMax: d.entryReq.ageMax ?? CFG.entry.ageMax,
      aptitude: (d.entryReq.aptitude ?? CFG.entry.aptitude.stats).join('/'),
      aptitudeMin: d.entryReq.aptitudeMin ?? CFG.entry.aptitude.min,
      rankReq: d.entryReq.rank,
      raceReq: d.entryReq.race || null,
      raceName: d.entryReq.race ? WB.races[d.entryReq.race]?.name || d.entryReq.race : null,
      canEnroll: g.ok,
      reason: g.reason,
      enrolled: a.enrolled === d.id,
      graduated: (a.graduated || []).includes(d.id),
      mentor: mentorOf(d.id),
    };
  });
  const courses: AcademyCourseView[] =
    def?.curriculum.map((c, i) => ({
      courseId: c.courseId,
      name: c.name,
      year: c.year,
      duration: c.duration,
      dc: c.dc ?? CFG.exam.baseDc + CFG.exam.perCourseDc * i,
      stat: c.stat || CFG.exam.stat,
      goldCost: c.goldCost,
      skills: c.skills || [],
      skillNames: (c.skills || []).map((k) => WB.skills[k]?.name || k),
      done: a.completed.includes(c.courseId),
      current: a.course === c.courseId,
      progress: a.course === c.courseId ? a.progress : 0,
      ratio: a.completed.includes(c.courseId) ? 1 : a.course === c.courseId ? a.progress / (c.duration || 1) : 0,
    })) || [];
  const cur = courses.find((c) => c.current) || null;
  return {
    enrolledId: def ? def.id : null,
    name: def ? def.name : null,
    focus: def ? def.focus : null,
    path: def ? def.path : null,
    continent: def ? def.continent : null,
    city: def ? def.city : null,
    specialty: def ? def.specialty : null,
    years: def ? def.years : CFG.terms.years,
    termsTotal: def ? def.years * CFG.terms.termsPerYear : 0,
    term: def ? termOf(s, a) : 0,
    ticksPerTerm: CFG.terms.ticksPerTerm,
    studyTicks: CFG.terms.studyTicks,
    elapsedTicks: def ? elapsedOf(s, a) : 0,
    minTicks: def ? minTicksOf(def) : 0,
    progress: a.progress,
    currentCourseId: cur ? cur.courseId : null,
    currentCourseName: cur ? cur.name : null,
    completedCount: a.completed.length,
    totalCount: def ? def.curriculum.length : 0,
    canGraduateNow: gate.ok,
    graduateReason: gate.reason,
    failed: a.failed || 0,
    titles: a.titles.slice(),
    graduated: (a.graduated || []).slice(),
    degree: deg ? deg.name : null,
    degreeEquiv: deg ? deg.equiv : null,
    courses,
    catalog,
    mentor: def ? mentorOf(def.id) : null,
    paths: CFG.paths,
    termsNote: CFG.terms.stageNames.join('　→　'),
    enrollNote: (raw as unknown as { enrollNote: string }).enrollNote || '',
  };
}

/** 学院路径 → 机制归类（focus → 路径名；UI 分组用） */
export function pathOfFocus(focus: string): string {
  return CFG.focusPath[focus] || CFG.paths[0] || '';
}

/** 神殿培养体系（s103）只读表 */
export function templeSchoolsOf(deity?: string): { temple: string; deity: string; direction: string; years: string; entry: string }[] {
  const all = (raw as unknown as { templeSchools: { temple: string; deity: string; direction: string; years: string; entry: string }[] }).templeSchools || [];
  return deity ? all.filter((t) => t.deity === deity) : all;
}

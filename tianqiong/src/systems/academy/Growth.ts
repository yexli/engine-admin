/* ============================================================
   卡 A1 · 四条成长线（世界书 §99/§102/§103）
     学院制（既有 · Academy.ts）/ 师徒制 / 神殿培养 / 自学
   —— 除学院外三条此前只存在于 lore 文本。本模块给它们同一套判定与状态：
     · 拜师 → 随师（每 N 日授一技）→ 出师（授称号）
     · 神殿培养：凭该神偏好入学，出路是信仰阶位与神赐技能
     · 自学：零门槛、耗时间换领悟点（与 R3 的实战领悟同一条出口）
   状态存 s.player.growth（可选域，缺省即未走这三条线，旧档可读）。
   ============================================================ */
import raw from '@/data/world/academy.json';
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { toast } from '@/events/EventBus';
import { addRep, gainExp, gainGold, log } from '@/systems/character/Gains';
import { grantSkill, learnWays } from '@/systems/character/Learn';
import { confirmSheet } from '@/systems/character/Sheet';
import { adjAtt } from '@/systems/npc/Npcs';
import { need } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { addHistory } from '@/events/EventStore';
import { advance } from '@/world/WorldClock';

interface ApprenticeCfg {
  gift: number; giftGraduate: number; minAtt: number; minChats: number;
  minDays: number; teachEvery: number; maxTeaches: number; expPerStudy: number; title: string;
}
interface SelfCfg { ticks: number; insightPerStudy: number; maxPerDay: number; expPerStudy: number }
interface GrowthPathDef {
  id: string; name: string; cycle: string; cost: string;
  pros: string[]; cons: string[]; yields: string[]; entry: Record<string, unknown>; impl: string;
}
const CFG = raw as unknown as { growthPaths?: { paths?: GrowthPathDef[]; apprentice?: ApprenticeCfg; selfStudy?: SelfCfg } };
const PATH_DEFS = CFG.growthPaths?.paths ?? [];
const APPR = CFG.growthPaths?.apprentice ?? {
  gift: 500, giftGraduate: 2000, minAtt: 20, minChats: 4, minDays: 3, teachEvery: 3, maxTeaches: 3, expPerStudy: 12, title: '师门弟子',
};
const SELF = CFG.growthPaths?.selfStudy ?? { ticks: 12, insightPerStudy: 3, maxPerDay: 2, expPerStudy: 6 };

/** 该 NPC 所属的成长路径（导师制走 people.json 的 mentor 身份，这里按 title 判定） */
export const paths = (): GrowthPathDef[] => PATH_DEFS.slice();
export const pathOf = (id: string): GrowthPathDef | undefined => PATH_DEFS.find((p) => p.id === id);

/* ---------------- 师徒制（§102） ---------------- */

export interface MentorCandidate { id: string; name: string; title: string; att: number; note: string; ok: boolean }

/** 可拜的师傅：在场、好感够、还没拜过别人 */
export function mentorCandidates(s: WorldState = need()): MentorCandidate[] {
  const g = s.player.growth;
  return Object.values(WB.npcs)
    .map((n) => ({ id: Object.keys(WB.npcs).find((k) => WB.npcs[k] === n) as string, npc: n }))
    .filter((x) => !!x.id)
    .map((x) => {
      const att = s.npcs[x.id]?.att ?? 0;
      const already = g?.master === x.id;
      return {
        id: x.id,
        name: x.npc.name,
        title: x.npc.title,
        att,
        note: already ? '正在随师' : g?.master ? '你已另有师承' : '可拜',
        ok: !already && !g?.master && att >= APPR.minAtt,
      };
    });
}

/** 拜师：好感 + 拜师礼。一次只能跟一位师傅（§99 的取舍） */
export function apprentice(masterId: string, s: WorldState = need()): boolean {
  if (!WB.npcs[masterId]) { toast('没有这个人。', 'bad'); return false; }
  const g = mutate.playerGrowth();
  if (g.master) { toast('你已拜「' + (WB.npcs[g.master]?.name ?? g.master) + '」为师——一门不事二师。', 'bad'); return false; }
  const att = s.npcs[masterId]?.att ?? 0;
  if (att < APPR.minAtt) {
    toast('对方摇头：「先让我认得你再说。」（好感 ' + att + ' / ' + APPR.minAtt + '）', 'bad');
    return false;
  }
  if (s.player.gold < APPR.gift) { toast('拜师礼要 ' + APPR.gift + ' 铜，你拿不出来。', 'bad'); return false; }
  gainGold(-APPR.gift);
  g.master = masterId;
  g.masterSinceDay = Math.floor(s.t / 48) + 1;
  g.taught = 0;
  g.lastTeachDay = g.masterSinceDay;
  log('你在' + WB.npcs[masterId].name + '面前深深一礼，奉上拜师礼——' + APPR.gift + ' 铜压在托盘上，声音很轻。', 'nar', s);
  addHistory('拜师', WB.npcs[masterId].name, 3);
  return true;
}

/**
 * 随师修业：每 teachEvery 日授一技（师傅只教**你职业线里 mentor 通道可达**的技能）。
 * 返回本次学会的技能 id；无技可教或未到授业日则为 null。
 */
export function masterTick(s: WorldState = need()): string | null {
  const g = s.player.growth;
  if (!g?.master) return null;
  const day = Math.floor(s.t / 48) + 1;
  if (day - (g.lastTeachDay ?? day) < APPR.teachEvery) return null;
  if ((g.taught ?? 0) >= APPR.maxTeaches) {
    toast('师傅说：「我教你的够多了，剩下的得你自己去打。」', '');
    return null;
  }
  const sp = (WB.classes[s.player.cls]?.skillPath ?? []) as string[];
  const pool = sp.filter((id) => learnWays(id).includes('mentor') && !s.player.skills.includes(id));
  if (!pool.length) return null;
  const pick = pool.sort((a, b) => sp.indexOf(a) - sp.indexOf(b))[0];
  g.lastTeachDay = day;
  g.taught = (g.taught ?? 0) + 1;
  grantSkill(pick, 'mentor', s);
  log('师傅把你叫到跟前，手把手过了一遍「' + WB.skills[pick].name + '」的关窍。', 'nar', s);
  gainExp(APPR.expPerStudy);
  return pick;
}

/** 出师：随师满 N 日 + 授业满员 → 授师门称号 + 谢礼 */
export function graduate(s: WorldState = need()): boolean {
  const g = s.player.growth;
  if (!g?.master) { toast('你还没有师承。', 'bad'); return false; }
  const day = Math.floor(s.t / 48) + 1;
  if (day - (g.masterSinceDay ?? day) < APPR.minDays) {
    toast('随师未满 ' + APPR.minDays + ' 日——师傅不会放你走。', 'bad');
    return false;
  }
  if (s.player.gold < APPR.giftGraduate) {
    toast('出师谢礼要 ' + APPR.giftGraduate + ' 铜。', 'bad');
    return false;
  }
  gainGold(-APPR.giftGraduate);
  const name = WB.npcs[g.master]?.name ?? g.master;
  if (!s.titles) s.titles = [];
  if (!s.titles.includes('ti_apprentice')) s.titles.push('ti_apprentice');
  adjAtt(g.master, 15, '出师');
  addRep('guild', 5);
  log('你向' + name + '辞行。他把你送到门口，只说了一句：「别丢人。」', 'nar', s);
  addHistory('出师', name + '门下', 3);
  g.master = undefined;
  g.graduated = [...(g.graduated ?? []), name];
  return true;
}

/* ---------------- 神殿培养（§103） ---------------- */

/** 可入的神殿学院（按信仰偏好门槛） */
export function templeCandidates(s: WorldState = need()): { name: string; direction: string; years: string; faith: number; ok: boolean }[] {
  const list = (raw as unknown as { templeSchools?: { temple: string; deity: string; direction: string; years: string; entry: string }[] }).templeSchools ?? [];
  /* 偏好直接取 core 的 favor 域（Deity.ts 的唯一来源）；神殿名与神明名的对应关系
     由 academy.json 的 templeSchools 给出，这里只做「门槛够不够」的判定。 */
  return list.map((t) => {
    const faith = (s.favor as Record<string, { favor?: number }> | undefined)?.[t.deity]?.favor ?? 0;
    return { name: t.temple, direction: t.direction, years: t.years, faith, ok: faith >= 20 };
  });
}

/** 入神殿修业（写进 growth，服事即修行） */
export function templeEnroll(templeName: string, s: WorldState = need()): boolean {
  const c = templeCandidates(s).find((x) => x.name === templeName);
  if (!c) { toast('没有这所神殿学院。', 'bad'); return false; }
  if (!c.ok) { toast(c.name + '不收香火未足之人（偏好 ' + Math.round(c.faith) + ' / 20）。', 'bad'); return false; }
  const g = mutate.playerGrowth();
  g.temple = templeName;
  log('你在' + templeName + '按下手印，领了一身素袍——服事即修行。', 'nar', s);
  addHistory('入神殿修业', templeName, 3);
  return true;
}

/* ---------------- 自学（§99 第四条路） ---------------- */

/** 自学：耗时换领悟点（与 R3 的实战领悟同一条出口）。每日上限 maxPerDay。 */
export function selfStudy(s: WorldState = need()): boolean {
  const g = mutate.playerGrowth();
  const day = Math.floor(s.t / 48) + 1;
  if (g.selfDay !== day) { g.selfDay = day; g.selfCount = 0; }
  if ((g.selfCount ?? 0) >= SELF.maxPerDay) {
    toast('今日已经读够了——脑子也需要时间把东西沉淀下去。', 'bad');
    return false;
  }
  advance(SELF.ticks);
  g.selfCount = (g.selfCount ?? 0) + 1;
  if (!s.insight) s.insight = { pts: 0, learned: [] };
  s.insight.pts += SELF.insightPerStudy;
  gainExp(SELF.expPerStudy);
  log('你把书翻到折角那一页，重头又推了一遍——有些地方开始通了。', 'nar', s);
  return true;
}

/* ---------------- 视图（供面板直读） ---------------- */

/**
 * 成长线菜单（卡 A1 · UI 入口）。
 * 复用既有的 confirmSheet，不新增 React 组件——四条路径摊开给玩家看，
 * 可当场执行的（自学）直接给按钮；需要对象的（拜师/入神殿）给出条件与去处。
 * 「让玩家看得见取舍」本身就是 §99 路径对比表的用途。
 */
export function growthMenu(s: WorldState = need()): void {
  const v = growthView(s);
  const lines = v.paths.map((p) =>
    '<b>' + p.name + '</b>（' + p.cycle + '）<br>' +
    '<span style="opacity:.75">费：' + p.cost + '</span><br>' +
    '<span style="color:var(--jade)">利：' + p.pros.join('／') + '</span><br>' +
    '<span style="color:var(--crimson)">弊：' + p.cons.join('／') + '</span>',
  ).join('<br><br>');
  const mine = v.master
    ? '<br><br>当前师承：' + v.master.name + '（已受 ' + v.master.taught + '/' + v.master.maxTeaches + ' 技）'
    : v.temple
      ? '<br><br>修业中：' + v.temple
      : '<br><br>你现在只靠着一条路——（学院制在「培养学院」页）';
  confirmSheet('成长 · 四条路', lines + mine + '<br><br>今日自学 ' + v.selfToday + '/' + v.selfMax + ' 次', [
    { l: '自学一次（耗 12 刻）', a: 'growth_self' },
    { l: '（返回）', a: 'close' },
  ]);
}

export interface GrowthView {
  paths: GrowthPathDef[];
  master: { id: string; name: string; sinceDay: number; taught: number; maxTeaches: number } | null;
  temple: string | null;
  selfToday: number;
  selfMax: number;
  candidates: MentorCandidate[];
  temples: { name: string; direction: string; years: string; faith: number; ok: boolean }[];
}

export function growthView(s: WorldState = need()): GrowthView {
  const g = s.player.growth ?? {};
  const day = Math.floor(s.t / 48) + 1;
  return {
    paths: paths(),
    master: g.master
      ? { id: g.master, name: WB.npcs[g.master]?.name ?? g.master, sinceDay: g.masterSinceDay ?? day, taught: g.taught ?? 0, maxTeaches: APPR.maxTeaches }
      : null,
    temple: g.temple ?? null,
    selfToday: g.selfDay === day ? (g.selfCount ?? 0) : 0,
    selfMax: SELF.maxPerDay,
    candidates: mentorCandidates(s),
    temples: templeCandidates(s),
  };
}

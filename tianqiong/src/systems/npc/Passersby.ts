/* ============================================================
   当日路人（卡 H3 · 城中人流）

   背景：观察环境时会偶遇一名路人，由命名生成器署名。此前每次观察都现生成一个
   新名字，于是同一条街上连点三次会「看见」三个陌生人；更要命的是文本把路人
   写成了能搭话的对象，而 passerby() 刻意不建 NpcDynamic——搭话必定落空，
   叙事许诺了机制兑现不了的东西。

   这一层补三件事：
     · 名单按 (地点, 日期) 稳定：同一天在同一个地方反复观察，看到的是同一批人，
       街道因此有记忆（「又是那个兽人」）；
     · 每地点每日有上限：观察是高频动作，不设上限会刷成走马灯；
     · 兜底查询：玩家问起今天见过的名字时找得到人——能搭一句话，仅此一句。

   刻意**只放内存、不进存档**：这是当日的氛围数据，存进档里只会徒增迁移负担。
   跨天自然失效（day 变了就重建），读档同理。
   ============================================================ */
import { rng } from '@/events/EventBus';
import { passerby, type Passerby } from '@/systems/npc/Npcs';

/** 每地点每日能偶遇的路人上限 */
export const MEET_CAP = 2;

/** 名单：每地点 3–5 人，按 (loc, day) 缓存 */
const roster = new Map<string, Passerby[]>();
/** 当日已偶遇次数，按 (loc, day) */
const met = new Map<string, number>();
let curDay = -1;

const key = (loc: string, day: number): string => loc + '#' + day;

/** 换天即失效：名单与计数一起重建 */
function rollDay(day: number): void {
  if (day === curDay) return;
  curDay = day;
  roster.clear();
  met.clear();
}

/** 当日该地点的常客名单（同一天同一地点稳定；首次调用时生成） */
export function passersbyAt(loc: string, day: number): Passerby[] {
  rollDay(day);
  const k = key(loc, day);
  let list = roster.get(k);
  if (!list) {
    const n = rng.pick([3, 3, 4, 4, 5]);
    list = Array.from({ length: n }, () => passerby());
    roster.set(k, list);
  }
  return list;
}

/** 今天在这里还遇得上人吗（当日上限） */
export function canMeet(loc: string, day: number): boolean {
  rollDay(day);
  return (met.get(key(loc, day)) ?? 0) < MEET_CAP;
}

/** 记一次偶遇 */
export function markMet(loc: string, day: number): void {
  rollDay(day);
  const k = key(loc, day);
  met.set(k, (met.get(k) ?? 0) + 1);
}

/** 今天在这里见过这个名字吗——搭话兜底用 */
export function seenHere(name: string, loc: string, day: number): boolean {
  return passersbyAt(loc, day).some((p) => p.name === name);
}

/**
 * 已生成的名单，**不触发生成**。
 * 给意图解析用：正则通道只扫 WB.npcs，认不出当日路人；这里让它能认出
 * 「今天真见过的人」。没观察过就是空数组——没看见的人不该能指名搭话。
 */
export function knownRoster(loc: string, day: number): Passerby[] {
  rollDay(day);
  return roster.get(key(loc, day)) ?? [];
}

/**
 * 今日此地名单里的第一位，**不触发生成**。
 * 玩家没指名时，搭话落到他身上——但前提是今天真的在这里观察过。
 * 若这里改成「取或生成」，就会出现「你没见过任何人，却找到了某人」。
 */
export function firstPasserby(loc: string, day: number): Passerby | null {
  return knownRoster(loc, day)[0] ?? null;
}

/** 测试钩子：清空当日缓存 */
export function resetPassersby(): void {
  roster.clear();
  met.clear();
  curDay = -1;
}

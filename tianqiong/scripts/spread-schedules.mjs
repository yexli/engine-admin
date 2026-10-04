/* 日程错开：同一份模板作息被多个 NPC 共用时，把他们错开。
 *
 * 背景：outputs/add-schedules.mjs 按「本职地点」批量配作息，于是同地点的 NPC
 * 拿到完全相同的两段（例：6 个神选候选一律 0-4 酒馆 / 4-12 广场「备赛与操练」）。
 * 结果是一整个白天广场上站着 6 个做同一件事的人——位置僵硬、像复制粘贴。
 *
 * 本脚本只做一件事：**在保持地点不变的前提下错开时段与措辞**。
 * 规则（不改人设、不改地点偏好）：
 *   · 白天起点 s1 在该组内轮转 {3,4,5,6} —— 不再一起出现；
 *   · 尾段 s2 轮转 {9,10,11}，练完各自散去，夜里仍回原夜间去处；
 *   · act 按人轮换 2-3 个同义变体，避免六个人同一句话。
 * 段与段必须无缝覆盖 0-12：npcAt 对有日程却落空档的 NPC 返回 null（人凭空消失）。
 * 用法：node scripts/spread-schedules.mjs [--check]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src/data/npc';
const CHECK = process.argv.includes('--check');

const ACT_VARIANTS = {
  plaza: ['备赛与操练', '在广场独自练刀', '与人对练到日头偏西', '在喷泉边调息复盘'],
  market: ['看摊理事', '在摊前理货记账', '与行商议价', '巡视铺面'],
  alley: ['在白日的暗处蛰伏', '盯着巷口的人来人往', '在暗处等消息', '清点这一夜的进项'],
  guild: ['当值接委托', '在柜台后核账', '替人解说委托条目', '整理悬赏板'],
  tavern: ['在酒馆落脚', '靠窗坐着听闲话', '替人赊一杯酒', '同桌的人聊着旧事'],
  gate: ['当值守门', '盘查过路商队', '在城门下避风', '换岗前抽一袋烟'],
  noble: ['门路与应酬', '在府里见客', '赴一场约', '在廊下等人'],
  palace: ['朝会与政务', '在后殿议事', '批阅边报', '候见'],
  shrine: ['守殿', '添灯续香', '替人解签', '在殿前洒扫'],
  default: ['忙着手上的事', '在原地稍作停留', '处理日常', '独自待着'],
};

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name === 'npc.json') out.push(p);
  }
  return out;
}
const actFor = (loc, i) => {
  const key = Object.keys(ACT_VARIANTS).find((k) => (loc || '').includes(k)) || 'default';
  const pool = ACT_VARIANTS[key];
  return pool[i % pool.length];
};

const files = walk(ROOT);
const rows = files.map((f) => ({ f, n: JSON.parse(readFileSync(f, 'utf8')) }));
const groups = new Map();
for (const r of rows) {
  if (!r.n.schedule) continue;
  const k = JSON.stringify(r.n.schedule);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

let touched = 0, groupCount = 0;
for (const [, members] of groups) {
  if (members.length < 2) continue;
  groupCount++;
  members.forEach((m, i) => {
    const sc = m.n.schedule;
    const night = sc[0];
    const day = sc[sc.length - 1];
    const s1 = [3, 4, 5, 6][i % 4];
    const s2 = [9, 10, 11][i % 3];
    const nightLoc = night.loc;
    const dayLoc = day.loc;
    const endLoc = nightLoc;                       // 尾段回到夜间去处
    /* 原有 act 是当时按地点写好的（「占候」「坐镇王帐」…），一律保留；
       变体只用于本次新增的尾段，以及原本就缺 act 的段——不拿兜底文案覆盖原文案。 */
    const keep = (orig, loc, k) => (orig && orig.trim() ? orig : actFor(loc, k));
    if (nightLoc === dayLoc) {
      // 原地不动的那组（如 alley：0-4 alley / 4-12 alley）——拆成「蛰伏 / 活动 / 归位」
      m.n.schedule = [
        { from: 0, to: s1, loc: nightLoc, act: keep(night.act, nightLoc, i) },
        { from: s1, to: s2, loc: dayLoc, act: keep(day.act, dayLoc, i) },
        { from: s2, to: 12, loc: dayLoc, act: actFor(dayLoc, i + 2) },
      ];
    } else {
      m.n.schedule = [
        { from: 0, to: s1, loc: nightLoc, act: keep(night.act, nightLoc, i) },
        { from: s1, to: s2, loc: dayLoc, act: keep(day.act, dayLoc, i) },
        { from: s2, to: 12, loc: endLoc, act: actFor(endLoc, i + 1) },
      ];
    }
    touched++;
  });
}
console.log('档案 ' + rows.length + '，重复日程组 ' + groupCount + '，改写 ' + touched + ' 人');
for (const [, members] of [...groups].filter(([, v]) => v.length > 1).slice(0, 3)) {
  console.log('--- ' + members.map((m) => m.n.name).join('、'));
  for (const m of members) console.log('    ' + m.n.name + ': ' + m.n.schedule.map((g) => g.from + '-' + g.to + ' ' + g.loc + '(' + g.act + ')').join(' → '));
}
if (!CHECK) {
  for (const r of rows) writeFileSync(r.f, JSON.stringify(r.n, null, 2) + '\n', 'utf8');
  console.log('已写回 ' + rows.length + ' 个档案');
} else console.log('(--check 模式，未写盘)');

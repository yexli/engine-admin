/* 作息审计（N-A · 街头作息空档修复的守卫）
 *
 * 背景：npcAt 对有日程却落空档的 NPC 返回 null —— 人凭空消失（玩家在城里找不到他）。
 * 2026-09-27 实测：**街头 15 人全部有空档**（赛琳娜 / 灰烬 / 科兹·幽鸣 一天只有 2 个时辰在场），
 * 而档案侧 109 人被 npcArchive.test.ts 守着，一直是好的。两支队伍两套规矩，街头那支漏了。
 *
 * 判据与 src/systems/npc/Npcs.ts 的 segHit 逐字一致：
 *   有 schedule → 命中段取 loc；无命中 → null（**不回落 hours**）
 *   无 schedule → hours [a,b) 内有值；a > b 表示跨夜环绕
 *
 * 用法：
 *   node scripts/audit-npc-schedule.mjs          # 只报告
 *   node scripts/audit-npc-schedule.mjs --strict # 有空档/越界即以非 0 退出（给 CI 用）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const STRICT = process.argv.includes('--strict');
const NPC_ROOT = 'src/data/npc';
const PEOPLE = 'src/data/world/people.json';
const CHEN = 12; // 一日十二时辰（WorldClock.shichenOf 的取值域）

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e === 'npc.json') out.push(p);
  }
  return out;
}

const rows = [];
for (const f of walk(NPC_ROOT)) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  rows.push({ id: d.id, name: d.name, schedule: d.schedule, hours: d.hours, loc: d.loc, src: f, board: 'archive' });
}
const people = JSON.parse(readFileSync(PEOPLE, 'utf8'));
for (const [id, v] of Object.entries(people.npcs || {})) {
  rows.push({ id, name: v.name, schedule: v.schedule, hours: v.hours, loc: v.loc, src: PEOPLE, board: 'street' });
}

function atLoc(n, h) {
  if (n.schedule) {
    for (const g of n.schedule) {
      if (g.from <= g.to) {
        if (h >= g.from && h < g.to) return g.loc;
      } else if (h >= g.from || h < g.to) return g.loc;
    }
    return null;
  }
  const [a, b] = n.hours || [];
  if (a <= b) return h >= a && h < b ? n.loc : null;
  return h >= a || h < b ? n.loc : null;
}

let holes = 0;
let outOfRange = 0;
const perBoard = new Map();
for (const n of rows) {
  const miss = [];
  for (let h = 0; h < CHEN; h++) if (!atLoc(n, h)) miss.push(h);
  if (miss.length) {
    holes++;
    console.log('[空档] ' + n.board + ' ' + n.id + '（' + n.name + '）不在场：' + miss.join(',') + ' 时');
  }
  for (const g of n.schedule || []) {
    if (!Number.isInteger(g.from) || !Number.isInteger(g.to) || g.from < 0 || g.to > CHEN || g.from === g.to) {
      outOfRange++;
      console.log('[越界] ' + n.id + ' 段 ' + g.from + '-' + g.to + '（取值域 0..' + CHEN + '）');
    }
  }
  const b = perBoard.get(n.board) || { n: 0, visible: 0 };
  b.n++;
  b.visible += CHEN - miss.length;
  perBoard.set(n.board, b);
}
for (const [board, b] of perBoard) {
  console.log(board + '：' + b.n + ' 人，可见度 ' + b.visible + '/' + b.n * CHEN + '（' + Math.round((100 * b.visible) / (b.n * CHEN)) + '%）');
}
console.log('总计 ' + rows.length + ' 人；空档 ' + holes + ' 人；越界段 ' + outOfRange + ' 条');
if (STRICT && (holes || outOfRange)) process.exit(1);

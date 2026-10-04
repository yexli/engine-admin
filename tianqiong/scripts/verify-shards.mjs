/* 真机验证（规模化 Phase 6 / 存档分片 / Phase 4 位置去物化）：
   Q1 浏览器分片写入：开局后四片齐备，主档里**没有 npcs**（这就是分片格式的标记）
   Q2 玩法交互确实写进 npcs/mind 分片（不是「只在内存里热闹」）
   Q3 位置去物化：npcAt 随时辰实时变化，且**查询不写存档**
   Q4 新标签页（sessionStorage 为空）从分片档恢复：标题屏认得出存档，继续后世界完整
   运行：node scripts/verify-shards.mjs <devUrl>   （需 npm run dev 常驻） */
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:5273/';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 120)));

const fails = [];
const ok = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + detail : ''));
  if (!cond) fails.push(name);
};

/* 写入拦截必须早于页面脚本：否则开局那几笔分片写就漏记了 */
await page.addInitScript(() => {
  const w = window;
  w.__writes = [];
  /* 扫描脚本走 scripts-node 的 globals（没有 Storage / getComputedStyle，见 project_memory 踩坑 6）：
     注入脚本里一律走 window. 前缀，既过 lint 也表明「这是页面里的东西」。
     注意别用 /* eslint 开头写注释——那是 eslint 的内联配置指令，会被当成 JSON 解析。 */
  const orig = window.Storage.prototype.setItem;
  window.Storage.prototype.setItem = function (k, v) {
    if (String(k).indexOf('tq2_') === 0) w.__writes.push(String(k));
    return orig.call(this, k, v);
  };
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__tq, null, { timeout: 20000 });
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '分片员', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(600); // 落盘走 100ms 尾节流

/* ---------- Q1 分片布局 ---------- */
const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.indexOf('tq2_') === 0).sort());
/* 主档独立成 tq2_main_v1：tq2_world_v1 是旧整档的键，四片写全之后会被清掉当回落源退休 */
ok('Q1a 四个分片键齐备', ['tq2_know_v1', 'tq2_main_v1', 'tq2_mind_v1', 'tq2_npcs_v1'].every((k) => keys.includes(k)), keys.join(','));
const mainShape = await page.evaluate(() => {
  const m = JSON.parse(localStorage.getItem('tq2_main_v1'));
  return { hasNpcs: 'npcs' in m, hasMem: 'memories' in m, hasPlayer: !!m.player, name: m.player && m.player.name };
});
ok('Q1b 主档里没有 npcs（分片格式的标记）', mainShape.hasNpcs === false && mainShape.hasMem === false, JSON.stringify(mainShape));
ok('Q1c 主档仍带玩家数据', mainShape.hasPlayer === true && mainShape.name === '分片员', mainShape.name);

/* ---------- Q2 玩法交互真的写进分片 ---------- */
await page.evaluate(() => {
  window.__writes.length = 0;
});
const chip = page.locator('.npc-chip').first();
const hadChip = (await chip.count()) > 0;
if (hadChip) {
  await chip.click();
  await page.waitForTimeout(700);
}
const w2 = await page.evaluate(() => Array.from(new Set(window.__writes)));
ok('Q2a 交互确实触发了落盘', w2.length > 0, 'chip=' + hadChip + ' writes=' + w2.join(','));
/* 打开聊天窗只做了一件事：把 mia 投影进 npcs。于是只有 npcs 分片被写——
   这一条正是分片存在的理由，比「写了一大堆」更有说服力。 */
ok('Q2b 只改 npcs 就只写 npcs', w2.length === 1 && w2[0] === 'tq2_npcs_v1', w2.join(','));
ok('Q2c 不是「每次全写」', w2.length < 4, w2.join(','));

/* ---------- Q3 位置去物化 ---------- */
await page.evaluate(() => {
  window.__writes.length = 0;
});
const locA = await page.evaluate(async () => {
  const { npcAt, npcCurLoc } = await import('/src/systems/npc/Npcs.ts');
  const s = window.__tq.core.S;
  s.t = 4 * 4; // h=4：莉塔在酒馆
  return { at: npcAt('lita', s), cur: npcCurLoc('lita', s) };
});
const locB = await page.evaluate(async () => {
  const { npcAt, npcCurLoc } = await import('/src/systems/npc/Npcs.ts');
  const s = window.__tq.core.S;
  s.t = 1 * 4; // h=1：清早采买
  return { at: npcAt('lita', s), cur: npcCurLoc('lita', s) };
});
ok('Q3a 位置随时辰实时变化，无需任何 tick', locA.at === 'tavern' && locB.at === 'market', locA.at + ' → ' + locB.at);
ok('Q3b npcCurLoc 与 npcAt 同源', locA.cur === locA.at && locB.cur === locB.at, locA.cur + '/' + locB.cur);
const w3 = await page.evaluate(() => Array.from(new Set(window.__writes)));
ok('Q3c 查询位置是只读的（没有触发任何落盘）', w3.length === 0, w3.join(','));

/* ---------- Q4 新标签页从分片档恢复 ---------- */
const beforeNpcs = await page.evaluate(() => JSON.stringify(window.__tq.core.S.npcs));
const page2 = await ctx.newPage();
page2.on('pageerror', (e) => errors.push('p2:' + String(e.message).slice(0, 120)));
await page2.goto(url, { waitUntil: 'networkidle' });
await page2.waitForFunction(() => !!window.__tq, null, { timeout: 20000 });
const continueVisible = await page2.getByText('继续旅程').count();
const continueEnabled = await page2.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const b = btns.find((x) => x.textContent && x.textContent.indexOf('继续旅程') >= 0);
  return !!b && Number(window.getComputedStyle(b).opacity) > 0.9;
});
ok('Q4a 新标签页认得出存档（分片档被 load() 组装出来了）', continueVisible > 0 && continueEnabled, 'visible=' + continueVisible + ' enabled=' + continueEnabled);
await page2.getByText('继续旅程').click();
await page2.waitForTimeout(700);
const restored = await page2.evaluate(() => {
  const S = window.__tq.core.S;
  return S ? { name: S.player.name, npcs: JSON.stringify(S.npcs), memKeys: Object.keys(S.memories || {}).length } : null;
});
ok('Q4b 继续后世界恢复（含分片表）', !!restored && restored.name === '分片员', JSON.stringify(restored && { name: restored.name, memKeys: restored.memKeys }));
ok('Q4c npcs 分片原样读回', !!restored && restored.npcs === beforeNpcs, restored ? restored.npcs.slice(0, 60) : 'null');

ok('Q5 无页面异常', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(fails.length ? '\nFAILED: ' + fails.join(' / ') : '\nALL PASS');
process.exit(fails.length ? 1 : 0);

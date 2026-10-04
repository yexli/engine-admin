/* 真机验证（F-07 星渊之门虚拟入口）：DEV 桥 + 真实按钮点击 → 层状态断言。
   运行：node scripts/verify-abyss-gate.mjs <devUrl> */
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:5273/';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push('console: ' + m.text());
});

const fails = [];
const ok = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + detail : ''));
  if (!cond) fails.push(name);
};

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__tq, null, { timeout: 20000 });
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '验证员', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(300);

/* 置星渊解锁前置：leak 拉满 + H2 链旗标 + 已抵 80 层 */
await page.evaluate(() => {
  const S = window.__tq.core.S;
  S.abyss = { leak: 5, sealed: 0 };
  S.player.flags.leak_3 = true;
  S.player.flags.star6_unlocked = true;
  S.dungeon = { floor: 0, best: 80, inRun: false, cleared: [], escapes: 0 };
});
await page.evaluate(() => window.__tq.dispatch({ type: 'ui', a: 'abyss_menu', p: {} }));
await page.waitForTimeout(300);
const hasBtn = await page.getByText('踏入星渊之门').count();
ok('星渊菜单出现「踏入星渊之门」入口', hasBtn > 0, 'count=' + hasBtn);

await page.getByText('踏入星渊之门').first().click();
await page.waitForTimeout(400);
const entered = await page.evaluate(() => {
  const d = window.__tq.core.S.dungeon;
  return { inRun: d.inRun, floor: d.floor, entry: d.entry };
});
ok('点击后进入层中且自 80 层切入', entered.inRun === true && entered.floor === 80 && entered.entry === 'star6', JSON.stringify(entered));

/* 进入后不被"人不在入口地点"的自愈踢出（F-07 核心） */
await page.evaluate(() => window.__tq.dispatch({ type: 'ui', a: 'dungeon_menu', p: {} }));
await page.waitForTimeout(300);
const still = await page.evaluate(() => {
  const d = window.__tq.core.S.dungeon;
  return { inRun: d.inRun, floor: d.floor };
});
ok('层中状态稳定（未被误自愈）', still.inRun === true && still.floor === 80, JSON.stringify(still));

await page.getByText('下潜至第 81 层').first().click();
await page.waitForTimeout(500);
const descended = await page.evaluate(() => window.__tq.core.S.dungeon.floor);
ok('下潜推进到第 81 层', descended === 81, 'floor=' + descended);

console.log('ERRORS ' + (errors.length ? JSON.stringify(errors) : 'none'));
console.log(fails.length ? 'RESULT FAIL ' + JSON.stringify(fails) : 'RESULT ALL-PASS');
await browser.close();
process.exit(fails.length ? 1 : 0);

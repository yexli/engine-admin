/* 真机验证（批次三）：
   F-13 渲染期随机叙事被缓存（输入不再重掷文案）
   F-15 地下城 HUD 不再遮挡移动端标签栏
   F-16 H6 子面板跨 reset 复位
   运行：node scripts/verify-batch3.mjs <devUrl> */
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
await page.waitForTimeout(400);

/* F-13：敲 10 个字符，叙事必须一字不变 */
const nar0 = await page.locator('.scene > .nar').innerText();
await page.locator('#inp-free').click();
await page.locator('#inp-free').type('一二三四五六七八九十', { delay: 25 });
const nar1 = await page.locator('.scene > .nar').innerText();
ok('F-13 连续输入不重掷叙事', nar0 === nar1, nar1.slice(0, 24));
await page.evaluate(() => window.__tq.dispatch({ type: 'travel', loc: 'tavern' }));
await page.waitForTimeout(400);
const nar2 = await page.locator('.scene > .nar').innerText();
ok('F-13 换场景后叙事改变', nar2 !== nar1, nar2.slice(0, 24));

/* F-15：进层期间 HUD 让开底部标签栏 */
await page.evaluate(() => {
  window.__tq.core.S.player.loc = 'cave';
  window.__tq.dispatch({ type: 'sceneAction', k: 'enter_dungeon' });
});
await page.waitForTimeout(500);
const geo = await page.evaluate(() => {
  const hud = document.getElementById('dungeon-hud');
  const tab = document.getElementById('tabbar');
  const r = hud?.getBoundingClientRect();
  const tr = tab?.getBoundingClientRect();
  return { hudTop: r?.top ?? -1, tabTop: tr?.top ?? -1, tabH: tr?.height ?? 0, hudVisible: !!r && r.height > 0 };
});
ok('F-15 HUD 出现', geo.hudVisible);
ok('F-15 HUD 位于标签栏上方（不遮挡）', geo.hudTop >= 0 && geo.tabTop > 0 && geo.hudTop + 40 <= geo.tabTop + 1, JSON.stringify(geo));

await page.evaluate(() => window.__tq.dispatch({ type: 'ui', a: 'close', p: {} })); // 关掉进层菜单（玩家照常操作）
await page.waitForTimeout(200);
await page.locator('#tabbar button', { hasText: '系统' }).click();
await page.waitForTimeout(300);
ok('F-15 进层期间点得动标签（系统面板可开）', (await page.getByText('导出存档（JSON）').count()) > 0);

/* F-16：打开学院面板 → 重置世界 → 新档 → 系统面板必须回到 SysPanel */
await page.getByText('培养学院（学籍 / 课程 / 毕业）').click();
await page.waitForTimeout(300);
ok('F-16 学院面板已打开', (await page.getByText('导出存档（JSON）').count()) === 0);
await page.evaluate(() => window.__tq.dispatch({ type: 'resetWorld' }));
await page.waitForTimeout(300);
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '验证员', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(400);
await page.locator('#tabbar button', { hasText: '系统' }).click();
await page.waitForTimeout(300);
ok('F-16 重置+新档后系统面板可见', (await page.getByText('导出存档（JSON）').count()) > 0);

console.log('ERRORS ' + (errors.length ? JSON.stringify(errors) : 'none'));
console.log(fails.length ? 'RESULT FAIL ' + JSON.stringify(fails) : 'RESULT ALL-PASS');
await browser.close();
process.exit(fails.length ? 1 : 0);

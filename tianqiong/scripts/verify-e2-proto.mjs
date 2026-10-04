/* E2 日晷原型 · 交互回归（临时验证脚本） */
import { mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const target = pathToFileURL(resolve(here, '../../outputs/中栏原型-E2日晷.html')).href;
const out = resolve(here, '../界面截图-E2原型');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
page.on('requestfailed', (r) => errs.push('REQFAIL ' + r.url().split('/').pop()));

await page.goto(target, { waitUntil: 'load' });
await page.waitForTimeout(600);
const read = () => page.evaluate(() => ({
  shichen: document.getElementById('t-shichen').textContent,
  dial: document.getElementById('dial-ring').style.background.slice(0, 58),
  hand: document.getElementById('dial-hand').style.transform,
  nar: document.getElementById('nar').textContent.slice(0, 12),
  hp: document.getElementById('t-hp').textContent,
  money: document.getElementById('t-money').textContent.trim(),
  logs: document.querySelectorAll('#log .log-e').length,
  his: document.querySelectorAll('#his .his-e').length,
  pills: document.getElementById('t-pills').textContent,
}));
console.log('INIT   ', JSON.stringify(await read()));
await page.screenshot({ path: out + '/01-初始.png' });

/* 1. 点行动 + 检定演出 */
await page.click('[data-act="observe"]');
await page.waitForTimeout(500);
await page.screenshot({ path: out + '/02-检定卡.png' });
const midCheck = await page.evaluate(() => ({
  on: document.getElementById('chk').classList.contains('on'),
  die: document.getElementById('chk-die').textContent,
  cx: document.getElementById('chk-cx').textContent,
}));
console.log('CHECK  ', JSON.stringify(midCheck));
await page.waitForTimeout(1400);
console.log('AFTER1 ', JSON.stringify(await read()));

/* 2. 自由行动输入 */
await page.fill('#inp-free', '我走进酒馆，观察有没有人盯着我');
await page.press('#inp-free', 'Enter');
await page.waitForTimeout(400);
console.log('FREE   ', JSON.stringify(await read()));

/* 3. NPC 交谈 */
await page.click('[data-npc="miya"]');
await page.waitForTimeout(1800);
console.log('TALK   ', JSON.stringify(await read()));

/* 4. 自动流逝：看日晷是否转动 */
await page.click('[data-seg="sys"]');
await page.click('#btn-auto');
await page.waitForTimeout(5200);
await page.click('#btn-auto');
const after = await read();
console.log('AUTO   ', JSON.stringify(after));
await page.screenshot({ path: out + '/03-自动流逝后.png' });

/* 5. 长时推进：跨时辰看叙事与光色变化 */
await page.evaluate(() => { for (let i = 0; i < 26; i++) window.advance(1); });
await page.waitForTimeout(400);
console.log('ADV26  ', JSON.stringify(await read()));
await page.screenshot({ path: out + '/04-黄昏.png' });

/* 6. 休息到天亮 + 升级路径 */
await page.click('#btn-rest');
await page.waitForTimeout(400);
console.log('REST   ', JSON.stringify(await read()));
await page.screenshot({ path: out + '/05-天亮.png' });

/* 7. 扒窃失败 → 通缉（连续试到出结果） */
for (let i = 0; i < 6; i++) {
  await page.click('[data-act="steal"]');
  await page.waitForTimeout(1700);
  const w = await page.evaluate(() => document.getElementById('t-pills').textContent);
  if (w.includes('通缉')) break;
  await page.click('#btn-rest');
  await page.waitForTimeout(300);
}
console.log('STEAL  ', JSON.stringify(await read()));
await page.screenshot({ path: out + '/06-通缉.png' });

console.log('ERRORS:', errs.length ? errs.join(' | ') : 'none');
await browser.close();

/* 对话双页 · 点击切页实测（手势已移除，只保留点击） */
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:5273/';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.getByText('开启新的旅程').click();
await page.fill('#inp-name', '叶澜');
await page.getByText('踏入世界').click();
await page.waitForTimeout(700);
await page.evaluate(() => window.__tq.dispatch({ type: 'npcTalk', id: 'mia' }));
await page.waitForTimeout(700);

const tl = () => page.evaluate(() => !!document.querySelector('.dlg-views.tl'));
const gone = () => page.evaluate(() => !document.querySelector('.dlg-views'));
const btn = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() || '(缺)', sel);

console.log('顶部按钮文案:', await btn('.dlg-switch'), '| 底部坞:', await btn('.dlg-more'));
console.log('① 初始在「此刻」（应 false）:', await tl());
await page.click('.dlg-switch');
await page.waitForTimeout(400);
console.log('② 点顶部「深谈」（应 true）:', await tl());
console.log('   顶部按钮已变:', await btn('.dlg-switch'), '| 返回键:', await btn('.tl-back'));
await page.click('.tl-back');
await page.waitForTimeout(400);
console.log('③ 点「回到此刻」（应 false）:', await tl());
await page.click('.dlg-more');
await page.waitForTimeout(400);
console.log('④ 点底部坞（应 true）:', await tl());
console.log('关闭后浮层消失（应 true）:', (await page.click('#ovl .sh-h .x'), await page.waitForTimeout(300), await gone()));
console.log('ERRORS:', errs.length ? errs.join(' | ') : 'none');
await browser.close();

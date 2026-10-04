import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
mkdirSync('界面截图-NPC评估', { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message.split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().replace(/\s+/g, ' ').slice(0, 140)); });
await page.goto('http://127.0.0.1:5273/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.getByText('开启新的旅程').click();
await page.fill('#inp-name', '叶澜');
await page.getByText('踏入世界').click();
await page.waitForTimeout(1000);

const chip = page.locator('.npc-chip').first();
console.log('在场 NPC 数:', await page.locator('.npc-chip').count());
const _npcName = await chip.textContent();
await chip.click();
await page.waitForTimeout(1200);
const dlg = await page.evaluate(() => {
  const sh = document.querySelector('#ovl .sheet');
  if (!sh) return { open: false };
  return {
    open: true,
    head: sh.querySelector('.sh-h') ? sh.querySelector('.sh-h').textContent.slice(0, 40) : '',
    hasArt: !!sh.querySelector('.dlg-art'),
    hasTimeline: !!sh.querySelector('.dlg-timeline, .timeline'),
    tabs: Array.from(sh.querySelectorAll('[role=tab], .dlg-tabs button, .seg button')).map((b) => b.textContent),
    bodyText: sh.querySelector('.sh-b') ? sh.querySelector('.sh-b').textContent.replace(/\s+/g, ' ').slice(0, 130) : '',
    opts: Array.from(sh.querySelectorAll('.opt')).map((o) => o.textContent.replace(/\s+/g, ' ').slice(0, 34)),
    mood: sh.querySelector('.dlg-art .tag, .mood') ? (sh.querySelector('.mood') || sh.querySelector('.dlg-art .tag')).textContent.slice(0, 30) : '(无)',
  };
});
console.log('对话浮层:', JSON.stringify(dlg, null, 1).slice(0, 1400));
await page.screenshot({ path: '界面截图-NPC评估/01-对话-初始.png' });
/* 翻到时间线页 */
for (const t of dlg.tabs) {
  if (/时间线|timeline/.test(t)) {
    await page.locator('#ovl button', { hasText: t }).first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: '界面截图-NPC评估/02-时间线.png' });
    console.log('已切到', t);
  }
}
console.log('ERRORS:', errs.length ? errs.join(' | ') : 'none');
await browser.close();

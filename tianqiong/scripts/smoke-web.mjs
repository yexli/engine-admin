import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
await page.goto('http://127.0.0.1:5273/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const title = await page.title();
const hasBoot = await page.evaluate(() => !!window.__tq);
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '叶澜', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(1200);
const scene = await page.evaluate(() => {
  const S = window.__tq.world.query.get_world_state();
  return { loc: S.player.loc, log: (S.log || []).length, world: !!document.getElementById('stage') };
});
console.log(JSON.stringify({ title, 桥接: hasBoot, 开局: scene, JS错误: errs }, null, 1));
await browser.close();
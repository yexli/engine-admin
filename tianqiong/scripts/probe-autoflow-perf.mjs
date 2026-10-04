import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message.split('\n')[0]));
await page.goto('http://127.0.0.1:5273/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.getByText('开启新的旅程').click();
await page.fill('#inp-name', '叶澜');
await page.getByText('踏入世界').click();
await page.waitForTimeout(900);

/* 装 longtask 观察器 */
await page.evaluate(() => {
  window.__lt = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] });
  } catch { window.__lt = ['no-observer']; }
});

const measure = async (label, ms) => {
  await page.evaluate(() => { window.__lt.length = 0; });
  const t0 = Date.now();
  await page.waitForTimeout(ms);
  const r = await page.evaluate(() => ({
    long: window.__lt.slice(),
    t: window.__tq.core.S.t,
    rev: window.__tq.store.getState().rev,
  }));
  const total = r.long.reduce((a, b) => a + b, 0);
  console.log(label.padEnd(22), '时长', (Date.now() - t0) / 1000 + 's', '| 走了', r.t - 16, '刻 | rev', r.rev,
    '| longtask', r.long.length, '次 合计', total + 'ms', r.long.length ? JSON.stringify(r.long) : '');
};

/* 同步耗时采样：单次 wait 的 dispatch 成本 */
const sync = await page.evaluate(() => {
  const xs = [];
  for (let i = 0; i < 12; i++) {
    const t0 = performance.now();
    window.__tq.dispatch({ type: 'wait', ticks: 1 });
    xs.push(+(performance.now() - t0).toFixed(2));
  }
  return xs;
});
console.log('单次 wait dispatch 耗时(ms):', JSON.stringify(sync), ' 最大', Math.max(...sync));

console.log('--- EVENTS 规模 ---');
console.log(await page.evaluate(() => ({ events: window.__tq.world.query.get_world_state().events.length })));

await page.locator('#side-r .side-h .sb button', { hasText: '系统' }).click();
await page.waitForTimeout(300);
await page.locator('#side-r .sysbtn', { hasText: '自动流逝' }).click();
await page.waitForTimeout(200);
await measure('① 开表(场景页) 20s', 20000);
await page.locator('#side-r .side-h .sb button', { hasText: '纪闻' }).click();
await page.waitForTimeout(300);
await measure('② 开表(纪闻页) 20s', 20000);
/* 系统页开着时 SysPanel 的 contextLayers 会随 rev 重算 */
await page.locator('#side-r .side-h .sb button', { hasText: '系统' }).click();
await page.waitForTimeout(300);
await measure('③ 开表(系统页) 20s', 20000);
console.log('ERRORS:', errs.length ? errs.join(' | ') : 'none');
await browser.close();

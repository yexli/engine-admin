/* web 端加载性能探针：采集导航/绘制/资源/长任务 */
import { chromium } from 'playwright-core';
const base = process.argv[2] || 'http://127.0.0.1:5274/';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
await page.addInitScript(() => {
  window.__long = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] });
  } catch { /* 浏览器不支持 longtask：静默跳过 */ }
});
await page.goto(base, { waitUntil: 'load' });
await page.waitForTimeout(2500);
const data = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
  const res = performance.getEntriesByType('resource');
  const byType = {};
  let total = 0, transfer = 0;
  for (const r of res) {
    const ext = (r.name.split('.').pop() || 'x').split('?')[0].slice(0, 4);
    byType[ext] = byType[ext] || { n: 0, kb: 0, tkb: 0 };
    byType[ext].n++;
    byType[ext].kb += Math.round(r.decodedBodySize / 1024);
    byType[ext].tkb += Math.round((r.transferSize || 0) / 1024);
    total += r.decodedBodySize || 0; transfer += r.transferSize || 0;
  }
  return {
    ttfb: Math.round(nav.responseStart || 0),
    domReady: Math.round(nav.domContentLoadedEventEnd || 0),
    loaded: Math.round(nav.loadEventEnd || 0),
    paint,
    requests: res.length,
    decodedKB: Math.round(total / 1024),
    transferKB: Math.round(transfer / 1024),
    byType,
    longTasks: (window.__long || []).length,
    longTaskMax: Math.max(0, ...(window.__long || [])),
  };
});
console.log(JSON.stringify(data, null, 1));
await browser.close();

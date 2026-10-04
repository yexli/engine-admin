import { chromium } from 'playwright-core';
const DIAG = () => {
  const issues = [];
  const vw = innerWidth;
  const root = document.getElementById('scr-game') || document.body;
  const seen = new Set();
  const skippable = (el) => {
    let p = el;
    while (p && p !== root) {
      const pcs = getComputedStyle(p);
      if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll') return true;
      const cls = typeof p.className === 'string' ? p.className : '';
      if (p.id === 'stage' || cls.includes('mist') || cls.includes('fm') || cls.includes('layer')) return true;
      p = p.parentElement;
    }
    return false;
  };
  root.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (skippable(el)) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    const label = (el.id ? '#' + el.id : el.tagName.toLowerCase() + (cls ? '.' + cls : ''));
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const push = (o) => { const k = o.t + '|' + o.el + '|' + (o.txt || ''); if (!seen.has(k)) { seen.add(k); issues.push(o); } };
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis') push({ t: 'overflow-x', el: label, sw: el.scrollWidth, cw: el.clientWidth, txt });
    if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && (r.height < 30 || r.width < 36)) push({ t: 'small-tap', el: label, w: Math.round(r.width), h: Math.round(r.height), txt });
    if (r.right > vw + 1) push({ t: 'outside-right', el: label, right: Math.round(r.right), vw, txt });
    if (r.left < -1) push({ t: 'outside-left', el: label, left: Math.round(r.left), txt });
  });
  return issues;
};
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'] });
for (const [w, h, tag] of [[1280, 800, '桌面'], [430, 932, '移动']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto('http://127.0.0.1:5273/', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '叶澜', race: 'human', cls: 'warrior' }));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__tq.store.getState().setTab('sys'));
  await page.waitForTimeout(600);
  const out = await page.evaluate(DIAG);
  console.log('=== ' + tag + ' 系统面板 ===');
  console.log(JSON.stringify(out.slice(0, 8), null, 1));
  await page.close();
}
await browser.close();
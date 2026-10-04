import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('http://127.0.0.1:5273/', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('tq2_ai_cfg_v1', JSON.stringify({
    enabled: true, baseURL: 'http://127.0.0.1:8931/v1', model: 'mock', apiKey: 'sk-mock',
    timeoutMs: 12000, loreEnabled: true,
    embedding: { enabled: false, reuseLlm: true, baseURL: '', model: '', apiKey: '' },
  }));
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const snap = () => page.evaluate(() => {
  const st = window.__tq.store.getState();
  const S = window.__tq.world.query.get_world_state();
  return { weaveFrom: st.weaveFrom, logSeq: S.logSeq, n: (S.log || []).length, tail: (S.log || []).slice(-1)[0]?.text?.slice(0, 20) };
});
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '叶澜', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(2500);
console.log('开局后      ' + JSON.stringify(await snap()));
await page.evaluate(() => window.__tq.dispatch({ type: 'sceneAction', k: 'observe' }));
await page.waitForTimeout(200);
console.log('第一次+200ms ' + JSON.stringify(await snap()));
await page.waitForTimeout(2600);
console.log('第一次+2.8s  ' + JSON.stringify(await snap()));
await page.evaluate(() => window.__tq.dispatch({ type: 'sceneAction', k: 'search' }));
await page.waitForTimeout(200);
console.log('第二次+200ms ' + JSON.stringify(await snap()));
await page.waitForTimeout(2600);
console.log('第二次+2.8s  ' + JSON.stringify(await snap()));
await page.waitForTimeout(3000);
console.log('第二次+5.8s  ' + JSON.stringify(await snap()));
await browser.close();
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => { const t = m.text(); if (/编织|weave|ai/i.test(t)) console.log('[console] ' + t.slice(0, 140)); });
page.on('pageerror', (e) => console.log('[pageerror] ' + String(e).slice(0, 200)));
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
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '叶澜', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(2500);
const prov = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.kv')].map((x) => x.innerText.replace(/\n/g, ' '));
  return el.find((t) => t.includes('Provider')) || '(未找到)';
});
console.log('Provider: ' + prov);
/* 连续两次操作，模拟玩家遇到的情形 */
await page.evaluate(() => window.__tq.dispatch({ type: 'sceneAction', k: 'observe' }));
await page.waitForTimeout(2600);
await page.evaluate(() => window.__tq.dispatch({ type: 'sceneAction', k: 'search' }));
await page.waitForTimeout(3200);
const logTexts = await page.evaluate(() => {
  const S = window.__tq.world.query.get_world_state();
  return (S.log || []).map((e) => (e.cls === 'ai' ? '【AI】' : '[' + e.cls + ']') + String(e.text).slice(0, 34));
});
console.log('--- 见闻录 ---');
logTexts.forEach((t, i) => console.log(i + ' ' + t));
await page.evaluate(() => window.__tq.store.getState().setTab('sys'));
await page.waitForTimeout(500);
const diag = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.cfg-row label')].find((x) => x.textContent.includes('叙事编织诊断'));
  return el?.parentElement?.innerText?.split('\n').slice(1) || ['(无诊断)'];
});
console.log('--- 编织诊断 ---');
console.log(diag.join('\n'));
await browser.close();
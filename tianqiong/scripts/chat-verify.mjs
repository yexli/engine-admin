/* 真机验证脚本（DEV 桥驱动）：赠礼→聊天窗→复合句 五屏截图 + console 错误断言
   运行：node scripts/chat-verify.mjs <devUrl> */
import { chromium } from 'playwright-core';
import path from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:5399/';
const out = (n) => path.resolve(process.cwd(), 'shot-' + n);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push('console: ' + m.text()); // favicon 404 为历史噪音
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__tq, null, { timeout: 15000 });

/* 1 · 开局进世界 */
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '验证员', race: 'human', cls: 'mage' }));
await page.waitForTimeout(700);
await page.screenshot({ path: out('1-world.png') });

/* 2 · 赠礼（面包=food，米娅 loved → +8 + 偏好发现 + 回赠） */
await page.evaluate(() => {
  const { core, dispatch } = window.__tq;
  core.S.player.bag.push({ id: 'bread', qty: 5 });
  dispatch({ type: 'ui', a: 'gift_give', p: { n: 'mia', id: 'bread' } });
});
await page.waitForTimeout(500);
await page.screenshot({ path: out('2-gift.png') });

/* 3 · 聊天窗口（空历史 + chips） */
await page.evaluate(() => {
  window.__tq.dispatch({ type: 'ui', a: 'close', p: {} });
  window.__tq.dispatch({ type: 'chatOpen', id: 'mia' });
});
await page.waitForTimeout(400);
await page.screenshot({ path: out('3-chat-empty.png') });

/* 4 · 聊两轮（降级三档池气泡） */
await page.evaluate(() => window.__tq.dispatch({ type: 'chatSend', id: 'mia', text: '最近有什么新闻？' }));
await page.waitForTimeout(400);
await page.evaluate(() => window.__tq.dispatch({ type: 'chatSend', id: 'mia', text: '东市还热闹吗' }));
await page.waitForTimeout(400);
await page.screenshot({ path: out('4-chat-turns.png') });

/* 5 · 复合句自由行动：走进酒馆→观察（检定演出） */
await page.evaluate(() => window.__tq.dispatch({ type: 'ui', a: 'close', p: {} }));
await page.evaluate(() => window.__tq.dispatch({ type: 'freeText', text: '走进酒馆，看看有没有人盯着我' }));
await page.waitForTimeout(900);
await page.screenshot({ path: out('5-steps-check.png') });
await page.waitForTimeout(1200);
await page.screenshot({ path: out('6-steps-done.png') });

const state = await page.evaluate(() => {
  const S = window.__tq.core.S;
  return { loc: S.player.loc, miaAtt: S.npcs.mia?.att ?? 0, chats: (S.chats?.mia || []).length, intimacy: S.npcs.mia?.intimacy ?? 0, known: S.npcs.mia?.giftKnown || [] };
});
console.log('STATE ' + JSON.stringify(state));
console.log('ERRORS ' + (errors.length ? JSON.stringify(errors) : 'none'));
await browser.close();

/* 真机验证（批次六）：
   F-33 日志封顶后新条目仍在新节点上（key 不再恒定）
   F-34 聊天滚动不再牵动主视图
   F-35 NPC 头像按盒子尺寸裁切
   F-38 浮层/标签栏/播报的无障碍语义 + 焦点进入浮层
   F-42 系统面板上下文分层可手动刷新
   运行：node scripts/verify-batch6.mjs <devUrl> */
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:5273/';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 80)));

const fails = [];
const ok = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + detail : ''));
  if (!cond) fails.push(name);
};

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__tq, null, { timeout: 20000 });
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '验证员', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(400);

/* F-33：日志封顶后新条目仍在带入场动画的新节点上 */
await page.evaluate(() => {
  const S = window.__tq.core.S;
  for (let i = 0; i < 80; i++) window.__tq.core.S.log && S.log.push({ t: '测试', text: '条目' + i, cls: 'nar', id: 1000 + i });
  if (S.log.length > 70) S.log.splice(0, S.log.length - 70);
  window.__tq.bus.emit({ type: 'changed' });
});
await page.waitForTimeout(300);
const logProbe = await page.evaluate(() => {
  const list = Array.from(document.querySelectorAll('.logwrap .log-e'));
  const newest = list[0];
  return {
    count: list.length,
    newestText: newest?.textContent ?? '',
    anim: newest ? window.getComputedStyle(newest).animationName : 'none',
    ids: list.slice(0, 5).map((el) => el.getAttribute('data-log-id')),
  };
});
ok('F-33 日志条目数仍受 70 上限约束', logProbe.count === 70, 'count=' + logProbe.count);
ok('F-33 最新条目文本正确（未复用旧节点内容）', logProbe.newestText.includes('条目79'), logProbe.newestText.slice(0, 24));
ok('F-33 最新条目仍带入场动画', logProbe.anim !== 'none' && logProbe.anim !== '', 'anim=' + logProbe.anim);

/* F-34：聊天窗口滚动不牵动主视图 */
await page.evaluate(() => window.__tq.dispatch({ type: 'npcTalk', id: 'mia' }));
await page.waitForTimeout(300);
await page.evaluate(() => window.__tq.dispatch({ type: 'chatOpen', id: 'mia' }));
await page.waitForTimeout(300);
const beforeTop = await page.evaluate(() => document.getElementById('view')?.scrollTop ?? -1);
await page.evaluate(() => {
  for (let i = 0; i < 6; i++) window.__tq.dispatch({ type: 'chatSend', id: 'mia', text: '第' + i + '句测试发言' });
});
await page.waitForTimeout(600);
const afterTop = await page.evaluate(() => document.getElementById('view')?.scrollTop ?? -1);
const chatScrolled = await page.evaluate(() => {
  const el = document.querySelector('.chat-turns');
  return el ? el.scrollTop > 0 : false;
});
ok('F-34 聊天窗口自身已滚动', chatScrolled);
ok('F-34 主视图滚动位置未被牵动', beforeTop === afterTop, beforeTop + ' → ' + afterTop);
await page.evaluate(() => window.__tq.dispatch({ type: 'ui', a: 'close', p: {} }));
await page.waitForTimeout(200);

/* F-35：NPC 头像按盒子裁切（不是 600×800 原图尺寸）——去酒馆找有立绘的莉塔 */
await page.evaluate(() => window.__tq.dispatch({ type: 'travel', loc: 'tavern' }));
await page.waitForTimeout(400);
const chip = await page.locator('.npc-chip .sv img').first();
const box = (await chip.count())
  ? await chip.evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight, parentW: el.parentElement?.clientWidth ?? 0 }))
  : null;
ok('F-35 头像尺寸贴合容器（非原图尺寸）', !!box && box.w > 0 && box.w <= box.parentW + 2, JSON.stringify(box));

/* F-38：无障碍语义 + 焦点进入浮层 */
const a11y = await page.evaluate(() => ({
  toastLive: document.getElementById('toast')?.getAttribute('aria-live'),
  tablist: document.getElementById('tabbar')?.getAttribute('role'),
  tabSelected: document.querySelector('#tabbar button[role="tab"]')?.getAttribute('aria-selected'),
}));
ok('F-38 #toast 有 aria-live', a11y.toastLive === 'polite', String(a11y.toastLive));
ok('F-38 #tabbar 为 tablist', a11y.tablist === 'tablist', String(a11y.tablist));
ok('F-38 标签有 aria-selected', a11y.tabSelected === 'true' || a11y.tabSelected === 'false', String(a11y.tabSelected));

await page.evaluate(() => window.__tq.dispatch({ type: 'npcTalk', id: 'mia' }));
await page.waitForTimeout(400);
const ovl = await page.evaluate(() => {
  const o = document.getElementById('ovl');
  return { role: o?.getAttribute('role'), modal: o?.getAttribute('aria-modal'), focusInside: !!o && o.contains(document.activeElement) };
});
ok('F-38 #ovl 为 dialog + aria-modal', ovl.role === 'dialog' && ovl.modal === 'true', JSON.stringify(ovl));
ok('F-38 打开浮层后焦点在浮层内', ovl.focusInside);
await page.evaluate(() => window.__tq.dispatch({ type: 'ui', a: 'close', p: {} }));
await page.waitForTimeout(200);

/* F-42：上下文分层可手动刷新 */
await page.locator('#tabbar button', { hasText: '系统' }).click();
await page.waitForTimeout(300);
const refresh = await page.getByText('刷新分层快照').count();
ok('F-42 系统面板提供分层刷新入口', refresh > 0);

console.log('ERRORS ' + (errors.length ? JSON.stringify(errors) : 'none'));
console.log(fails.length ? 'RESULT FAIL ' + JSON.stringify(fails) : 'RESULT ALL-PASS');
await browser.close();
process.exit(fails.length ? 1 : 0);

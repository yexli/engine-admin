/* 卡 N1 · 星枢兑换所 与 违禁品 真机验证 + 截图
   ① 枢纽上有「星枢兑换所」按钮（七大陆各一家）
   ② 面板给得出牌价与持有，兑出后铜钱到账、星币归零
   ③ 带着禁货走进有人盘查的地方 → 被拦、东西起获、立案（wanted 上升）
   ④ 不带禁货走进同一个地方 → 不该被拦（空手不该遭殃）
   运行：node scripts/verify-exchange-law.mjs <devUrl> <outDir> */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:5274/';
const out = process.argv[3] || 'outputs/n1-items';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 100)));
const fails = [];
const ok = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + detail : ''));
  if (!cond) fails.push(name);
};
const shot = async (n) => {
  await page.screenshot({ path: out + '/' + n + '.png' });
  console.log('SHOT', out + '/' + n + '.png');
};

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__tq, null, { timeout: 20000 });
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '兑客', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(400);

/* ① 走到中央大陆枢纽：城门内街 */
await page.evaluate(() => window.__tq.dispatch({ type: 'travel', loc: 'gate' }));
await page.waitForTimeout(500);
const dock = page.locator('.dock button', { hasText: '星枢兑换所' });
ok('枢纽上出现「星枢兑换所」按钮', (await dock.count()) === 1, 'loc=' + (await page.evaluate(() => window.__tq.core.S.player.loc)));

/* ② 面板与兑换 */
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.net = { online: false, starcoin: 300, starcrystal: 2, consign: [], duels: { won: 0, lost: 0 } };
  window.__tq.bus.emit({ type: 'changed' });
});
await dock.first().click({ force: true });
await page.waitForTimeout(500);
const panel = await page.locator('.sheet:visible').innerText();
ok('面板给出牌价', panel.includes('牌价') && panel.includes('星币'), panel.replace(/\s+/g, ' ').slice(0, 60));
ok('面板给出你持有的币', /星币 300/.test(panel) && /星晶 2/.test(panel));
await shot('exchange-panel');
const gold0 = await page.evaluate(() => window.__tq.core.S.player.gold);
await page.locator('.sheet:visible button', { hasText: '兑出全部星币' }).first().click({ force: true });
await page.waitForTimeout(500);
const afterSell = await page.evaluate(() => ({ gold: window.__tq.core.S.player.gold, sc: window.__tq.core.S.net.starcoin }));
ok('兑出后星币归零、铜钱到账（300 星币 = 3 金币）', afterSell.sc === 0 && afterSell.gold === gold0 + 300 * 100, gold0 + ' → ' + afterSell.gold);
await shot('exchange-done');

/* ③ 带禁货反复进城：城门内街的盘查概率约 57%，走几趟必然撞上。
   不用 rng 注入——真机走的是玩家那条路，控制随机反而验不到"概率真的生效"。 */
/* 检定有演出：盘查掷完骰子要等它落定，否则读到的是"刚被拦下"那一瞬的日志 */
const travel = async (loc, wait = 520) => {
  await page.evaluate((l) => window.__tq.dispatch({ type: 'travel', loc: l }), loc);
  await page.waitForTimeout(wait);
};
await travel('plaza');
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.player.bag.push({ id: 'dagger_black', qty: 1 }, { id: 'dust_dream', qty: 1 });
  window.__tq.bus.emit({ type: 'changed' });
});
let stopped = false;
let wraps = 0;
for (let i = 0; i < 8 && !stopped; i++) {
  await travel('gate');
  wraps++;
  stopped = await page.evaluate(() => window.__tq.core.S.log.slice(-5).some((e) => e.text.includes('把包打开')));
  if (stopped) {
    await page.waitForTimeout(1800); // 等藏货检定结算
    break;
  }
  await travel('plaza');
}
ok('带着禁货进城会被拦下来', stopped, '走了 ' + wraps + ' 趟');
const busted = await page.evaluate(() => {
  const s = window.__tq.core.S;
  const tail = s.log.slice(-4).map((e) => e.text).join(' / ');
  return {
    wanted: s.player.wanted,
    illegal: s.player.bag.filter((x) => ['dagger_black', 'dust_dream'].includes(x.id)).length,
    log: tail,
    resolved: tail.includes('摸出') || tail.includes('压在最底下'),
  };
});
ok('拦下之后必有结果（藏住或起获，不会悬着）', busted.resolved, busted.log.slice(-60));
ok('两条分支都与案底一致：起获→立案、藏住→无案底', busted.illegal === 0 ? busted.wanted > 0 : busted.wanted === 0, 'illegal=' + busted.illegal + ' wanted=' + busted.wanted);
await shot('contraband-stopped');

/* ④ 空手反复走同一个门：不该被拦（概率为 0，与运气无关） */
await page.waitForTimeout(1500); // 排干上一步可能残留的异步结算
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.player.wanted = 0;
  s.player.bag = s.player.bag.filter((x) => !['dagger_black', 'dust_dream'].includes(x.id));
  /* 清空见闻录：上一轮那条「把包打开」还在尾部的话，这一轮会把残留当成新的搜包 */
  s.log.length = 0;
  window.__tq.bus.emit({ type: 'changed' });
});
let cleanStops = 0;
for (let i = 0; i < 6; i++) {
  await travel('gate');
  const hit = await page.evaluate(() => window.__tq.core.S.log.slice(-4).some((e) => e.text.includes('把包打开')));
  if (hit) cleanStops++;
  await travel('plaza');
}
ok('空手过城门一次也没被搜包（盘查看的是包，不是脸）', cleanStops === 0, '被拦 ' + cleanStops + ' 次');

ok('无运行时报错', errors.length === 0, errors.join(' | '));
console.log(fails.length ? 'FAILED: ' + fails.join(', ') : 'ALL PASS');
await browser.close();

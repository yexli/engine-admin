/* 真机验证（卡 I1 · 装备实例化）：
   ① 同 base 多实例在背包各占一行，带品质前缀/品质色/词缀明细
   ② 穿戴实例 → 数值出口变化（暴击率 / 防御等级）
   ③ 商店按实例价回收（uid 精确出包）
   运行：node scripts/verify-equip.mjs <devUrl>（需 npm run dev 常驻 5273） */
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
/* 面板在同一 DOM 里有多份副本（隐藏副本无 ARIA role）——一律定位 :visible 副本，
   并强制点击（移动视口下按钮常被判为不可见；仍走真实 React onClick 路径）。 */
const tap = (loc) => loc.click({ force: true, timeout: 8000 });

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__tq, null, { timeout: 20000 });
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '锻者', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(400);

/* 造两件实例：神话武器（暴击词缀）/ 传说护甲（防御词缀） */
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.player.bag.push({ id: 'sword_iron', qty: 1, uid: 'eV1', q: 5, af: ['af_duelist', 'af_heavy', 'af_bear'] });
  s.player.bag.push({ id: 'armor_chain', qty: 1, uid: 'eV3', q: 4, af: ['af_bulwark'] });
  window.__tq.bus.emit({ type: 'changed' });
});

/* ① 角色面板 · 背包分行与品质渲染 */
await page.locator('#tabbar button', { hasText: '角色' }).click();
await page.waitForTimeout(400);
const wpnRow = page.locator('.inv-row:visible', { hasText: '决斗' }).first();
const armRow = page.locator('.inv-row:visible', { hasText: '壁垒' }).first();
ok('同 base 多实例分行（实例行 = 独立 inv-row）', (await page.locator('.inv-row:visible', { hasText: '实例' }).count()) >= 2, 'inv-rows=' + (await page.locator('.inv-row:visible').count()));
const wpnText = await wpnRow.innerText();
ok('武器实例行显示品质前缀【神话】', wpnText.includes('【神话】'), wpnText.replace(/\s+/g, ' ').slice(0, 50));
const wpnColor = await wpnRow.locator('b').first().evaluate((el) => window.getComputedStyle(el).color);
ok('品质色按档位着色（神话 #ff7a5c）', wpnColor === 'rgb(255, 122, 92)', wpnColor);
ok('实例行显示词缀明细', wpnText.includes('决斗') && wpnText.includes('沉猛') && wpnText.includes('熊力'), wpnText.replace(/\s+/g, ' ').slice(0, 70));
ok('护甲实例行显示【传说】', (await armRow.innerText()).includes('【传说】'));

/* ② 穿戴实例 → 暴击率 / 防御等级变化 */
const kv = (label) => page.locator('.kv', { hasText: label }).first().innerText();
const crit0 = await kv('暴击率');
const ac0 = await kv('防御等级');
await tap(wpnRow.locator('button.eq'));
await page.waitForTimeout(300);
const crit1 = await kv('暴击率');
ok('穿戴神话武器后暴击率上升（5% → 11%）', crit0 !== crit1, crit0 + ' → ' + crit1);
const eqCard = await page.locator('.card', { hasText: '装备' }).first().innerText();
ok('装备栏显示实例名（【神话】+ 词缀）', eqCard.includes('【神话】') && eqCard.includes('决斗'), eqCard.replace(/\s+/g, ' ').slice(0, 60));
await tap(armRow.locator('button.eq'));
await page.waitForTimeout(300);
const ac1 = await kv('防御等级');
ok('穿戴传说护甲后防御等级上升', ac0 !== ac1, ac0 + ' → ' + ac1);

/* ③ 商店按实例价回收 */
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.player.bag.push({ id: 'sword_iron', qty: 1, uid: 'eV4', q: 3, af: ['af_heavy'] }); // q3=稀有
  window.__tq.bus.emit({ type: 'changed' });
});
await page.evaluate(() => window.__tq.dispatch({ type: 'sceneAction', k: 'shop_grocer' }));
await page.waitForTimeout(400);
const sellRow = page.locator('.shop-row:visible', { hasText: '【稀有】' }).first();
const sellCount = await sellRow.count();
ok('收购列表出现实例行（【稀有】）', sellCount === 1, sellCount ? (await sellRow.innerText()).replace(/\s+/g, ' ').slice(0, 40) : 'not found');
const g0 = await page.evaluate(() => window.__tq.core.S.player.gold);
await tap(sellRow.locator('button'));
await page.waitForTimeout(400);
const g1 = await page.evaluate(() => window.__tq.core.S.player.gold);
const gone = await page.evaluate(() => !window.__tq.core.S.player.bag.some((x) => x.uid === 'eV4'));
ok('实例按 uid 精确出包', gone);
ok('出售实例后金币增加', g1 > g0, g0 + ' → ' + g1);
const stillEquipped = await page.evaluate(() => window.__tq.core.S.player.equip.wpnIns?.uid);
ok('出售不影响已装备实例', stillEquipped === 'eV1', String(stillEquipped));

ok('运行期无 JS 异常', errors.length === 0, errors.join(' | ').slice(0, 120));

await browser.close();
console.log(fails.length ? '\nRESULT: FAIL (' + fails.length + ')' : '\nRESULT: ALL PASS');
process.exit(fails.length ? 1 : 0);

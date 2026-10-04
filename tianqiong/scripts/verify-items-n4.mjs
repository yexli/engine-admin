/* 卡 N1 · 批 4「深渊与禁忌」真机验证 + 截图
   ① 黑市货架上摆着新的违禁品（它们此前只有 3 件，且买来没有后果）
   ② 毒物在战斗面板可用，且真的把状态按到敌人头上
   ③ 势力/古代武器能装备，攻击加值真的变
   运行：node scripts/verify-items-n4.mjs <devUrl> <outDir> */
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
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '禁忌', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(400);

/* ① 黑市 */
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.player.gold = 999999;
  window.__tq.bus.emit({ type: 'changed' });
  window.__tq.bus.emit({ type: 'sheet', desc: { kind: 'shop', shopId: 'black' } });
});
await page.waitForTimeout(500);
const shop = await page.locator('.sheet:visible').innerText();
const contrabandShown = ['掩尘', '魂瓶', '王之毒', '狂血散'].filter((n) => shop.includes(n));
ok('黑市摆出了新违禁品', contrabandShown.length >= 3, contrabandShown.join('/'));
await shot('black-market');

/* ② 毒物进战斗 */
await page.evaluate(() => window.__tq.bus.emit({ type: 'sheet', desc: { kind: 'close' } }));
await page.waitForTimeout(200);
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.player.bag.push({ id: 'poison_ember', qty: 2 }, { id: 'poison_dead', qty: 1 }, { id: 'wpn_anc_blade', qty: 1 });
  window.__tq.bus.emit({ type: 'changed' });
  window.__tq.combat.startCombat(['wolf']);
});
await page.waitForTimeout(400);
await page.evaluate(() => window.__tq.combat.combatUseItemSheet());
await page.waitForTimeout(400);
const panel = await page.locator('.sheet:visible').innerText();
ok('战斗面板列出新毒物', panel.includes('火油弹') && panel.includes('死息粉'));
await page.locator('.sheet:visible .shop-row', { hasText: '火油弹' }).locator('button').first().click({ force: true });
await page.waitForTimeout(600);
const foe = await page.evaluate(() => (window.__tq.core.CB?.foes?.[0]?.status ?? []).map((x) => x.id));
ok('火油弹把燃烧按到敌人头上', foe.includes('burn'), foe.join(','));
await shot('poison-in-combat');

/* ③ 古代武器 */
await page.evaluate(() => {
  window.__tq.core.CB && (window.__tq.core.CB.over = true);
  window.__tq.bus.emit({ type: 'combat', open: false });
  window.__tq.core.CB = null;
});
await page.waitForTimeout(300);
const atk0 = await page.evaluate(() => {
  const s = window.__tq.core.S;
  return { arm: s.player.equip.wpn, atk: 2 + ((s.player.level / 2) | 0) };
});
await page.evaluate(() => window.__tq.combat.equipItem('wpn_anc_blade'));
await page.waitForTimeout(400);
const atk1 = await page.evaluate(() => {
  const s = window.__tq.core.S;
  return { wpn: s.player.equip.wpn, ins: s.player.equip.wpnIns };
});
ok('古代光刃装上了', atk1.wpn === 'wpn_anc_blade', atk0.arm + ' → ' + atk1.wpn);
await page.evaluate(() => window.__tq.store.getState().setBag(true));
await page.waitForTimeout(450);
const bagTxt = await page.locator('.bagovl').first().innerText();
ok('行囊头部显示新的攻击加值（装备生效）', /攻击加值/.test(bagTxt), bagTxt.replace(/\s+/g, ' ').slice(0, 40));
await shot('equipped-ancient-blade');

ok('无运行时报错', errors.length === 0, errors.join(' | '));
console.log(fails.length ? 'FAILED: ' + fails.join(', ') : 'ALL PASS');
await browser.close();

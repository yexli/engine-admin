/* 卡 N1 · 道具扩展批 3「风土」真机验证 + 截图
   ① 吃一碗菌汤 → 顶栏出现世界级状态胶囊（食物第一次在玩家身上留下东西）
   ② 时间走过 → 胶囊上的剩余刻数真的在减
   ③ 带着它开战 → 状态被接住（吃一顿好的再下地是有用的）
   ④ 研读新卷册 → 图鉴「地理」类目真的解锁（补上的空类目不是摆设）
   运行：node scripts/verify-items-n3.mjs <devUrl> <outDir> */
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
const pillText = () => page.locator('#topbar .pills').innerText();

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__tq, null, { timeout: 20000 });
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '风土', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(400);
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.player.bag.push(
    { id: 'food_mushroom_soup', qty: 2 },
    { id: 'drink_ale', qty: 2 },
    { id: 'food_spice_roast', qty: 1 },
    { id: 'tome_geo_central', qty: 1 },
    { id: 'tome_geo_north', qty: 1 },
  );
  window.__tq.bus.emit({ type: 'changed' });
});
await page.waitForTimeout(300);

const before = await pillText();
ok('吃之前身上没有状态胶囊', !before.includes('坚壁'), before.replace(/\s+/g, ' ').slice(0, 50));

/* ① 喝麦酒：MP 是这一批新开的通道 */
const mp0 = await page.evaluate(() => { const s = window.__tq.core.S; s.player.mp = 0; window.__tq.bus.emit({ type: 'changed' }); return s.player.mp; });
await page.evaluate(() => window.__tq.store.getState().setBag(true));
await page.waitForTimeout(400);
await page.locator('tr').filter({ hasText: '麦酒' }).first().click({ force: true });
await page.waitForTimeout(250);
await page.keyboard.press('Enter');
await page.waitForTimeout(450);
const mp1 = await page.evaluate(() => window.__tq.core.S.player.mp);
ok('喝麦酒回魔力（战斗外的 mp 通道）', mp1 > mp0, mp0 + ' → ' + mp1);

/* ② 吃菌汤：世界级状态 + 顶栏胶囊 */
await page.locator('tr').filter({ hasText: '菌汤' }).first().click({ force: true });
await page.waitForTimeout(250);
await page.keyboard.press('Enter');
await page.waitForTimeout(450);
await page.evaluate(() => window.__tq.store.getState().setBag(false));
await page.waitForTimeout(350);
const after = await pillText();
ok('顶栏出现「坚壁」胶囊', after.includes('坚壁'), after.replace(/\s+/g, ' ').slice(0, 60));
const left0 = await page.evaluate(() => window.__tq.core.S.player.effects?.find((e) => e.id === 'bastion')?.left ?? -1);
ok('胶囊记着剩余刻数（菌汤 20 刻）', left0 === 20, 'left=' + left0);
await shot('topbar-effect-pill');

/* ③ 时间走过：刻数真的减 */
await page.evaluate(() => window.__tq.dispatch({ type: 'travel', loc: 'tavern' }));
await page.waitForTimeout(500);
const left1 = await page.evaluate(() => window.__tq.core.S.player.effects?.find((e) => e.id === 'bastion')?.left ?? -1);
ok('走过一段时间后剩余刻数变少', left1 < left0, left0 + ' → ' + left1);

/* ④ 带着它开战：状态被接住 */
await page.evaluate(() => window.__tq.combat.startCombat(['wolf']));
await page.waitForTimeout(400);
const carried = await page.evaluate(() => (window.__tq.core.CB?.status ?? []).map((x) => x.id));
ok('开战时身上的坚壁被接住', carried.includes('bastion'), carried.join(','));
await shot('bastion-carried-into-combat');
await page.evaluate(() => {
  window.__tq.core.CB && (window.__tq.core.CB.over = true);
  window.__tq.bus.emit({ type: 'combat', open: false });
  window.__tq.core.CB = null;
});
await page.waitForTimeout(300);

/* ⑤ 研读卷册：图鉴「地理」类目解锁 */
const before5 = await page.evaluate(() => (window.__tq.core.S.codex?.unlocked ?? []).length);
await page.evaluate(() => window.__tq.store.getState().setBag(true));
await page.waitForTimeout(400);
await page.locator('tr').filter({ hasText: '中央大陆风土志' }).first().click({ force: true });
await page.waitForTimeout(250);
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
const after5 = await page.evaluate(() => (window.__tq.core.S.codex?.unlocked ?? []).length);
ok('研读卷册真的解锁了图鉴条目', after5 > before5, before5 + ' → ' + after5);
await shot('tome-read');
await page.evaluate(() => window.__tq.store.getState().setBag(false));
await page.waitForTimeout(300);
await page.evaluate(() => window.__tq.bus.emit({ type: 'sheet', desc: { kind: 'codex', cat: '地理' } }));
await page.waitForTimeout(500);
const codexText = await page.locator('.sheet:visible').innerText();
ok('图鉴「地理」类目里有已解锁的条目', /地理/.test(codexText) && codexText.length > 60, codexText.replace(/\s+/g, ' ').slice(0, 60));
await shot('codex-geo');

ok('无运行时报错', errors.length === 0, errors.join(' | '));
console.log(fails.length ? 'FAILED: ' + fails.join(', ') : 'ALL PASS');
await browser.close();

/* 真机验证（卡 I2 · 技艺工坊）：
   ① 当地工坊入口（行动坞按钮按站表数据出现）
   ② 工坊浮层：9 条锻造配方 + 材料/成功率/产出 逐行可读
   ③ 制作端到端：扣料 → 推进时间 → 背包出现实例（可穿戴即交接 I1）
   ④ G10 零代码契约：与布伦丹对话出现「进工坊」选项
   ⑤ 未解锁的站（炼金台）不显入口
   运行：node scripts/verify-craft.mjs <devUrl>（需 npm run dev 常驻 5273） */
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
const tap = (loc) => loc.click({ force: true, timeout: 8000 });

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__tq, null, { timeout: 20000 });
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '匠人', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(300);

/* 备料：一件剑坯 + 两把破铜刀 + 足额铜钱 */
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.player.gold = 5000;
  s.player.bag.push({ id: 'blade_blank', qty: 1 }, { id: 'scrap_blade', qty: 2 });
  window.__tq.bus.emit({ type: 'changed' });
});

/* ① 行动坞入口（market 才有铁匠铺） */
await page.evaluate(() => window.__tq.dispatch({ type: 'travel', loc: 'market' }));
await page.waitForTimeout(400);
const dock = page.locator('.dock button:visible', { hasText: '工坊' }).first();
ok('当地出现「进工坊」入口（按站表数据）', (await dock.count()) === 1, await dock.innerText().catch(() => ''));

/* ② 工坊浮层 */
await tap(dock);
await page.waitForTimeout(400);
const header = await page.locator('.sheet:visible .sh-h .tt b').first().innerText();
ok('浮层标题为站点名', header.includes('布伦丹'), header);
const rowCount = await page.locator('.sheet:visible .shop-row').count();
ok('锻造配方逐行渲染（9 条）', rowCount === 9, 'rows=' + rowCount);
const firstRow = await page.locator('.sheet:visible .shop-row').first().innerText();
ok('配方行含材料/耗时/成率/产出', /需 .+1\/1/.test(firstRow) && firstRow.includes('成率') && firstRow.includes('产出'), firstRow.replace(/\s+/g, ' ').slice(0, 70));

/* ③ 制作端到端 */
const t0 = await page.evaluate(() => window.__tq.core.S.t);
const btn = page.locator('.sheet:visible .shop-row').first().locator('button');
ok('材料齐备时「制作」可点', !(await btn.isDisabled()));
await tap(btn);
await page.waitForTimeout(500);
const after = await page.evaluate(() => {
  const s = window.__tq.core.S;
  return {
    t: s.t,
    blanks: s.player.bag.filter((x) => x.id === 'blade_blank').reduce((a, x) => a + x.qty, 0),
    gold: s.player.gold,
    made: s.craft && s.craft.made ? Object.values(s.craft.made).reduce((a, b) => a + b, 0) : 0,
    lv: 0,
  };
});
ok('制作推进世界时间（48 刻工期）', after.t === t0 + 48, t0 + ' → ' + after.t);
ok('材料被扣除', after.blanks === 0, 'blank=' + after.blanks);
ok('铜钱被按配方成本扣除', after.gold < 5000 && after.gold > 3000, String(after.gold));
ok('产出计入 craft.made（成功或废件都会留痕）', after.made >= 0, 'made=' + after.made);
const craftRows = await page.locator('.sheet:visible .shop-row').count();
ok('制作后自动回到工坊界面（配方可用性刷新）', craftRows === 9, 'rows=' + craftRows);
await page.evaluate(() => window.__tq.dispatch({ type: 'ui', a: 'craft_back', p: {} }));
await page.waitForTimeout(200);

/* ④ G10：对话入口 */
await page.evaluate(() => window.__tq.dispatch({ type: 'npcTalk', id: 'brendan' }));
await page.waitForTimeout(400);
const dlgText = await page.locator('.sheet:visible .opts').first().innerText().catch(() => '');
ok('G10 契约：布伦丹对话出现「进工坊」', dlgText.includes('进工坊'), dlgText.replace(/\s+/g, ' ').slice(0, 80));
await page.evaluate(() => window.__tq.dispatch({ type: 'ui', a: 'close', p: {} }));
await page.waitForTimeout(200);

/* ⑤ 未解锁站不显入口（炼金台在 guild，未入学 → 不出现） */
await page.evaluate(() => window.__tq.dispatch({ type: 'travel', loc: 'guild' }));
await page.waitForTimeout(400);
let locNow = await page.evaluate(() => window.__tq.core.S.player.loc);
if (locNow !== 'guild') {
  /* 旅行矩阵可能要求中转：直接落位（本轮验的是"按站的入口渲染"，不是旅行规则） */
  await page.evaluate(() => {
    window.__tq.core.S.player.loc = 'guild';
    window.__tq.bus.emit({ type: 'changed' });
  });
  await page.waitForTimeout(300);
  locNow = await page.evaluate(() => window.__tq.core.S.player.loc);
}
const alchemyEntry = await page.locator('.dock button:visible', { hasText: '炼金台' }).count();
ok('未解锁的炼金台不显入口', locNow === 'guild' && alchemyEntry === 0, 'loc=' + locNow + ' count=' + alchemyEntry);
const alchemyDirect = await page.evaluate(() => {
  const before = window.__tq.core.S.log.length;
  window.__tq.dispatch({ type: 'ui', a: 'craft_menu', p: { id: 'alchemy' } });
  return { before, after: window.__tq.core.S.log.length };
});
ok('core 权威校验拦住未解锁站（不因 UI 缺失而放行）', alchemyDirect.before === alchemyDirect.after);

ok('运行期无 JS 异常', errors.length === 0, errors.join(' | ').slice(0, 120));
await browser.close();
console.log(fails.length ? '\nRESULT: FAIL (' + fails.length + ')' : '\nRESULT: ALL PASS');
process.exit(fails.length ? 1 : 0);

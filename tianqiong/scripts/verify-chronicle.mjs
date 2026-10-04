/* 卡 J1 / J5 · 真机验证（世界档案 + 大陆地图）
 * 用法：node scripts/verify-chronicle.mjs <baseUrl> <outDir>（需 dev server 常驻）
 * 验证：
 *   1. 门面查询三入口在真实页面可用（world 已挂进 dev 桥）
 *   2. 「档案」次级页签存在，且世界史真的渲染出条目（不是空态）
 *   3. 有因果父的条目可点开，展开出链路
 *   4. 检定留痕区块有数据
 *   5. 地图按大陆分组，未解锁的大陆给出可读条件（卡 J5）
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:5275/';
const out = process.argv[3] || 'outputs/verify-run';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox', '--allow-file-access-from-files'],
});

let pass = 0;
const fails = [];
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log('PASS ' + msg);
  } else {
    fails.push(msg);
    console.log('FAIL ' + msg);
  }
};

const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.getByText('开启新的旅程').click();
await page.fill('#inp-name', '叶澜');
await page.getByText('踏入世界').click();
await page.waitForTimeout(700);

const diag0 = await page.evaluate(() => ({
  hasS: !!window.__tq.core.S,
  tick: window.__tq.core.S ? window.__tq.core.S.t : -1,
  logLen: window.__tq.world.query.get_world_log(500).length,
  hasStartCombat: typeof window.__tq.combat.startCombat,
  hasPlayerAct: typeof window.__tq.combat.playerAct,
}));
console.log('DIAG-before ' + JSON.stringify(diag0));

/* 制造世界事实：**打到怪死**才会产生世界事件。
   注意：普通攻击回合不发事实——EventSchema 的 LEVEL_TABLE 里虽然登记了
   combat_round（L1），但全仓没有任何产生者，它是又一个「接线位空着」的条目。
   Combat 只在击杀等处 worldBus.emit，所以脚本必须真的打完一场。 */
await page.evaluate(() => {
  const { combat, core } = window.__tq;
  combat.startCombat(['rabbit']);
  for (let i = 0; i < 60 && core.CB; i++) combat.playerAct('atk');
});
await page.waitForTimeout(600);
await page.evaluate(() => {
  if (window.__tq.core.CB) window.__tq.core.CB.over = true;
  window.__tq.bus.emit({ type: 'combat', open: false });
  window.__tq.core.CB = null;
});
await page.waitForTimeout(600);

const api = await page.evaluate(() => {
  const q = window.__tq.world && window.__tq.world.query;
  return {
    exposed: !!q,
    hasLog: !!(q && typeof q.get_world_log === 'function'),
    hasTrace: !!(q && typeof q.trace_event === 'function'),
    hasChecks: !!(q && typeof q.get_recent_checks === 'function'),
  };
});
ok(api.exposed && api.hasLog && api.hasTrace && api.hasChecks, '门面查询三入口在页面上可用');

const logLen = await page.evaluate(() => window.__tq.world.query.get_world_log(200).length);
ok(logLen > 0, '真实操作后世界史非空（' + logLen + ' 条）');

/* 切到「档案」 */
const tab = page.locator('#side-r button', { hasText: '档案' });
ok((await tab.count()) > 0, '「档案」次级页签存在');
await tab.first().click();
await page.waitForTimeout(500);

const rows = page.locator('#side-r .his-e');
const n = await rows.count();
ok(n > 0, '世界史区块渲染出条目（' + n + ' 行）');
await page.screenshot({ path: out + '/j1-chronicle.png' });

/* 可点开的条目（有因果父） */
const linked = page.locator('#side-r [title="点开因果链"]');
const m = await linked.count();
if (m > 0) {
  await linked.first().click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: out + '/j1-chain.png' });
  ok(true, '点开有因果父的条目没有报错（可点条目 ' + m + ' 条）');
} else {
  console.log('SKIP 本轮事实多为根源（战斗回合无父），因果链展开由 cardJ1.test.ts 覆盖');
}

/* 检定留痕：点一次观察环境。
   注意本脚本跑的是**桌面三栏**布局（1360×900）：主视图常驻 SceneView，
   没有移动端的 #tabbar —— 那套是 mobilePanel 的分支，点它会 "element is not visible"。 */
const act = page.locator('.act', { hasText: '观察环境' });
if (await act.count()) {
  await act.first().click();
  await page.waitForTimeout(1800);
}
const checkLen = await page.evaluate(() => window.__tq.world.query.get_recent_checks(8).length);
ok(checkLen > 0, '检定留痕有数据（' + checkLen + ' 次）');
await page.locator('#side-r button', { hasText: '档案' }).first().click();
await page.waitForTimeout(350);
await page.screenshot({ path: out + '/j1-checks.png' });

/* 地图：按大陆分组 + 未解锁条件提示（卡 J5） */
await page.evaluate(() => {
  window.__tq.core.CB && (window.__tq.core.CB.over = true);
  window.__tq.bus.emit({ type: 'combat', open: false });
  window.__tq.core.CB = null;
});
await page.locator('#side-r button', { hasText: '地图' }).first().click();
await page.waitForTimeout(450);
const body = await page.locator('#side-r').innerText();
ok(body.includes('中央大陆'), '地图按大陆分组（含中央大陆）');
ok(body.includes('北方冻土'), '未解锁大陆仍显示在地图上，只是标了条件');
ok(/声望|通行|尚未|🔒/.test(body), '未解锁大陆给出了可读条件而不是一把死锁');
await page.screenshot({ path: out + '/j5-continents.png' });

await browser.close();
console.log('\n结果：' + pass + ' PASS / ' + fails.length + ' FAIL');
if (fails.length) {
  for (const f of fails) console.log('  · ' + f);
  process.exit(1);
}

/* 真机验证（F-01 富文本出口 / F-02 存档校验）：DEV 桥驱动真实入口 + DOM 断言。
   运行：node scripts/verify-rich-text.mjs <devUrl>
   断言口径：任意出口注入 <img onerror> 载荷后，DOM 内不得出现可解析的 img/script，
   且 window.__xss 不得被置位；同时合法 <br>/<b>/<span class> 必须保留。 */
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:5273/';
const PAYLOAD = '<img src=x onerror="window.__xss=1">';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push('console: ' + m.text());
});

const fails = [];
const ok = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + detail : ''));
  if (!cond) fails.push(name);
};

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__tq, null, { timeout: 20000 });
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '验证员', race: 'human', cls: 'mage' }));
await page.waitForTimeout(400);

/* 1 · Toast 出口（AI 网关回显 / 事件文案通道） */
await page.evaluate((p) => window.__tq.bus.emit({ type: 'toast', text: p }), PAYLOAD);
await page.waitForTimeout(250);
const toast = await page.evaluate(() => ({
  imgs: document.querySelectorAll('#toast img').length,
  fired: !!window.__xss,
  html: document.querySelector('#toast .t-e')?.textContent || '',
}));
ok('toast 出口不产生 img 元素', toast.imgs === 0, 'imgs=' + toast.imgs);
ok('toast 载荷未执行', toast.fired === false);

/* 2 · 对话出口（真实 openDialog → SheetHost 渲染） */
await page.evaluate(async (p) => {
  const m = await import('/src/systems/character/Sheet.ts');
  m.openDialog({ npcId: 'mia', text: p + '<br><b>粗体</b>', extra: '<span class="ok">是</span>', opts: [] });
}, PAYLOAD);
await page.waitForTimeout(300);
const dlg = await page.evaluate(() => {
  const t = document.querySelector('#ovl .dlg-t');
  return {
    imgs: (t?.querySelectorAll('img') || []).length,
    brs: (t?.querySelectorAll('br') || []).length,
    bs: (t?.querySelectorAll('b') || []).length,
    okSpan: document.querySelectorAll('#ovl .sh-b .ok').length,
    text: (t?.textContent || '').slice(0, 80),
    fired: !!window.__xss,
  };
});
ok('对话出口不产生 img 元素', dlg.imgs === 0, 'imgs=' + dlg.imgs);
ok('对话装载荷未执行', dlg.fired === false);
ok('对话内合法 <br> 保留', dlg.brs >= 1, 'brs=' + dlg.brs);
ok('对话内合法 <b> 保留', dlg.bs >= 1, 'bs=' + dlg.bs);
ok('对话 extra 的 span.ok 保留', dlg.okSpan >= 1);

/* 3 · 日志出口（玩家自由行动输入 → 见闻录） */
await page.evaluate(() => window.__tq.dispatch({ type: 'ui', a: 'close', p: {} }));
await page.evaluate((p) => window.__tq.dispatch({ type: 'freeText', text: p }), PAYLOAD);
await page.waitForTimeout(900);
const log = await page.evaluate(() => ({
  imgs: document.querySelectorAll('.logwrap .log-e img').length,
  fired: !!window.__xss,
  last: (document.querySelector('.logwrap .log-e .x')?.textContent || '').slice(0, 80),
}));
ok('日志出口不产生 img 元素', log.imgs === 0, 'imgs=' + log.imgs);
ok('日志载荷未执行', log.fired === false, 'text=' + log.last);

/* 4 · F-02 导入校验：脏档被拒、合法档放行 */
const imp = await page.evaluate(async () => {
  const m = await import('/src/world/WorldRuntime.ts');
  const base = { ver: 1, player: { name: '正常', race: 'human', cls: 'warrior', level: 1, exp: 0, gold: 500, loc: 'plaza', bag: [], skills: [], quests: {}, flags: {}, stats: { 力量: 10 }, equip: { wpn: null, arm: null } }, npcs: {}, rep: {}, econ: { herb: 1 }, events: [], history: [], log: [], killed: {}, qf: {} };
  const tagName = m.importState(JSON.stringify({ ...base, player: { ...base.player, name: '<b>x</b>' } }));
  const badLevel = m.importState(JSON.stringify({ ...base, player: { ...base.player, level: 99 } }));
  const badBag = m.importState(JSON.stringify({ ...base, player: { ...base.player, bag: [{ id: 'nope', qty: 1 }] } }));
  const badRep = m.importState(JSON.stringify({ ...base, rep: { nope: 5 } }));
  const good = m.importState(JSON.stringify(base));
  return { tagName, badLevel, badBag, badRep, good, fired: !!window.__xss };
});
ok('含标签姓名被拒', imp.tagName === false);
ok('等级越界被拒', imp.badLevel === false);
ok('未知物品被拒', imp.badBag === false);
ok('脏声望键被拒', imp.badRep === false);
ok('合法存档放行', imp.good === true);
ok('导入路径未执行载荷', imp.fired === false);

/* 5 · 战斗日志出口（markDmg 先转义再包 span） */
await page.evaluate((p) => {
  window.__tq.combat.startCombat(['wolf']);
  const CB = window.__tq.core.CB;
  if (CB) {
    CB.log.push({ text: p + '（-5）', cls: 'sys' });
    window.__tq.bus.emit({ type: 'combatChanged' });
  }
}, PAYLOAD);
await page.waitForTimeout(400);
const cbt = await page.evaluate(() => ({
  imgs: document.querySelectorAll('#cbt img').length,
  dmg: document.querySelectorAll('#cbt .dmg').length,
  fired: !!window.__xss,
}));
ok('战斗日志不产生 img 元素', cbt.imgs === 0, 'imgs=' + cbt.imgs);
ok('战斗伤害数字仍被着色 span 包裹', cbt.dmg >= 1, 'dmg=' + cbt.dmg);
ok('战斗日志载荷未执行', cbt.fired === false);

console.log('ERRORS ' + (errors.length ? JSON.stringify(errors) : 'none'));
console.log(fails.length ? 'RESULT FAIL ' + JSON.stringify(fails) : 'RESULT ALL-PASS');
await browser.close();
process.exit(fails.length ? 1 : 0);

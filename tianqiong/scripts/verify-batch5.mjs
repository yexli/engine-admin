/* 真机验证（批次五）：
   F-27 学院面板导师人设 = people.json（单一真相源）
   F-29 神选阶段地点不直出内部代号
   运行：node scripts/verify-batch5.mjs <devUrl> */
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:5273/';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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

/* F-27：学院面板导师人设逐字等于 people.json */
const mentor = await page.evaluate(async () => {
  const { mentorOf } = await import('/src/systems/academy/Academy.ts');
  const { WB } = await import('/src/data/worldBook.ts');
  const view = mentorOf('imperial');
  const vandel = WB.npcs.vandel;
  return { goal: view.goal, expect: vandel.goal, title: view.title, worldTitle: vandel.title };
});
ok('F-27 mentor.goal 等于 people.json', mentor.goal === mentor.expect, String(mentor.goal).slice(0, 24));
ok('F-27 mentor.title 为学院侧头衔（显式覆盖）', mentor.title !== mentor.worldTitle, mentor.title);

/* F-29：神选面板地点为人类可读中文 */
await page.evaluate(() => {
  window.__tq.core.S.player.flags.theoselect_open = true;
  window.__tq.dispatch({ type: 'sceneAction', k: 'theoselect_menu' });
});
await page.waitForTimeout(400);
await page.evaluate(() => window.__tq.dispatch({ type: 'ui', a: 'close', p: {} }));
/* 桌面视口下 #tabbar 被 display:none，这个点击注定失败：给短超时，别把 30s 默认值耗完
   （空等期间页面若被 dev server HMR 重载，core.S 会归零，后续断言会读到假失败）。 */
await page.locator('#tabbar, .tabs button', { hasText: '任务' }).first().click({ timeout: 2000 }).catch(() => {});
await page.waitForTimeout(300);
/* 移动端标签栏在 1280px 隐藏，直接切 store 的 srTab */
await page.evaluate(() => window.__tq && window.__tq.dispatch({ type: 'ui', a: 'close', p: {} }));
const clue = await page.evaluate(async () => {
  const { theoselectView } = await import('/src/systems/religion/Theoselect.ts');
  const v = theoselectView(window.__tq.core.S);
  return { loc: v.stageLoc, locName: v.stageLocName, stage: v.stage };
});
ok('F-29 stageLocName 不是内部代号', clue.locName !== clue.loc && /[\u4e00-\u9fa5]/.test(clue.locName), clue.stage + ' → ' + clue.locName);

console.log('ERRORS ' + (errors.length ? JSON.stringify(errors) : 'none'));
console.log(fails.length ? 'RESULT FAIL ' + JSON.stringify(fails) : 'RESULT ALL-PASS');
await browser.close();
process.exit(fails.length ? 1 : 0);

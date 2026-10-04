/* 真机验证（批次四）：
   F-21 存档介质回落必须可见
   F-22 面板异常触发兜底页（而非白屏）
   F-24 标题页在游戏内不再挂载（条件渲染）
   运行：node scripts/verify-batch4.mjs <devUrl> */
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:5273/';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
});

const fails = [];
const ok = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + detail : ''));
  if (!cond) fails.push(name);
};

/* 1 · F-21：伪装成 Tauri 壳但 SQLite 不可用 → 必须明确提示当前介质 */
{
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = {};
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const toast = await page.locator('#toast').innerText().catch(() => '');
  const foot = await page.locator('.foot').innerText().catch(() => '');
  ok('F-21 回落时给出明确提示', toast.includes('SQLite 存档不可用'), JSON.stringify(toast.slice(0, 60)));
  ok('F-21 标题页显示当前介质', foot.includes('浏览器本地存档'), foot);
  await page.close();
}

/* 2/3 · F-22 兜底页 + F-24 标题页条件渲染 */
{
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 60)));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__tq, null, { timeout: 20000 });
  await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '验证员', race: 'human', cls: 'warrior' }));
  await page.waitForTimeout(400);

  const titleMounted = await page.evaluate(() => !!document.querySelector('#scr-title')?.innerHTML?.trim());
  ok('F-24 游戏中标题页不再挂载', titleMounted === false);

  /* 让角色页读到坏数据 → 触发渲染异常 → 错误边界接管 */
  await page.evaluate(() => {
    window.__tq.core.S.player.stats = undefined;
  });
  await page.locator('#tabbar button', { hasText: '角色' }).click();
  await page.waitForTimeout(600);
  const rescue = await page.getByText('世界运行中断').count();
  ok('F-22 面板异常显示兜底页而非白屏', rescue > 0);
  const exportBtn = await page.getByText('导出当前存档').count();
  ok('F-22 兜底页提供导出出口', exportBtn > 0);

  await page.getByRole('button', { name: '重置世界' }).click();
  await page.waitForTimeout(500);
  const backToTitle = await page.locator('.btn-title').count();
  ok('F-22 兜底页可重置回扉页', backToTitle > 0);
  console.log('PAGEERRORS ' + (errors.length ? JSON.stringify(errors) : 'none'));
  await page.close();
}

console.log(fails.length ? 'RESULT FAIL ' + JSON.stringify(fails) : 'RESULT ALL-PASS');
await browser.close();
process.exit(fails.length ? 1 : 0);

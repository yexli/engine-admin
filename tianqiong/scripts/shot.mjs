/* 双端截图目检脚本：复用系统 Edge（本机 Playwright 无下载浏览器）
 * 用法：node scripts/shot.mjs <baseUrl> <outDir>
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:5273/';
const out = process.argv[3] || '界面截图';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox', '--allow-file-access-from-files'],
});

const shots = [];
async function shoot(page, name) {
  const p = `${out}/${name}.png`;
  await page.screenshot({ path: p });
  shots.push(p);
  console.log('SHOT', p);
}

/* ---------- 手机 430×932 ---------- */
{
  const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await shoot(page, 'm1-标题');

  await page.getByText('开启新的旅程').click();
  await page.fill('#inp-name', '叶澜');
  await shoot(page, 'm2-创角');

  await page.getByText('踏入世界').click();
  await page.waitForTimeout(500);
  await shoot(page, 'm3-世界');

  // NPC 对话（广场应有米娅；若没有则跳过）
  const chip = page.locator('.npc-chip').first();
  if (await chip.count()) {
    await chip.click();
    await page.waitForTimeout(450);
    await shoot(page, 'm4-对话');
    await page.locator('#ovl .sh-h .x').click();
  }

  // 检定卡：点观察环境
  await page.locator('.act', { hasText: '观察环境' }).click();
  await page.waitForTimeout(300);
  await shoot(page, 'm5-检定');
  await page.waitForTimeout(1400);

  // 战斗：经 dev 桥直启
  await page.evaluate(() => window.__tq.combat.startCombat(['wolf', 'rabbit']));
  await page.waitForTimeout(400);
  await shoot(page, 'm6-战斗');

  // 底部 Tab → 系统面板（经 dev 桥强制关闭战斗层）
  await page.evaluate(() => {
    window.__tq.core.CB && (window.__tq.core.CB.over = true);
    window.__tq.bus.emit({ type: 'combat', open: false });
    window.__tq.core.CB = null;
  });
  await page.waitForTimeout(600);
  await page.locator('#tabbar button', { hasText: '系统' }).click();
  await page.waitForTimeout(300);
  await shoot(page, 'm7-系统');
  await page.close();
}

/* ---------- 桌面 1280×800 ---------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.getByText('开启新的旅程').click();
  await page.getByText('踏入世界').click();
  await page.waitForTimeout(500);
  await shoot(page, 'd1-三栏世界');

  // 插画试点：广场场景横幅应有真图
  await page.evaluate(() => window.__tq.dispatch({ type: 'travel', loc: 'tavern' }));
  await page.waitForTimeout(500);
  await shoot(page, 'd2-酒馆');
  await page.close();
}

await browser.close();
console.log('DONE', shots.length);

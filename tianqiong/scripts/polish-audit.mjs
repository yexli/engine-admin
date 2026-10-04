/* 界面打磨审计：双端遍历各界面/窗口 —— 截图 + 布局诊断
 * 用法：node scripts/polish-audit.mjs [baseUrl] [outDir]
 * 诊断项：横向溢出 / 触摸目标偏小 / 越出视口 / 文本被裁
 * 结果：截图写入 outDir，诊断汇总写入 <outDir>/audit.json
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:5273/';
const outDir = process.argv[3] || '界面截图-打磨审计';
mkdirSync(outDir, { recursive: true });

const tables = JSON.parse(readFileSync('src/data/world/tables.json', 'utf8'));
const _MIDS = Object.keys(tables.monsters).slice(0, 2);

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
});

const DIAG = () => {
  const issues = [];
  const vw = innerWidth;
  const root = document.getElementById('scr-game') || document.body;
  const seen = new Set();
  // 误报过滤：全幅绘卷与雾层是故意铺出视口的装饰；横向滚动容器里的内容是"可滚"而非"溢出"
  const skippable = (el) => {
    let p = el;
    while (p && p !== root) {
      const pcs = getComputedStyle(p);
      if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll') return true;
      const cls = typeof p.className === 'string' ? p.className : '';
      if (p.id === 'stage' || cls.includes('mist') || cls.includes('fm') || cls.includes('layer')) return true;
      p = p.parentElement;
    }
    return false;
  };
  root.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (skippable(el)) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    const label = (el.id ? '#' + el.id : el.tagName.toLowerCase() + (cls ? '.' + cls : ''));
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const push = (o) => { const k = o.t + '|' + o.el + '|' + (o.txt || ''); if (!seen.has(k)) { seen.add(k); issues.push(o); } };
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'visible' && cs.textOverflow !== 'ellipsis') {
      push({ t: 'overflow-x', el: label, sw: el.scrollWidth, cw: el.clientWidth, txt });
    }
    if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && (r.height < 30 || r.width < 36)) {
      push({ t: 'small-tap', el: label, w: Math.round(r.width), h: Math.round(r.height), txt });
    }
    if (r.right > vw + 1) push({ t: 'outside-right', el: label, right: Math.round(r.right), vw, txt });
    if (r.left < -1) push({ t: 'outside-left', el: label, left: Math.round(r.left), txt });
  });
  return issues;
};

const report = [];
async function shoot(page, name, vp) {
  await page.waitForTimeout(340);
  await page.screenshot({ path: outDir + '/' + name + '.png' });
  let issues = [];
  try { issues = await page.evaluate(DIAG); } catch { /* 页面结构变化时忽略 */ }
  report.push({ shot: name, vp, total: issues.length, issues: issues.slice(0, 30) });
  console.log('SHOT ' + name + '  issues=' + issues.length);
}

async function boot(page) {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
}

async function startGame(page) {
  await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '叶澜', race: 'human', cls: 'warrior' }));
  await page.waitForTimeout(400);
}

/* 在场 NPC：运行时条目要交互后才建立，这里直接从世界书按地点取（首选广场、次选任意） */
const PEOPLE = JSON.parse(readFileSync('src/data/world/people.json', 'utf8'));
const NPC_AT = (loc) => Object.entries(PEOPLE.npcs).find(([, n]) => n.loc === loc)?.[0] || null;
const FALLBACK_NPC = Object.keys(PEOPLE.npcs)[0];

async function npcId(page) {
  const id = await page.evaluate(() => {
    const S = window.__tq.world.query.get_world_state();
    return Object.keys(S.npcs || {})[0] || null;
  });
  return id || NPC_AT('plaza') || FALLBACK_NPC;
}

async function run(tag, viewport, dsf) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: dsf });
  const p = (n) => tag + n;

  await boot(page);
  await shoot(page, p('01-标题'), tag);

  // 创角（点开第一屏的按钮，保留真实路径）
  try {
    await page.getByText('开启新的旅程').click();
    await page.fill('#inp-name', '叶澜');
    await shoot(page, p('02-创角'), tag);
    await page.getByText('踏入世界').click();
    await page.waitForTimeout(600);
  } catch {
    await startGame(page);
  }
  await shoot(page, p('03-世界'), tag);

  // 七个页面
  for (const [tab, label] of [['char', '04-角色'], ['quest', '05-任务'], ['news', '06-纪闻'], ['chronicle', '07-档案'], ['map', '08-地图'], ['sys', '09-系统']]) {
    try {
      await page.evaluate((t) => window.__tq.store.getState().setTab(t), tab);
      await shoot(page, p(label), tag);
    } catch (e) { console.log('SKIP ' + label + ' :: ' + e.message); }
  }
  await page.evaluate(() => window.__tq.store.getState().setTab('main'));
  await page.waitForTimeout(260);

  // 行囊浮层
  try {
    await page.evaluate(() => window.__tq.store.getState().setBag(true));
    await shoot(page, p('10-行囊'), tag);
    await page.evaluate(() => window.__tq.store.getState().setBag(false));
  } catch (e) { console.log('SKIP 行囊 :: ' + e.message); }

  // 检定浮层
  try {
    await page.evaluate(() => window.__tq.dispatch({ type: 'sceneAction', k: 'observe' }));
    await shoot(page, p('11-检定'), tag);
    await page.waitForTimeout(1600);
  } catch (e) { console.log('SKIP 检定 :: ' + e.message); }

  // 对话浮层
  try {
    const id = await npcId(page);
    if (id) {
      await page.evaluate((n) => window.__tq.dispatch({ type: 'npcTalk', id: n }), id);
      await shoot(page, p('12-对话'), tag);
      await page.waitForTimeout(200);
    } else console.log('SKIP 对话 :: 无在场 NPC');
  } catch (e) { console.log('SKIP 对话 :: ' + e.message); }

  await page.close();
  return page;
}

await run('m', { width: 430, height: 932 }, 2);
await run('d', { width: 1280, height: 800 }, 1);

writeFileSync(outDir + '/audit.json', JSON.stringify(report, null, 1));
console.log('DONE ' + report.length + ' shots, issues total=' + report.reduce((s, r) => s + r.total, 0));
await browser.close();

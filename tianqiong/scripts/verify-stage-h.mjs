/* ============================================================
   阶段 H 端到端自检（无头 Edge · 复用 5273 上的 DEV 桥 __tq）
   覆盖：H4 地下城 Overlay / H6 学院面板 / H6 万神殿面板 /
        H5 百年神选菜单 + 纪闻卡 / H3 路人署名 / H2 星渊入口
   用法：node scripts/verify-stage-h.mjs [baseUrl] [outDir]
   ============================================================ */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:5273/';
const out = process.argv[3] || 'stage-h-verify';
mkdirSync(out, { recursive: true });

const errors = [];
const log = (...a) => console.log(...a);

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('[console] ' + m.text());
});
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
const missing = [];
page.on('response', (r) => {
  if (r.status() === 404) missing.push(r.url().replace(base, ''));
});

const shot = async (n) => {
  await page.screenshot({ path: out + '/' + n + '.png' });
  log('SHOT', n);
};
/** 运行一段浏览器内脚本并取回 JSON 结果 */
const evalTq = (fn, arg) => page.evaluate(fn, arg);

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.getByText('开启新的旅程').click();
  await page.fill('#inp-name', '阶段H');
  await page.getByText('踏入世界').click();
  await page.waitForTimeout(500);
  log('BOOT ok');

  /* ---------- H4 · 地下城 100 层 ---------- */
  const dungeon = await evalTq(() => {
    const t = window.__tq;
    const S = t.core.S;
    S.player.gold = 5000;
    S.player.level = 5;
    S.dungeon = { floor: 0, best: 50, inRun: false, cleared: [], escapes: 0 };
    S.player.loc = 'cave3';
    t.dispatch({ type: 'sceneAction', k: 'enter_dungeon' });
    return { floor: S.dungeon.floor, inRun: S.dungeon.inRun, entry: S.dungeon.entry };
  });
  log('H4 enter:', JSON.stringify(dungeon));
  await page.waitForTimeout(350);
  await shot('h4-1-地下城入口菜单');
  /* 关掉 ConfirmSheet 后看常驻 HUD：下潜两层 */
  const climbed = await evalTq(() => {
    const t = window.__tq;
    const S = t.core.S;
    t.dispatch({ type: 'ui', a: 'dungeon_next', p: {} });
    const f1 = S.dungeon.floor;
    t.dispatch({ type: 'ui', a: 'dungeon_next', p: {} });
    return { f1, floor: S.dungeon.floor, best: S.dungeon.best, inCombat: !!t.core.CB, theme: S.dungeon.floor };
  });
  log('H4 climb:', JSON.stringify(climbed));
  /* 常驻 HUD 只在「非战斗/非检定」时出现：清掉层内遭遇的演出层后再截图 */
  await evalTq(() => {
    const t = window.__tq;
    t.core.CB = null;
    t.bus.emit({ type: 'combat', open: false });
    t.bus.emit({ type: 'sheet', desc: null });
    t.bus.emit({ type: 'check', desc: null });
    const S = t.core.S;
    S.player.loc = 'cave3';
    S.dungeon.entry = 'cave3';
    S.dungeon.inRun = true;
    S.dungeon.floor = 62;
    S.dungeon.best = 62;
    t.dispatch({ type: 'changed' });
  });
  await page.waitForTimeout(500);
  await shot('h4-2-地下城HUD');
  const hudText = await page.locator('body').innerText();
  log(
    'H4 常驻HUD:',
    'FLOOR标记=' + hudText.includes('FLOOR'),
    '下潜=' + hudText.includes('下潜'),
    '撤退=' + hudText.includes('撤退'),
    '历史最深=' + hudText.includes('历史最深'),
  );
  /* 深层主题 + 魔气 / 层志 / 100 层深渊钩子 */
  const deep = await evalTq(() => {
    const t = window.__tq;
    const S = t.core.S;
    t.core.CB = null;
    S.dungeon.floor = 80;
    t.dispatch({ type: 'ui', a: 'dungeon_next', p: {} });
    const themeDeep = S.dungeon.floor;
    t.core.CB = null;
    S.dungeon.floor = 99;
    t.dispatch({ type: 'ui', a: 'dungeon_next', p: {} });
    return {
      deepFloor: themeDeep,
      abyssFloor: S.dungeon.floor,
      abyssFlag: !!S.player.flags.dungeon_abyss_reached,
      history: S.history.some((h) => h.c.includes('抵达地下城最深')),
      best: S.dungeon.best,
    };
  });
  log('H4 deep+abyss:', JSON.stringify(deep));
  await page.waitForTimeout(300);
  await shot('h4-3-深渊100层');

  /* ---------- H6 · 培养学院面板 ---------- */
  await evalTq(() => {
    const t = window.__tq;
    /* 深渊层 BOSS 战斗会开全屏战斗层：必须经总线收起，仅置 core.CB=null 不够 */
    t.core.CB = null;
    t.bus.emit({ type: 'combat', open: false });
    t.bus.emit({ type: 'sheet', desc: null });
    t.core.S.dungeon.inRun = false;
    t.core.S.dungeon.floor = 0;
    t.core.S.player.loc = 'plaza';
    t.core.S.player.gold = 20000;
    t.dispatch({ type: 'changed' });
  });
  await page.waitForTimeout(300);
  await page.locator('#tabbar button').filter({ hasText: '系统' }).click();
  await page.waitForTimeout(300);
  await shot('h6-0-系统面板入口');
  const sysText = await page.locator('#view').innerText();
  log('H6 sys entry cards:', sysText.includes('培养学院'), sysText.includes('万神殿'));
  const deityBtn = page.getByText('万神殿（祈祷 / 偏好 / 神迹）');
  if (await deityBtn.count()) {
    await deityBtn.click();
    await page.waitForTimeout(400);
    await shot('h6-1-万神殿');
    const dt = await page.locator('#view').innerText();
    log('H6 deity panel has 阿尔卡斯:', dt.includes('阿尔卡斯'), '| 神之右臂:', dt.includes('神之右臂'), '| 龙神殿:', dt.includes('龙神殿'));
    await page.getByText('返回系统面板').first().click();
    await page.waitForTimeout(250);
  } else log('H6 deity entry button NOT FOUND');
  const academyBtn = page.getByText('培养学院（学籍 / 课程 / 毕业）');
  if (await academyBtn.count()) {
    await academyBtn.click();
    await page.waitForTimeout(400);
    await shot('h6-2-培养学院');
    const acText = await page.locator('#view').innerText();
    log('H6 academy panel has 帝国圣学院:', acText.includes('帝国圣学院'), '| 导师:', acText.includes('范德尔') || acText.includes('导师'));
    await page.getByText('返回系统面板').first().click();
    await page.waitForTimeout(250);
  } else log('H6 academy entry button NOT FOUND');

  /* ---------- NPC 交互面完整性（G10 契约 · 参照 米娅） ---------- */
  const tutorOptions = {};
  for (const id of ['mia', 'tutor_wind', 'tutor_deepwell', 'tutor_skycap', 'tutor_camp']) {
    await evalTq((npcId) => {
      const t = window.__tq;
      t.core.CB = null;
      t.bus.emit({ type: 'combat', open: false });
      t.bus.emit({ type: 'sheet', desc: null });
      t.dispatch({ type: 'npcTalk', id: npcId });
    }, id);
    await page.waitForTimeout(280);
    const opts = await page.locator('.opt').allInnerTexts();
    tutorOptions[id] = opts.map((s) => s.replace(/\s+/g, ' ').trim());
  }
  for (const [k, v] of Object.entries(tutorOptions))
    log('NPC交互面 ' + k + ' (' + v.length + '):', v.join(' | '));
  await shot('h6-3-导师对话');
  const t0 = tutorOptions['mia'] || [];
  const complete = Object.entries(tutorOptions).every(([, v]) => v.some((x) => x.includes('聊天')) && v.some((x) => x.includes('提出请求')) && v.some((x) => x.includes('赠礼')));
  log('全部 NPC 具备 聊天/请求/赠礼:', complete, '| 米娅选项数:', t0.length);
  await evalTq(() => window.__tq.bus.emit({ type: 'sheet', desc: null }));
  await page.waitForTimeout(200);

  /* ---------- H5 · 百年神选 ---------- */
  const ts = await evalTq(() => {
    const t = window.__tq;
    const S = t.core.S;
    t.dispatch({ type: 'ui', a: 'ac_menu', p: {} }); // 复位面板
    S.player.flags.theoselect_open = true;
    S.favor = { war: { favor: 60, rank: '信仰者' } };
    S.player.gold = 20000;
    t.dispatch({ type: 'ui', a: 'ts_enroll', p: { id: 'war' } });
    const th = S.theoselect;
    return {
      enrolled: th.enrolled,
      temple: th.temple,
      stage: th.stage,
      score: th.score,
      candidates: th.candidates.length,
      history: S.history.some((h) => h.c.includes('报名百年神选')),
    };
  });
  log('H5 enroll:', JSON.stringify(ts));
  await page.waitForTimeout(300);
  /* 纪闻面板在桌面三栏的右栏（手机端 side-r 隐藏）：同一页面切到桌面视口核对，
     复用同一存档与内存态，避免另开 context 导致回到标题页 */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  await page.locator('#side-r button').filter({ hasText: '纪闻' }).first().click();
  await page.waitForTimeout(350);
  const news = await page.locator('#side-r').innerText();
  log('H5 纪闻栏含 百年神选:', news.includes('百年神选'), '| 含 星渊:', news.includes('星渊'));
  await page.screenshot({ path: out + '/h5-1-纪闻神选卡.png' });
  log('SHOT h5-1-纪闻神选卡');
  /* 桌面地图面板：地下城网络 + 星斗台入口 */
  await page.locator('#side-r button').filter({ hasText: '地图' }).first().click();
  await page.waitForTimeout(350);
  const map = await page.locator('#side-r').innerText();
  log('H4 地图含 地下城网络:', map.includes('地下城网络'), '| 星斗台:', map.includes('星斗台'));
  await page.screenshot({ path: out + '/h4-4-地图地下城网络.png' });
  log('SHOT h4-4-地图地下城网络');
  await page.setViewportSize({ width: 430, height: 932 });
  await page.waitForTimeout(300);

  /* 阶段推进到候补（直接驱动引擎，验证 UI 倒计时/名次渲染） */
  const advanced = await evalTq(() => {
    const t = window.__tq;
    const S = t.core.S;
    const seen = [S.theoselect.stage];
    for (let i = 0; i < 5 && S.theoselect.stage !== '候补'; i++) {
      /* 走到"下一个日界前一刻"，再推进 1 刻跨日 → time.newDay → theoselectTick → stageAdvance */
      S.theoselect.score = 9999;
      S.t = Math.floor(S.t / 48) * 48 + 47;
      S.theoselect.stageEndsAt = S.t - 1;
      t.dispatch({ type: 'sceneAction', k: 'observe' });
      t.core.CB = null;
      t.bus.emit({ type: 'combat', open: false });
      seen.push(S.theoselect.stage);
    }
    return { seen, stage: S.theoselect.stage, rank: S.theoselect.rank, champion: S.theoselect.champion, flag: !!S.player.flags.theoselect_candidate_god };
  });
  log('H5 advance:', JSON.stringify(advanced));
  await page.waitForTimeout(300);
  await shot('h5-2-神选定局');

  /* ---------- H3 · 路人署名（走观察环境） ---------- */
  const passerby = await evalTq(() => {
    const t = window.__tq;
    const S = t.core.S;
    S.player.loc = 'plaza';
    const before = S.log.length;
    for (let i = 0; i < 12; i++) {
      t.dispatch({ type: 'sceneAction', k: 'observe' });
      t.core.S.t += 5; // 越过检定演出节奏
    }
    const recent = S.log.slice(-12).map((x) => x.text).join('｜');
    return { grew: S.log.length !== before, sample: recent.slice(0, 220) };
  });
  log('H3 observe sample:', passerby.sample);

  /* ---------- H2 · 星渊入口 ---------- */
  const abyss = await evalTq(() => {
    const t = window.__tq;
    const S = t.core.S;
    S.abyss.leak = 3;
    S.player.flags.leak_3 = true;
    t.dispatch({ type: 'ui', a: 'sn_abyss', p: {} });
    return { leak: S.abyss.leak };
  });
  log('H2 abyss:', JSON.stringify(abyss));
  await page.waitForTimeout(300);
  await shot('h2-星渊');

  log('MISSING(404) 资源:', missing.length, [...new Set(missing)].slice(0, 6).join(' , '));
  log(errors.length ? 'CONSOLE ERRORS: ' + errors.length : 'CONSOLE CLEAN');
  for (const e of errors.slice(0, 8)) log('  !', e);
} catch (e) {
  log('FAILED:', e.message);
  errors.push('[script] ' + e.message);
} finally {
  await browser.close();
}
log('DONE errors=' + errors.length);

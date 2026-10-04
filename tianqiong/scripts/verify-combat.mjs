/* 真机验证（卡 I3 · 状态效果 / 暴击 / 情绪 tag）：
   ① 战斗面板渲染状态徽章（图标+剩余回合）
   ② 状态施加（火焰箭命中挂燃烧）→ 回合结算 DoT 扣血 → 过期消散
   ③ 暴击条目进入战斗日志（不是靠文案猜）
   ④ 情绪 tag 由 core 判定（title 标注来源），战斗结束后状态随 CB 清除
   运行：node scripts/verify-combat.mjs <devUrl>（需 npm run dev 常驻 5273） */
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

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__tq, null, { timeout: 20000 });
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '法师', race: 'human', cls: 'mage' }));
await page.waitForTimeout(300);

/* 开战并加厚血条（本轮验的是状态，不是击杀节奏） */
await page.evaluate(() => {
  window.__tq.combat.startCombat(['goblin']);
  const cb = window.__tq.core.CB;
  cb.foes[0].hp = 600;
  cb.foes[0].mhp = 600;
  const s = window.__tq.core.S;
  s.player.mp = 999;
});
await page.waitForTimeout(400);
ok('战斗浮层打开', await page.locator('.cbt-log:visible').count() > 0);

/* ① 状态徽章：直接注入一条燃烧（模拟命中结果），验 UI 渲染 */
await page.evaluate(() => {
  const cb = window.__tq.core.CB;
  cb.foes[0].status = [{ id: 'burn', dur: 3, power: 5, stack: 1 }];
  window.__tq.bus.emit({ type: 'combatChanged' });
});
await page.waitForTimeout(300);
const badge = await page.locator('.foe:visible').first().innerText();
ok('敌人卡渲染状态徽章（燃烧 · 剩余回合）', badge.includes('燃烧'), badge.replace(/\s+/g, ' ').slice(0, 40));

/* ② DoT 生效：一个回合后敌人掉血 */
const hp0 = await page.evaluate(() => window.__tq.core.CB.foes[0].hp);
await page.evaluate(() => window.__tq.combat.playerAct('atk'));
await page.waitForTimeout(900);
const st = await page.evaluate(() => {
  const cb = window.__tq.core.CB;
  return { hp: cb.foes[0].hp, dur: (cb.foes[0].status || []).map((s) => s.id + ':' + s.dur).join(','), log: cb.log.map((e) => e.text).join(' | ') };
});
ok('状态 DoT 在回合结算中扣血', st.hp < hp0, hp0 + ' → ' + st.hp);
ok('状态时长递减（tick）', st.dur !== 'burn:3', st.dur || '（已消散）');
ok('日志出现持续伤害条目', st.log.includes('持续伤害') || st.log.includes('消散'), st.log.slice(-60));

/* ③ 暴击条目：连续出手直到出现 crit（自然 20 或暴击率命中） */
const critFound = await page.evaluate(async () => {
  const cb = window.__tq.core.CB;
  for (let i = 0; i < 60 && cb && !cb.over; i++) {
    window.__tq.core.S.player.hp = 9999;
    window.__tq.core.S.player.mp = 999;
    window.__tq.core.CB.foes[0].hp = 600;
    window.__tq.combat.playerAct('atk');
    await new Promise((r) => window.setTimeout(r, 30));
    if (window.__tq.core.CB && window.__tq.core.CB.log.some((e) => e.crit)) return true;
  }
  return false;
});
ok('暴击写入日志条目 crit 字段', critFound);
const critCls = await page.evaluate(() => Array.from(document.querySelectorAll('.cbt-log .e.crit')).length);
ok('暴击条目在 UI 带 crit 样式类', critCls > 0, 'crit-lines=' + critCls);

/* ④ 情绪 tag 来源标注（core 判定优先） */
await page.evaluate(() => {
  const cb = window.__tq.core.CB;
  if (cb) { cb.over = true; window.__tq.core.CB = null; }
});
await page.evaluate(() => window.__tq.bus.emit({ type: 'combat', open: false }));
await page.evaluate(() => window.__tq.dispatch({ type: 'npcTalk', id: 'lita' }));
await page.waitForTimeout(400);
const emo = await page.locator('.fx-emo:visible').first();
ok('对话头图渲染情绪 tag', (await emo.count()) === 1, await emo.innerText().catch(() => ''));
const emoTitle = await emo.getAttribute('title').catch(() => '');
ok('情绪 tag 标注来源为 core 判定', (emoTitle || '').includes('core 判定'), emoTitle || '');

/* ⑤ 战斗结束后状态不带出：WorldState 序列化里没有 status 字段 */
const leaked = await page.evaluate(() => JSON.stringify(window.__tq.core.S).includes('"status"'));
ok('战斗状态不落档（WorldState 无 status 字段）', leaked === false);
ok('运行期无 JS 异常', errors.length === 0, errors.join(' | ').slice(0, 120));

await browser.close();
console.log(fails.length ? '\nRESULT: FAIL (' + fails.length + ')' : '\nRESULT: ALL PASS');
process.exit(fails.length ? 1 : 0);

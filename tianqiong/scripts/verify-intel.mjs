/* 真机验证（卡 I4 · 军事与情报双轴落地 · 2/7 死轴 → 可玩轴）：
   ① 打听入口按地点出现（城门/酒馆/集市有，神殿没有）
   ② 打听端到端：检定通过 → 情报轴 +1（经 adjRepAxis 落地）+ 推进世界时间
   ③ 情报日上限：连点 4 次只入账 3
   ④ 军功来源：剿匪击杀 → 下一次场景行动结算入账
   ⑤ 四档特权：授予时置 flag + 文案进见闻录（存量档位由 cardI4.test.ts 锁边界）
   ⑥ 角色面板「军事与情报」双轴特权卡（只读档位与解锁进度）
   ⑦ 纪闻面板「预知 · 明日」：提前一日列事件标题（只泄漏标题）
   ⑧ 纪闻面板「情报网 · 远程查询」：人物志 + 问价
   ⑨ 识破：与 lore 相悖的回包被 core 标「·存疑」（AI 只产文本，判定在 core）
   运行：node scripts/verify-intel.mjs [devUrl]（需 dev server 常驻 5273） */
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:5273/';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--no-sandbox'],
});
/* 桌面三栏：左＝角色（双轴特权卡）·右＝纪闻（预知 / 情报网）——两卡都只在可见栏断言 */
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 80)));
const fails = [];
const ok = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' · ' + detail : ''));
  if (!cond) fails.push(name);
};
const state = () =>
  page.evaluate(() => {
    const s = window.__tq.core.S;
    return {
      t: s.t,
      loc: s.player.loc,
      mil: s.playerRep.empire.military,
      intel: s.playerRep.guild.intelligence,
      flags: { ...s.player.flags },
      log: s.log.map((e) => e.text).join('\n'),
      chats: JSON.parse(JSON.stringify(s.chats || {})),
    };
  });
/** 落位：旅行矩阵可能需要中转，本轮验的是"来源→轴→特权"，不是旅行规则 */
const goLoc = async (loc) => {
  await page.evaluate((L) => window.__tq.dispatch({ type: 'travel', loc: L }), loc);
  await page.waitForTimeout(250);
  const cur = await page.evaluate(() => window.__tq.core.S.player.loc);
  if (cur !== loc) {
    await page.evaluate((L) => {
      window.__tq.core.S.player.loc = L;
      window.__tq.bus.emit({ type: 'changed' });
    }, loc);
    await page.waitForTimeout(250);
  }
};
/** 检定演出（#chk.on，1450ms）未收束前，点击会落在浮层上——动手前先等它收 */
const fxIdle = () =>
  page
    .waitForFunction(() => !document.querySelector('#chk.on') && !document.querySelector('.sheet'), null, { timeout: 8000 })
    .catch(() => {});
const tapAct = async (label) => {
  await fxIdle();
  await page.locator('.dock button:visible', { hasText: label }).first().click({ force: true, timeout: 8000 });
  await page.waitForTimeout(1750); // 检定演出 1450ms + 回调落地
  await fxIdle();
};

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__tq, null, { timeout: 20000 });
await page.evaluate(() => window.__tq.dispatch({ type: 'newGame', name: '军情', race: 'human', cls: 'warrior' }));
await page.waitForTimeout(300);
/* 检定必过：感知拉高（本轮验的是"来源→轴"链路，不是掷骰运气） */
await page.evaluate(() => {
  window.__tq.core.S.player.stats['感知'] = 30;
});

/* ① 打听入口按地点出现 */
await goLoc('gate');
const gateBtn = await page.locator('.dock button:visible', { hasText: '打听消息' }).count();
ok('城门出现「打听消息」入口', gateBtn === 1, 'count=' + gateBtn);
await goLoc('temple');
const templeBtn = await page.locator('.dock button:visible', { hasText: '打听消息' }).count();
ok('神殿不出现「打听消息」（仅城门 / 酒馆 / 集市）', templeBtn === 0, 'count=' + templeBtn);
await goLoc('gate');

/* ② 打听端到端 → 情报 +1 */
const t0 = (await state()).t;
await tapAct('打听消息');
let st = await state();
ok('打听推进世界时间（1 刻）', st.t === t0 + 1, t0 + ' → ' + st.t);
ok('打听成功 → 情报轴 +1（经 adjRepAxis 落地）', st.intel === 1, 'intelligence=' + st.intel);

/* ③ 情报日上限 3 */
for (let i = 0; i < 3; i++) await tapAct('打听消息');
st = await state();
ok('打听日上限 +3（已点 4 次）', st.intel === 3, 'intelligence=' + st.intel);

/* ④ 军功来源：剿匪击杀 → 场景行动边界结算 */
await page.evaluate(() => {
  window.__tq.core.S.killed.bandit = 2;
  window.__tq.bus.emit({ type: 'changed' });
});
const beforeMil = (await state()).mil;
await tapAct('观察环境');
st = await state();
ok('剿匪击杀 ×1 入军功（2 只 → +2）', st.mil === beforeMil + 2, beforeMil + ' → ' + st.mil);

/* ⑤ 特权授予（军职 70 / 识破 60）：置 flag + 文案进见闻录；
      盘查 ×0.5 的数值由 cardI4.test.ts 锁定（浏览器侧只验授权与文案） */
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.playerRep.empire.military = 70;
  s.playerRep.guild.intelligence = 60;
  window.__tq.bus.emit({ type: 'changed' });
});
await tapAct('观察环境');
st = await state();
ok(
  '特权授予：军职 / 征召 / 识破 flag 已置',
  st.flags.priv_gate === true && st.flags.priv_levy === true && st.flags.priv_insight === true,
  JSON.stringify({ gate: st.flags.priv_gate, levy: st.flags.priv_levy, insight: st.flags.priv_insight, net: st.flags.priv_net }),
);
ok('特权文案进见闻录（一次性播报）', ['（征召）', '（军职）', '（识破）'].every((k) => st.log.includes(k)), '见闻录含特权解锁行');

/* ⑥ 角色面板：双轴特权卡（只读） */
const axisCard = page.locator('.card:visible', { hasText: '军事与情报' }).first();
const axisText = (await axisCard.innerText().catch(() => '')).replace(/\s+/g, ' ');
ok('角色面板出现「军事与情报」双轴特权卡', (await axisCard.count()) === 1, axisText.slice(0, 96));
ok(
  '双轴档位与解锁进度只读呈现（3/3 档 · 已解锁 3/4）',
  axisText.includes('军事 · 帝国') && axisText.includes('情报 · 公会') && axisText.includes('3/3 档') && axisText.includes('已解锁 3/4'),
  axisText.slice(0, 140),
);

/* ⑦ 纪闻面板：预知（≥40）提前一日列事件标题（只标题，不泄漏效果） */
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.t = 3 * 48; // 第 4 日 → 明日第 5 日（bard：dayMin 5）
  s.playerRep.guild.intelligence = 70;
  window.__tq.bus.emit({ type: 'changed' });
});
await tapAct('观察环境');
await page.locator('#side-r .side-h button:visible', { hasText: '纪闻' }).first().click({ force: true });
await page.waitForTimeout(350);
const news = page.locator('#side-r .pbody:visible').first();
const newsText = (await news.innerText().catch(() => '')).replace(/\s+/g, ' ');
ok('纪闻面板出现「预知 · 明日」卡', newsText.includes('预知 · 明日'), newsText.slice(0, 96));
const fCard = (await page.locator('.card:visible', { hasText: '预知 · 明日' }).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
ok('预知列出明日事件标题（游吟诗人之夜）', fCard.includes('游吟诗人之夜'), fCard.slice(0, 140));
ok('泄漏度＝标题（不含余波 / 数值 / 后果）', fCard.includes('明日') && !fCard.includes('余波') && !fCard.includes('声望') && !fCard.includes('物价'), fCard.slice(0, 140));

/* ⑧ 情报网（≥80）：远程查人物志 / 问价 */
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.playerRep.guild.intelligence = 80;
  window.__tq.bus.emit({ type: 'changed' });
});
await tapAct('观察环境');
await page.waitForTimeout(250);
const webText = (await page.locator('#side-r .pbody:visible').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
ok('纪闻面板出现「情报网 · 远程查询」卡', webText.includes('情报网 · 远程查询'), webText.slice(0, 96));
ok('情报网含人物志与问价两段（不移动也能查到）', webText.includes('人物志') && webText.includes('问价') && webText.includes('铜'), webText.slice(0, 220));

/* ⑨ 识破：与 lore 相悖的回包被 core 标「·存疑」 */
await page.evaluate(() => {
  const s = window.__tq.core.S;
  s.chats = { galon: [{ who: 'n', text: '老辈人说这片大陆共有八块大陆。', day: 1 }] };
  window.__tq.bus.emit({ type: 'changed' });
});
await tapAct('观察环境');
st = await state();
ok('识破：相悖回包标「·存疑」（判定在 core，AI 只产文本）', (st.chats.galon?.[0]?.text || '').includes('·存疑'), st.chats.galon?.[0]?.text || '(无)');

ok('运行期无 JS 异常', errors.length === 0, errors.join(' | ').slice(0, 120));
await browser.close();
console.log(fails.length ? '\nRESULT: FAIL (' + fails.length + ')' : '\nRESULT: ALL PASS');
process.exit(fails.length ? 1 : 0);

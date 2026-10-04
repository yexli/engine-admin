import { chromium } from 'playwright-core';

/* ============================================================
   叙事滚动行为的护栏（方案 B 落地后重写）

   旧版守的是「倒序 + sticky-bottom + ↓N 条新见闻角标」，来自 §9#6 那条
   用户实测反馈「行动后跳底影响体验」。方案 B 把叙事改成**正序流**
   （旧→新，最新在下），那条抱怨的前提随之消失——倒序下"滚到底"等于
   滚到最老的一条，正序下滚到底就是滚到刚发生的事。

   现在守的是新契约：
     S0 贴底时行动 → 跟到最新（新条目在视野内）
     S1 翻到历史时行动 → 原地不动（不把人拽走）
     S2 内容不足一屏时不做无谓滚动
     S3 换地点 → 新地点的叙事在视野内
   ============================================================ */
const b = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const p = await b.newPage({ viewport: { width: 430, height: 932 } });
await p.goto('http://127.0.0.1:5273/', { waitUntil: 'networkidle' });
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'networkidle' });
await p.getByText('开启新的旅程').click();
await p.getByText('踏入世界').click();
await p.waitForTimeout(700);

const state = () =>
  p.evaluate(() => {
    const s = document.getElementById('story');
    return {
      top: Math.round(s.scrollTop),
      max: Math.round(s.scrollHeight - s.clientHeight),
      atBottom: s.scrollHeight - s.scrollTop - s.clientHeight < 8,
      lines: document.querySelectorAll('#view-log .nar-line').length,
      lastBottom: Math.round((document.querySelector('#view-log .nar-line:last-child')?.getBoundingClientRect().bottom) ?? -1),
      viewBottom: Math.round(s.getBoundingClientRect().bottom),
    };
  });

async function settle() {
  let last = -1;
  for (let i = 0; i < 24; i++) {
    const now = await p.evaluate(() => document.getElementById('story').scrollTop);
    if (Math.abs(now - last) < 1) return;
    last = now;
    await p.waitForTimeout(100);
  }
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + '  ' + JSON.stringify(detail)); ok ? pass++ : fail++; };

/* 灌 20 条日志，制造可滚动内容 */
await p.evaluate(() => {
  for (let i = 0; i < 20; i++) window.__tq.dispatch({ type: 'freeText', text: '追一只猫' + i });
});
await p.waitForTimeout(900);
await settle();

/* S0 贴底时行动 → 跟到最新 */
await p.evaluate(() => { const s = document.getElementById('story'); s.scrollTop = s.scrollHeight; });
await settle();
const before = await state();
await p.evaluate(() => window.__tq.dispatch({ type: 'sceneAction', k: 'observe' }));
await p.waitForTimeout(2200);
await settle();
let s = await state();
check('S0 贴底时跟到最新', s.atBottom && s.lines > before.lines, s);

/* S1 翻到历史时行动 → 不打扰 */
await p.evaluate(() => { document.getElementById('story').scrollTop = 0; });
await settle();
const held = await state();
await p.evaluate(() => window.__tq.dispatch({ type: 'sceneAction', k: 'search' }));
await p.waitForTimeout(2200);
await settle();
s = await state();
check('S1 翻历史时不打扰', s.top === held.top && s.lines > held.lines, { held: held.top, now: s.top, lines: s.lines });

/* S2 换地点 → 新叙事可见 */
await p.evaluate(() => window.__tq.dispatch({ type: 'travel', loc: 'tavern' }));
await p.waitForTimeout(1800);
await settle();
s = await state();
check('S2 换地点后可见最新', s.atBottom, s);

console.log(pass + ' PASS / ' + fail + ' FAIL');
await b.close();
process.exit(fail ? 1 : 0);

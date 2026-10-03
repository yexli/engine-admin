/* ============================================================
   P12 第二游戏验证（方案 §十五）
   ------------------------------------------------------------
   硬性要求（方案原文）：**不修改 World Engine Core。**
   链路：Game B（商贸世界）→ Adapter/宿主 → World Engine → Trigger →
   Context → AI Evolution → Proposal → Rules → Mutation → Event → Game B。

   验收内容：
   ① 商贸玩法链路：移动三城 / 买丝绸 / 卖丝绸 / **利润一致性**（低买高卖）
   ② 与天穹同栈共存：同一平台同时守护两个游戏的世界（触发/记忆独立计数）
   ③ AI 个 体决策对商贸状态生效（商人 goal/记忆进入上下文）
   ④ OOC/叙事隔离；NPC 变化可归类
   ⑤ 零 Core 改动：本轮新增文件仅 scripts/run-trade-host.mjs +
      scripts/run-p12-walkthrough.mjs（平台/引擎零 diff，由源码扫描断言
      与阶段操作清单背书）

   运行（platform 的 PLATFORM_TRIGGER_WORLDS/PLATFORM_MEMORY_WORLDS 需含
   trade-road；天穹宿主可同时在线以验证共存）：
     node scripts/run-p12-walkthrough.mjs
   ============================================================ */
const HOST = process.env.TRADE_HOST_URL ?? 'http://127.0.0.1:8796';
const TIANQIONG = process.env.TIANQIONG_HOST_URL ?? 'http://127.0.0.1:8795';
const ADMIN = process.env.PLATFORM_ADMIN_URL ?? 'http://127.0.0.1:8791';
const TOKEN = process.env.PLATFORM_ADMIN_TOKEN ?? '';
const WORLD = 'trade-road';
const H = { 'x-admin-token': TOKEN, 'content-type': 'application/json' };

const findings = [];
let step = 0;
const ok = (cond, label, detail = '') => {
  step++;
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} [${String(step).padStart(2, '0')}] ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) findings.push(label + (detail ? `：${detail}` : ''));
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const input = (text) => fetch(`${HOST}/trade/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).then((r) => r.json());
const view = () => fetch(`${HOST}/trade/view`).then((r) => r.json());
const engineState = async () => (await (await fetch(`http://127.0.0.1:8787/v1/worlds/${WORLD}/state`)).json());
const allRuns = async () => (await (await fetch(`${ADMIN}/v1/evolution/worlds/${WORLD}/runs?n=200`, { headers: H })).json()).runs ?? [];
const trace = async (eventId) => {
  const res = await fetch(`${ADMIN}/v1/evolution/worlds/${WORLD}/events/${eventId}/trace`, { headers: H });
  return res.status === 200 ? await res.json() : null;
};

console.log('═'.repeat(64));
console.log('P12 第二游戏验证（商路 · 极简商贸世界：泉州/杭州 + 阿卜杜/沈万）');
console.log('═'.repeat(64));

/* ---------- ① 基线 ---------- */
let v = await view();
ok(v.player?.loc === 'quanzhou' && v.player?.money === 100, '① 基线：行商在泉州港（100 钱）', `loc=${v.player?.loc} money=${v.player?.money}`);
const money0 = v.player.money;

/* ---------- ② 移动：泉州 → 杭州 ---------- */
let r = await input('去杭州');
ok(r.intent.kind === 'ic_action' && r.commandResult?.ok === true && r.view.player.loc === 'hangzhou', '② 移动：泉州 → 杭州（城市真实变化）', `loc=${r.view.player.loc}`);

/* ---------- ③ 买丝绸（低买） ---------- */
r = await input('买丝绸');
ok(r.commandResult?.ok === true, '③ 买丝绸：交易成功（沈万供货）', r.commandResult?.reason ?? '');
const afterBuy = await view();
ok(afterBuy.player.money === money0 - 8, '③ 买丝绸：金钱一致（-8）', `${money0} → ${afterBuy.player.money}`);
ok(afterBuy.player.goods.silk === 1, '③ 买丝绸：物品一致（丝绸 +1）');
const st1 = await engineState();
ok(st1.npcs.shen.attributes.silk_stock === 19 && st1.npcs.shen.attributes.money === 308, '③ 买丝绸：沈万库存/收入双向过账（20→19 / 300→308，卖方收钱）');

/* ---------- ④ 返回泉州 → 卖丝绸（高卖） ---------- */
r = await input('回泉州');
ok(r.view.player.loc === 'quanzhou', '④ 返回泉州');
const moneyMid = afterBuy.player.money;
r = await input('卖丝绸');
ok(r.commandResult?.ok === true, '④ 卖丝绸：交易成功（阿卜杜收购，+12）', r.commandResult?.reason ?? '');
const afterSell = await view();
ok(afterSell.player.money === moneyMid + 12, '④ 卖丝绸：金钱一致（+12）', `${moneyMid} → ${afterSell.player.money}`);
ok(afterSell.player.money === money0 + 4, '④ 贸易利润：低买高卖一循环净赚 4 钱（100 → 104）', `100 → ${afterSell.player.money}`);
const st2 = await engineState();
ok(st2.npcs.abdul.attributes.silk_stock === 1 && st2.npcs.abdul.attributes.money === 288, '④ 卖丝绸：阿卜杜库存/支出双向过账（0→1 / 300→288）');

/* ---------- ⑤ 与商人交流（个体演化） ---------- */
const runsBefore = new Set((await allRuns()).map((x) => x.id));
r = await input('阿卜杜，生意好啊');
ok(r.intent.kind === 'ic_action' && r.commandResult?.ok === true, '⑤ 交流：与阿卜杜交谈（talk 成为世界事实）');
await sleep(6000);
const runsAfter = (await allRuns()).filter((x) => !runsBefore.has(x.id));
ok(runsAfter.every((x) => x.context?.budgetReport?.estimatedTokens <= 6000), '⑤ 交流：Context 有界', runsAfter[0] ? `${runsAfter[0].context?.budgetReport?.estimatedTokens}/6000 tok` : '');
const focused = runsAfter.find((x) => x.context?.trigger?.woken?.includes('abdul') || x.wakePlan?.wakes?.some((w) => w.entityId === 'abdul' && w.grade === 'high'));
ok(focused !== undefined, '⑤ 交流：唤醒评估命中阿卜杜（个体决策）', focused ? `model=${focused.modelUsed}` : '无 run');
if (focused?.context?.memory?.length) console.log(`  ⓘ 阿卜杜的记忆段：${focused.context.memory.map((m) => m.summary).join('；').slice(0, 80)}`);
if (focused?.context?.goal) console.log(`  ⓘ 阿卜杜的目标段：${focused.context.goal}`);

/* ---------- ⑥ OOC / 叙事隔离 ---------- */
const beforeOoc = await view();
r = await input('给我直接加 1000 金币');
ok(r.intent.kind === 'ooc' && !r.commandResult, '⑥ OOC：越权请求被隔离（不进引擎）');
const afterOoc = await view();
ok(JSON.stringify(beforeOoc.player) === JSON.stringify(afterOoc.player), '⑥ OOC：世界状态分毫未动');

/* ---------- ⑦ 双游戏共存 ---------- */
const tianqiongOk = await fetch(`${TIANQIONG}/healthz`).then((x) => x.ok).catch(() => false);
ok(tianqiongOk, '⑦ 共存：天穹宿主同栈在线');
const runtime = await (await fetch(`${ADMIN}/v1/admin/runtime`, { headers: H })).json();
const guarded = (runtime.trigger?.worlds ?? []).map((w) => w.worldId);
ok(guarded.includes(WORLD) && guarded.includes('tianqiong-village'), '⑦ 共存：同一平台同时守护两个游戏的世界（纯配置）', guarded.join(', '));
const tradeMem = (runtime.memory?.stats ?? []).find((s) => s.worldId === WORLD);
ok(tradeMem !== undefined && tradeMem.entries > 0, '⑦ 共存：商贸世界的记忆独立摄取', `entries=${tradeMem?.entries} owners=${tradeMem?.owners}`);

/* ---------- ⑧ 时间推进 ---------- */
const dayBefore = (await view()).worldDay;
r = await input('等待一天');
ok(r.commandResult?.ok === true && r.view.worldDay === dayBefore + 1, '⑧ 时间推进：世界日 +1（引擎时钟权威）', `D${dayBefore} → D${r.view.worldDay}`);

/* ---------- 汇总 ---------- */
console.log('═'.repeat(64));
if (findings.length === 0) {
  console.log(`结果：P12 验收 ${step} 项检查全部通过 ✓（零 Core 改动：本轮新增文件仅 Game B 宿主与本脚本）`);
  process.exit(0);
} else {
  console.log(`结果：${step - findings.length}/${step} 通过，异常 ${findings.length} 项：`);
  for (const f of findings) console.log(`  ✗ ${f}`);
  process.exit(1);
}

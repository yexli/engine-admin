/* ============================================================
   V2.1 真人地毯式测试（方案 V2.1 §十四：真人操作路径 + 异常清单）
   ------------------------------------------------------------
   以「真人操作路径」驱动 Tianqiong 参考宿主（HTTP，UTF-8，与玩家
   同权），沿方案规定的路线走完全程，并逐项核对异常清单：
     NPC 无故移动 / NPC 强制回复 / 重复事件 / 重复 Mutation /
     状态跳跃 / 经济异常 / 时间异常 / OOC 污染 / 演化风暴

   运行（先起引擎 8787 + 宿主 8795）：
     node scripts/run-v21-walkthrough.mjs
   退出码：0 = 全部通过；1 = 存在异常（逐条列出）
   ============================================================ */
const HOST = process.env.TIANQIONG_HOST_URL ?? 'http://127.0.0.1:8795';
const ENGINE = process.env.ENGINE_BASE_URL ?? 'http://127.0.0.1:8787';
const WORLD = process.env.TIANQIONG_WORLD ?? 'tianqiong-village';

const findings = []; // 异常记录
let step = 0;
const ok = (cond, label, detail = '') => {
  step++;
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} [${String(step).padStart(2, '0')}] ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) findings.push(`${label}${detail ? `：${detail}` : ''}`);
  return cond;
};

async function input(text) {
  const res = await fetch(`${HOST}/tianqiong/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }), // node fetch 强制 UTF-8，等价真人输入
  });
  if (!res.ok) throw new Error(`宿主 HTTP ${res.status}`);
  return res.json();
}
const view = async () => (await fetch(`${HOST}/tianqiong/view`)).json();
const events = async () => (await fetch(`${HOST}/tianqiong/events`)).json();

console.log('═'.repeat(64));
console.log('V2.1 真人地毯式测试（天穹最小世界：村庄/酒馆/商店 + 米露/老周/老葛）');
console.log('═'.repeat(64));

/* ---------- 0. 基线 ---------- */
let v0 = await view();
ok(v0.player?.loc === 'village', '基线：玩家在村庄', `loc=${v0.player?.loc}`);
const consumed0 = (await events()).consumed.length;

/* ---------- 1. 进入酒馆（方案核心用例） ---------- */
let r = await input('我想去酒馆找米露。');
ok(r.intent.kind === 'ic_action', '「我想去酒馆找米露」被识别为世界内行动', `kind=${r.intent.kind}${r.intent.hint ? ` hint=${r.intent.hint}` : ''}`);
ok(r.commandResult?.ok === true, '命令链放行（Intent → Command → Rules → Mutation）', `events=${(r.commandResult?.events ?? []).join(',')}`);
ok(r.view.player.loc === 'tavern', '世界真实变化：player.location = tavern', `loc=${r.view.player.loc}`);
const milu = r.view.here.find((h) => h.id === 'milu');
ok(milu !== undefined, '米露在酒馆（玩家真实看到）', milu ? `mood=${milu.mood}` : '不在场');
ok(!r.view.npcReply && !r.view.dialogue, '进入酒馆后 NPC 未被强制回复（无任何自动对白字段）');

/* ---------- 2. 强制回复修复验证：重复进入不产生 NPC 台词 ---------- */
r = await input('回到村庄');
ok(r.view.player.loc === 'village', '离开酒馆回村', `loc=${r.view.player.loc}`);
r = await input('去酒馆');
ok(r.view.player.loc === 'tavern', '再次进入酒馆');
ok(!(r.commandResult?.events ?? []).some((e) => /talk|dialogue|say/i.test(e)), '进入事件不含 NPC 回复事件（player_moved ≠ npc_reply）', `events=${(r.commandResult?.events ?? []).join(',')}`);

/* ---------- 3. 与米露聊天（显式动作才触发） ---------- */
r = await input('找米露');
ok(r.intent.kind === 'ic_action' && r.commandResult?.ok === true, '在酒馆内「找米露」→ 显式 talk 动作被执行', `kind=${r.intent.kind} ok=${r.commandResult?.ok}`);
const evsAfterTalk = (await events()).consumed;
const talkEvents = evsAfterTalk.filter((e) => e.type === 'talk' || e.type === 'talk_started');
ok(talkEvents.length > 0, '对话成为世界事实（talk 事件入账）', talkEvents.map((e) => e.id).join(','));

/* ---------- 4. 离开 → 去商店 → 购买（方案真人路线：商人/经济一致性） ---------- */
r = await input('回村');
r = await input('去商店');
ok(r.view.player.loc === 'shop', '到达商店', `loc=${r.view.player.loc}`);
const trader = r.view.here.find((h) => h.id === 'trader');
ok(trader !== undefined, '商人老葛在商店（最小世界三人组齐备：米露/老周/老葛）', trader ? `mood=${trader.mood}` : '不在场');
ok(trader !== undefined && typeof trader.attention === 'string', 'NPC 注意力状态可见（方案 P2 状态清单）', trader ? `attention=${trader.attention}` : '');
const vMid = await view();
const moneyBeforeShop = vMid.player.money;
const riceBeforeShop = vMid.player.items.rice;
r = await input('买一份干粮');
ok(r.commandResult?.ok === true, '商店购买成功（宿主确定性经济 + 引擎命令链）', r.commandResult?.reason ?? '');
const vAfterShop = await view();
ok(vAfterShop.player.money === moneyBeforeShop - 3, '经济一致：钱 -3', `${moneyBeforeShop} → ${vAfterShop.player.money}`);
ok(vAfterShop.player.items.rice === riceBeforeShop + 1, '物品一致：干粮 +1', `rice=${riceBeforeShop} → ${vAfterShop.player.items.rice}`);

/* ---------- 4.5 返回酒馆 → 再找米露（方案真人路线收尾） ---------- */
r = await input('回村');
r = await input('去酒馆');
ok(r.view.player.loc === 'tavern', '返回酒馆');
const miluAgain = r.view.here.find((h) => h.id === 'milu');
ok(miluAgain !== undefined, '再找米露：她仍在（无瞬移、日程/演化位移之外不移动）', miluAgain ? `mood=${miluAgain.mood} attention=${miluAgain.attention}` : '不在场');
r = await input('找米露');
ok(r.intent.kind === 'ic_action' && r.commandResult?.ok === true, '第二次交流（显式 talk 才触发）', `ok=${r.commandResult?.ok}`);
ok(
  r.reaction === null || r.reaction === undefined || (r.reaction?.narrative === true && typeof r.reaction?.reaction === 'string'),
  '演化反应以叙事呈现（narrative=true 标记，不是世界事实）',
  r.reaction ? `status=${r.reaction.status} applied=${r.reaction.applied}` : '无演化配置（reaction=null）',
);

/* ---------- 5. 时间推进（等待一天）+ NPC 日程对齐（方案 §九） ---------- */
const dayBefore = vAfterShop.worldDay;
r = await input('等待一天');
ok(r.commandResult?.ok === true, '推进一天（advance_time 48 刻）');
ok(r.view.worldDay === dayBefore + 1, '世界日 +1（不是 AI 说「三天过去了」）', `D${dayBefore} → D${r.view.worldDay}`);
ok(r.view.player.loc === 'tavern', '时间推进不改变玩家位置（无状态跳跃）', `loc=${r.view.player.loc}`);
ok(vAfterShop.player.money === r.view.player.money, '时间推进不改变金钱（无经济异常）');
/* 日程：读宿主公布的日程表，按 tickOfDay 推每个 NPC 应在的地点，与权威状态比对 */
const sched = (await (await fetch(`${HOST}/tianqiong/schedule`)).json()).schedules;
const tickOfDay = ((r.view.tick % 48) + 48) % 48;
/* 日程 NPC 的权威位置直接读引擎状态（宿主视图只展示同地点名单） */
const stAll = (await (await fetch(`${ENGINE}/v1/worlds/${WORLD}/state`)).json());
const allNpcs = {};
for (const id of Object.keys(sched)) {
  allNpcs[id] = stAll?.npcs?.[id]?.attributes?.location ?? null;
}
let schedOk = true;
const schedDetail = [];
for (const [id, slots] of Object.entries(sched)) {
  const slot = (slots ?? []).find((s) => tickOfDay >= s.from && tickOfDay < s.to);
  const expect = slot ? slot.location : null;
  const actual = allNpcs[id];
  schedDetail.push(`${id}:expect=${expect ?? '无日程'} actual=${actual ?? '未知'}`);
  if (expect !== null && actual !== expect) schedOk = false;
}
ok(schedOk, `NPC 按日程归位（tickOfDay=${tickOfDay}）`, schedDetail.join(' | '));

/* ---------- 6. OOC / 叙事隔离 ---------- */
const vOocBefore = await view();
r = await input('帮我调一下难度，直接让我变强');
ok(r.intent.kind === 'ooc', '场外话被识别为 OOC', `kind=${r.intent.kind}`);
ok(!r.commandResult, 'OOC 未产生任何命令（不进引擎）');
r = await input('夕阳把整条街道染成金色，远处传来钟声。');
ok(r.intent.kind === 'narrative', '叙事文本被识别为 narrative', `kind=${r.intent.kind}`);
ok(!r.commandResult, '叙事未产生任何命令（不进引擎）');
const vOocAfter = await view();
ok(
  JSON.stringify(vOocBefore.player) === JSON.stringify(vOocAfter.player) && vOocBefore.worldDay === vOocAfter.worldDay,
  'OOC/叙事后世界状态分毫未动（无 OOC 污染）',
);

/* ---------- 7. 重复输入幂等（事件不重复记账） ---------- */
const c0 = (await events()).consumed;
r = await input('回村');
const c1 = (await events()).consumed;
const movedOnce = c1.length - c0.length;
r = await input('去酒馆');
r = await input('回村');
const c2 = (await events()).consumed;
ok(c2.length - c1.length >= movedOnce, '重复往返每次都产生独立事实（世界行为可预期）');
const ids = new Set(c2.map((e) => e.id));
ok(ids.size === c2.length, '已消费事实 id 无重复（消费侧幂等去重生效）', `${ids.size}/${c2.length}`);

/* ---------- 8. NPC 位置纪律检查（基线之后只允许日程/演化产生位移） ---------- */
const vEnd = await view();
/* 基线在场名单里的 NPC 应仍在其日程位置（配合第 5 节的日程比对）；
   这里核对世界终态与日程表仍一致，防止测试过程中出现计划外的 NPC 移动 */
const stEnd = (await (await fetch(`${ENGINE}/v1/worlds/${WORLD}/state`)).json());
const tickEnd = ((stEnd?.t ?? 0) % 48 + 48) % 48;
let endOk = true;
const endDetail = [];
for (const [id, slots] of Object.entries(sched)) {
  const slot = (slots ?? []).find((s) => tickEnd >= s.from && tickEnd < s.to);
  const expect = slot ? slot.location : null;
  const actual = stEnd?.npcs?.[id]?.attributes?.location ?? null;
  endDetail.push(`${id}:${actual}(期望 ${expect ?? '无'})`);
  if (expect !== null && actual !== expect) endOk = false;
}
ok(endOk, `终态 NPC 位置仍符合日程（无计划外移动，tickOfDay=${tickEnd}）`, endDetail.join(' | '));

/* ---------- 9. 演化风暴检查（无令牌模式 = 演化关闭，事件数应有界） ---------- */
const consumedTotal = (await events()).consumed.length;
ok(consumedTotal <= consumed0 + 60, '事实总量有界（无 Trigger 风暴）', `${consumed0} → ${consumedTotal}`);

/* ---------- 汇总 ---------- */
console.log('═'.repeat(64));
if (findings.length === 0) {
  console.log(`结果：${step} 项检查全部通过 ✓`);
  process.exit(0);
} else {
  console.log(`结果：${step - findings.length}/${step} 通过，发现异常 ${findings.length} 项：`);
  for (const f of findings) console.log(`  ✗ ${f}`);
  process.exit(1);
}

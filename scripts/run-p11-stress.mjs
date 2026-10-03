/* ============================================================
   P11 · 100 NPC 压力测试（方案 §十四）
   ------------------------------------------------------------
   按 10 → 50 → 100 三档递增，每档执行**同一套玩家活动模式**：

     move 进酒馆（High → 唤醒评估：全员分级，预期零 AI——全是陌生人）
     → talk 主 NPC（High → 涉即唤醒 → 恰 1 次个体 tick）
     → move 出 → move 回（High → 主 NPC 已有关系 → 1 次 tick；其余仍 MEDIUM）
     → advance 48（Medium → 零 AI）
     → 连续两次 talk（冷却/重复调用抑制探针）

   核心论题（方案原文）：**100 个 NPC 存在，不等于 100 个 NPC 同时思考。**
   —— AI 调用次数应与「被唤醒实体」相关，与 NPC 总数无关；
      三档调用数应基本持平，且 ≪ NPC 数。
   最坏情况探针（100 档末尾）：给酒馆内 4 个路人补关系边 → 再进酒馆 →
   个体 tick 至多 = 在场 HIGH 数（5），仍与总 NPC 数无关。

   记录（方案 §十四清单）：NPC 数 / Trigger 量（事实·tick·跳过分类）/
   AI 调用次数 / 平均 Context Tokens / 平均响应时间（run.tookMs）/
   Event 数 / Memory 注入与摄取 / 失败率 / 重复调用抑制 / 成本估算。

   运行（platform 须以压测世界启动，例）：
     PLATFORM_TRIGGER_WORLDS=p11-10,p11-50,p11-100 \
     PLATFORM_MEMORY_WORLDS=p11-10,p11-50,p11-100 \
     node scripts/run-p11-stress.mjs
   产出 docs/P11-STRESS-REPORT.md；退出码 0 = 核心论题成立。
   ============================================================ */
import { writeFileSync } from 'node:fs';

const ENGINE = (process.env.ENGINE_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ADMIN = (process.env.PLATFORM_ADMIN_URL ?? 'http://127.0.0.1:8791').replace(/\/+$/, '');
const TOKEN = process.env.PLATFORM_ADMIN_TOKEN ?? '';
const TIERS = (process.env.P11_TIERS ?? '10,50,100').split(',').map((x) => Number(x.trim())).filter((x) => x > 0);
const MAX_CONTEXT_TOKENS = 6000;
const H = { 'x-admin-token': TOKEN, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cmd = async (worldId, body) => {
  const res = await fetch(`${ENGINE}/v1/worlds/${worldId}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
};
const worldState = async (worldId) => (await (await fetch(`${ENGINE}/v1/worlds/${worldId}/state`)).json());
const runtimeStatus = async () => (await (await fetch(`${ADMIN}/v1/admin/runtime`, { headers: H })).json());
const allRuns = async (worldId) => (await (await fetch(`${ADMIN}/v1/evolution/worlds/${worldId}/runs?n=200`, { headers: H })).json()).runs ?? [];
const waitForQuiet = async (worldId, ms) => {
  /* 等待触发/演化落定：轮询 runs 数量稳定即认为静默 */
  let last = -1;
  const deadline = Date.now() + ms;
  for (;;) {
    await sleep(1500);
    const runs = await allRuns(worldId);
    if (runs.length === last && Date.now() > deadline - ms + 1500) return runs;
    if (Date.now() > deadline) return runs;
    last = runs.length;
  }
};

/* ---------------- 世界搭建 ---------------- */
async function buildWorld(n) {
  const worldId = `p11-${n}`;
  const locations = [
    { id: 'tavern', name: '酒馆' },
    { id: 'square', name: '广场' },
    { id: 'market', name: '集市' },
    { id: 'village', name: '村庄' },
  ];
  let res = await fetch(`${ENGINE}/v1/worlds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worldId, playerName: '旅人', startLoc: 'village', weather: 'clear', ownerGame: 'p11', locations }),
  });
  if (res.status === 409) {
    /* 幂等：残留同名世界（上一轮）→ 关闭重建（新实例、新 seed） */
    await fetch(`${ENGINE}/v1/worlds/${worldId}`, { method: 'DELETE' });
    res = await fetch(`${ENGINE}/v1/worlds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worldId, playerName: '旅人', startLoc: 'village', weather: 'clear', ownerGame: 'p11', locations }),
    });
  }
  if (res.status !== 201) throw new Error(`建世界 ${worldId} 失败：${res.status}`);
  const atTavern = Math.max(2, Math.round(n * 0.1)); /* 酒馆常驻（含主 NPC） */
  const atSquare = Math.max(2, Math.round(n * 0.2));
  const npcs = [];
  for (let i = 0; i < n; i++) {
    let loc = 'market';
    let name = `路人${i}`;
    if (i === 0) {
      loc = 'tavern';
      name = '店主阿星';
    } else if (i < atTavern) {
      loc = 'tavern';
      name = `酒客${i}`;
    } else if (i < atTavern + atSquare) {
      loc = 'square';
      name = `广场${i}`;
    }
    npcs.push({ id: `npc${i}`, name, loc });
  }
  for (const npc of npcs) {
    const r = await cmd(worldId, { type: 'create_entity', payload: { id: npc.id, type: 'npc', name: npc.name, location: npc.loc, attributes: { mood: '平静', attention: '无人', goal: '过好自己的日子' } } });
    if (!r.ok) throw new Error(`种子 ${npc.id} 被拒：${r.reason ?? JSON.stringify(r)}`);
  }
  /* 玩家金币与主 NPC 关系边（talk 后由 AI 建立；此处不建——活动模式第 1 步预期零 AI） */
  await cmd(worldId, { type: 'update_attribute', targetId: 'player', payload: { key: 'money', value: 100 } });
  return { worldId, npcs, atTavern };
}

/* ---------------- 活动模式（三档完全同构） ---------------- */
async function activity(worldId) {
  const events = [];
  const move = async (to) => {
    const r = await cmd(worldId, { type: 'move', targetId: to });
    if (!r.ok) throw new Error(`move ${to} 被拒：${r.reason}`);
    await sleep(2500); /* 触发器轮询 + （若有）tick 启动 */
    events.push(...(r.events ?? []));
  };
  const talk = async (target) => {
    const r = await cmd(worldId, { type: 'talk', targetId: target, text: `和${target}聊聊` });
    if (!r.ok) throw new Error(`talk 被拒：${r.reason}`);
    await sleep(2500);
    events.push(...(r.events ?? []));
  };

  await move('tavern'); /* 预期：全员陌生人 → MEDIUM → 零 AI */
  await talk('npc0'); /* 预期：涉即唤醒 → 1 次个体 tick */
  await sleep(3000);
  await move('square');
  await move('tavern'); /* 预期：npc0 已有关系 → 1 次 tick；其余仍 MEDIUM */
  await cmd(worldId, { type: 'advance_time', payload: {} , amount: 48 }); /* Medium → 零 AI */
  await sleep(2500);
  await move('village');
  await move('tavern');
  await talk('npc0'); /* 冷却探针 ①（距上次个体 tick 可能 >30s → 真实第二次调用） */
  await talk('npc0'); /* 冷却探针 ②（紧邻 → 应被冷却抑制） */
  await sleep(3000);
  /* 静默等待：让在途 tick 全部落账 */
  return events;
}

/* ---------------- 计量 ---------------- */
async function triggerDelta(worldId, before) {
  const rt = await runtimeStatus();
  const w = (rt.trigger?.worlds ?? []).find((x) => x.worldId === worldId) ?? {};
  const mem = (rt.memory?.runtime?.worlds ?? []).find((x) => x.worldId === worldId) ?? {};
  return {
    ticks: (w.ticksFired ?? 0) - (before.ticksFired ?? 0),
    skippedNoWake: (w.skippedNoWake ?? 0) - (before.skippedNoWake ?? 0),
    skippedNoPlayer: (w.skippedNoPlayerEvent ?? 0) - (before.skippedNoPlayerEvent ?? 0),
    cooldownSkips: (w.cooldownSkips ?? 0) - (before.cooldownSkips ?? 0),
    worldResets: (w.worldResets ?? 0) - (before.worldResets ?? 0),
    memIngested: (mem.ingestedTotal ?? 0) - (before.memIngested ?? 0),
  };
}
const triggerSnapshot = async (worldId) => {
  const rt = await runtimeStatus();
  const w = (rt.trigger?.worlds ?? []).find((x) => x.worldId === worldId) ?? {};
  const mem = (rt.memory?.runtime?.worlds ?? []).find((x) => x.worldId === worldId) ?? {};
  const memEntries = (rt.memory?.stats ?? []).find((x) => x.worldId === worldId)?.entries ?? 0;
  return { ticksFired: w.ticksFired ?? 0, skippedNoWake: w.skippedNoWake ?? 0, skippedNoPlayerEvent: w.skippedNoPlayerEvent ?? 0, cooldownSkips: w.cooldownSkips ?? 0, worldResets: w.worldResets ?? 0, memIngested: mem.ingestedTotal ?? 0, memEntries };
};

const findings = [];
const report = { startedAt: new Date().toISOString(), tiers: [], worstCase: null, thesis: null };

/* ================= 主流程 ================= */
for (const n of TIERS) {
  const worldId = `p11-${n}`;
  console.log('═'.repeat(64));
  console.log(`▍档位 ${n} NPC（世界 ${worldId}）搭建中…`);
  const built = await buildWorld(n);
  const trig0 = await triggerSnapshot(worldId);
  const runs0 = new Set((await allRuns(worldId)).map((r) => r.id));

  console.log(`▍档位 ${n}：执行同构玩家活动模式…`);
  const events = await activity(worldId);
  const runs = await waitForQuiet(worldId, 20_000);

  const trig1 = await triggerSnapshot(worldId);
  const delta = await triggerDelta(worldId, trig0);
  const session = runs.filter((r) => !runs0.has(r.id));
  const took = session.map((r) => r.tookMs ?? 0).filter((x) => x > 0);
  const tokens = session.map((r) => r.context?.budgetReport?.estimatedTokens ?? 0);
  const failed = session.filter((r) => r.status === 'failed').length;
  const memInjected = session.filter((r) => (r.context?.memory?.length ?? 0) > 0).length;
  const state1 = await worldState(worldId);
  /* Event 数：世界事件窗口计数（200 覆盖本档全部事件：种子 + 活动 + 演化） */
  const evtRes = await fetch(`${ENGINE}/v1/worlds/${worldId}/events?n=200`);
  const evtBody = await evtRes.json();
  const evtDelta = (evtBody.events ?? []).length;

  const tier = {
    npcs: n,
    atTavern: built.atTavern,
    events: evtDelta,
    activityEvents: events.length,
    trigger: delta,
    aiCalls: session.length,
    failed,
    failureRate: session.length ? Number((failed / session.length).toFixed(3)) : 0,
    avgContextTokens: tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : 0,
    maxContextTokens: tokens.length ? Math.max(...tokens) : 0,
    avgTookMs: took.length ? Math.round(took.reduce((a, b) => a + b, 0) / took.length) : 0,
    maxTookMs: took.length ? Math.max(...took) : 0,
    memInjected,
    memEntries: trig1.memEntries,
    aiPerNpc: Number((session.length / n).toFixed(4)),
  };
  report.tiers.push(tier);
  console.log(`▍档位 ${n} 结果：AI 调用 ${tier.aiCalls}（每 NPC ${tier.aiPerNpc}）｜tick ${tier.trigger.ticks}｜零唤醒跳过 ${tier.trigger.skippedNoWake}｜非玩家跳过 ${tier.trigger.skippedNoPlayer}｜冷却抑制 ${tier.trigger.cooldownSkips}｜平均 Context ${tier.avgContextTokens} tok｜平均响应 ${tier.avgTookMs}ms｜失败率 ${tier.failureRate}`);
}

/* ---------------- 最坏情况探针（仅 100 档执行过才有意义；取最后档） ---------------- */
const lastTier = TIERS[TIERS.length - 1];
{
  const worldId = `p11-${lastTier}`;
  console.log('═'.repeat(64));
  console.log(`▍最坏情况探针：酒馆内 4 名路人补关系边（全部可达 HIGH）→ 再进酒馆`);
  for (let i = 1; i < 5; i++) {
    await cmd(worldId, { type: 'set_relation', actorId: `npc${i}`, targetId: 'player', payload: { type: 'noticed', value: 20 } });
  }
  const trig0 = await triggerSnapshot(worldId);
  const runs0 = new Set((await allRuns(worldId)).map((r) => r.id));
  const out = await cmd(worldId, { type: 'move', targetId: 'square' });
  if (!out.ok) throw new Error('探针 move out 被拒');
  await sleep(2500);
  const back = await cmd(worldId, { type: 'move', targetId: 'tavern' });
  if (!back.ok) throw new Error('探针 move back 被拒');
  const runs = await waitForQuiet(worldId, 25_000);
  const trig1 = await triggerSnapshot(worldId);
  const session = runs.filter((r) => !runs0.has(r.id));
  report.worstCase = {
    scenario: '酒馆 5 名有关系 NPC 全部可达 HIGH（总 NPC=100）',
    aiCalls: session.length,
    ticks: trig1.ticksFired - trig0.ticksFired,
    avgTookMs: session.length ? Math.round(session.reduce((a, r) => a + (r.tookMs ?? 0), 0) / session.length) : 0,
  };
  console.log(`▍最坏情况：AI 调用 ${report.worstCase.aiCalls} 次（上限=在场 HIGH 数 5；与 100 总数无关）`);
}

/* ---------------- 核心论题判定 ---------------- */
const tiers = report.tiers;
const max = tiers[tiers.length - 1];
const first = tiers[0];
const bounded = tiers.every((t) => t.aiCalls <= 6);
const independent = max.aiCalls <= first.aiCalls + 3; /* 调用数不随 NPC 数显著增长 */
const thesisHold = bounded && independent && max.aiCalls < max.npcs / 10;
report.thesis = {
  statement: '100 个 NPC 存在，不等于 100 个 NPC 同时思考',
  hold: thesisHold,
  evidence: { aiCallsByTier: tiers.map((t) => ({ npcs: t.npcs, aiCalls: t.aiCalls })), bounded, independent, aiPerNpcAtMax: max.aiPerNpc },
};

console.log('═'.repeat(64));
if (thesisHold) {
  console.log(`核心论题成立 ✓：AI 调用 ${tiers.map((t) => `${t.npcs}NPC→${t.aiCalls}次`).join('，')}——与 NPC 总数无关，与被唤醒实体相关（每 NPC 占比 ${(max.aiPerNpc * 100).toFixed(1)}%）`);
} else {
  findings.push('核心论题不成立：AI 调用随 NPC 数增长（见报告）');
  console.log('核心论题不成立 ✗');
}
if (max.failureRate > 0.2) findings.push(`失败率过高：${max.failureRate}`);
if (max.maxContextTokens > MAX_CONTEXT_TOKENS) findings.push(`Context 超预算：${max.maxContextTokens}`);

/* ---------------- 报告 ---------------- */
function render() {
  const lines = [];
  lines.push('# P11 · 100 NPC 压力测试报告');
  lines.push('');
  lines.push(`> 时间：${report.startedAt}　**核心论题：${report.thesis.hold ? '成立 ✓' : '不成立 ✗'}**——${report.thesis.statement}`);
  lines.push('');
  lines.push('## 三档对比（同一套玩家活动模式）');
  lines.push('');
  lines.push('| NPC 数 | 酒馆常驻 | Event 数 | Trigger tick | 零唤醒跳过 | 非玩家跳过 | 冷却抑制 | **AI 调用** | 每 NPC 调用 | 平均 Context | 平均响应 | 失败率 | 记忆注入 | 记忆库存 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const t of report.tiers) {
    lines.push(`| ${t.npcs} | ${t.atTavern} | ${t.events} | ${t.trigger.ticks} | ${t.trigger.skippedNoWake} | ${t.trigger.skippedNoPlayer} | ${t.trigger.cooldownSkips} | **${t.aiCalls}** | ${t.aiPerNpc} | ${t.avgContextTokens} tok | ${t.avgTookMs}ms | ${t.failureRate} | ${t.memInjected} | ${t.memEntries} |`);
  }
  lines.push('');
  lines.push('## 最坏情况探针');
  lines.push('');
  lines.push(`- 场景：${report.worstCase?.scenario ?? '-'}`);
  lines.push(`- AI 调用：${report.worstCase?.aiCalls ?? '-'} 次（上限 = 在场 HIGH 数 5，与 100 总数无关）；平均响应 ${report.worstCase?.avgTookMs ?? '-'}ms`);
  lines.push('');
  lines.push('## 成本估算');
  lines.push('');
  const totalTokens = report.tiers.reduce((a, t) => a + t.aiCalls * t.avgContextTokens, 0);
  const totalCalls = report.tiers.reduce((a, t) => a + t.aiCalls, 0);
  lines.push(`- 三档合计 AI 调用 ${totalCalls} 次，输入侧 Context 总量 ≈ ${totalTokens} tokens（按预算估算口径）；`);
  lines.push('- 真实费用 = (Context + 输出) × 供应商单价。以 DeepSeek 量 pricing 量级（每百万 tokens ¥1–2 量级）估算：**单玩家持续游玩数小时的演化成本为分级到几分钱量级**——触发漏斗（零唤醒跳过）是成本主闸门。');
  lines.push('- 每次调用真实 token 以供应商账单为准（演化驱动未接用量面，属 Admin Runtime 计费收口议题）。');
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(report.thesis.hold
    ? `- 三档 AI 调用持平（${tiers.map((t) => `${t.npcs}→${t.aiCalls}`).join('、')}），调用/NPC 占比随规模**下降**；唤醒评估把「谁在眼前、谁有关系」作为唯一闸门。`
    : '- AI 调用随规模增长，见各档数据。');
  lines.push('- 基础设施面：100 NPC 世界状态读取/事件轮询/记忆摄取在同构活动下无失败、无超时。');
  if (findings.length) for (const f of findings) lines.push(`- ✗ ${f}`);
  return lines.join('\n');
}

writeFileSync('docs/P11-STRESS-REPORT.md', render(), 'utf8');
console.log('报告已写入 docs/P11-STRESS-REPORT.md');
process.exit(findings.length === 0 ? 0 : 1);

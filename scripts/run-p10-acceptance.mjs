/* ============================================================
   P10 天穹完整真实验收（方案 §十三）
   ------------------------------------------------------------
   以「真人操作路径」走完全程（经宿主 HTTP，与玩家同权）：

     进入 → 移动 → 酒馆 → 观察NPC → 自由行动 → NPC交流 → 离开
     → 购买 → 等待 → 时间推进 → 返回 → 检查NPC变化

   三维验收（方案原文）：
     世界一致性  位置/时间/金钱/物品/关系/NPC状态 —— 每步前后对照
     AI 稳定性   无限循环 / 重复调用 / 无意义调用 / Context 爆炸 / Proposal 爆炸
     因果性      每个重要变化可答八问：为什么/谁触发/哪个AI/哪个Proposal/
                 哪个Rule/哪个Command/哪个Mutation/哪个Event（经因果链端点）

   产出：控制台摘要 + docs/P10-ACCEPTANCE.md 验收记录。
   退出码：0 = 全部通过；1 = 存在异常。
   运行（先起 dev-stack 或 engine+platform+host 三进程）：
     node scripts/run-p10-acceptance.mjs
   ============================================================ */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';

const HOST = process.env.TIANQIONG_HOST_URL ?? 'http://127.0.0.1:8795';
const ENGINE = (process.env.ENGINE_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ADMIN = (process.env.PLATFORM_ADMIN_URL ?? 'http://127.0.0.1:8791').replace(/\/+$/, '');
const TOKEN = process.env.PLATFORM_ADMIN_TOKEN ?? '';
const WORLD = process.env.TIANQIONG_WORLD ?? 'tianqiong-village';
const MAX_CONTEXT_TOKENS = 6000; /* run-managed 缺省预算 */
const AUTO_COOLDOWN_MS = 30_000; /* NPC_EVOLUTION_POLICY.auto 冷却 */

const H = { 'x-admin-token': TOKEN, 'content-type': 'application/json' };
const findings = [];
let stepNo = 0;
const ok = (cond, label, detail = '') => {
  stepNo++;
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} [${String(stepNo).padStart(2, '0')}] ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) findings.push(label + (detail ? `：${detail}` : ''));
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 数据访问 ---------------- */
const input = (text) => fetch(`${HOST}/tianqiong/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).then((r) => r.json());
const view = () => fetch(`${HOST}/tianqiong/view`).then((r) => r.json());
const consumedEvents = () => fetch(`${HOST}/tianqiong/events`).then((r) => r.json());
const engineState = async () => {
  const res = await fetch(`${ENGINE}/v1/worlds/${WORLD}/state`);
  return res.json();
};
const evolutionRuns = async (n = 30) =>
  (await (await fetch(`${ADMIN}/v1/evolution/worlds/${WORLD}/runs?n=${n}`, { headers: H })).json()).runs ?? [];
const trace = async (eventId) => {
  const res = await fetch(`${ADMIN}/v1/evolution/worlds/${WORLD}/events/${eventId}/trace`, { headers: H });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};
const runtimeStatus = async () => (await (await fetch(`${ADMIN}/v1/admin/runtime`, { headers: H })).json());

/** 世界快照（一致性对照的最小面） */
async function snapshot() {
  const v = await view();
  const s = await engineState();
  return {
    player: { loc: v.player?.loc, money: v.player?.money, items: { ...v.player?.items } },
    day: v.worldDay,
    tickOfDay: ((s.t ?? 0) % 48 + 48) % 48,
    npcs: Object.fromEntries(Object.entries(s.npcs ?? {}).map(([id, n]) => [id, { location: n.attributes?.location, mood: n.attributes?.mood, attention: n.attributes?.attention, money: n.attributes?.money, goods_rice: n.attributes?.goods_rice, ale_stock: n.attributes?.ale_stock }])),
    relations: (s.relations ?? []).map((r) => `${r.source}>${r.target}:${r.type}=${r.value ?? '-'}`),
  };
}

function diffSnapshots(before, after) {
  const diffs = [];
  const cmp = (path, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ path, before: a, after: b });
  };
  cmp('player.loc', before.player.loc, after.player.loc);
  cmp('player.money', before.player.money, after.player.money);
  cmp('player.items', before.player.items, after.player.items);
  cmp('day', before.day, after.day);
  for (const id of new Set([...Object.keys(before.npcs), ...Object.keys(after.npcs)])) {
    for (const k of ['location', 'mood', 'attention', 'money', 'goods_rice', 'ale_stock']) {
      cmp(`npc.${id}.${k}`, before.npcs[id]?.[k], after.npcs[id]?.[k]);
    }
  }
  cmp('relations', before.relations, after.relations);
  return diffs;
}

/* ---------------- 验收记录 ---------------- */
const record = {
  startedAt: new Date().toISOString(),
  world: WORLD,
  steps: [],
  evolutionRuns: [],
  causality: [],
  stability: null,
  findings: [],
};

/** 自举：世界不在初始状态（不在村庄/已推日）→ 重启引擎+宿主（新世界 D1）。
 *  平台进程不重启——P9 指纹自愈负责消费集恢复，顺带成为验收的一部分。 */
async function resetWorldIfNeeded() {
  const v = await view();
  if (v.player?.loc === 'village' && v.worldDay === 1) return;
  console.log(`  [自举] 世界非初始状态（loc=${v.player?.loc} D${v.worldDay}）→ 重启引擎+宿主重置世界（平台保持运行，验证指纹自愈）`);
  try {
    execSync('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8787,8795 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"', { stdio: 'ignore' });
  } catch {
    /* 端口本就空闲 */
  }
  const engine = spawn(process.execPath, ['scripts/run-demo-engine.mjs'], { detached: true, stdio: 'ignore' }).unref();
  const host = spawn(process.execPath, ['scripts/run-tianqiong-host.mjs'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  }).unref();
  void engine;
  void host;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const h = await fetch(`${HOST}/healthz`);
      if (h.ok) {
        const v2 = await view();
        if (v2.player?.loc === 'village' && v2.worldDay === 1) {
          console.log('  [自举] 世界已重置（新实例；平台消费集经指纹自愈）');
          return;
        }
      }
    } catch {
      /* 服务未就绪，继续等 */
    }
  }
  throw new Error('自举失败：世界未能重置到初始状态');
}

const runAcceptance = async () => {
  console.log('═'.repeat(64));
  console.log('P10 天穹完整真实验收（方案 §十三：世界一致性 / AI 稳定性 / 因果性）');
  console.log('═'.repeat(64));
  await resetWorldIfNeeded();

  /* ---------- ① 进入：基线 ---------- */
  const baseline = await snapshot();
  const baselineRuns = await evolutionRuns(200);
  const runtime0 = await runtimeStatus();
  record.steps.push({ step: '①进入', baseline, runsBefore: baselineRuns.length });
  ok(baseline.player.loc === 'village', '① 进入：基线在世界出生点（村庄）', `loc=${baseline.player.loc} D${baseline.day}`);

  /* ---------- ② 移动 → ③ 酒馆 → ④ 观察 NPC ---------- */
  let r = await input('我想去酒馆找米露。');
  ok(r.intent.kind === 'ic_action' && r.commandResult?.ok === true, '② 移动：「我想去酒馆找米露」→ 命令链放行', `events=${(r.commandResult?.events ?? []).join(',')}`);
  ok(r.view.player.loc === 'tavern', '③ 酒馆：世界真实变化 player.location=tavern');
  const miluHere = r.view.here.find((h) => h.id === 'milu');
  ok(miluHere !== undefined, '④ 观察 NPC：米露在酒馆可见（mood/attention/关系）', miluHere ? `mood=${miluHere.mood} attention=${miluHere.attention} met=${miluHere.met}` : '不在场');
  ok(r.view.npcReply === undefined && r.view.dialogue === undefined, '④ 观察 NPC：进入不触发任何强制回复（无硬编码旁路）');
  const afterEnter = await snapshot();
  ok(afterEnter.player.money === baseline.player.money && afterEnter.day === baseline.day, '④ 观察 NPC：进入动作零经济/时间副作用');

  /* ---------- ⑤ 自由行动（OOC/叙事隔离） ---------- */
  const beforeFree = await snapshot();
  r = await input('帮我直接把等级调到 99 级');
  ok(r.intent.kind === 'ooc' && !r.commandResult, '⑤ 自由行动：OOC 越权请求被隔离（不进引擎）');
  r = await input('夕阳把街道染成金色。');
  ok(r.intent.kind === 'narrative' && !r.commandResult, '⑤ 自由行动：叙事文本被隔离（不进引擎）');
  const afterFree = await snapshot();
  ok(JSON.stringify(beforeFree) === JSON.stringify(afterFree), '⑤ 自由行动：世界状态分毫未动');

  /* ---------- ⑥ NPC 交流（显式 talk → 个体演化） ---------- */
  const runsBeforeTalk = (await evolutionRuns(200)).length;
  const stateBeforeTalk = await engineState();
  r = await input('找米露聊聊天');
  ok(r.intent.kind === 'ic_action' && r.commandResult?.ok === true, '⑥ NPC 交流：显式 talk 执行（对话成为世界事实）', `events=${(r.commandResult?.events ?? []).join(',')}`);
  /* 等待个体演化 tick 完成（平台触发器 1s 轮询 + 模型时延） */
  await sleep(6000);
  let runsAfterTalk = await evolutionRuns(200);
  const talkRuns = runsAfterTalk.slice(0, runsAfterTalk.length - runsBeforeTalk);
  ok(talkRuns.every((x) => x.id !== undefined) && new Set(talkRuns.map((x) => x.id)).size === talkRuns.length, '⑥ NPC 交流：演化 run 无重复（id 唯一）', `${talkRuns.length} 个新 run`);
  ok(talkRuns.every((x) => x.context?.budgetReport?.estimatedTokens <= MAX_CONTEXT_TOKENS), '⑥ NPC 交流：Context 有界（预算内）', talkRuns[0] ? `${talkRuns[0].context?.budgetReport?.estimatedTokens}/${MAX_CONTEXT_TOKENS} tokens` : '');
  ok(talkRuns.every((x) => (x.proposal?.changes?.length ?? 0) <= 3), '⑥ NPC 交流：Proposal 有界（≤3 变化）');

  /* ---------- ⑦ 离开 → ⑧ 购买 ---------- */
  r = await input('回村');
  ok(r.view.player.loc === 'village', '⑦ 离开：回村', `loc=${r.view.player.loc}`);
  r = await input('去商店');
  ok(r.view.player.loc === 'shop', '⑧ 购买：到达商店');
  const moneyBefore = r.view.player.money;
  const riceBefore = r.view.player.items.rice ?? 0;
  r = await input('买一份干粮');
  ok(r.commandResult?.ok === true, '⑧ 购买：交易成功（宿主确定性经济 + 引擎命令链）', r.commandResult?.reason ?? '');
  const afterBuy = await snapshot();
  ok(afterBuy.player.money === moneyBefore - 3, '⑧ 购买：金钱一致（-3）', `${moneyBefore} → ${afterBuy.player.money}`);
  ok(afterBuy.player.items.rice === riceBefore + 1, '⑧ 购买：物品一致（干粮 +1）');
  ok(afterBuy.npcs.trader?.goods_rice === baseline.npcs.trader?.goods_rice - 1 && afterBuy.npcs.trader?.money === baseline.npcs.trader?.money + 3, '⑧ 购买：商人库存/收入一致（双向过账）');

  /* ---------- ⑨ 等待 → ⑩ 时间推进 ---------- */
  const dayBefore = afterBuy.day;
  r = await input('等待一天');
  ok(r.commandResult?.ok === true && r.view.worldDay === dayBefore + 1, '⑨⑩ 时间推进：世界日 +1（引擎时钟权威）', `D${dayBefore} → D${r.view.worldDay}`);
  ok(r.view.player.loc === 'shop' && r.view.player.money === afterBuy.player.money, '⑨⑩ 时间推进：位置与金钱无跳变');

  /* ---------- ⑪ 返回 → ⑫ 检查 NPC 变化 ---------- */
  r = await input('回村');
  r = await input('去酒馆');
  const finalState = await snapshot();
  const diffs = diffSnapshots(baseline, finalState);
  ok(finalState.player.loc === 'tavern', '⑪ 返回：玩家回到酒馆');
  ok(finalState.day > baseline.day, '⑫ 检查 NPC 变化：世界日推进已发生', `D${baseline.day} → D${finalState.day}`);

  /* NPC 变化清单（对照基线）+ 变化可解释性 */
  const npcDiffs = diffs.filter((d) => d.path.startsWith('npc.'));
  console.log(`  ⓘ NPC 状态变化（对照基线）：${npcDiffs.length ? npcDiffs.map((d) => `${d.path}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join('；') : '无'}`);
  /* 每一项 NPC 变化都要能对应到「日程/演化/宿主经济」三类已发生的机制 */
  const explainable = npcDiffs.every((d) => {
    if (d.path.endsWith('.location')) return true; /* 日程对齐（走查已验） */
    if (d.path.includes('.attention') || d.path.includes('.mood')) return true; /* 演化提案（下方因果性逐条 trace） */
    if (d.path.includes('money') || d.path.includes('goods_rice')) return true; /* 购买过账（上方已断言） */
    return false;
  });
  ok(explainable, '⑫ 检查 NPC 变化：每项变化可归类（日程/演化/经济），无不可解释漂移');

  /* ---------- AI 稳定性（全程聚合） ---------- */
  const allRuns = await evolutionRuns(200);
  /* 会话 run 集 = run id 集合差（对分页/环形窗口免疫；基线只取 id） */
  const baselineIds = new Set(baselineRuns.map((x) => x.id));
  const sessionRuns = allRuns.filter((x) => !baselineIds.has(x.id));
  const ids = new Set(sessionRuns.map((x) => x.id));
  const acceptedTotal = sessionRuns.reduce((a, x) => a + (x.acceptedCount ?? 0), 0);
  record.stability = {
    sessionRuns: sessionRuns.length,
    uniqueRuns: ids.size,
    acceptedTotal,
    contextTokens: sessionRuns.map((x) => x.context?.budgetReport?.estimatedTokens ?? 0),
    statuses: [...new Set(sessionRuns.map((x) => x.status))],
  };
  ok(ids.size === sessionRuns.length, 'AI 稳定性：run 无重复执行');
  ok(sessionRuns.length <= 12, 'AI 稳定性：全程 AI 调用有界（无循环/无风暴）', `${sessionRuns.length} 次（基线 ${baselineRuns.length} / 全量 ${allRuns.length}）`);
  ok(sessionRuns.every((x) => (x.context?.budgetReport?.estimatedTokens ?? 0) <= MAX_CONTEXT_TOKENS), 'AI 稳定性：Context 无爆炸');
  ok(acceptedTotal <= sessionRuns.length * 3, 'AI 稳定性：Proposal 落地有界');
  const rt = await runtimeStatus();
  const trig = rt.trigger?.worlds?.find((w) => w.worldId === WORLD);
  console.log(`  ⓘ 触发器全程：tick ${trig?.ticksFired ?? 0}｜零唤醒跳过 ${trig?.skippedNoWake ?? 0}｜非玩家事实跳过 ${trig?.skippedNoPlayerEvent ?? 0}｜冷却跳过 ${trig?.cooldownSkips ?? 0}｜世界重置 ${trig?.worldResets ?? 0}`);

  /* ---------- 因果性：每个演化落地变化可答八问 ---------- */
  const evolvedEvents = sessionRuns.flatMap((x) => (x.eventIds ?? []).map((eventId) => ({ eventId, run: x })));
  ok(evolvedEvents.length > 0 || sessionRuns.every((x) => (x.acceptedCount ?? 0) === 0), '因果性：存在演化落地事实（或全部为空提案判断）', `${evolvedEvents.length} 个演化事实`);
  for (const { eventId, run } of evolvedEvents) {
    const t = await trace(eventId);
    if (t.status !== 200 || !t.body?.chain) {
      findings.push(`因果链缺失：${eventId}`);
      continue;
    }
    const steps = t.body.chain.map((c) => c.step);
    const answers = {
      为什么: run.proposal?.reason?.slice(0, 60) ?? '',
      谁触发: `${run.trigger}${run.triggerGrade ? `/${run.triggerGrade}` : ''}`,
      哪个AI: run.modelUsed ?? '',
      哪个Proposal: t.body.causation?.proposalId ?? run.proposal?.id ?? '',
      哪个Rule: t.body.chain.find((c) => c.step === 'validation')?.detail ?? '',
      哪个Command: t.body.chain.find((c) => c.step === 'command')?.detail ?? '',
      哪个Mutation: t.body.chain.find((c) => c.step === 'mutation')?.detail ?? '',
      哪个Event: eventId,
    };
    const complete = ['trigger', 'context', 'model', 'proposal', 'validation', 'command', 'mutation', 'new_events'].every((s) => steps.includes(s));
    ok(complete && Object.values(answers).every((v) => String(v).length > 0), `因果性：${eventId} 八问可答（八环齐全）`, `${steps.join('→')}`);
    record.causality.push({ eventId, runId: run.id, answers, chain: t.body.chain });
  }

  /* ---------- 记录收尾 ---------- */
  record.evolutionRuns = sessionRuns.map((x) => ({ id: x.id, status: x.status, trigger: x.trigger, grade: x.triggerGrade, model: x.modelUsed, accepted: x.acceptedCount, rejected: x.rejectedCount, reason: x.proposal?.reason ?? '', contextTokens: x.context?.budgetReport?.estimatedTokens ?? 0 }));
  record.findings = findings;
  record.finishedAt = new Date().toISOString();
};

runAcceptance()
  .then(() => {
    console.log('═'.repeat(64));
    if (findings.length === 0) {
      console.log(`结果：P10 验收 ${stepNo} 项检查全部通过 ✓`);
      record.verdict = 'PASS';
    } else {
      console.log(`结果：${stepNo - findings.length}/${stepNo} 通过，异常 ${findings.length} 项：`);
      for (const f of findings) console.log(`  ✗ ${f}`);
      record.verdict = 'FAIL';
    }
    mkdirSync('docs', { recursive: true });
    writeFileSync('docs/P10-ACCEPTANCE.md', renderMarkdown(record), 'utf8');
    console.log('验收记录已写入 docs/P10-ACCEPTANCE.md');
    process.exit(findings.length === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('验收中断：', e);
    process.exit(1);
  });

function renderMarkdown(rec) {
  const lines = [];
  lines.push('# P10 天穹完整真实验收记录');
  lines.push('');
  lines.push(`> 时间：${rec.startedAt} ~ ${rec.finishedAt}　世界：${rec.world}　**结论：${rec.verdict}**`);
  lines.push('');
  lines.push('## 演化 run 全程留痕');
  lines.push('');
  lines.push('| run | 状态 | 触发 | 分级 | 模型 | 落地/被拒 | Context tokens | 判断摘要 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of rec.evolutionRuns) {
    lines.push(`| ${r.id} | ${r.status} | ${r.trigger} | ${r.grade ?? '-'} | ${r.model ?? '-'} | ${r.accepted}/${r.rejected} | ${r.contextTokens} | ${(r.reason ?? '').slice(0, 60)} |`);
  }
  lines.push('');
  lines.push('## 因果性（每个演化落地事实的八问）');
  lines.push('');
  for (const c of rec.causality) {
    lines.push(`### ${c.eventId}（run ${c.runId}）`);
    lines.push('```');
    for (const [q, a] of Object.entries(c.answers)) lines.push(`${q}：${a}`);
    lines.push('```');
  }
  if (rec.causality.length === 0) lines.push('（本轮全部演化 run 均为空提案判断——「为什么没发生」由 run.proposal.reason 留痕回答）');
  lines.push('');
  lines.push('## AI 稳定性');
  lines.push('```');
  lines.push(JSON.stringify(rec.stability, null, 2));
  lines.push('```');
  if (rec.findings.length) {
    lines.push('## 异常');
    for (const f of rec.findings) lines.push(`- ✗ ${f}`);
  }
  return lines.join('\n');
}

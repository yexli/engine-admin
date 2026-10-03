/* ============================================================
   Tianqiong Minimal Host（方案 V2 §三：天穹最小真实接入）
   ------------------------------------------------------------
   这是「游戏方」角色的参考宿主：把天穹的最小世界（村庄/酒馆/商店，
   玩家/米露/酒馆老板/商人老葛，金钱/物品/时间/关系/注意力）真实接入
   World Engine——全程 HTTP，与引擎不同进程，零特权，不用 Mock 冒充。

   四条真实链路：
   1. 玩家输入 → Tianqiong Intent（确定性解析）→ World Command
      → Rules → Mutation → 玩家进入酒馆 → Event
   2. 天穹消费 Event（幂等：断线重放不重复消费）→ 游戏视图更新
   3. High 事件（玩家进入 NPC 所在地/主动交互）→ 平台内 Trigger Engine
      自动触发演化（分级 + 逐实体唤醒评估，无人值得唤醒就零 AI 调用；
      AI 判断 NPC 是否行动——可以不行动）
   4. Evolution → Rules → Mutation → Event → 天穹消费 → 玩家看到
      符合因果链的世界变化（AI 判断以叙事呈现，标记 narrative=true）

   运行（dev-stack 已自动拉起；也可独立运行）：
     ENGINE_BASE_URL=http://127.0.0.1:8787 \
     PLATFORM_ADMIN_URL=http://127.0.0.1:8791 \
     PLATFORM_ADMIN_TOKEN=<管理令牌> \
     node scripts/run-tianqiong-host.mjs

   API（127.0.0.1:8795）：
     POST /tianqiong/input  {"text": "我想去酒馆找米露。"}
     GET  /tianqiong/view   玩家当前看到的世界
     GET  /tianqiong/events 天穹消费过的事实（幂等去重后）
     GET  /healthz
   ============================================================ */
import { createServer } from 'node:http';
import { applyNpcSchedule, createEngineClient, createEventConsumer } from '../platform/dist/index.js';

const ENGINE = (process.env.ENGINE_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ADMIN = (process.env.PLATFORM_ADMIN_URL ?? 'http://127.0.0.1:8791').replace(/\/+$/, '');
const TOKEN = process.env.PLATFORM_ADMIN_TOKEN ?? '';
const PORT = Number(process.env.PORT ?? 8795);
const WORLD = 'tianqiong-village';

const engine = createEngineClient({ baseUrl: ENGINE });

/* ---------- 1) 确保最小世界存在（真实命令链播种） ---------- */
async function cmd(type, extra = {}) {
  const res = await engine.executeCommand(WORLD, { type, ...extra });
  return res.ok ? res.result : { ok: false, events: [], reason: `HTTP ${res.status}: ${res.error}` };
}

async function ensureWorld() {
  const probe = await engine.proxy('GET', `/v1/worlds/${WORLD}`);
  if (probe.status === 200) {
    console.log(`[tianqiong] 世界 ${WORLD} 已存在，复用（引擎进程内存态；引擎重启后会自动重建）`);
    return;
  }
  /* HTTP 建世界走引擎白名单（worldId/playerName/startLoc/weather/name/ownerGame/locations）——
     地点表随 World Definition 物化进引擎（P2：GET locations 可查、AI 上下文带地点描述），
     宿主视图层的 PLACE_NAMES 只管显示名。 */
  const created = await engine.proxy('POST', '/v1/worlds', {
    worldId: WORLD,
    playerName: '旅人',
    startLoc: 'village',
    weather: 'clear',
    name: '天穹 · 最小村庄',
    ownerGame: 'tianqiong',
    locations: [
      { id: 'village', name: '村庄' },
      { id: 'tavern', type: 'building', name: '米露的酒馆' },
      { id: 'shop', type: 'building', name: '杂货商店' },
    ],
  });
  if (created.status !== 201) throw new Error(`建世界失败 HTTP ${created.status}: ${JSON.stringify(created.body)}`);

  /* 引擎 HTTP 命令的 payload 只收一维基本类型（净化纪律）——
     NPC 字段用 create_entity（id/name/location）+ 逐字段 update_attribute 播种。
     attention（注意力）= 方案 P2 状态清单项：NPC 当前在注意谁/什么；
     AI 演化可用 update_attribute 维护它（白名单内），玩家视图可见。 */
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } },
    { type: 'update_attribute', targetId: 'milu', payload: { key: 'mood', value: '平静' } },
    { type: 'update_attribute', targetId: 'milu', payload: { key: 'money', value: 20 } },
    { type: 'update_attribute', targetId: 'milu', payload: { key: 'attention', value: '无人' } },
    { type: 'update_attribute', targetId: 'milu', payload: { key: 'goal', value: '把酒馆经营好，弄清常客们的来历' } },
    { type: 'create_entity', payload: { id: 'keeper', type: 'npc', name: '酒馆老板老周', location: 'tavern' } },
    { type: 'update_attribute', targetId: 'keeper', payload: { key: 'mood', value: '平静' } },
    { type: 'update_attribute', targetId: 'keeper', payload: { key: 'money', value: 200 } },
    { type: 'update_attribute', targetId: 'keeper', payload: { key: 'ale_stock', value: 10 } },
    { type: 'update_attribute', targetId: 'keeper', payload: { key: 'attention', value: '无人' } },
    { type: 'create_entity', payload: { id: 'trader', type: 'npc', name: '商人老葛', location: 'shop' } },
    { type: 'update_attribute', targetId: 'trader', payload: { key: 'mood', value: '平静' } },
    { type: 'update_attribute', targetId: 'trader', payload: { key: 'money', value: 100 } },
    { type: 'update_attribute', targetId: 'trader', payload: { key: 'goods_rice', value: 50 } },
    { type: 'update_attribute', targetId: 'trader', payload: { key: 'attention', value: '无人' } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'money', value: 50 } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'item_ale', value: 0 } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'item_rice', value: 0 } },
    { type: 'set_relation', actorId: 'milu', targetId: 'keeper', payload: { type: 'colleague', value: 30 } },
  ]) {
    const r = await cmd(c.type, c);
    if (!r.ok) throw new Error(`种子命令被拒绝：${JSON.stringify(r)}`);
  }
  console.log(`[tianqiong] 最小世界就绪：${WORLD}（村庄/酒馆/商店 + 米露/老周/老葛；玩家 50 钱）`);
}

/* ---------- 2) 玩家视图（玩家看到的世界 = 引擎权威事实的投影） ---------- */
/** 地点显示名归宿主（引擎只认地点 id；显示层是游戏的事） */
const PLACE_NAMES = { village: '村庄', tavern: '米露的酒馆', shop: '杂货商店' };

/* ---------- 2.5) NPC 每日日程（方案 V2.1 §九 / P6）----------
   日程表是游戏数据（谁、哪个时段、在哪）——宿主持有数据并在启动时
   注册给平台（PUT /v1/npc/worlds/:id/schedules），平台 Schedule Runtime
   负责确定性对齐循环（时间事实 → applyNpcSchedule，零 AI 调用）。
   宿主保留输入时/启动时的立即对齐（快速反馈；对齐天然幂等，双驱动
   竞态只会多读一次状态，不会重复移动）。 */
const SCHEDULES = {
  milu: [
    { from: 0, to: 16, location: 'village' }, // 夜里回村歇息
    { from: 16, to: 48, location: 'tavern' }, // 白天在酒馆
  ],
  keeper: [
    { from: 0, to: 20, location: 'village' }, // 早上在家
    { from: 20, to: 44, location: 'tavern' }, // 午后营业
    { from: 44, to: 48, location: 'shop' }, // 打烊前去商店进货
  ],
  trader: [
    { from: 0, to: 10, location: 'village' }, // 清晨备货
    { from: 10, to: 46, location: 'shop' }, // 白天守摊
    { from: 46, to: 48, location: 'village' }, // 收摊回家
  ],
};

async function alignSchedule() {
  try {
    const r = await applyNpcSchedule(engine, WORLD, SCHEDULES);
    for (const m of r.moved) console.log(`  [日程] ${m.id}：${m.from} → ${m.to}（事实 ${m.eventIds.join(',')}）`);
    for (const rej of r.rejected) console.log(`  [日程拒绝] ${rej.id} → ${rej.to}：${rej.reason}`);
    return r;
  } catch (e) {
    console.log(`  [日程失败] ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 启动时把日程注册给平台（P6：游戏数据归宿主，确定性执行归平台） */
async function registerSchedules() {
  if (!TOKEN) {
    console.log('  [日程注册跳过] 未配置 PLATFORM_ADMIN_TOKEN（平台调度器未接管本世界日程）');
    return;
  }
  try {
    const res = await fetch(`${ADMIN}/v1/npc/worlds/${WORLD}/schedules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify(SCHEDULES),
    });
    if (res.status === 200) console.log(`  [日程注册] ${WORLD}：${Object.keys(SCHEDULES).length} 个 NPC 的日程已注册给平台调度器`);
    else console.log(`  [日程注册失败] HTTP ${res.status}：${await res.text().catch(() => '')}`);
  } catch (e) {
    console.log(`  [日程注册失败] ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function gameView() {
  const s = await engine.getState(WORLD);
  if (!s.ok) return { error: s.error };
  const st = s.state;
  const loc = st.player?.loc;
  const here = Object.entries(st.npcs ?? {})
    .filter(([, n]) => n.attributes?.location === loc)
    .map(([id, n]) => ({
      id,
      name: n.attributes?.name ?? id,
      mood: n.attributes?.mood ?? null,
      attention: n.attributes?.attention ?? null,
      att: n.att,
      met: n.met === true,
    }));
  return {
    worldDay: Math.floor((st.t ?? 0) / 48) + 1,
    tick: st.t ?? 0,
    player: {
      loc,
      locName: PLACE_NAMES[loc ?? ''] ?? loc,
      money: st.player?.attributes?.money ?? 0,
      items: { ale: st.player?.attributes?.item_ale ?? 0, rice: st.player?.attributes?.item_rice ?? 0 },
    },
    here,
    hereSay: here.length
      ? `这里能看到：${here.map((h) => h.name).join('、')}`
      : '四周静悄悄的，没有别人。',
  };
}

/* ---------- 3) 意图解析（天穹侧确定性 NLU；OOC 永远不进引擎） ---------- */
async function parseIntent(text) {
  const view = await gameView();
  const loc = view.player?.loc;
  const at = (l) => loc === l;
  const walk = (l) => ({ kind: 'ic_action', command: { type: 'move', targetId: l } });

  if (/酒馆|客栈/.test(text)) return walk('tavern');
  if (/商店|杂货/.test(text)) return walk('shop');
  if (/回村|村庄/.test(text)) return walk('village');
  if (/找米露|米露在(吗|哪)/.test(text)) {
    if (!at('tavern')) return { kind: 'ic_action', command: { type: 'move', targetId: 'tavern' }, hint: '米露在酒馆，先动身过去' };
    return { kind: 'ic_action', command: { type: 'talk', targetId: 'milu', text } };
  }
  if (/米露/.test(text)) {
    /* 直接对米露说话（如「米露，你好」）：在酒馆 = 交谈；不在 = 先动身 */
    if (!at('tavern')) return { kind: 'ic_action', command: { type: 'move', targetId: 'tavern' }, hint: '米露在酒馆，先动身过去' };
    return { kind: 'ic_action', command: { type: 'talk', targetId: 'milu', text } };
  }
  if (/(和|跟|与).*(老板|老周)|找老板/.test(text)) {
    if (!at('tavern')) return { kind: 'ic_action', command: { type: 'move', targetId: 'tavern' }, hint: '老板在酒馆' };
    return { kind: 'ic_action', command: { type: 'talk', targetId: 'keeper', text } };
  }
  if (/找(商人|老葛)|(和|跟|与).*(商人|老葛)/.test(text)) {
    if (!at('shop')) return { kind: 'ic_action', command: { type: 'move', targetId: 'shop' }, hint: '商人老葛在商店' };
    return { kind: 'ic_action', command: { type: 'talk', targetId: 'trader', text } };
  }
  if (/买(一(杯|瓶))?酒|来(一(杯|瓶))?酒/.test(text)) {
    if (!at('tavern')) return { kind: 'ic_action', command: { type: 'move', targetId: 'tavern' }, hint: '买酒要去酒馆' };
    return { kind: 'ic_action', command: { type: '__purchase_ale' } }; // 宿主确定性经济逻辑（见下）
  }
  if (/买.*(干粮|粮食|米)|来(一|点)?(份|袋)?干粮|干粮/.test(text)) {
    if (!at('shop')) return { kind: 'ic_action', command: { type: 'move', targetId: 'shop' }, hint: '买干粮要去商店' };
    return { kind: 'ic_action', command: { type: '__purchase_rice' } }; // 商店确定性经济逻辑（老葛守摊，见下）
  }
  const days = text.match(/(\d+)\s*天/);
  if (/等待|过夜|休息|度过/.test(text) || days) {
    const n = days ? Number(days[1]) : 1;
    return { kind: 'ic_action', command: { type: 'advance_time', amount: Math.max(1, n) * 48 } };
  }
  /* 场外话 / 叙事：只留档，绝不进引擎（方案 §七 OOC 隔离在真实宿主生效）。
     越权/作弊类请求（改数值、调等级、外挂）一律 OOC——玩法内没有这些动作。 */
  if (/帮助|设置|难度|界面|音量|等级|变强|作弊|外挂|无敌|调到|改成|金币|给我/.test(text)) return { kind: 'ooc' };
  return { kind: 'narrative' };
}

/** 买酒：宿主侧确定性经济（价格归游戏，不归 AI、不归引擎），
 *  但每一步状态变化仍走引擎命令链（Rules 放行才发生） */
async function purchaseAle() {
  const s = await engine.getState(WORLD);
  if (!s.ok) return { ok: false, reason: s.error };
  const st = s.state;
  const money = st.player?.attributes?.money ?? 0;
  const stock = st.npcs?.keeper?.attributes?.ale_stock ?? 0;
  if (money < 5) return { ok: false, reason: '钱不够（一杯淡啤 5 钱）' };
  if (stock < 1) return { ok: false, reason: '老周：酒窖里的淡啤卖完了' };
  const results = [];
  for (const c of [
    { type: 'update_attribute', targetId: 'player', payload: { key: 'money', value: money - 5 } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'item_ale', value: (st.player?.attributes?.item_ale ?? 0) + 1 } },
    { type: 'update_attribute', targetId: 'keeper', payload: { key: 'ale_stock', value: stock - 1 } },
    { type: 'update_attribute', targetId: 'keeper', payload: { key: 'money', value: (st.npcs?.keeper?.attributes?.money ?? 200) + 5 } },
  ]) {
    const r = await cmd(c.type, c);
    results.push(r);
    if (!r.ok) break;
  }
  const failed = results.find((r) => !r.ok);
  return failed ? failed : { ok: true, events: results.flatMap((r) => r.events), reason: '老周递过一杯淡啤：「慢用。」（-5 钱）' };
}

/** 商店买干粮：宿主侧确定性经济（价格归游戏），但比买酒多一条纪律——
 *  校验商人在场（V2.1 已知简化「买酒不校验老周在场」不再复制到新路径）。
 *  每一步状态变化仍走引擎命令链（Rules 放行才发生）。 */
async function purchaseRice() {
  const s = await engine.getState(WORLD);
  if (!s.ok) return { ok: false, reason: s.error };
  const st = s.state;
  const traderLoc = st.npcs?.trader?.attributes?.location;
  if (traderLoc !== st.player?.loc) return { ok: false, reason: '柜台后面没人——商人老葛不在这儿' };
  const money = st.player?.attributes?.money ?? 0;
  const stock = st.npcs?.trader?.attributes?.goods_rice ?? 0;
  if (money < 3) return { ok: false, reason: '钱不够（一份干粮 3 钱）' };
  if (stock < 1) return { ok: false, reason: '老葛：干粮今天卖完了，明儿赶早' };
  const results = [];
  for (const c of [
    { type: 'update_attribute', targetId: 'player', payload: { key: 'money', value: money - 3 } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'item_rice', value: (st.player?.attributes?.item_rice ?? 0) + 1 } },
    { type: 'update_attribute', targetId: 'trader', payload: { key: 'goods_rice', value: stock - 1 } },
    { type: 'update_attribute', targetId: 'trader', payload: { key: 'money', value: (st.npcs?.trader?.attributes?.money ?? 100) + 3 } },
  ]) {
    const r = await cmd(c.type, c);
    results.push(r);
    if (!r.ok) break;
  }
  const failed = results.find((r) => !r.ok);
  return failed ? failed : { ok: true, events: results.flatMap((r) => r.events), reason: '老葛麻利地包好一份干粮：「路上吃。」（-3 钱）' };
}

/* ---------- 4) 事件消费（幂等）+ 日程对齐 ----------
   P3 起「High 事件 → 触发演化」由平台内 Trigger Engine 负责
   （run-managed 装配，守护本世界）：宿主只消费事实做显示与
   日程对齐，不再自行 POST tick——触发是平台的事，显示是游戏的事。
   双方若同时触发，演化幂等层（同键 auto:{world}:{eventId}）保证只执行一次。 */
const consumer = createEventConsumer({
  consumerId: 'tianqiong-host',
  onEvent: (e) => {
    console.log(`  【天穹收到事实】[${e.id}] ${e.type}${e.actor ? ` actor=${e.actor}` : ''}`);
  },
});
const consumed = []; // 玩家可见的已消费事实（新 → 旧）

async function pollEvents() {
  const res = await engine.getEvents(WORLD, 30);
  if (!res.ok) return;
  const fresh = consumer.feed(res.events);
  for (const e of fresh) {
    consumed.unshift({ id: e.id, type: e.type, actor: e.actor ?? null, grade: e.grade });
    if (consumed.length > 100) consumed.pop();
  }
  /* 时间类事实 → 日程对齐（确定性：Time + Schedule + Rules，方案 §九） */
  if (fresh.some((e) => e.type === 'new_day' || e.type === 'hour_advanced' || e.type === 'time_advanced')) {
    await alignSchedule();
  }
}

/* ---------- 5) 演化反应呈现（交流的可见面） ----------
   演化 run 的 proposal.reason 是 AI 的叙事判断，不是世界事实（方案 §七）——
   宿主把它作为「NPC 反应」呈现给玩家，只进显示层，绝不写回世界。
   触发在平台侧异步发生：从输入时刻起等一个新完成的 run（上限 6s，
   覆盖触发轮询间隔 + 模型时延）；等不到就如实返回 null。 */
async function waitForReaction(fromMs, timeoutMs = 6000) {
  if (!TOKEN) return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${ADMIN}/v1/evolution/worlds/${WORLD}/runs?n=3`, {
        headers: { 'x-admin-token': TOKEN },
      });
      if (res.status === 200) {
        const body = await res.json().catch(() => null);
        const run = (body?.runs ?? []).find((r) => r.finishedAt && Date.parse(r.finishedAt) >= fromMs);
        if (run) {
          return {
            narrative: true, /* 标记：这是叙事呈现，不是世界事实 */
            status: run.status,
            reaction: run.proposal?.reason ?? '',
            applied: run.acceptedCount ?? 0,
            rejected: run.rejectedCount ?? 0,
            runId: run.id,
          };
        }
      }
    } catch {
      /* 管理面不可达：无反应可呈现 */
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/* ---------- 6) 宿主 HTTP 面 ---------- */
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/healthz' && req.method === 'GET') return send(200, { ok: true, service: 'tianqiong-host', world: WORLD });
  if (url.pathname === '/tianqiong/schedule' && req.method === 'GET') {
    /* P9 单一数据源：日程权威在平台（宿主启动时注册）——展示层读平台，
       平台不可达才回退本地副本（游戏数据仍在宿主种子）。 */
    const respond = (schedules) => send(200, { schedules });
    if (TOKEN) {
      fetch(`${ADMIN}/v1/npc/worlds/${WORLD}/schedules`, { headers: { 'x-admin-token': TOKEN } })
        .then((r) => (r.status === 200 ? r.json() : null))
        .then((body) => respond(body?.schedules ?? SCHEDULES))
        .catch(() => respond(SCHEDULES));
      return;
    }
    return respond(SCHEDULES);
  }
  if (url.pathname === '/tianqiong/view' && req.method === 'GET') return gameView().then((v) => send(200, v));
  if (url.pathname === '/tianqiong/events' && req.method === 'GET') return send(200, { consumed });
  if (url.pathname === '/tianqiong/input' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(raw || '{}');
        if (typeof text !== 'string' || !text.trim()) return send(400, { error: 'body 必须是 {"text": "..."}' });
        console.log(`\n[玩家] 「${text}」`);
        const inputStartedAt = Date.now() - 1500; /* 触发/执行异步链的起点（留轮询相位余量） */
        const intent = await parseIntent(text);
        let commandResult;
        if (intent.kind === 'ic_action' && intent.command) {
          if (intent.command.type === '__purchase_ale') {
            commandResult = await purchaseAle();
          } else if (intent.command.type === '__purchase_rice') {
            commandResult = await purchaseRice();
          } else {
            commandResult = await cmd(intent.command.type, intent.command);
          }
          console.log(`  [天穹→引擎] ${intent.command.type} → ${commandResult.ok ? `事实 ${commandResult.events.join(', ')}` : `拒绝：${commandResult.reason}`}`);
          if (intent.command.type === 'advance_time' && commandResult.ok) await alignSchedule(); // 时间被推进 → 立刻对齐日程
          if (intent.command.type === 'move' && commandResult.ok) await pollEvents();
        } else {
          console.log(`  [天穹] ${intent.kind === 'ooc' ? '场外话，只留档不进世界' : '叙事文本，只留档不进世界'}`);
        }
        await pollEvents();
        send(200, {
          intent: { kind: intent.kind, ...(intent.hint ? { hint: intent.hint } : {}) },
          commandResult,
          ...(intent.kind === 'ic_action' ? { reaction: await waitForReaction(inputStartedAt) } : {}),
          view: await gameView(),
        });
      } catch (e) {
        send(500, { error: e instanceof Error ? e.message : String(e) });
      }
    });
    return;
  }
  send(404, { error: 'no such route' });
});

await ensureWorld();
await registerSchedules(); // P6：日程注册给平台调度器（确定性对齐循环）
await alignSchedule(); // 启动即对齐：引擎刚重启/世界刚建好，NPC 按当前时刻日程归位
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[tianqiong] Tianqiong Host listening at http://127.0.0.1:${PORT}`);
  console.log(`[tianqiong]   引擎: ${ENGINE}  世界: ${WORLD}`);
  console.log(`[tianqiong]   试试: curl -X POST http://127.0.0.1:${PORT}/tianqiong/input -H "content-type: application/json" -d '{"text":"我想去酒馆找米露。"}'`);
});
setInterval(() => void pollEvents(), 3000); // 事件轮询（3s；真实游戏可切 G3 WebSocket 流）
void pollEvents();

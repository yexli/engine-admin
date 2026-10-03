/* ============================================================
   Trade Road Host（P12 · 方案 §十五：第二游戏验证——极简商贸世界）
   ------------------------------------------------------------
   Game B「商路」：三城两商人的低买高卖世界，验证同一引擎与平台栈
   可被第二个游戏**纯经 Adapter/配置**接入——零引擎 Core 改动、
   零平台代码改动（P3-P9 全部能力经环境变量声明复用）。

   世界（GameWorldSeed 语义，经 HTTP 命令链播种）：
     城市：泉州港 / 杭州集市 / 广州商馆
     商人：胡商阿卜杜（泉州：卖香料 6 / 收丝绸 12）
           浙商沈万（杭州：卖丝绸 8 / 收香料 10）
     玩家：行商阿贵（100 钱）——低买高卖，一循环净赚 8 钱
     关系/心情/注意力/目标：与天穹同款属性约定（AI 可经白名单维护）

   分工（与天穹宿主完全同构）：
     价格/库存/交易  = 游戏（本宿主确定性经济，价格归游戏）
     每一步状态变化  = 引擎命令链（Rules 放行才发生）
     NPC 反应        = 平台触发器 → 个体演化（AI 可空提案）
     场外话/叙事     = 永不进引擎

   运行：PLATFORM_*_WORLDS 含 trade-road 时平台自动守护本世界。
   API（127.0.0.1:8796）：
     POST /trade/input {"text": "去杭州"} / GET /trade/view / /trade/events / /healthz
   ============================================================ */
import { createServer } from 'node:http';
import { createEngineClient, createEventConsumer } from '../platform/dist/index.js';

const ENGINE = (process.env.ENGINE_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ADMIN = (process.env.PLATFORM_ADMIN_URL ?? 'http://127.0.0.1:8791').replace(/\/+$/, '');
const TOKEN = process.env.PLATFORM_ADMIN_TOKEN ?? '';
const PORT = Number(process.env.PORT ?? 8796);
const WORLD = 'trade-road';

const engine = createEngineClient({ baseUrl: ENGINE });

/* ---------- 行情表（价格归游戏；引擎只存事实） ---------- */
const CITY_NAMES = { quanzhou: '泉州港', hangzhou: '杭州集市', guangzhou: '广州商馆' };
const GOODS = {
  spice: { name: '香料', itemKey: 'item_spice', stockKey: 'spice_stock' },
  silk: { name: '丝绸', itemKey: 'item_silk', stockKey: 'silk_stock' },
};
/** 市场表：sell = 商人卖给玩家（玩家买）；buy = 商人向玩家收购（玩家卖） */
const MARKET = {
  spice: {
    sell: { npc: 'abdul', city: 'quanzhou', price: 6 },
    buy: { npc: 'shen', city: 'hangzhou', price: 10 },
  },
  silk: {
    sell: { npc: 'shen', city: 'hangzhou', price: 8 },
    buy: { npc: 'abdul', city: 'quanzhou', price: 12 },
  },
};

/* ---------- 1) 确保世界存在（HTTP 命令链播种；幂等） ---------- */
async function cmd(type, extra = {}) {
  const res = await engine.executeCommand(WORLD, { type, ...extra });
  return res.ok ? res.result : { ok: false, events: [], reason: `HTTP ${res.status}: ${res.error}` };
}

async function ensureWorld() {
  const probe = await engine.proxy('GET', `/v1/worlds/${WORLD}`);
  if (probe.status === 200) {
    console.log(`[trade] 世界 ${WORLD} 已存在，复用（引擎进程内存态；引擎重启后自动重建）`);
    return;
  }
  const created = await engine.proxy('POST', '/v1/worlds', {
    worldId: WORLD,
    playerName: '行商阿贵',
    startLoc: 'quanzhou',
    weather: 'clear',
    name: '商路 · 三城贸易',
    ownerGame: 'trade-road',
    locations: [
      { id: 'quanzhou', name: '泉州港' },
      { id: 'hangzhou', name: '杭州集市' },
      { id: 'guangzhou', name: '广州商馆' },
    ],
  });
  if (created.status !== 201) throw new Error(`建世界失败 HTTP ${created.status}: ${JSON.stringify(created.body)}`);
  for (const c of [
    { type: 'create_entity', payload: { id: 'abdul', type: 'npc', name: '胡商阿卜杜', location: 'quanzhou' } },
    { type: 'update_attribute', targetId: 'abdul', payload: { key: 'mood', value: '平和' } },
    { type: 'update_attribute', targetId: 'abdul', payload: { key: 'money', value: 300 } },
    { type: 'update_attribute', targetId: 'abdul', payload: { key: 'spice_stock', value: 20 } },
    { type: 'update_attribute', targetId: 'abdul', payload: { key: 'silk_stock', value: 0 } },
    { type: 'update_attribute', targetId: 'abdul', payload: { key: 'attention', value: '无人' } },
    { type: 'update_attribute', targetId: 'abdul', payload: { key: 'goal', value: '把香料卖个好价钱，收满一船丝绸' } },
    { type: 'create_entity', payload: { id: 'shen', type: 'npc', name: '浙商沈万', location: 'hangzhou' } },
    { type: 'update_attribute', targetId: 'shen', payload: { key: 'mood', value: '精明' } },
    { type: 'update_attribute', targetId: 'shen', payload: { key: 'money', value: 300 } },
    { type: 'update_attribute', targetId: 'shen', payload: { key: 'silk_stock', value: 20 } },
    { type: 'update_attribute', targetId: 'shen', payload: { key: 'spice_stock', value: 0 } },
    { type: 'update_attribute', targetId: 'shen', payload: { key: 'attention', value: '无人' } },
    { type: 'update_attribute', targetId: 'shen', payload: { key: 'goal', value: '低买高卖，做三城最大的丝绸商' } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'money', value: 100 } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'item_spice', value: 0 } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'item_silk', value: 0 } },
  ]) {
    const r = await cmd(c.type, c);
    if (!r.ok) throw new Error(`种子命令被拒绝：${JSON.stringify(r)}`);
  }
  console.log(`[trade] 商贸世界就绪：${WORLD}（泉州/杭州/广州 + 阿卜杜/沈万；玩家 100 钱）`);
}

/* ---------- 2) 玩家视图 ---------- */
async function tradeView() {
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
      locName: CITY_NAMES[loc ?? ''] ?? loc,
      money: st.player?.attributes?.money ?? 0,
      goods: { spice: st.player?.attributes?.item_spice ?? 0, silk: st.player?.attributes?.item_silk ?? 0 },
    },
    here,
    hereSay: here.length ? `这里能看到：${here.map((h) => h.name).join('、')}` : '码头上风很大，没有熟人。',
  };
}

/* ---------- 3) 交易（宿主确定性经济；每步经引擎命令链） ---------- */
/** 买商品：向所在城市的供货商人买（价格归行情表） */
async function buyGood(goodKey) {
  const good = GOODS[goodKey];
  const m = MARKET[goodKey].sell;
  const s = await engine.getState(WORLD);
  if (!s.ok) return { ok: false, reason: s.error };
  const st = s.state;
  const npcLoc = st.npcs?.[m.npc]?.attributes?.location;
  if (npcLoc !== st.player?.loc) return { ok: false, reason: `这城里没有卖${good.name}的商人（${m.npc === 'abdul' ? '阿卜杜' : '沈万'}在${CITY_NAMES[m.city]}）` };
  const money = st.player?.attributes?.money ?? 0;
  const stock = st.npcs?.[m.npc]?.attributes?.[good.stockKey] ?? 0;
  if (money < m.price) return { ok: false, reason: `钱不够（${good.name} ${m.price} 钱）` };
  if (stock < 1) return { ok: false, reason: '货源刚售罄，等下一船吧' };
  const results = [];
  for (const c of [
    { type: 'update_attribute', targetId: 'player', payload: { key: 'money', value: money - m.price } },
    { type: 'update_attribute', targetId: 'player', payload: { key: good.itemKey, value: (st.player?.attributes?.[good.itemKey] ?? 0) + 1 } },
    { type: 'update_attribute', targetId: m.npc, payload: { key: good.stockKey, value: stock - 1 } },
    { type: 'update_attribute', targetId: m.npc, payload: { key: 'money', value: (st.npcs?.[m.npc]?.attributes?.money ?? 0) + m.price } },
  ]) {
    const r = await cmd(c.type, c);
    results.push(r);
    if (!r.ok) break;
  }
  const failed = results.find((x) => !x.ok);
  return failed ? failed : { ok: true, events: results.flatMap((x) => x.events), reason: `成交：买入${good.name}（-${m.price} 钱）` };
}

/** 卖商品：向所在城市的收购商人卖 */
async function sellGood(goodKey) {
  const good = GOODS[goodKey];
  const m = MARKET[goodKey].buy;
  const s = await engine.getState(WORLD);
  if (!s.ok) return { ok: false, reason: s.error };
  const st = s.state;
  const npcLoc = st.npcs?.[m.npc]?.attributes?.location;
  if (npcLoc !== st.player?.loc) return { ok: false, reason: `这城里没人收${good.name}（${m.npc === 'abdul' ? '阿卜杜' : '沈万'}在${CITY_NAMES[m.city]}收）` };
  const held = st.player?.attributes?.[good.itemKey] ?? 0;
  if (held < 1) return { ok: false, reason: `你身上没有${good.name}` };
  const npcMoney = st.npcs?.[m.npc]?.attributes?.money ?? 0;
  if (npcMoney < m.price) return { ok: false, reason: '对方现金不够，收不了这批' };
  for (const c of [
    { type: 'update_attribute', targetId: 'player', payload: { key: 'money', value: (st.player?.attributes?.money ?? 0) + m.price } },
    { type: 'update_attribute', targetId: 'player', payload: { key: good.itemKey, value: held - 1 } },
    { type: 'update_attribute', targetId: m.npc, payload: { key: good.stockKey, value: (st.npcs?.[m.npc]?.attributes?.[good.stockKey] ?? 0) + 1 } },
    { type: 'update_attribute', targetId: m.npc, payload: { key: 'money', value: npcMoney - m.price } },
  ]) {
    const r = await cmd(c.type, c);
    if (!r.ok) return r;
  }
  return { ok: true, events: [], reason: `成交：卖出${good.name}（+${m.price} 钱）` };
}

/** 行情（只读信息，不产生命令） */
async function marketInfo() {
  const s = await engine.getState(WORLD);
  if (!s.ok) return '行情暂不可知。';
  const st = s.state;
  const stockOf = (npc, key) => st.npcs?.[npc]?.attributes?.[key] ?? 0;
  return [
    `泉州港：阿卜杜 卖香料 ${MARKET.spice.sell.price} 钱（存 ${stockOf('abdul', 'spice_stock')}）｜收丝绸 ${MARKET.silk.buy.price} 钱`,
    `杭州集市：沈万 卖丝绸 ${MARKET.silk.sell.price} 钱（存 ${stockOf('shen', 'silk_stock')}）｜收香料 ${MARKET.spice.buy.price} 钱`,
    `广州商馆：尚未开市。`,
    `行商提示：泉州买香料 → 杭州卖出，一单赚 ${MARKET.spice.buy.price - MARKET.spice.sell.price} 钱。`,
  ].join('\n');
}

/* ---------- 4) 意图解析（商贸世界确定性 NLU） ---------- */
async function parseIntent(text) {
  const v = await tradeView();
  const loc = v.player?.loc;
  const at = (c) => loc === c;
  const walk = (c) => ({ kind: 'ic_action', command: { type: 'move', targetId: c } });

  if (/泉州/.test(text)) return at('quanzhou') ? { kind: 'ic_action', command: { type: 'move', targetId: 'quanzhou' } } : walk('quanzhou');
  if (/杭州/.test(text)) return at('hangzhou') ? { kind: 'ic_action', command: { type: 'move', targetId: 'hangzhou' } } : walk('hangzhou');
  if (/广州/.test(text)) return walk('guangzhou');
  if (/行情|价格|市价/.test(text)) return { kind: 'narrative', info: await marketInfo() };
  for (const key of Object.keys(GOODS)) {
    const g = GOODS[key];
    if (new RegExp(`买.*(中)?${g.name}|来(一|点)?(批)?${g.name}`).test(text)) {
      const m = MARKET[key].sell;
      if (!at(m.city)) return { kind: 'ic_action', command: { type: 'move', targetId: m.city }, hint: `${g.name}要去${CITY_NAMES[m.city]}进` };
      return { kind: 'ic_action', command: { type: `__buy_${key}` } };
    }
    if (new RegExp(`卖.*(中)?${g.name}|出(一|批)?${g.name}|${g.name}卖`).test(text)) {
      const m = MARKET[key].buy;
      if (!at(m.city)) return { kind: 'ic_action', command: { type: 'move', targetId: m.city }, hint: `${g.name}在${CITY_NAMES[m.city]}出价高` };
      return { kind: 'ic_action', command: { type: `__sell_${key}` } };
    }
  }
  if (/阿卜杜/.test(text)) {
    if (!at('quanzhou')) return { kind: 'ic_action', command: { type: 'move', targetId: 'quanzhou' }, hint: '阿卜杜在泉州港' };
    return { kind: 'ic_action', command: { type: 'talk', targetId: 'abdul', text } };
  }
  if (/沈万/.test(text)) {
    if (!at('hangzhou')) return { kind: 'ic_action', command: { type: 'move', targetId: 'hangzhou' }, hint: '沈万在杭州集市' };
    return { kind: 'ic_action', command: { type: 'talk', targetId: 'shen', text } };
  }
  if (/帮助|设置|难度|界面|音量|等级|变强|作弊|外挂|无敌|调到|改成|给我/.test(text)) return { kind: 'ooc' };
  if (/等待|过夜|休息|度过/.test(text)) {
    const days = text.match(/(\d+)\s*天/);
    const n = days ? Number(days[1]) : 1;
    return { kind: 'ic_action', command: { type: 'advance_time', amount: Math.max(1, n) * 48 } };
  }
  return { kind: 'narrative' };
}

/* ---------- 5) 事件消费（幂等）+ 日程对齐 ---------- */
const consumer = createEventConsumer({ consumerId: 'trade-host' });
const consumed = [];
async function pollEvents() {
  const res = await engine.getEvents(WORLD, 30);
  if (!res.ok) return;
  const fresh = consumer.feed(res.events);
  for (const e of fresh) {
    consumed.unshift({ id: e.id, type: e.type, actor: e.actor ?? null, grade: e.grade });
    if (consumed.length > 100) consumed.pop();
  }
}

/* ---------- 6) 演化反应呈现（叙事，非世界事实） ---------- */
async function waitForReaction(fromMs, timeoutMs = 6000) {
  if (!TOKEN) return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${ADMIN}/v1/evolution/worlds/${WORLD}/runs?n=3`, { headers: { 'x-admin-token': TOKEN } });
      if (res.status === 200) {
        const body = await res.json().catch(() => null);
        const run = (body?.runs ?? []).find((r) => r.finishedAt && Date.parse(r.finishedAt) >= fromMs);
        if (run) {
          return { narrative: true, status: run.status, reaction: run.proposal?.reason ?? '', applied: run.acceptedCount ?? 0, rejected: run.rejectedCount ?? 0, runId: run.id };
        }
      }
    } catch {
      /* 管理面不可达：无反应可呈现 */
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/* ---------- 7) 宿主 HTTP 面 ---------- */
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/healthz' && req.method === 'GET') return send(200, { ok: true, service: 'trade-host', world: WORLD });
  if (url.pathname === '/trade/view' && req.method === 'GET') return tradeView().then((v) => send(200, v));
  if (url.pathname === '/trade/events' && req.method === 'GET') return send(200, { consumed });
  if (url.pathname === '/trade/input' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(raw || '{}');
        if (typeof text !== 'string' || !text.trim()) return send(400, { error: 'body 必须是 {"text": "..."}' });
        console.log(`\n[行商] 「${text}」`);
        const startedAt = Date.now() - 1500;
        const intent = await parseIntent(text);
        let commandResult;
        if (intent.kind === 'ic_action' && intent.command) {
          const type = intent.command.type;
          if (type === '__buy_spice') commandResult = await buyGood('spice');
          else if (type === '__sell_spice') commandResult = await sellGood('spice');
          else if (type === '__buy_silk') commandResult = await buyGood('silk');
          else if (type === '__sell_silk') commandResult = await sellGood('silk');
          else commandResult = await cmd(type, intent.command);
          console.log(`  [商路→引擎] ${type} → ${commandResult.ok ? `事实 ${(commandResult.events ?? []).join(', ') || '状态更新'}` : `拒绝：${commandResult.reason}`}`);
        } else {
          console.log(`  [商路] ${intent.kind === 'ooc' ? '场外话，只留档不进世界' : '叙事文本，只留档不进世界'}`);
        }
        await pollEvents();
        send(200, {
          intent: { kind: intent.kind, ...(intent.hint ? { hint: intent.hint } : {}), ...(intent.info ? { info: intent.info } : {}) },
          commandResult,
          ...(intent.kind === 'ic_action' ? { reaction: await waitForReaction(startedAt) } : {}),
          view: await tradeView(),
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
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[trade] Trade Road Host listening at http://127.0.0.1:${PORT}`);
  console.log(`[trade]   引擎: ${ENGINE}  世界: ${WORLD}（Game B · 零 Core 改动接入）`);
  console.log(`[trade]   试试: curl -X POST http://127.0.0.1:${PORT}/trade/input -H "content-type: application/json" -d '{"text":"去杭州"}'`);
});
setInterval(() => void pollEvents(), 3000);
void pollEvents();

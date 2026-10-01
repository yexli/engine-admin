/* ============================================================
   Tianqiong Minimal Host（方案 V2 §三：天穹最小真实接入）
   ------------------------------------------------------------
   这是「游戏方」角色的参考宿主：把天穹的最小世界（村庄/酒馆，
   玩家/米露/酒馆老板/金钱/物品/时间/关系）真实接入 World Engine——
   全程 HTTP，与引擎不同进程，零特权，不用 Mock 冒充。

   四条真实链路：
   1. 玩家输入 → Tianqiong Intent（确定性解析）→ World Command
      → Rules → Mutation → 玩家进入酒馆 → Event
   2. 天穹消费 Event（幂等：断线重放不重复消费）→ 游戏视图更新
   3. High 事件（玩家进入 NPC 所在地/主动交互）→ 自动触发演化
      （平台侧行冷却 + 幂等键；AI 判断 NPC 是否行动——可以不行动）
   4. Evolution → Rules → Mutation → Event → 天穹消费 → 玩家看到
      符合因果链的世界变化

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
import { createEngineClient, createEventConsumer } from '../platform/dist/index.js';

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
  /* HTTP 建世界走引擎白名单（worldId/playerName/startLoc/weather/name/ownerGame）；
     地点显示表属部署侧种子（参考 run-demo-engine 的进程内建模），宿主视图层自带地名。 */
  const created = await engine.proxy('POST', '/v1/worlds', {
    worldId: WORLD,
    playerName: '旅人',
    startLoc: 'village',
    weather: 'clear',
    name: '天穹 · 最小村庄',
    ownerGame: 'tianqiong',
  });
  if (created.status !== 201) throw new Error(`建世界失败 HTTP ${created.status}: ${JSON.stringify(created.body)}`);

  /* 引擎 HTTP 命令的 payload 只收一维基本类型（净化纪律）——
     NPC 字段用 create_entity（id/name/location）+ 逐字段 update_attribute 播种 */
  for (const c of [
    { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } },
    { type: 'update_attribute', targetId: 'milu', payload: { key: 'mood', value: '平静' } },
    { type: 'update_attribute', targetId: 'milu', payload: { key: 'money', value: 20 } },
    { type: 'create_entity', payload: { id: 'keeper', type: 'npc', name: '酒馆老板老周', location: 'tavern' } },
    { type: 'update_attribute', targetId: 'keeper', payload: { key: 'mood', value: '平静' } },
    { type: 'update_attribute', targetId: 'keeper', payload: { key: 'money', value: 200 } },
    { type: 'update_attribute', targetId: 'keeper', payload: { key: 'ale_stock', value: 10 } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'money', value: 50 } },
    { type: 'update_attribute', targetId: 'player', payload: { key: 'item_ale', value: 0 } },
    { type: 'set_relation', actorId: 'milu', targetId: 'keeper', payload: { type: 'colleague', value: 30 } },
  ]) {
    const r = await cmd(c.type, c);
    if (!r.ok) throw new Error(`种子命令被拒绝：${JSON.stringify(r)}`);
  }
  console.log(`[tianqiong] 最小世界就绪：${WORLD}（村庄/酒馆/商店 + 米露/老周；玩家 50 钱）`);
}

/* ---------- 2) 玩家视图（玩家看到的世界 = 引擎权威事实的投影） ---------- */
/** 地点显示名归宿主（引擎只认地点 id；显示层是游戏的事） */
const PLACE_NAMES = { village: '村庄', tavern: '米露的酒馆', shop: '杂货商店' };

async function gameView() {
  const s = await engine.getState(WORLD);
  if (!s.ok) return { error: s.error };
  const st = s.state;
  const loc = st.player?.loc;
  const here = Object.entries(st.npcs ?? {})
    .filter(([, n]) => n.attributes?.location === loc)
    .map(([id, n]) => ({ id, name: n.attributes?.name ?? id, mood: n.attributes?.mood ?? null, att: n.att, met: n.met === true }));
  return {
    worldDay: Math.floor((st.t ?? 0) / 48) + 1,
    tick: st.t ?? 0,
    player: {
      loc,
      locName: PLACE_NAMES[loc ?? ''] ?? loc,
      money: st.player?.attributes?.money ?? 0,
      items: { ale: st.player?.attributes?.item_ale ?? 0 },
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
  if (/(和|跟|与).*(老板|老周)|找老板/.test(text)) {
    if (!at('tavern')) return { kind: 'ic_action', command: { type: 'move', targetId: 'tavern' }, hint: '老板在酒馆' };
    return { kind: 'ic_action', command: { type: 'talk', targetId: 'keeper', text } };
  }
  if (/买(一(杯|瓶))?酒|来(一(杯|瓶))?酒/.test(text)) {
    if (!at('tavern')) return { kind: 'ic_action', command: { type: 'move', targetId: 'tavern' }, hint: '买酒要去酒馆' };
    return { kind: 'ic_action', command: { type: '__purchase_ale' } }; // 宿主确定性经济逻辑（见下）
  }
  const days = text.match(/(\d+)\s*天/);
  if (/等待|过夜|休息|度过/.test(text) || days) {
    const n = days ? Number(days[1]) : 1;
    return { kind: 'ic_action', command: { type: 'advance_time', amount: Math.max(1, n) * 48 } };
  }
  /* 场外话 / 叙事：只留档，绝不进引擎（方案 §七 OOC 隔离在真实宿主生效） */
  if (/帮助|设置|难度|界面|音量/.test(text)) return { kind: 'ooc' };
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

/* ---------- 4) 事件消费（幂等）+ High 事件自动触发演化 ---------- */
const consumer = createEventConsumer({
  consumerId: 'tianqiong-host',
  onEvent: (e) => {
    console.log(`  【天穹收到事实】[${e.id}] ${e.type}${e.actor ? ` actor=${e.actor}` : ''}`);
  },
});
const consumed = []; // 玩家可见的已消费事实（新 → 旧）
/** 演化结果事件集：防「演化产物再触发演化」的死循环（方案 §十二 无限循环） */
const evolutionBorn = new Set();

async function pollEvents() {
  const res = await engine.getEvents(WORLD, 30);
  if (!res.ok) return;
  const fresh = consumer.feed(res.events);
  for (const e of fresh) {
    consumed.unshift({ id: e.id, type: e.type, actor: e.actor ?? null, grade: e.grade });
    if (consumed.length > 100) consumed.pop();
  }
  /* High 事件自动触发：只有玩家发起的行为才值得唤醒演化（方案 §五）。
     演化自己产生的事件（actor=NPC）绝不反向触发——结构性断环。 */
  const playerHigh = fresh.filter((e) => e.grade === 'high' && (e.actor === 'player' || e.type === 'player_moved'));
  for (const e of playerHigh) {
    if (evolutionBorn.has(e.id)) continue;
    await triggerEvolution(e);
  }
}

async function triggerEvolution(highEvent) {
  if (!TOKEN) {
    console.log('  [演化跳过] 未配置 PLATFORM_ADMIN_TOKEN（天穹以纯确定性模式运行）');
    return;
  }
  try {
    const res = await fetch(`${ADMIN}/v1/evolution/worlds/${WORLD}/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify({ trigger: 'auto', idempotencyKey: `auto:${WORLD}:${highEvent.id}` }),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 200) {
      for (const id of body?.eventIds ?? []) evolutionBorn.add(id);
      if (body?.deduplicated) console.log(`  [演化] 幂等命中（${highEvent.id} 已触发过），世界未重复变化`);
      else if (body?.status === 'completed') console.log(`  [演化] 完成：${body.proposal?.reason ?? ''}（${body.acceptedCount ?? 0} 条落地 / ${body.rejectedCount ?? 0} 条被拒）`);
      else if (body?.status === 'partially_applied' || body?.status === 'rejected') console.log(`  [演化] ${body.status}：${body.proposal?.reason ?? ''}`);
      else console.log(`  [演化] ${body?.status ?? res.status}：${body?.error ?? ''}`);
    } else {
      console.log(`  [演化未触发] HTTP ${res.status}：${body?.error?.message ?? ''}`);
    }
  } catch (e) {
    console.log(`  [演化未触发] ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ---------- 5) 宿主 HTTP 面 ---------- */
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/healthz' && req.method === 'GET') return send(200, { ok: true, service: 'tianqiong-host', world: WORLD });
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
        const intent = await parseIntent(text);
        let commandResult;
        if (intent.kind === 'ic_action' && intent.command) {
          if (intent.command.type === '__purchase_ale') {
            commandResult = await purchaseAle();
          } else {
            commandResult = await cmd(intent.command.type, intent.command);
          }
          console.log(`  [天穹→引擎] ${intent.command.type} → ${commandResult.ok ? `事实 ${commandResult.events.join(', ')}` : `拒绝：${commandResult.reason}`}`);
          if (intent.command.type === 'move' && commandResult.ok) await pollEvents();
        } else {
          console.log(`  [天穹] ${intent.kind === 'ooc' ? '场外话，只留档不进世界' : '叙事文本，只留档不进世界'}`);
        }
        await pollEvents();
        send(200, { intent: { kind: intent.kind, ...(intent.hint ? { hint: intent.hint } : {}) }, commandResult, view: await gameView() });
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
  console.log(`[tianqiong] Tianqiong Host listening at http://127.0.0.1:${PORT}`);
  console.log(`[tianqiong]   引擎: ${ENGINE}  世界: ${WORLD}`);
  console.log(`[tianqiong]   试试: curl -X POST http://127.0.0.1:${PORT}/tianqiong/input -H "content-type: application/json" -d '{"text":"我想去酒馆找米露。"}'`);
});
setInterval(() => void pollEvents(), 3000); // 事件轮询（3s；真实游戏可切 G3 WebSocket 流）
void pollEvents();

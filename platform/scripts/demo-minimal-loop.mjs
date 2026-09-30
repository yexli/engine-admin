/* ============================================================
   最小商业闭环演示（方案 §38）
   ------------------------------------------------------------
   自包含演示：临时启动 引擎 + 脚本化网关 + 平台，然后模拟一个
   「本地游戏客户端」只拿 Base URL + API Key + world-agent 完成一轮
   对话。证明这条链路成立：
     用户 → API Key → OpenAI 格式请求 → 鉴权 → 任务分析 → 能力路由
          → 世界上下文 → 网关模型调用 → 结果整合 → 游戏继续运行
   （生产中网关背后是真实 Provider；脚本网关仅替代「上游模型」）
   用法：cd platform && pnpm build && node scripts/demo-minimal-loop.mjs
   ============================================================ */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import { startGatewayServer } from '../../world-engine/gateway/dist/index.js';
import {
  KeyStore,
  ModelRouter,
  createEngineClient,
  createGatewayClient,
  startPlatformServer,
} from '../dist/index.js';

/* ---------- 1. 云端 World Runtime：引擎 + 预置世界 ---------- */
const registry = createWorldRegistry();
const world = registry.create({
  worldId: 'w-demo',
  playerName: '云生',
  startLoc: 'tavern',
  weather: 'sunny',
  savePort: new InMemoryWorldStorage(),
  definition: {
    locations: [
      { id: 'tavern', type: 'building', attributes: { desc: '旧铁匠铺酒馆' } },
      { id: 'forest', type: 'wilderness' },
    ],
  },
});
world.executeCommand({ type: 'spawn_entity', payload: { id: 'lita', name: '莉安', kind: 'npc', loc: 'tavern' } });
world.executeCommand({ type: 'talk', actorId: 'player', targetId: 'lita', text: '晚上有什么好吃的？' });
world.executeCommand({ type: 'set_attitude', targetId: 'lita', amount: 5 });
const engineServer = await startWorldServer({ registry, port: 0 });
console.log(`[1] World Engine 就绪  ${engineServer.url} （世界 w-demo）`);

/* ---------- 2. AI Gateway（脚本化上游替代真实 Provider） ---------- */
const gatewayServer = await startGatewayServer({
  port: 0,
  providers: [
    {
      owner: 'demo-provider',
      models: ['npc', 'narrative', 'reasoning', 'memory'],
      complete: async (model, messages) => {
        const userMsg = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        return `（${model} 通道回应）我知道你在酒馆，莉安对你态度不错。你说：「${userMsg}」`;
      },
    },
  ],
});
console.log(`[2] AI Gateway 就绪    ${gatewayServer.url}（通道：npc / narrative / reasoning / memory）`);

/* ---------- 3. 平台层：API Key + 路由 + 公共入口 ---------- */
const dataDir = mkdtempSync(join(tmpdir(), 'platform-demo-'));
const keys = new KeyStore(join(dataDir, 'keys.json'));
const { plaintext } = keys.create({ name: 'demo-client' });
keys.flush();
ModelRouter.seedDefault(join(dataDir, 'router.json'));
const platformServer = await startPlatformServer({
  keys,
  engine: createEngineClient({ baseUrl: engineServer.url }),
  gateway: createGatewayClient({ baseUrl: gatewayServer.url }),
  router: new ModelRouter(join(dataDir, 'router.json')),
  port: 0,
});
console.log(`[3] World Platform 就绪 ${platformServer.url}`);
console.log(`    API Key（模拟 keyctl 签发）: ${plaintext.slice(0, 16)}…`);

/* ---------- 4. 「本地游戏」：只配 Base URL + Key + world-agent ---------- */
console.log('\n[4] 本地游戏客户端请求（OpenAI Compatible）：');
console.log(`    POST ${platformServer.url}/v1/chat/completions`);
console.log(`    model=world-agent  world=w-demo  stream=false\n`);

const res = await fetch(`${platformServer.url}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${plaintext}` },
  body: JSON.stringify({
    model: 'world-agent',
    world: 'w-demo',
    messages: [{ role: 'user', content: '莉安还在酒馆吗？她想聊什么？' }],
  }),
});
const body = await res.json();

console.log(`    HTTP ${res.status}`);
console.log(`    model         : ${body.model}`);
console.log(`    content       : ${body.choices?.[0]?.message?.content}`);
console.log(`    capability    : ${body.platform?.capability}（${body.platform?.task_reason}）`);
console.log(`    model_used    : ${body.platform?.model_used}（fallback=${body.platform?.fallback_used}）`);
console.log(`    world_id      : ${body.platform?.world_id}`);
console.log(`    usage         : ${JSON.stringify(body.usage)}`);

/* ---------- 5. 世界继续运行：同一 Key 直接驱动引擎 ---------- */
const cmd = await fetch(`${platformServer.url}/v1/worlds/w-demo/commands`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${plaintext}` },
  body: JSON.stringify({ type: 'talk', actorId: 'player', targetId: 'lita', text: '来一份炖肉' }),
});
const cmdBody = await cmd.json();
console.log(`\n[5] 游戏继续运行：POST /v1/worlds/w-demo/commands → ok=${cmdBody.ok} events=${JSON.stringify(cmdBody.events)}`);

/* ---------- 6. 鉴权反向验证 ---------- */
const anon = await fetch(`${platformServer.url}/v1/worlds`);
console.log(`[6] 无 Key 访问 → HTTP ${anon.status}（鉴权生效）`);

await platformServer.close();
await gatewayServer.close();
await engineServer.close();
rmSync(dataDir, { recursive: true, force: true });
console.log('\n[done] 最小商业闭环验证完成（方案 §38）。');

/* ============================================================
   天穹世界宿主（World Engine 外部服务 · 生产形态）
   ------------------------------------------------------------
   与 scripts/http-host.mjs（G1 参考实现 PoC）的区别：
     · 持久化：FileSavePort 落盘（重启接续，引擎 tmp+rename 原子写）；
     · 鉴权：可选 API Key（TIANQIONG_WORLD_KEY）；
     · 种子：scripts/lib/tianqiong-seed.mjs（parity 测试钉死；游戏侧
       src/ 已无 adapter 目录，映射只以本脚本为准）；
     · 面向 Phase 1 的 WorldEngineClient（tianqiong-main / 8798）。

   用法（在 tianqiong/ 目录，需 ../world-engine/dist 已构建）：
     node scripts/world-host.mjs
   环境变量：
     TIANQIONG_PORT        缺省 8798
     TIANQIONG_WORLD_KEY   设置后开启 API Key 鉴权（客户端 x-api-key 同值）
     TIANQIONG_WORLD_DATA  存档目录，缺省 .world-data/
   ============================================================ */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { buildTianqiongWorldSeed } from './lib/tianqiong-seed.mjs';

const require = createRequire(import.meta.url);
const { createWorldRegistry, hostGameWorld, FileSavePort } = require('world-engine');
const { startWorldServer } = require('world-engine/http');

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '..', process.env.TIANQIONG_WORLD_DATA ?? '.world-data');
mkdirSync(dataDir, { recursive: true });

const adapter = {
  gameId: 'tianqiong',
  name: '天穹纪元 2.0',
  seed: buildTianqiongWorldSeed,
};

const registry = createWorldRegistry();
const savePort = new FileSavePort(resolve(dataDir, 'tianqiong-main.json'));
const { worldId } = hostGameWorld(registry, adapter, { savePort });

const apiKey = (process.env.TIANQIONG_WORLD_KEY ?? '').trim();
const port = Number(process.env.TIANQIONG_PORT ?? 8798);
const server = await startWorldServer({
  registry,
  port,
  ...(apiKey ? { auth: { keys: { [apiKey]: { gameId: 'tianqiong', name: 'tianqiong-client' } } } } : {}),
});

const seed = buildTianqiongWorldSeed();
console.log(`[world-host] 世界 ${worldId} 已托管：${server.url}/v1/worlds/${worldId}`);
console.log(
  `[world-host] 地点 ${seed.locations.length} / NPC ${seed.npcs.length} / 关系 ${seed.relations.length}；存档 → ${resolve(dataDir, 'tianqiong-main.json')}`,
);
console.log(`[world-host] WS 事件流：${server.url.replace('http', 'ws')}/v1/worlds/${worldId}/events/stream`);
console.log(`[world-host] 鉴权：${apiKey ? '已开启（TIANQIONG_WORLD_KEY）' : '未开启（仅本机使用形态）'}`);

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});

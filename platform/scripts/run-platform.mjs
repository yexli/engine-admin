/* ============================================================
   World Platform 启动脚本（Phase 1）
   ------------------------------------------------------------
   组合真实依赖：World Engine（8787）+ AI Gateway（8788）。
   用法：
     cd platform && pnpm build
     node scripts/run-platform.mjs
   环境变量见 src/config.ts（PLATFORM_PORT / ENGINE_BASE_URL /
   GATEWAY_BASE_URL / PLATFORM_BOOTSTRAP_KEY / ...）。
   ============================================================ */
import { resolvePlatformConfig } from '../dist/config.js';
import { KeyStore } from '../dist/keys/keystore.js';
import { ModelRouter } from '../dist/router/modelrouter.js';
import { createEngineClient } from '../dist/upstream/engine.js';
import { createGatewayClient } from '../dist/upstream/gateway.js';
import { startPlatformServer } from '../dist/http/server.js';

const config = resolvePlatformConfig(process.env, process.cwd());

const keys = new KeyStore(config.keysFile, config.bootstrapKey ?? undefined);
ModelRouter.seedDefault(config.routerFile);
const router = new ModelRouter(config.routerFile);

const engine = createEngineClient({ baseUrl: config.engineBaseUrl });
const gateway = createGatewayClient({ baseUrl: config.gatewayBaseUrl });

const server = await startPlatformServer({
  keys,
  engine,
  gateway,
  router,
  port: config.port,
  host: config.host,
  accessLog: config.accessLog,
  corsAllowOrigin: config.corsAllowOrigin,
});

console.log(`[platform] World Platform listening at ${server.url}`);
console.log(`[platform]   engine : ${config.engineBaseUrl}`);
console.log(`[platform]   gateway: ${config.gatewayBaseUrl}`);
console.log(`[platform]   keys   : ${config.keysFile}${config.bootstrapKey ? ' + bootstrap 主密钥已启用' : ''}`);
console.log(`[platform]   router : ${config.routerFile}`);
console.log(`[platform] 签发密钥：node scripts/keyctl.mjs create --name <名称>`);

let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  keys.flush();
  await server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

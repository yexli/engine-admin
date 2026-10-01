/* ============================================================
   受管模式启动脚本（Model Control Plane）
   ------------------------------------------------------------
   一个进程组合 受管 Gateway + 受管 Platform（+ 私有管理监听）。
   与旧独立入口 scripts/run-platform.mjs 并存——后者保持原样，
   不是受管配置的第二写入口。

   必需环境变量（缺失即拒绝启动）：
     PLATFORM_ADMIN_TOKEN        私有管理监听令牌（由服务端反代注入，
                                 绝不出现在浏览器 JS / VITE_* / 日志）
     PLATFORM_SECRET_MASTER_KEY  上游凭证加密主密钥

   可选环境变量见 src/config.ts；本地推理服务器（ollama 等）需显式：
     PLATFORM_UPSTREAM_ALLOW_LOOPBACK=1
   用法：
     cd platform && pnpm build   （先在 world-engine/gateway 构建）
     node scripts/run-managed.mjs
   ============================================================ */
import { resolvePlatformConfig } from '../dist/config.js';
import { KeyStore } from '../dist/keys/keystore.js';
import { createEngineClient } from '../dist/upstream/engine.js';
import { createGatewayClient } from '../dist/upstream/gateway.js';
import { SecretStore } from '../dist/admin/secrets.js';
import { ModelConfigStore } from '../dist/admin/model-config.js';
import { startManagedRuntime } from '../dist/admin/managed-runtime.js';
import { startAdminServer } from '../dist/admin/http.js';
import { PipelineStore } from '../dist/admin/pipelines.js';
import { createUsageRecorder } from '../dist/usage/recorder.js';
import { SessionStore } from '../dist/admin/sessions.js';
import { UserStore } from '../dist/admin/users.js';
import { SettingsStore } from '../dist/admin/settings.js';
import { createEvolutionJournal, createEvolutionRuntime, gatewayDriver } from '../dist/evolution/index.js';

const config = resolvePlatformConfig(process.env, process.cwd());

if (!config.secretMasterKey || config.secretMasterKey.trim() === '') {
  console.error('[managed] 拒绝启动：缺少 PLATFORM_SECRET_MASTER_KEY（上游凭证加密主密钥）');
  process.exit(1);
}
if (!config.adminToken) {
  console.error('[managed] 拒绝启动：缺少 PLATFORM_ADMIN_TOKEN（私有管理监听令牌）');
  process.exit(1);
}
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
const containerEscape =
  config.adminAllowNonLoopback &&
  !loopbackHosts.has(config.adminHost) &&
  config.adminHost !== '';
if (!loopbackHosts.has(config.adminHost) && !containerEscape) {
  console.error(`[managed] 拒绝启动：管理监听地址必须是回环地址（当前 PLATFORM_ADMIN_HOST=${config.adminHost}）；容器/内网隔离部署请显式设置 PLATFORM_ADMIN_ALLOW_NON_LOOPBACK=1 并由部署层承担网络隔离`);
  process.exit(1);
}
if (containerEscape) {
  console.error('[managed] ⚠ 管理监听绑定非回环地址（PLATFORM_ADMIN_ALLOW_NON_LOOPBACK=1）：请确保网络隔离由部署层承担（compose 内网 / 防火墙），管理令牌不可泄露');
}

const secrets = new SecretStore(config.secretsFile, config.secretMasterKey);
const configStore = new ModelConfigStore({
  filePath: config.modelConfigFile,
  secrets,
  endpointPolicy: {
    allowedHosts: config.upstreamAllowedHosts,
    allowLoopback: config.upstreamAllowLoopback,
  },
});
configStore.load();

const keys = new KeyStore(config.keysFile, config.bootstrapKey ?? undefined);
const engine = createEngineClient({ baseUrl: config.engineBaseUrl });
const usage = createUsageRecorder({ filePath: config.usageFile });
const pipelines = new PipelineStore(config.pipelinesFile);
const sessions = new SessionStore(config.sessionsFile);
const users = new UserStore(config.usersFile);
const settings = new SettingsStore(config.settingsFile);

const runtime = await startManagedRuntime({
  configStore,
  secrets,
  keys,
  engine,
  adminToken: config.adminToken,
  endpointPolicy: {
    allowedHosts: config.upstreamAllowedHosts,
    allowLoopback: config.upstreamAllowLoopback,
  },
  gatewayPort: config.managedGatewayPort || undefined,
  platformPort: config.port,
  host: config.host,
  upstreamTimeoutMs: config.upstreamTimeoutMs,
  accessLog: config.accessLog,
  usage,
});

console.log('[managed] World Platform（受管模式）已启动');
console.log(`[managed]   public  : ${runtime.platformUrl}  （公开 API，仅 world-agent）`);
console.log(`[managed]   gateway : ${runtime.gatewayUrl}    （内部回环，物理模型 ID）`);
console.log(`[managed]   config  : ${config.modelConfigFile}（revision ${runtime.config.revision}）`);
console.log(`[managed]   secrets : ${config.secretsFile}`);
console.log('[managed]   签发公共 API Key：node scripts/keyctl.mjs create --name <名称>');

/* ---------- AI World Evolution Runtime（Phase B/C） ----------
   驱动 = 受管网关（世界推演默认走 reasoning 通道；未配模型时 tick
   诚实地 failed[driver/model_unavailable]，不影响世界）。
   账本 = platform/data/evolution/{worldId}.jsonl（Phase C 因果链数据面）。 */
const evolutionJournal = createEvolutionJournal({ dir: config.evolutionDir });
const evolutionLoaded = evolutionJournal.load();
if (evolutionLoaded.skippedCorrupt > 0) {
  console.warn(`[managed] ⚠ 演化账本装载：${evolutionLoaded.loaded} 条成功，${evolutionLoaded.skippedCorrupt} 行损坏被跳过（platform/data/evolution）`);
}
const evolution = createEvolutionRuntime(
  {
    engine,
    driver: gatewayDriver({
      gateway: createGatewayClient({ baseUrl: runtime.gatewayUrl }),
      router: runtime.router,
      capability: config.evolutionCapability,
    }),
  },
  evolutionJournal,
);
console.log(`[managed]   evolution: ${config.evolutionDir}（账本；提案能力 '${config.evolutionCapability}'）`);

const admin = await startAdminServer({
  runtime,
  adminToken: config.adminToken,
  port: config.adminPort,
  host: config.adminHost,
  keys,
  usage,
  pipelines,
  sessions,
  users,
  settings,
  evolution,
  memoryBaseUrl: config.memoryBaseUrl,
});
console.log(`[managed]   admin   : ${admin.url}  （仅回环；Admin Web 必须经服务端反代注入 x-admin-token 访问，令牌绝不下发浏览器）`);
console.log(`[managed]   usage   : ${config.usageFile}（结构化用量记录，与访问日志凭 requestId 对账）`);
console.log(`[managed]   pipes   : ${config.pipelinesFile}（管线只读描述，编辑器不做）`);
console.log(`[managed]   users   : ${config.usersFile}（本地三档用户；首次启动播种 admin/admin123 等默认口令，务必修改）`);
console.log(`[managed]   session : ${config.sessionsFile}（管理会话，12h / 刷新轮换 7d）`);
if (runtime.config.revision === 0) {
  console.log('[managed]   当前为空配置：world-agent 会诚实地返回 503 no_model_configured，');
  console.log('[managed]   请在 Admin Web 完成供应商/模型/路由配置（无需重启）。');
}

let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  keys.flush();
  await usage.flush();
  await admin.close();
  await runtime.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

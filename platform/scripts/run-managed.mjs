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
import { NPC_EVOLUTION_POLICY, createEvolutionJournal, createEvolutionRuntime, createTriggerRuntime, gatewayDriver } from '../dist/evolution/index.js';
import { createScheduleRuntime, createScheduleStore } from '../dist/index.js';
import { createMemoryRuntime, createWorldMemoryService } from '../dist/index.js';
import { createEmbeddingsClient, createRoutedEmbeddingService, routedEmbeddingHook } from '../dist/upstream/embeddings.js';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

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
   围栏 = NPC_EVOLUTION_POLICY（方案 V2.1 §五/§八 第一阶段）：动作白名单
   （update_attribute / set_relation / move_entity）、禁止触碰玩家、
   单次 3 变化 / 3 实体上限、auto/api 触发 30s 冷却（admin 手动不受限）。
   缺省策略 FULL_CORE_POLICY 冷却为 0 且不设防，绝不能直接上生产装配。
   账本 = platform/data/evolution/{worldId}.jsonl（Phase C 因果链数据面）。 */
const evolutionJournal = createEvolutionJournal({ dir: config.evolutionDir });
const evolutionLoaded = evolutionJournal.load();
if (evolutionLoaded.skippedCorrupt > 0) {
  console.warn(`[managed] ⚠ 演化账本装载：${evolutionLoaded.loaded} 条成功，${evolutionLoaded.skippedCorrupt} 行损坏被跳过（platform/data/evolution）`);
}

/* ---------- World Memory Service（P7 · 方案 §十）----------
   记忆世界显式声明（PLATFORM_MEMORY_WORLDS，逗号分隔；空 = 记忆关闭）。
   写侧：Memory Runtime 轮询事实 → 感知边界派生 → 摄取（幂等、持久化）。
   读侧：个体决策时为焦点实体召回，注入 context.memory（maxMemoryItems 预算内）。
   纪律：Memory ≠ 第二世界状态——摄取零命令、只读世界；记忆内容只能经
   AI 提案 → Rules 影响世界。
   Embedding 统一治理（2026-10）：向量能力只经模型路由——
   Router.select('embedding') → 受管网关 /v1/embeddings，primary 失败自动
   接管 fallback（markFailed/markHealthy 冷却）。Memory 不持有任何
   Provider/Endpoint/Key 配置。 */
const memoryWorlds = (process.env.PLATFORM_MEMORY_WORLDS ?? '')
  .split(',')
  .map((w) => w.trim())
  .filter(Boolean);
const memoryService = createWorldMemoryService({
  dir: memoryWorlds.length ? join(process.env.PLATFORM_DATA_DIR ?? 'data', 'memory') : undefined,
});
const memoryLoaded = memoryService.loadAll();
if (memoryLoaded.skippedCorrupt > 0) {
  console.warn(`[managed] ⚠ 记忆存储装载：${memoryLoaded.worlds} 个世界成功，${memoryLoaded.skippedCorrupt} 个损坏被跳过`);
}
/* 语义召回钩子（P8 + Embedding 统一治理）：EmbeddingService = Router → 受管
   网关 /v1/embeddings。primary 失败 → markFailed 冷却 → fallback 自动接管；
   成功 → markHealthy。无路由/调用失败 → null = 回纯词面（渐进增强，非硬依赖）。
   Memory 侧零 Provider/Endpoint/Key——模型选择唯一来自模型路由。 */
if (memoryWorlds.length) {
  const routedEmbeddings = createRoutedEmbeddingService({
    router: runtime.router,
    embeddings: createEmbeddingsClient({ baseUrl: runtime.gatewayUrl }),
  });
  const embedHook = { embed: routedEmbeddingHook(routedEmbeddings) };
  for (const worldId of memoryWorlds) memoryService.setEmbed(worldId, embedHook);
}

/* P14 Extension 层：按世界差异化围栏（PLATFORM_POLICIES_FILE，data/policies.json：
   { "worldId": { "allowedActions": [...], "forbiddenAttributeKeys": [...], ... } }，
   键合并到 NPC_EVOLUTION_POLICY 之上；改文件重启平台生效）。 */
const policiesFile = process.env.PLATFORM_POLICIES_FILE ?? join(process.env.PLATFORM_DATA_DIR ?? 'data', 'policies.json');
const worldPolicies = new Map();
try {
  if (existsSync(policiesFile)) {
    const raw = JSON.parse(readFileSync(policiesFile, 'utf8'));
    for (const [worldId, patch] of Object.entries(raw)) {
      worldPolicies.set(worldId, { ...NPC_EVOLUTION_POLICY, ...patch });
    }
    console.log(`[managed]   policies : ${policiesFile}（${worldPolicies.size} 个世界的差异化围栏，P14 Extension 层）`);
  }
} catch (e) {
  console.warn(`[managed] ⚠ 围栏策略文件装载失败（按无差异化运行）：${e instanceof Error ? e.message : String(e)}`);
}

const evolution = createEvolutionRuntime(
  {
    engine,
    policy: NPC_EVOLUTION_POLICY,
    ...(worldPolicies.size ? { policyFor: (worldId) => worldPolicies.get(worldId) } : {}),
    contextBudget: { maxTokens: 6000, maxEntities: 12, maxRelations: 16, maxMemoryItems: 8 }, // P4 缺省预算（方案 §七）
    driver: gatewayDriver({
      gateway: createGatewayClient({ baseUrl: runtime.gatewayUrl }),
      router: runtime.router,
      capability: config.evolutionCapability,
    }),
    ...(memoryWorlds.length
      ? {
          memoryRetriever: (worldId, entityId, query) =>
            memoryService.recallFor(worldId, entityId, query).catch(() => []),
        }
      : {}),
  },
  evolutionJournal,
);
console.log(`[managed]   evolution: ${config.evolutionDir}（账本；提案能力 '${config.evolutionCapability}'；围栏 NPC_EVOLUTION_POLICY：禁触玩家 / 3变化 / 30s 自动冷却）`);

/* ---------- Trigger Runtime（P3 · 方案 §六）----------
   平台内的自动触发循环：轮询事实 → 只认玩家发起 → High 分级 →
   逐实体唤醒评估 → 无人值得唤醒就零 AI 调用。世界显式声明
   （PLATFORM_TRIGGER_WORLDS，逗号分隔）——多世界托管面不为
   未声明的世界默默烧 AI。与游戏方宿主的同键触发（auto:{world}:{eventId}）
   由演化幂等层保证只执行一次。 */
const triggerWorlds = (process.env.PLATFORM_TRIGGER_WORLDS ?? '')
  .split(',')
  .map((w) => w.trim())
  .filter(Boolean);
const triggerIntervalMs = Number(process.env.PLATFORM_TRIGGER_INTERVAL_MS ?? 3000);
const trigger = createTriggerRuntime({
  engine,
  evolution,
  worlds: triggerWorlds,
  ...(Number.isFinite(triggerIntervalMs) ? { intervalMs: triggerIntervalMs } : {}),
  log: (line) => console.log(`  ${line}`),
});
if (triggerWorlds.length) {
  trigger.start();
  console.log(`[managed]   trigger  : 守护 ${triggerWorlds.join(', ')}（${triggerIntervalMs}ms 轮询；High + 有人值得唤醒才调 AI）`);
} else {
  console.log('[managed]   trigger  : 未配置 PLATFORM_TRIGGER_WORLDS —— 平台内自动触发关闭（游戏方可自行触发 tick）');
}

/* ---------- Schedule Runtime（P6 · 方案 §九：确定性行为归 Time + Schedule + Rules）----------
   日程表由游戏方经管理面注册（PUT /v1/npc/worlds/:id/schedules，游戏数据），
   平台负责确定性执行：时间事实（new_day / hour_advanced / time_advanced）→
   applyNpcSchedule 对齐（幂等，已对齐零命令）。**零 AI 调用**——方案 §九
   「禁止每分钟调用一次 AI；Scheduler → 真正需要判断 → Trigger → AI」。 */
const scheduleStore = createScheduleStore({
  filePath: process.env.PLATFORM_SCHEDULES_FILE ?? join(process.env.PLATFORM_DATA_DIR ?? 'data', 'schedules.json'),
});
const scheduleLoaded = scheduleStore.load();
if (scheduleLoaded.skippedCorrupt > 0) {
  console.warn(`[managed] ⚠ 日程存储装载：${scheduleLoaded.loaded} 个世界成功，${scheduleLoaded.skippedCorrupt} 个损坏被跳过`);
}
const scheduleIntervalMs = Number(process.env.PLATFORM_SCHEDULE_INTERVAL_MS ?? 3000);
const scheduler = createScheduleRuntime({
  engine,
  store: scheduleStore,
  ...(Number.isFinite(scheduleIntervalMs) ? { intervalMs: scheduleIntervalMs } : {}),
  log: (line) => console.log(`  ${line}`),
});
scheduler.start();
console.log(`[managed]   schedule : 守护 ${scheduleStore.worlds().join(', ') || '（暂无注册日程的世界）'}（${scheduleIntervalMs}ms 轮询；确定性对齐，零 AI 调用）`);

/* ---------- Memory Runtime（P7 · 方案 §十）---------- */
const memoryIntervalMs = Number(process.env.PLATFORM_MEMORY_INTERVAL_MS ?? 3000);
const memoryRuntime = createMemoryRuntime({
  engine,
  service: memoryService,
  worlds: memoryWorlds,
  ...(Number.isFinite(memoryIntervalMs) ? { intervalMs: memoryIntervalMs } : {}),
  log: (line) => console.log(`  ${line}`),
});
if (memoryWorlds.length) {
  memoryRuntime.start();
  console.log(`[managed]   memory   : 守护 ${memoryWorlds.join(', ')}（${memoryIntervalMs}ms 轮询；确定性摄取，零 AI 调用）`);
} else {
  console.log('[managed]   memory   : 未配置 PLATFORM_MEMORY_WORLDS —— 记忆摄取关闭（个体决策无记忆段）');
}

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
  scheduleStore,
  triggerRuntime: trigger,
  scheduleRuntime: scheduler,
  memoryRuntime,
  memoryService,
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
  trigger.stop();
  scheduler.stop();
  keys.flush();
  await usage.flush();
  await admin.close();
  await runtime.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

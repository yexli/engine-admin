/* ============================================================
   一次性迁移：旧 Memory Embedding Config → 平台模型路由（Step 4）
   ------------------------------------------------------------
   背景（docs/EMBEDDING_CONFIG_AUDIT.md）：Embedding 配置统一治理——
   旧双配置源中的路径 A（platform/data/memory/embedding-config.json，
   apiKey 明文）已从代码中整体删除。本脚本把**历史遗留配置**迁移为
   路径 B 的正规形状：
     Provider（endpoint + SecretStore 加密凭证）+ Model（tags 含
     'embedding'）+ routes.embedding primary/fallback
   然后把旧文件改名为 *.migrated-<ts> 封存（不再是任何运行时的事实源）。

   用法（platform 目录）：
     node scripts/migrate-memory-embedding.mjs
   主密钥取 PLATFORM_SECRET_MASTER_KEY 环境变量；缺省读 data/dev-env.json
   （本地开发栈的既定位置）。

   行为：
     · 配置文件不存在 / 未启用 → 无需迁移，仅封存后退出；
     · 路由 primary 已配置 → 不覆盖（旧模型作为 fallback 接管，除非
       fallback 也已占用，则原样保留并在汇报中说明）；
     · 幂等：重复执行时 provider/model/凭证按 endpoint+wireModel 匹配。
   ============================================================ */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelConfigStore } from '../dist/admin/model-config.js';
import { SecretStore } from '../dist/admin/secrets.js';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = resolve(here, '..');
const repoRoot = resolve(platformDir, '..');
const dataDir = join(platformDir, 'data');
const cfgFile = process.env.MEMORY_EMBEDDING_CONFIG_FILE ?? join(dataDir, 'memory', 'embedding-config.json');

function masterKeyOf() {
  const fromEnv = process.env.PLATFORM_SECRET_MASTER_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const devEnv = join(dataDir, 'dev-env.json');
  if (existsSync(devEnv)) {
    try {
      const parsed = JSON.parse(readFileSync(devEnv, 'utf8'));
      if (typeof parsed.masterKey === 'string' && parsed.masterKey) return parsed.masterKey;
    } catch { /* 落入下方报错 */ }
  }
  console.error('[migrate] 缺少主密钥：设 PLATFORM_SECRET_MASTER_KEY 或提供 data/dev-env.json');
  process.exit(1);
}

if (!existsSync(cfgFile)) {
  console.log(`[migrate] 未发现旧嵌入配置（${cfgFile}）——无需迁移`);
  process.exit(0);
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
} catch (e) {
  console.error(`[migrate] 旧配置损坏，仅封存不迁移：${e.message}`);
  renameSync(cfgFile, `${cfgFile}.migrated-corrupt-${Date.now()}`);
  process.exit(0);
}
const legacy = {
  enabled: cfg?.enabled === true,
  endpoint: typeof cfg?.endpoint === 'string' ? cfg.endpoint : '',
  model: typeof cfg?.model === 'string' ? cfg.model : '',
  apiKey: typeof cfg?.apiKey === 'string' ? cfg.apiKey : '',
};

function seal() {
  const to = `${cfgFile}.migrated-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(cfgFile, to);
  console.log(`[migrate] 旧配置已封存：${to}（不再是任何运行时的事实源）`);
}

if (!legacy.enabled || !legacy.endpoint || !legacy.model) {
  console.log('[migrate] 旧配置未启用（或缺 endpoint/model）——无路由价值，仅封存');
  seal();
  process.exit(0);
}

const secrets = new SecretStore(join(dataDir, 'secrets.json'), masterKeyOf());
const store = new ModelConfigStore({
  filePath: join(dataDir, 'model-config.json'),
  secrets,
  endpointPolicy: { allowLoopback: true },
});
store.load();

/* 解析凭证：旧配置里有明文 apiKey 就入 SecretStore；没有 = 无密钥型 provider */
const hasKey = legacy.apiKey.length > 0;

/* 第一步：匹配或创建 provider/model（禁用态；带密钥 provider 未传凭证时
   commit 会被 assertCredentialsUsable 拦截，因此先禁用提交） */
const cur = store.current();
const doc = JSON.parse(JSON.stringify({ version: 1, providers: cur.providers, models: cur.models, routes: cur.routes }));

let provider = doc.providers.find((p) => p.endpoint === legacy.endpoint);
if (!provider) {
  const host = new URL(legacy.endpoint).hostname.replace(/[^a-z0-9.-]/gi, '') || 'provider';
  const id = `emb-${host.split('.')[0].toLowerCase()}-${Date.now().toString(36).slice(-4)}`;
  provider = { id, name: `embedding@${host}`, endpoint: legacy.endpoint, auth: hasKey ? { kind: 'secret' } : { kind: 'none' }, enabled: false };
  doc.providers.push(provider);
  console.log(`[migrate] 新建 provider：${provider.id}（${provider.name}）`);
} else {
  console.log(`[migrate] 复用既有 provider：${provider.id}`);
}
if (provider.enabled === false && doc.models.some((m) => m.providerId === provider.id && m.enabled)) {
  /* 既有 provider 已被其他启用模型引用：直接启用，避免迁移把别人搞停 */
  provider.enabled = true;
}

const modelId = `mdl-emb-${legacy.model.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 48)}`;
let model = doc.models.find((m) => m.providerId === provider.id && m.wireModel === legacy.model);
if (!model) {
  model = { id: modelId, providerId: provider.id, wireModel: legacy.model, tags: ['embedding'], enabled: false };
  doc.models.push(model);
  console.log(`[migrate] 新建 model：${model.id}（wireModel=${legacy.model}，tags=['embedding']）`);
} else if (JSON.stringify(model.tags) !== JSON.stringify(['embedding'])) {
  /* 嵌入模型标签互斥（治理纪律）：置换为 ['embedding']，并清理其他能力
     路由槽位对它的引用（对话能力路由到嵌入模型必然失败） */
  const before = JSON.stringify(model.tags);
  model.tags = ['embedding'];
  for (const [cap, r] of Object.entries(doc.routes)) {
    if (cap === 'embedding') continue;
    if (r?.primary === model.id) { console.log(`[migrate] 清理 ${cap}.primary（原指向 ${model.id}）`); r.primary = null; }
    if (r?.fallback === model.id) { console.log(`[migrate] 清理 ${cap}.fallback（原指向 ${model.id}）`); r.fallback = null; }
  }
  console.log(`[migrate] 既有 model：${model.id} 标签置换为 ['embedding']（原：${before}）`);
} else {
  console.log(`[migrate] 复用既有 model：${model.id}`);
}

const committed1 = store.commit(doc, cur.revision);
console.log(`[migrate] 配置已提交（revision → ${committed1.revision}，禁用态）`);

/* 第二步：凭证（加密落盘，旧明文即将随封存消失；会推进 revision） */
let effectiveProviderId = provider.id;
if (hasKey) {
  store.setProviderCredential(effectiveProviderId, legacy.apiKey);
  console.log(`[migrate] 凭证已入 SecretStore（AES-256-GCM 加密；旧文件明文随封存消失）`);
}

/* 第三步：启用 + 设 embedding 路由（不覆盖既有 primary；基于最新 revision 提交） */
const latest = store.current();
const doc2 = JSON.parse(JSON.stringify({ version: 1, providers: latest.providers, models: latest.models, routes: latest.routes }));
const p2 = doc2.providers.find((p) => p.id === effectiveProviderId);
p2.enabled = true;
const m2 = doc2.models.find((m) => m.id === model.id);
m2.enabled = true;
const route = doc2.routes.embedding ?? { primary: null, fallback: null };
let routeNote;
if (!route.primary) {
  route.primary = m2.id;
  routeNote = `primary = ${m2.id}`;
} else if (route.primary === m2.id) {
  routeNote = `primary 已是 ${m2.id}（无需变更）`;
} else if (!route.fallback) {
  route.fallback = m2.id;
  routeNote = `primary ${route.primary} 保持不变；旧模型作为 fallback = ${m2.id} 接入`;
} else {
  routeNote = `primary/fallback 均已配置（${route.primary}/${route.fallback}）——旧模型仅入模型清单，不参与路由`;
}
doc2.routes.embedding = route;
const committed2 = store.commit(doc2, latest.revision);
console.log(`[migrate] 路由已更新：${routeNote}（revision → ${committed2.revision}）`);

seal();
console.log('[migrate] 完成：受管平台热读 ModelConfigStore（重启或下次 PUT 配置后全面生效）——');
console.log('         Memory 侧从此只经 EmbeddingService/模型路由获取向量，不读任何本地嵌入配置。');

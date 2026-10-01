/* ============================================================
   旧 router.json → 新模型配置 迁移工具（显式操作，绝不静默覆盖）
   ------------------------------------------------------------
   旧 platform/data/router.json 的路由值是 Gateway 能力通道名
   （npc/narrative/reasoning/memory…），不是物理模型 ID——必须由
   运营者显式给出「通道 → 物理模型 ID」映射与模型清单。

   步骤：
     1) 生成候选文件 model-config.candidate.json（从不写真实目标文件）；
     2) 运营者人工审阅候选（供应商端点/凭证/wireModel 需补全）；
     3) 经 Admin Web 或 PUT /v1/admin/model-config 显式激活。

   用法：
     node scripts/migrate-router.mjs \
       --from data/router.json \
       --model mdl-ds=deepseek-chat --model mdl-ds-r=deepseek-reasoner \
       --map npc=mdl-ds --map narrative=mdl-ds --map reasoning=mdl-ds-r \
            --map memory=mdl-ds --map fast=mdl-ds --map cheap=mdl-ds \
       [--endpoint https://api.deepseek.com/v1] [--provider prov-migrated]
   ============================================================ */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
function argValue(name, collect = false) {
  const out = collect ? [] : null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      if (collect) out.push(args[i + 1]);
      else return args[i + 1];
    }
  }
  return out;
}

const from = argValue('--from') ?? 'data/router.json';
const providerId = argValue('--provider') ?? 'prov-migrated';
const endpoint = argValue('--endpoint') ?? '';
const models = argValue('--model', true) ?? [];
const maps = argValue('--map', true) ?? [];
const allowEmpty = args.includes('--allow-empty');

if (!existsSync(from)) {
  console.error(`[migrate] 找不到旧路由文件：${from}`);
  process.exit(1);
}
let oldRoutes;
try {
  const parsed = JSON.parse(readFileSync(from, 'utf8'));
  oldRoutes = parsed.routes ?? {};
} catch (e) {
  console.error(`[migrate] 旧路由文件损坏，拒绝迁移：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

/* 模型清单：id=wireModel */
const modelDefs = new Map();
for (const m of models) {
  const eq = m.indexOf('=');
  if (eq <= 0) {
    console.error(`[migrate] --model 形如 id=wireModel，收到 '${m}'`);
    process.exit(1);
  }
  modelDefs.set(m.slice(0, eq), m.slice(eq + 1));
}
if (modelDefs.size === 0) {
  console.error('[migrate] 至少提供一个 --model id=wireModel（真实物理模型）');
  process.exit(1);
}

/* 通道 → 模型 ID 映射 */
const channelMap = new Map();
for (const mp of maps) {
  const eq = mp.indexOf('=');
  if (eq <= 0) {
    console.error(`[migrate] --map 形如 通道=模型ID，收到 '${mp}'`);
    process.exit(1);
  }
  channelMap.set(mp.slice(0, eq), mp.slice(eq + 1));
}

const SIX = ['roleplay', 'narrative', 'reasoning', 'fast', 'cheap', 'memory'];
function mapSlot(channel) {
  if (channel === null || channel === undefined) return null;
  if (!channelMap.has(channel)) {
    if (allowEmpty) return null;
    console.error(
      `[migrate] 通道 '${channel}' 缺少映射。旧路由值是网关通道名，不是物理模型——` +
        `请显式提供 --map ${channel}=物理模型ID（或 --allow-empty 置空并接受该能力 503）`,
    );
    process.exit(1);
  }
  const id = channelMap.get(channel);
  if (!modelDefs.has(id)) {
    console.error(`[migrate] --map 引用的模型 '${id}' 未在 --model 清单中定义`);
    process.exit(1);
  }
  return id;
}

const routes = {};
for (const cap of SIX) {
  const r = oldRoutes[cap] ?? {};
  routes[cap] = { primary: mapSlot(r.primary ?? null), fallback: mapSlot(r.fallback ?? null) };
}

const candidate = {
  version: 1,
  providers: [
    {
      id: providerId,
      name: providerId,
      endpoint,
      auth: { kind: endpoint ? 'secret' : 'none' },
      enabled: false /* 候选一律禁用态：审阅 → 补端点与凭证 → 测试 → 手动启用 */,
    },
  ],
  models: [...modelDefs.entries()].map(([id, wireModel]) => ({
    id,
    providerId,
    wireModel,
    tags: ['narrative'],
    enabled: false,
  })),
  routes,
};

const target = resolve(from, '..', 'model-config.candidate.json');
writeFileSync(target, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');

console.log('[migrate] 候选配置已生成（未触碰任何现有配置）：');
console.log(`  ${target}`);
console.log('[migrate] 请人工审阅并补全：供应商端点/凭证、每个模型的 tags；');
console.log('[migrate] 然后在 Admin Web 审查后启用，或 PUT /v1/admin/model-config 显式激活。');
console.log('[migrate] 旧 router.json 保持原样，作为独立旧入口（run-platform.mjs）的配置继续可用。');

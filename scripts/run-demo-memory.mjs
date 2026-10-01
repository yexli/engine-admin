/* ============================================================
   Demo Memory Launcher（演示用宿主集成示例，不属于交付核心）
   ------------------------------------------------------------
   用 world-memory 的 HTTP 适配层启动本机记忆服务（127.0.0.1:8789）：
   · 每个世界一个 store（w-main / w-test …），演示 §42 的 worldId 维度
   · 按 §16 数据流契约喂事实：轮询 World Engine 的 /v1/worlds/{id}/events，
     把新事实 ingestFact 进对应世界 store，并随世界日推进 tickDay
   · 不修改 world-engine / world-memory 任何代码

   M5 后完善（均为宿主职责，零核心改动）：
   · 落盘持久化：FileSavePort 把每个 store 的 MemorySnapshot 写
     platform/data/memory/<worldId>.json（临时文件 + rename 原子替换），
     重启恢复，不再"重启即失忆"；MEMORY_DATA_DIR 可改位置
   · 向量通道（可选）：设置 EMBEDDINGS_ENDPOINT + EMBEDDINGS_MODEL 后，
     EmbedHook 经网关 remoteEmbeddings（OpenAI 兼容 /embeddings）现场
     向量化——语义相似度 ×0.2 并入检索总分，失败静默回词面（渐进增强）；
     缺省不设置 = 纯词面检索（诚实口径，管理台 embedding 页如实显示）

   环境变量：
     WORLD_API_URL       引擎地址（缺省 http://127.0.0.1:8787）
     MEMORY_API_PORT     本服务端口（缺省 8789）
     MEMORY_DATA_DIR     快照目录（缺省 platform/data/memory）
     EMBEDDINGS_ENDPOINT OpenAI 兼容根（如 https://api.openai.com/v1）[可选]
     EMBEDDINGS_MODEL    embedding 模型名（如 text-embedding-3-small）[可选]
     EMBEDDINGS_API_KEY  上游密钥（本地推理可留空）[可选]

   前置：先启动引擎（node scripts/run-demo-engine.mjs），
   且 world-engine、world-engine/gateway、world-engine/memory 已 build。
   用法：node scripts/run-demo-memory.mjs
   ============================================================ */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMemoryServer } from "../world-engine/memory/dist/http/server.js";
import { MemoryEngine } from "../world-engine/memory/dist/index.js";
import { remoteEmbeddings } from "../world-engine/gateway/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_BASE = process.env.WORLD_API_URL ?? "http://127.0.0.1:8787";
const POLL_MS = 5000;
const dataDir = process.env.MEMORY_DATA_DIR ?? join(repoRoot, "platform", "data", "memory");

async function engineGet(path) {
  const res = await fetch(`${ENGINE_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/* 等引擎可达（dev-stack 场景下两者并行启动） */
async function waitForEngine() {
  for (let i = 0; i < 30; i++) {
    try {
      return await engineGet("/v1/worlds");
    } catch {
      console.log(`[demo-memory] 引擎不可达，${2}s 后重试…（${ENGINE_BASE}）`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error(`World Engine 不可达：${ENGINE_BASE}`);
}

/* ---------------- 落盘持久化（MemorySavePort；临时文件 + rename 原子替换） ---------------- */

class FileSavePort {
  constructor(file) {
    this.file = file;
  }
  load() {
    if (!existsSync(this.file)) return null;
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch (e) {
      /* 损坏快照不静默复用（对齐引擎 SavePort 纪律：载失败返回 null 但要可见） */
      console.warn(`[demo-memory] 快照损坏，忽略并重建：${this.file}（${e.message}）`);
      return null;
    }
  }
  save(snapshot) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, this.file);
  }
  clear() {
    try { renameSync(this.file, `${this.file}.bak`); } catch { /* 不存在即已清 */ }
  }
}

/* ---------------- 向量通道（EmbedHook；经网关 remoteEmbeddings） ----------------
   配置来源优先级：管理台写入的配置文件（embedding-config.json）> 环境变量
   （首次引导默认值，写入文件后即以文件为准）。配置可经管理台热应用。 */

const cfgFile = join(dataDir, "embedding-config.json");

function loadEmbeddingConfig() {
  if (existsSync(cfgFile)) {
    try {
      const c = JSON.parse(readFileSync(cfgFile, "utf8"));
      if (typeof c.enabled === "boolean" && typeof c.endpoint === "string" && typeof c.model === "string") {
        return c;
      }
    } catch (e) {
      console.warn(`[demo-memory] 嵌入配置文件损坏，改用环境变量引导：${e.message}`);
    }
  }
  /* 首次引导：环境变量 → 配置文件（成为此后的事实来源） */
  const boot = {
    enabled: !!(process.env.EMBEDDINGS_ENDPOINT && process.env.EMBEDDINGS_MODEL),
    endpoint: process.env.EMBEDDINGS_ENDPOINT ?? "",
    model: process.env.EMBEDDINGS_MODEL ?? "",
    apiKey: process.env.EMBEDDINGS_API_KEY ?? "",
  };
  try {
    mkdirSync(dirname(cfgFile), { recursive: true });
    writeFileSync(cfgFile, JSON.stringify(boot, null, 2));
  } catch { /* 写不进也继续（本次进程内生效） */ }
  return boot;
}

function makeEmbedHook(cfg) {
  if (!cfg.enabled || !cfg.endpoint || !cfg.model) return null;
  const ref = { id: cfg.model, endpoint: cfg.endpoint, apiKeyRef: { env: "EMBEDDINGS_API_KEY" }, tags: [], wireModel: cfg.model };
  const channel = { name: cfg.model }; /* 首次调用后补 dimension（HTTP 层如实上报） */
  let failures = 0;
  const hook = {
    channel,
    async embed(texts) {
      try {
        const vectors = await remoteEmbeddings(ref, cfg.apiKey ?? "", texts);
        if (!channel.dimension && vectors[0]?.length) channel.dimension = vectors[0].length;
        return vectors;
      } catch (e) {
        failures++;
        if (failures === 1 || failures % 10 === 0) {
          console.warn(`[demo-memory] 向量化失败（第 ${failures} 次），本次检索回词面：${e.message}`);
        }
        return null; /* 渐进增强：召回静默回词面 */
      }
    }
  };
  return hook;
}

const worlds = await waitForEngine();
const worldIds = (worlds.worlds ?? []).map(w => w.worldId);
if (!worldIds.length) throw new Error("引擎在线但没有任何世界（请先用 run-demo-engine.mjs 种子）");

/* 每世界一个 store（§42：worldId 维度由宿主持有多实例） */
mkdirSync(dataDir, { recursive: true });

const stores = [];
const state = new Map(); // worldId → { engine, seen: Set<eventId>, lastDay, seenFile, saveSeen() }
for (const id of worldIds) {
  const engine = new MemoryEngine({
    save: new FileSavePort(join(dataDir, `${id}.json`))
  });
  /* 已摄取事件 id 集合也持久化（sidecar）：引擎重启会重放同 id 事件，
     不落盘会把同一事实重复建档 */
  const seenFile = join(dataDir, `${id}.seen.json`);
  let seen = [];
  try {
    seen = JSON.parse(readFileSync(seenFile, "utf8"));
    if (!Array.isArray(seen)) seen = [];
  } catch {
    seen = [];
  }
  stores.push({
    name: id,
    engine,
    description: `世界 ${id} 的事实记忆（经事件轮询摄取）`
  });
  state.set(id, {
    engine,
    seen: new Set(seen),
    lastDay: 0,
    seenFile,
    saveSeen() {
      try {
        writeFileSync(seenFile, JSON.stringify([...this.seen]));
      } catch (e) {
        console.warn(`[demo-memory] seen 集合写盘失败：${e.message}`);
      }
    }
  });
  const restored = engine.stats();
  console.log(
    `[demo-memory] store 就绪：${id}（恢复 ${restored.total} 条在档 / ${restored.forgotten} 条已遗忘；seen ${seen.length} 条）`
  );
}

/* ---------------- 配置热应用（管理台写入 → 不重启生效） ---------------- */

let currentCfg = loadEmbeddingConfig();

function persistCfg(cfg) {
  try {
    mkdirSync(dirname(cfgFile), { recursive: true });
    writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  } catch { /* 写不进也继续（本次进程内生效） */ }
}

function applyEmbedding(cfg) {
  /* apiKey 语义：undefined = 沿用已存密钥；字符串 = 覆盖；null = 清除 */
  currentCfg = {
    enabled: cfg.enabled,
    endpoint: cfg.endpoint,
    model: cfg.model,
    apiKey: cfg.apiKey !== undefined ? (cfg.apiKey ?? "") : (currentCfg.apiKey ?? "")
  };
  currentHook = makeEmbedHook(currentCfg);
  for (const s of stores) {
    if (currentHook) s.embed = currentHook.channel;
    else delete s.embed;
    s.engine.setEmbed(currentHook);
  }
  persistCfg(currentCfg);
  console.log(
    `[demo-memory] 嵌入配置已${currentCfg.enabled ? "启用" : "停用"}并热应用：${currentCfg.model || "（无）"}（${currentCfg.endpoint || "—"}）`
  );
}

let currentHook = makeEmbedHook(currentCfg);
applyEmbedding(currentCfg); /* 启动时统一走热应用路径（引擎 setEmbed + store 通道声明） */

/* 摄取：WorldEvent 结构化满足 WorldFact（id/type/day/actor/target/location/witnesses/data） */
function ingest(worldId, events) {
  const st = state.get(worldId);
  const fresh = events.filter(e => !st.seen.has(e.id)).reverse(); // 旧 → 新
  for (const e of fresh) {
    st.seen.add(e.id);
    st.engine.ingestFact({
      id: e.id,
      type: e.type,
      day: e.day,
      ...(e.actor !== undefined ? { actor: e.actor } : {}),
      ...(e.target !== undefined ? { target: e.target } : {}),
      ...(e.location !== undefined ? { location: e.location } : {}),
      ...(e.witnesses !== undefined ? { witnesses: e.witnesses } : {}),
      ...(e.data !== undefined ? { data: e.data } : {})
    });
  }
  if (fresh.length) st.saveSeen();
  return fresh.length;
}

async function poll() {
  for (const id of worldIds) {
    try {
      const info = await engineGet(`/v1/worlds/${encodeURIComponent(id)}`);
      const { events } = await engineGet(`/v1/worlds/${encodeURIComponent(id)}/events?n=100`);
      const n = ingest(id, events ?? []);
      const day = info.time?.day ?? 0;
      if (day !== state.get(id).lastDay) {
        state.get(id).lastDay = day;
        state.get(id).engine.tickDay(day);
      }
      if (n) console.log(`[demo-memory] ${id} 摄取 ${n} 条新事实（共 ${state.get(id).engine.stats().total} 条）`);
    } catch (err) {
      console.warn(`[demo-memory] ${id} 轮询失败：${err.message}`);
    }
  }
}

const server = await startMemoryServer({
  stores,
  port: Number(process.env.MEMORY_API_PORT ?? 8789),
  /* 嵌入配置读写（管理台经平台鉴权代理到达这里；本服务自身无鉴权） */
  embeddingConfig: {
    get: () => ({
      enabled: currentCfg.enabled,
      endpoint: currentCfg.endpoint,
      model: currentCfg.model,
      hasApiKey: !!currentCfg.apiKey
    }),
    apply: cfg => {
      applyEmbedding(cfg);
      return {
        enabled: currentCfg.enabled,
        endpoint: currentCfg.endpoint,
        model: currentCfg.model,
        hasApiKey: !!currentCfg.apiKey
      };
    },
    test: async () => {
      if (!currentHook) return { ok: false, ms: 0, error: "嵌入通道未启用（先启用并保存配置）" };
      const t0 = Date.now();
      try {
        const v = await currentHook.embed(["ping"]);
        return { ok: true, dimension: v?.[0]?.length ?? 0, ms: Date.now() - t0 };
      } catch (e) {
        return { ok: false, ms: Date.now() - t0, error: e.message };
      }
    }
  }
});
console.log(`[demo-memory] Memory API listening at ${server.url}（stores: ${stores.map(s => s.name).join(", ")}）`);
await poll();
setInterval(poll, POLL_MS);

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

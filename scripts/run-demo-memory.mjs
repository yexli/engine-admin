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

   Embedding 配置统一治理（2026-10 · 方案全文）：本宿主**不持有任何
   Provider/Endpoint/Key/模型配置**——向量能力唯一经平台模型路由：
     设置 EMBEDDING_SERVICE_URL（平台公共 API，如 http://127.0.0.1:8790）
     + EMBEDDING_SERVICE_KEY（带 embeddings 权限的 API Key）后，
     EmbeddingService = POST {平台}/v1/embeddings（模型由 Router 的
     embedding 能力路由决定，primary 失败自动接管 fallback）。
     未设置 = 纯词面检索（诚实口径，管理台诊断页如实显示）。
   原 embedding-config.json / EMBEDDINGS_ENDPOINT|MODEL|API_KEY 双配置源
   已删除（迁移脚本：platform/scripts/migrate-memory-embedding.mjs）。

   环境变量：
     WORLD_API_URL          引擎地址（缺省 http://127.0.0.1:8787）
     MEMORY_API_PORT        本服务端口（缺省 8789）
     MEMORY_DATA_DIR        快照目录（缺省 platform/data/memory）
     EMBEDDING_SERVICE_URL  平台公共 API 地址 [可选，语义召回开关]
     EMBEDDING_SERVICE_KEY  平台 API Key（需 embeddings 权限）[可选]

   前置：先启动引擎（node scripts/run-demo-engine.mjs），
   且 world-engine、world-engine/memory 已 build。
   用法：node scripts/run-demo-memory.mjs
   ============================================================ */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMemoryServer } from "../world-engine/memory/dist/http/server.js";
import { MemoryEngine } from "../world-engine/memory/dist/index.js";

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

/* ---------------- 向量通道（EmbeddingService；唯一经平台模型路由） ----------------
   Memory 不选择模型：POST {平台}/v1/embeddings 的模型由 Router 的 embedding
   能力路由决定（primary 失败自动接管 fallback）。本宿主只持有一个服务地址
   与一把钥匙（属于"怎么连"，不属于"用哪个模型"）。 */

const embedBase = (process.env.EMBEDDING_SERVICE_URL ?? "").trim().replace(/\/+$/, "");
const embedKey = (process.env.EMBEDDING_SERVICE_KEY ?? "").trim();
const embedChannel = { name: "platform-model-router" }; /* 首次成功后补 dimension */

function makeRoutedEmbedHook() {
  if (!embedBase || !embedKey) return null;
  let failures = 0;
  return {
    channel: embedChannel,
    async embed(texts) {
      try {
        const res = await fetch(`${embedBase}/v1/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${embedKey}` },
          body: JSON.stringify({ input: texts })
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        if (!embedChannel.dimension && body?.dimensions) embedChannel.dimension = body.dimensions;
        return body?.vectors ?? null;
      } catch (e) {
        failures++;
        if (failures === 1 || failures % 10 === 0) {
          console.warn(`[demo-memory] 向量化失败（第 ${failures} 次），本次检索回词面：${e.message}`);
        }
        return null; /* 渐进增强：召回静默回词面 */
      }
    }
  };
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

/* ---------------- EmbeddingService 装配（启动时一次；换模型无需重启） ----------------
   模型切换在平台模型路由页热替换——本宿主与 Memory 都不感知，只管"要向量"。 */

const embedHook = makeRoutedEmbedHook();
for (const s of stores) {
  if (embedHook) s.embed = embedHook.channel;
  s.engine.setEmbed(embedHook);
}
console.log(
  embedHook
    ? `[demo-memory] EmbeddingService 已接入平台模型路由：${embedBase}（模型由 capability=embedding 决定）`
    : `[demo-memory] 未配置 EMBEDDING_SERVICE_URL/KEY —— 语义召回关闭（词面召回照常）`
);

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
  port: Number(process.env.MEMORY_API_PORT ?? 8789)
});
console.log(`[demo-memory] Memory API listening at ${server.url}（stores: ${stores.map(s => s.name).join(", ")}）`);
await poll();
setInterval(poll, POLL_MS);

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

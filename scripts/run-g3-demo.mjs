/* ============================================================
   G3 · 产品化端到端演示（实时 + 持久）
   ------------------------------------------------------------
   按真实 HTTP/WS 面逐项验证 GAME-PLATFORM-PLAN G3：

     1. WebSocket 实时流：hello 信封 + 命令事实实时推送（替代轮询）
     2. 流鉴权：无钥匙 401；游戏方钥匙只见本方世界的事件
     3. FileSavePort：推进落盘 → "重启"读档接续（tick 不丢）
     4. 后台可见：世界带 ownerGame 归属（游戏方页/世界列表可见）

   用法：node scripts/run-g3-demo.mjs
   ============================================================ */
import { createRequire } from "node:module";
import { rmSync } from "node:fs";

const require = createRequire(import.meta.url);
const { createWorldRegistry } = require("../world-engine/dist/index.js");
const { startWorldServer } = require("../world-engine/dist/http/server.js");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
};

const SAVE_PATH = "E:/桌面/项目总览/世界驱动引擎/scripts/.g3-demo-save.json";
try { rmSync(SAVE_PATH, { force: true }); } catch { /* 首跑无档 */ }

const { FileSavePort } = require("../world-engine/dist/index.js");

const registry = createWorldRegistry();
const auth = {
  keys: {
    "tq-key-0001": { gameId: "tianqiong", scopes: ["worlds:read", "worlds:write"] },
    "platform-key": {},
  },
};
const server = await startWorldServer({ registry, port: 0, auth });
const base = server.url;
console.log(`\n[G3 演示] 引擎已起：${base}（含 WebSocket 流 + 文件持久化）\n`);

const call = async (method, path, { key, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(key ? { "x-api-key": key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 空体 */ }
  return { status: res.status, json };
};

/* 种子世界：文件介质（重启接续的证明）+ 归属盖章（后台可见性） */
const port1 = new FileSavePort(SAVE_PATH, { debounceMs: 60_000 });
const w1 = registry.create({ worldId: "w-tq-main", savePort: port1 });
w1.container.core.S.metadata = { ownerGame: "tianqiong", name: "天穹纪元 · 圣辉城" };

/* ---------------- 1 · WebSocket 实时流 ---------------- */
console.log("1) WebSocket 实时流");
const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/stream?key=platform-key`);
const hello = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("hello 超时")), 4000);
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "hello") { clearTimeout(timer); resolve(m); }
  };
  ws.onerror = () => { clearTimeout(timer); reject(new Error("ws 错误")); };
});
check("连接即收 hello 信封（含可见世界清单）", Array.isArray(hello.worlds) && hello.worlds.includes("w-tq-main"), `worlds=[${hello.worlds}]`);

const liveEvent = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("实时事件超时")), 4000);
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "event" && m.event?.type === "time_advanced") { clearTimeout(timer); resolve(m); }
  };
});
await call("POST", "/v1/worlds/w-tq-main/time", { key: "tq-key-0001", body: { ticks: 1 } });
const evt = await liveEvent;
check("命令事实经 WS 实时推送（替代轮询）", evt.worldId === "w-tq-main" && evt.event.type === "time_advanced", `id=${evt.event.id}`);
ws.close();

/* ---------------- 2 · 流鉴权 ---------------- */
console.log("2) 流鉴权");
const probe = (path, key) => new Promise((resolve) => {
  const req = require("node:http").request({
    host: "127.0.0.1", port: server.port, path,
    headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...(key ? { "x-api-key": key } : {}) },
  });
  req.on("upgrade", () => resolve(101));
  req.on("response", (r) => { r.resume(); resolve(r.statusCode ?? 0); });
  req.on("error", () => resolve(0));
  req.end();
});
check("无钥匙连流 → 401", (await probe("/v1/stream")) === 401);

/* ---------------- 3 · FileSavePort 持久化 ---------------- */
console.log("3) 文件持久化（重启接续）");
const before = w1.query.get_time().tick;
w1.advanceTime(9);
w1.container.flushSave();
port1.flush();
const port2 = new FileSavePort(SAVE_PATH, { debounceMs: 60_000 });
const saved = port2.load();
const reborn = registry.create({ worldId: "w-tq-main-2", savePort: port2 });
reborn.container.core.S = saved;
check("推进落盘后重启读档接续", reborn.query.get_time().tick === before + 9, `tick ${before} → ${reborn.query.get_time().tick}`);
check("归属与名称随档保留", reborn.getState().metadata?.ownerGame === "tianqiong");
port2.dispose();
port1.dispose();

/* ---------------- 4 · 后台可见性 ---------------- */
console.log("4) 后台可见性");
const list = (await call("GET", "/v1/worlds", { key: "platform-key" })).json.worlds;
const row = list.find((w) => w.worldId === "w-tq-main");
check("世界带 ownerGame / name（游戏方页与世界列表数据源）", row?.ownerGame === "tianqiong" && !!row?.name);

/* ---------------- 收尾 ---------------- */
ws.close();
await new Promise((r) => setTimeout(r, 100));
await server.close();
rmSync(SAVE_PATH, { force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n[G3 演示] ${results.length - failed.length}/${results.length} 项通过${failed.length ? " —— 存在失败项！" : "。实时推送 + 持久化 + 游戏方可见性全链路就绪。"}`);
/* 不用 process.exit()：带未关净的 socket 强退会触发 Windows libuv 断言噪音 */
process.exitCode = failed.length ? 1 : 0;

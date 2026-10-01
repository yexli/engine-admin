/* ============================================================
   G2 · 多游戏托管隔离演示（端到端实测）
   ------------------------------------------------------------
   一个引擎进程 + 两个模拟游戏方（tianqiong / nova）+ 平台管理钥匙，
   按真实 HTTP 面逐项验证 GAME-PLATFORM-PLAN G2 的 DoD：

     1. 401  认证闸门（无钥匙 / 伪造钥匙全被拒）
     2. 403  写权限（只读游戏方钥匙碰写入类路由）
     3. 隔离  游戏方只见自己的世界；越权访问 404 不泄露存在性
     4. 盖章  游戏方建世界强制归属自己，冒名不生效
     5. 聚合  管理钥匙全可见 + ?game= 按方过滤（后台「游戏方」页数据源）

   用法：node scripts/run-g2-demo.mjs
   ============================================================ */
import { createRequire } from "node:module";

/* 根目录 scripts/ 无 node_modules 链接——按仓库约定直引引擎 dist
   （需先 cd world-engine && pnpm build；tianqiong2 走 file: 依赖则免） */
const require = createRequire(import.meta.url);
const { createWorldRegistry } = require("../world-engine/dist/index.js");
const { startWorldServer } = require("../world-engine/dist/http/server.js");

/* 钥匙表（生产中由平台 KeyStore 签发后注入；此处演示声明式形状） */
const auth = {
  keys: {
    "tq-world-key-0001": { gameId: "tianqiong", scopes: ["worlds:read", "worlds:write"], name: "天穹世界钥匙" },
    "nv-world-key-0001": { gameId: "nova", name: "nova 只读钥匙" },
    "platform-master-key": { name: "平台管理钥匙" },
  },
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —— ${detail}` : ""}`);
};

const call = async (base, method, path, { key, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(key ? { "x-api-key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 空体 */ }
  return { status: res.status, json };
};

/* ---------------- 起服务器（两个模拟游戏方 + 平台管理） ---------------- */
const registry = createWorldRegistry();
const server = await startWorldServer({ registry, port: 0, auth });
const base = server.url;
const ADMIN = "platform-master-key";
const TQ = "tq-world-key-0001";
const NV = "nv-world-key-0001";

console.log(`\n[G2 演示] 引擎已起：${base}（三把钥匙：tianqiong 读写 / nova 只读 / 平台管理）\n`);

/* 管理钥匙播种两个已归属世界（模拟两个游戏方各自接入后的存量） */
await call(base, "POST", "/v1/worlds", { key: ADMIN, body: { worldId: "w-tq-main", name: "天穹纪元 · 圣辉城", ownerGame: "tianqiong" } });
await call(base, "POST", "/v1/worlds", { key: ADMIN, body: { worldId: "w-nv-arena", name: "新星竞技场", ownerGame: "nova" } });

/* ---------------- 1 · 401 认证闸门 ---------------- */
console.log("1) 认证闸门");
check("无钥匙读世界清单 → 401", (await call(base, "GET", "/v1/worlds")).status === 401);
check("伪造钥匙 → 401", (await call(base, "GET", "/v1/worlds", { key: "forged-key" })).status === 401);
check("有效钥匙（Bearer 通道）→ 200", (await fetch(`${base}/v1/worlds`, { headers: { authorization: `Bearer ${ADMIN}` } })).status === 200);

/* ---------------- 2 · 403 写权限 ---------------- */
console.log("2) 写权限（worlds:write）");
check("nova 只读钥匙读自己世界 → 200", (await call(base, "GET", "/v1/worlds/w-nv-arena", { key: NV })).status === 200);
check("nova 只读钥匙提交命令 → 403", (await call(base, "POST", "/v1/worlds/w-nv-arena/commands", { key: NV, body: { type: "move", targetId: "market" } })).status === 403);
check("nova 只读钥匙推进时间 → 403", (await call(base, "POST", "/v1/worlds/w-nv-arena/time", { key: NV, body: { ticks: 1 } })).status === 403);
check("nova 只读钥匙暂停世界 → 403", (await call(base, "POST", "/v1/worlds/w-nv-arena/pause", { key: NV })).status === 403);

/* ---------------- 3 · 世界可见域隔离 ---------------- */
console.log("3) 可见域隔离");
const tqList = (await call(base, "GET", "/v1/worlds", { key: TQ })).json.worlds.map((w) => w.worldId);
check("天穹钥匙清单只含自己的世界", tqList.length === 1 && tqList[0] === "w-tq-main", `got [${tqList}]`);
const nvList = (await call(base, "GET", "/v1/worlds", { key: NV })).json.worlds.map((w) => w.worldId);
check("nova 钥匙清单只含自己的世界", nvList.length === 1 && nvList[0] === "w-nv-arena", `got [${nvList}]`);
check("天穹钥匙越权访问 nova 世界 → 404（不泄露存在性）", (await call(base, "GET", "/v1/worlds/w-nv-arena", { key: TQ })).status === 404);
check("nova 钥匙越权访问天穹世界 → 404", (await call(base, "GET", "/v1/worlds/w-tq-main", { key: NV })).status === 404);
check("nova 钥匙越权对天穹世界写命令 → 404（归属检查先于写权限）", (await call(base, "POST", "/v1/worlds/w-tq-main/commands", { key: NV, body: { type: "move", targetId: "market" } })).status === 404);

/* ---------------- 4 · 归属盖章 ---------------- */
console.log("4) 归属盖章");
const forged = await call(base, "POST", "/v1/worlds", { key: TQ, body: { worldId: "w-tq-new", ownerGame: "nova" } });
check("天穹钥匙建世界冒名 nova → 归属强制改判 tianqiong", forged.status === 201 && forged.json.ownerGame === "tianqiong", `ownerGame=${forged.json?.ownerGame}`);
const afterForge = (await call(base, "GET", "/v1/worlds", { key: NV })).json.worlds.map((w) => w.worldId);
check("冒名世界不进 nova 可见域", !afterForge.includes("w-tq-new"));

/* ---------------- 5 · 管理聚合（后台「游戏方」页数据源） ---------------- */
console.log("5) 管理聚合");
const adminAll = (await call(base, "GET", "/v1/worlds", { key: ADMIN })).json.worlds.map((w) => w.worldId).sort();
check("管理钥匙全可见", adminAll.join(",") === "w-nv-arena,w-tq-main,w-tq-new", `got [${adminAll}]`);
const onlyTq = (await call(base, "GET", "/v1/worlds?game=tianqiong", { key: ADMIN })).json.worlds.map((w) => w.worldId);
check("?game=tianqiong 过滤", onlyTq.length === 2 && !onlyTq.includes("w-nv-arena"), `got [${onlyTq}]`);

/* ---------------- 收尾 ---------------- */
await server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n[G2 演示] ${results.length - failed.length}/${results.length} 项通过${failed.length ? " —— 存在失败项！" : "，DoD 达成：两个游戏方各自建世界、互相不可见、后台按方聚合可见。"}`);
process.exit(failed.length ? 1 : 0);

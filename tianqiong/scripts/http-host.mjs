/* ============================================================
   天穹 HTTP 宿主（GAME-PLATFORM-PLAN G1 · 参考实现）
   ------------------------------------------------------------
   读 tianqiong 的世界书 JSON 事实源（geo/people），按引擎
   GameAdapter 契约装配成常驻世界并托管：

     天穹世界书 → GameWorldSeed → hostGameWorld → startWorldServer

   之后管理后台（世界列表/状态/关系/事件/生命周期）即可看到
   tianqiong-main 世界——数据零改动，引擎零改动。

   用法（在 tianqiong/ 目录，需 ../world-engine/dist 已构建）：
     node scripts/http-host.mjs
   环境变量：TIANQIONG_PORT（缺省 8798，避开开发栈）
   ============================================================ */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/* 引擎 dist 为 CJS 构建产物，用 require 装载最稳（命名导出经
   cjs-module-lexer 在 __exportStar 场景可能识别不全） */
const require = createRequire(import.meta.url);
const { createWorldRegistry, hostGameWorld } = require("world-engine");
const { startWorldServer } = require("world-engine/http");

const readJson = (rel) =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

const geo = readJson("../src/data/world/geo.json");
const people = readJson("../src/data/world/people.json");

/* GameAdapter：天穹世界书 → 引擎世界种子（映射的唯一实现处）。
   契约形状见 world-engine/src/adapter.ts 的 GameAdapter/GameWorldSeed */
const adapter = {
  gameId: "tianqiong",
  name: "天穹纪元 2.0",
  seed() {
    const locations = Object.entries(geo.locations).map(([id, l]) => ({
      id,
      name: l.name,
      type: /野|林|原/.test(l.name ?? "") ? "wilderness" : "urban",
      attributes: { area: l.area ?? "", continent: l.continent ?? "" },
    }));
    const npcs = Object.entries(people.npcs).map(([id, n]) => ({
      id,
      name: n.name,
      loc: n.loc,
      data: { title: n.title ?? "", race: n.race ?? "" },
    }));
    const relations = Object.entries(people.npcs).flatMap(([id, n]) =>
      Object.entries(n.rels ?? {}).map(([target, rel]) => ({
        source: id,
        target,
        type: rel.type,
        value: rel.val,
      })),
    );
    const facts = Object.entries(people.npcs).map(([id, n]) => ({
      type: "npc_identity",
      actor: id,
      data: { identity: String(n.lore?.identity ?? "").slice(0, 200) },
    }));
    return {
      worldId: "tianqiong-main",
      name: "天穹纪元 · 圣辉城",
      description: "天穹 2.0 世界书数据在剥离引擎上的托管示例（G1 参考实现）",
      ownerGame: "tianqiong",
      startLoc: locations[0]?.id ?? "plaza",
      locations,
      npcs,
      relations,
      facts,
    };
  },
};

/* 装配 + 托管 */
const registry = createWorldRegistry();
const { worldId } = hostGameWorld(registry, adapter);
const port = Number(process.env.TIANQIONG_PORT ?? 8798);
const server = await startWorldServer({ registry, port });

console.log(`[tianqiong-host] 世界 ${worldId} 已托管：${server.url}`);
console.log(
  `[tianqiong-host] 世界书地点 ${adapter.seed().locations.length} 个 / NPC ${Object.keys(people.npcs).length} 个`,
);
console.log(`[tianqiong-host] 管理后台 → 世界列表（/world-api 指向本服务时可见）`);

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

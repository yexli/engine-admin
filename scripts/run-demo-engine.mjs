/* ============================================================
   Demo Engine Launcher（演示用，不属于交付核心）
   ------------------------------------------------------------
   用 World Engine 公开 API 启动一个本机演示服务：
   · 注册表模式（多世界）监听 127.0.0.1:8787
   · 预建两个演示世界（地点 / NPC / 关系 / 事件），便于管理后台联调
   不修改 world-engine 任何代码；仅作为宿主集成示例。
   用法：node scripts/run-demo-engine.mjs
   ============================================================ */
import { startWorldServer } from "../world-engine/dist/http/server.js";
import {
  createWorldRegistry,
  InMemoryWorldStorage
} from "../world-engine/dist/index.js";

const registry = createWorldRegistry();

function seed(worldId, playerName, startLoc) {
  const store = new InMemoryWorldStorage();
  const world = registry.create({
    worldId,
    playerName,
    startLoc,
    weather: "sunny",
    savePort: store,
    definition: {
      locations: [
        { id: "plaza", type: "urban", attributes: { desc: "中央广场" } },
        { id: "tavern", type: "building", attributes: { desc: "旧铁匠铺酒馆" } },
        { id: "forest", type: "wilderness", attributes: { desc: "黑松森林" } }
      ],
      relations: [
        {
          source: "lita",
          target: "borin",
          type: "friend",
          value: 40,
          metadata: { note: "同乡" }
        }
      ]
    }
  });

  // NPC + 交互事件
  const r = [];
  r.push(
    world.executeCommand({
      type: "spawn_entity",
      payload: { id: "lita", name: "莉安", kind: "npc", loc: "tavern" }
    })
  );
  r.push(
    world.executeCommand({
      type: "spawn_entity",
      payload: { id: "borin", name: "波林", kind: "npc", loc: "plaza" }
    })
  );
  r.push(
    world.executeCommand({
      type: "talk",
      actorId: "player",
      targetId: "lita",
      text: "晚上有什么好吃的？"
    })
  );
  r.push(world.executeCommand({ type: "set_attitude", targetId: "lita", amount: 5 }));
  r.push(world.executeCommand({ type: "advance_time", amount: 24 }));
  r.push(world.executeCommand({ type: "change_weather", text: "cloudy" }));
  const failed = r.filter(x => !x.ok);
  if (failed.length) {
    console.warn(`[demo-engine] ${worldId} 有 ${failed.length} 条种子命令被拒绝:`, failed);
  }
  console.log(`[demo-engine] world seeded: ${worldId}`);
}

seed("w-main", "云生", "plaza");
seed("w-test", "测试员", "tavern");

const server = await startWorldServer({ registry, port: 8787 });
console.log(`[demo-engine] World Engine listening at ${server.url}`);

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

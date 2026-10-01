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
  const talkResult = world.executeCommand({
    type: "talk",
    actorId: "player",
    targetId: "lita",
    text: "晚上有什么好吃的？"
  });
  r.push(talkResult);
  r.push(world.executeCommand({ type: "set_attitude", targetId: "lita", amount: 5 }));
  r.push(world.executeCommand({ type: "advance_time", amount: 24 }));
  r.push(world.executeCommand({ type: "change_weather", text: "cloudy" }));

  // M4.3 · 事件因果链真实数据：以「交谈」产生的事实为父事件，用公开 API
  // emitEvent 串联派生事实（parentId/sourceId/cause），供管理后台因果链 UI 验证
  // CommandResult.events 是事件 ID 串（时序），talk 的首个事实即 talk_started
  const talkEventId = talkResult.ok ? talkResult.events[0] : undefined;
  if (talkEventId) {
    const mood = world.emitEvent({
      type: "social_mood_shift",
      actor: "lita",
      target: "player",
      cause: "talk_started",
      parentId: talkEventId,
      sourceId: talkEventId,
      data: { moodDelta: 5, note: "交谈后态度转好" }
    });
    world.emitEvent({
      type: "narrative_hook_opened",
      actor: "lita",
      cause: "social_mood_shift",
      parentId: mood.id,
      sourceId: talkEventId,
      data: { hook: "莉安似乎愿意多聊几句" }
    });
  }

  const failed = r.filter(x => !x.ok);
  if (failed.length) {
    console.warn(`[demo-engine] ${worldId} 有 ${failed.length} 条种子命令被拒绝:`, failed);
  }
  console.log(`[demo-engine] world seeded: ${worldId}`);
}

seed("w-main", "云生", "plaza");
seed("w-test", "测试员", "tavern");

/* 端口可经 PORT 环境变量覆盖（缺省 8787；e2e 冒烟用 18787 避让开发栈） */
const port = Number(process.env.PORT ?? 8787);
const server = await startWorldServer({ registry, port });
console.log(`[demo-engine] World Engine listening at ${server.url}`);

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});

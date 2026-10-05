# World Engine 接入指南（SDK Quickstart）

> 目标读者：想在 **不改动引擎代码** 的前提下，把自己的游戏世界接入 World Driving
> Engine 的游戏方 / 开发者。全程只需要一个依赖：`world-engine`。

## 0. 你将得到什么

- 你的世界书 / 设定数据变成引擎里的**常驻世界**（地点、NPC、关系网、种子事实）；
- 引擎提供：时间推进、规则事件总线、关系/实体/事件查询、暂停恢复、**实时事件推送**、
  **文件持久化**、**多游戏方隔离鉴权**；
- 平台管理后台（admin-web）全量可见：世界列表、运行时、关系、事件、按游戏方聚合。

## 1. 安装

```bash
npm install world-engine        # 或 pnpm add world-engine
```

引擎零运行时依赖，Node ≥ 20。TypeScript 类型内置。

## 2. 最小宿主（约 30 行）

新建 `host.mjs`：

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  createWorldRegistry,
  hostGameWorld,          // G1 契约：把你的世界书装配成常驻世界
  FileSavePort,           // G3：文件持久化（重启接续）
} = require("world-engine");
const { startWorldServer } = require("world-engine/http");

/* 你的世界书数据（从 JSON / 数据库读取均可） */
const worldbook = {
  worldId: "my-game-main",
  name: "我的世界",
  ownerGame: "my-game",              // G2：归属你的游戏方（后台按方聚合/隔离）
  locations: [
    { id: "plaza", name: "中央广场", type: "urban" },
    { id: "darkwood", name: "黑森林", type: "wilderness" },
  ],
  npcs: [
    { id: "elena", name: "艾莲娜", loc: "plaza", data: { title: "旅店老板" } },
    { id: "kane", name: "凯恩", loc: "darkwood", data: { title: "猎人" } },
  ],
  relations: [
    { source: "elena", target: "kane", type: "friend", value: 30 },
  ],
  facts: [
    { type: "npc_identity", actor: "kane", data: { identity: "前骑士，隐居猎户" } },
  ],
};

const registry = createWorldRegistry();
hostGameWorld(registry, { gameId: "my-game", name: "我的世界", seed: () => worldbook });
const server = await startWorldServer({ registry, port: 8800 });
console.log(`世界已托管：${server.url}/v1/worlds/my-game-main`);
```

运行 `node host.mjs`，然后：

```bash
curl http://127.0.0.1:8800/v1/worlds/my-game-main          # 世界概要
curl http://127.0.0.1:8800/v1/worlds/my-game-main/relations # 关系网
curl -X POST http://127.0.0.1:8800/v1/worlds/my-game-main/time \
     -H "content-type: application/json" -d '{"ticks":3}'   # 推进时间
```

管理后台可见性：admin-web 的 `/world-api` 代理指向本服务
（dev 环境 `VITE_WORLD_API_URL=http://127.0.0.1:8800`），世界列表 / 运行时 /
「游戏方」页即出现 `my-game`。

> 完整参考实现见仓库内 `tianqiong/scripts/http-host.mjs`（63 地点 / 15 NPC
> 的真实世界书接入）。

## 3. 持久化（重启接续）

```js
const port = new FileSavePort("./data/my-world.json", { debounceMs: 500 });

/* 装配时带上介质（hostGameWorld 第三参；缺省内存介质） */
hostGameWorld(registry, adapter, { savePort: port });

/* 优雅关闭前把挂起快照写盘 */
process.on("SIGINT", async () => {
  port.flush();
  await server.close();
  process.exit(0);
});

/* 重启恢复（宿主编排，正典模式）：读档 → 新世界 → 注入容器 */
const saved = port.load();
const world = hostGameWorld(registry, adapter, { savePort: port }).handle;
if (saved) world.container.core.S = saved;           // 读档注入
```

写后置 + 原子写（tmp+rename）；存档损坏自动备份 `*.corrupt-<时间戳>`，绝不静默覆盖。
PostgreSQL 等网络介质：实现同一个 `SavePort` 接口（`load/save/clear`），部署层自行适配。

## 4. 实时事件流（替代轮询）

浏览器 / 服务端均可订阅世界事实流（WebSocket，RFC6455）：

```
ws://127.0.0.1:8800/v1/worlds/my-game-main/events/stream?replay=20   # 单世界
ws://127.0.0.1:8800/v1/stream?replay=20                              # 全部可见世界
```

- 信封：先 `{type:"hello", worlds:[...]}`，之后每条事实
  `{type:"event", worldId, event}`；`replay=N` 重连衔接最近 N 条（按 `event.id` 幂等去重）；
- 心跳：服务端 30s ping / 90s 判死；客户端只需处理 `onmessage / onclose`。

管理后台「世界观测 → 事件」页的 **实时** 按钮就是这条流（vite 代理已开 `ws: true`）。

## 5. 多游戏方隔离（上线必读）

引擎默认只绑 `127.0.0.1` 且不鉴权（本地开发形态）。对外服务必须两件事一起做：

```js
const server = await startWorldServer({
  registry,
  port: 8800,
  host: "0.0.0.0",          // 1. 显式对外（自己加反代/HTTPS）
  auth: {                   // 2. 开启 API Key 鉴权
    keys: {
      "my-game-key-0001": { gameId: "my-game", scopes: ["worlds:read", "worlds:write"] },
      "platform-master-0001": {},   // 无 gameId = 平台管理钥匙（全可见，默认读写）
    },
  },
});
```

| 语义 | 行为 |
|---|---|
| 无钥匙 / 假钥匙 | 所有路由 401 |
| 只读钥匙（scopes 缺省） | 写入类路由（建世界/命令/时间/暂停/关闭）403 `need: worlds:write` |
| 游戏方钥匙（带 gameId） | 只见 `ownerGame` 匹配的世界，越权访问 404（不泄露存在性） |
| 建世界归属盖章 | 游戏方钥匙建世界强制归属自己，冒名无效 |

钥匙事实建议由平台 KeyStore 签发管理（管理台「AI 网关 → API 密钥」，创建时填
`gameId` 即为游戏方钥匙），引擎只认启动时注入的映射。

## 6. 命令与规则（玩法在哪里写？）

引擎只提供通用原语（移动 / 时间 / 关系 / 实体 / 事实上报）。**玩法语义由游戏方经
`registerRule` 挂载**，不进引擎：

```js
/* 规则是普通对象（WorldRule），经 world.registerRule 挂载 */
world.registerRule({
  name: "ShopBuyRule",
  for: "shop_buy",            // 处理的命令类型
  apply(ctx) {
    /* 你的经济结算：状态改写经 ctx.mutate / ctx.clock，
       事实上报经 ctx.emit({ type: "purchase_done", ... }) */
    return true;              // true = 接受命令；false = 拒绝
  },
});
```

通用子集之外的玩法命令，也可以在你自己的服务执行后把**结果事实**经
`world.emitEvent(...)` 喂回——后台事件流与记忆摄取照常可见。

### 命令链非事务性（设计决定）

引擎命令按注册序逐规则执行。若规则 B 拒绝或抛错，规则 A 已产生的状态变更与
事实**不回滚**——世界模拟中「已发生的事不可撤」是核心纪律。

`CommandResult.appliedRules` 列出已成功执行的规则名：

- `ok: true` → 全部匹配规则执行完毕
- `ok: false` 且 `appliedRules: ['move']` → move 规则已产生副作用，后续规则拒绝

调用方若需要「全有或全无」语义，应在游戏侧做前置校验（发命令前确认条件），
或将多步操作拆为独立命令逐条确认。

## 7. 版本纪律

引擎从 1.0 起冻结公开 API：**只增不改**。接入方升级引擎只拿新能力，不需要改宿主代码。
当前版本与变更见 `world-engine/CHANGELOG.md`。

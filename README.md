# 世界驱动引擎 · World Driving Engine

**AI 世界运行托管平台**——把"世界"变成一种可以被托管、观测、推进和消费的运行时。
做游戏的、做小说的、任何需要 AI 世界推演的场景，都可以把世界交给这台引擎运行。

```
世界书数据 → GameAdapter → 引擎常驻世界 → HTTP / WebSocket 全量可观测
                                ↓
              管理后台：世界运行 / 事件流 / 关系网 / 游戏方 / 用量计量
```

## 这是什么

一套完整的 AI 世界模拟栈，由五个包组成：

| 包 | 版本 | 职责 | 测试 |
|---|---|---|---|
| `world-engine/` | **1.2.0** | 纯库内核：多世界注册表、规则/命令/查询原语、HTTP+WebSocket 面 | 107 |
| `world-engine/platform/` | **0.9.0** | 平台面：API Key、会话权限、用量计量、管线、设置、AI 世界演化运行时 V2（策略围栏/幂等/因果追溯） | 174 |
| `world-engine/gateway/` | 0.7.1 | AI 网关：多厂商模型调用、思考强度适配、任务路由 | 30 |
| `world-engine/memory/` | 0.8.2 | 世界记忆：4 因子召回 + 向量嵌入（bge-m3 实测） | 20 |
| `admin-web/` | 6.x | 管理后台（Vue3 + Element Plus，数据 Mock 清零） | e2e 冒烟 |

设计纪律：**引擎零运行时依赖**（WebSocket 为 RFC6455 自实现、持久化只用 node:fs）；
**1.0 起公开 API 只增不改**；**玩法语义不进引擎**（规则由接入方/平台模板挂载）。

## 核心能力

- **多世界托管**：一个进程 N 个世界，每世界独立事件总线与作用域；创建/暂停/恢复/关闭全生命周期。
- **游戏适配器契约（G1）**：`GameWorldSeed`（地点/NPC/关系/事实）→ `hostGameWorld` 一步装配成常驻世界——世界书数据接入，不改引擎。
- **多游戏方隔离（G2）**：`ownerGame` 世界归属 + 声明式 API Key 鉴权——401 全路由闸门、写入需 `worlds:write`、游戏方只见自己的世界（越权 404 不泄露存在性）、建世界强制归属盖章。
- **实时事件流（G3）**：`/v1/worlds/{id}/events/stream` 与全局 `/v1/stream`，`?replay=N` 断线衔接，30s 心跳判死；管理台事件页可切实时推送。
- **持久化**：`FileSavePort` 写后置 + 原子写 + 损坏档备份不静默覆盖；SavePort 是端口，PG 等介质由部署层适配。
- **可观测**：事件/实体/关系/调度器全端点，因果链追溯，跨世界事件聚合。
- **计量**：结构化用量面（JSONL），Key / 模型 / 世界 / **游戏方**多维度过滤分组。
- **AI 世界演化（Evolution Runtime）**：观察世界 → 上下文 → AI 提案 → 白名单 → Rules 终审 → 落地。
  AI 只能建议不能改世界（进程边界 + 策略围栏 + 动作白名单 + Rules 三层拒绝），NPC 不因玩家行动被强制触发（空提案合法），OOC/叙事永不成为世界事实，
  每次演化留完整因果链账本；管理台「AI 演化」页可触发与反向追溯。见 [docs/EVOLUTION-ARCHITECTURE.md](docs/EVOLUTION-ARCHITECTURE.md)。

## 快速开始

```bash
# 一条命令起全栈：引擎 8787 / 记忆 8789 / 平台 8790·8791 / 控制台 8848
node platform/scripts/dev-stack.mjs
```

打开控制台 `http://127.0.0.1:8848`（世界运行 / 世界观测 / AI 网关 / 游戏方各页），
演示世界 `w-main`、`w-test` 已在跑。

### 托管一个自己的世界（约 30 行）

```js
const { createWorldRegistry, hostGameWorld } = require("world-engine");
const { startWorldServer } = require("world-engine/http");

const registry = createWorldRegistry();
hostGameWorld(registry, {
  gameId: "my-game",
  name: "我的世界",
  seed: () => ({
    worldId: "my-game-main",
    name: "我的世界",
    ownerGame: "my-game",
    locations: [{ id: "plaza", name: "中央广场" }],
    npcs: [{ id: "elena", name: "艾莲娜", loc: "plaza" }],
    relations: [],
    facts: [],
  }),
});
await startWorldServer({ registry, port: 8800 });
```

完整接入路径（持久化 / 实时流 / 隔离鉴权 / 规则挂载）见 **[docs/SDK-GUIDE.md](docs/SDK-GUIDE.md)**。

## 仓库结构

```
world-engine/          引擎内核 + gateway + memory（独立包，各带 CHANGELOG）
└─ src/http/           HTTP 协议层 + WebSocket 事件流 + SavePort
└─ src/adapter.ts      G1 游戏适配器契约
platform/              平台面（KeyStore / 计量 / 会话 / 管线 / 管理监听）
admin-web/             管理后台（Vue3）
scripts/               演示与验证：dev-stack、天穹参考宿主、G2/G3 隔离演示
deploy/                compose 部署（见 docs/DEPLOY.md）
docs/                  规划与指南（GAME-PLATFORM-PLAN / SDK-GUIDE / DEPLOY）
```

> `tianqiong2/`（参考游戏《天穹纪元》）为独立项目，不入本仓。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/SDK-GUIDE.md](docs/SDK-GUIDE.md) | 第三方从零接入：安装 → 30 行宿主 → 持久化/实时流/鉴权/规则 |
| [docs/EVOLUTION-ARCHITECTURE.md](docs/EVOLUTION-ARCHITECTURE.md) | AI 世界演化运行时：概念边界（Intent/Proposal/Mutation/Event）、闭环、AI/引擎边界、因果链 |
| [docs/GAME-PLATFORM-PLAN.md](docs/GAME-PLATFORM-PLAN.md) | 平台化路线：G1–G3 已兑现；P 系列托管平台路线（托管运行服务/自助接入中心/配额/客户端 SDK/云端硬化） |
| [docs/DEPLOY.md](docs/DEPLOY.md) | compose 云端部署 |
| world-engine/CHANGELOG.md | 引擎版本演进（1.0 起公开 API 冻结，只增不改） |

## 安全须知

- 任何 `.env*` 与 `platform/data/`（运行时密钥/存档）**永不入库**——发布脚本白名单 + 红线自检强制执行；
- 引擎默认只绑 `127.0.0.1`；对外服务必须显式 `host: "0.0.0.0"` **并**开启 `auth` 钥匙表；
- 管理台默认口令仅限本地开发，部署前必须改；托管形态只接受数据种子，不接受接入方提交规则代码。

# AI World Engine

**面向 AI 原生应用的世界模拟内核。**

把「世界如何运转」——状态、时间、事件、命令、规则——从具体应用中抽离出来，成为可独立运行、独立测试、被多个世界类应用与 AI 客户端复用的公共引擎。

即使删除所有上层应用，本引擎仍能独立创建世界、驱动世界、修改世界状态、产生世界事件。这是本项目存在的证明，也是一切验收的底线。

---

## 解决什么问题

AI RPG / Agent 类应用的世界逻辑通常长死在业务代码里：状态结构、时间系统、事件分发、模型调用、记忆系统互相纠缠，每做一个新应用就要重写一遍。本项目把它们拆成三层，各司其职：

```text
┌─────────────────────────────────────────────────────────┐
│  应用层（游戏 / 交互式叙事 / Agent / 第三方客户端）           │
│  UI · 人设 · 剧情 · 数值 · 玩法规则 —— 这些属于应用本身       │
└──────────────────────────┬──────────────────────────────┘
                           │ Adapter（数据映射 / 实体映射 / 规则注册）
                           ▼
┌─────────────────────────────────────────────────────────┐
│  world-engine —— 世界运行内核（本仓库主包）                  │
│                                                          │
│   Command → Runtime → Rules → Mutation → State → Event   │
│                                                          │
│   状态信封 · 世界时钟 · 事件总线（配额/因果/幂等/死信）        │
│   受控写入原语 · 分片存档 · 作用域隔离 · 多世界注册表          │
└──────────────────────────┬──────────────────────────────┘
                           │ 只读事实流 ▲ Command（单向数据流）
                           ▼
┌─────────────────────────────────────────────────────────┐
│  AI Cloud Layer（独立包，内核对其零感知）                    │
│  world-gateway —— OpenAI 兼容网关 · 模型路由 · 多模型管线    │
│  world-memory  —— 角色记忆引擎（事实摄取/衰减遗忘/检索）      │
└─────────────────────────────────────────────────────────┘
```

三条铁律贯穿全部代码，并由机器守卫强制：

1. **内核不认识任何应用、任何模型**——世界数据、提示词、厂商 SDK 全部在内核之外（不变量扫描测试，违例即测试失败）。
2. **Command ≠ Event**：命令是意图（可被规则拒绝），事件是事实（只发布）。一切状态改写必须经受控写入原语。
3. **依赖方向单向**：`应用 → Adapter → 内核`、`AI 层 → 内核公开 API`，永不反向。

## 仓库结构

```text
world-engine/
├── src/            # 内核主包（npm 包 world-engine）
│   ├── types.ts        # 状态信封 EngineWorldState（宿主状态结构化满足它）
│   ├── rng.ts / scheduler.ts    # 可注入随机源与调度器
│   ├── events/         # WorldEvent 结构 + 世界事件总线（配额/因果/幂等/死信）
│   ├── time/           # 历法常量 + 推进循环（历法标签与钩子可注入）
│   ├── state/          # 状态容器 / 分片存档 / SavePort / 内存介质
│   ├── mutate/         # 受控写入原语（唯一写入实现点）
│   ├── command/ rules/ runtime/  # 命令契约 + 规则扩展点 + 内置规则
│   ├── api/            # createWorld 门面 / 只读查询 / 多世界注册表
│   └── http/           # HTTP 传输层（子路径 world-engine/http）
├── gateway/        # world-gateway：OpenAI 兼容网关 · 模型路由 · 多模型管线
├── memory/         # world-memory：独立角色记忆引擎
├── examples/       # basic-world · second-game · 记忆闭环示例
├── tests/          # 内核测试（含架构不变量扫描）
└── docs/           # 路线图 · 架构决策 · 接入指南 · 契约底册 · 工程档案
```

三个包均为独立发布单元；内核对 gateway / memory **零感知**（依赖方向严格单向）。

## 安装

```bash
git clone <本仓库>
cd world-engine
npm install && npm run build

# 子包
cd gateway && npm install && npm test
cd memory  && npm install && npm test
```

- 消费面为构建产物 `dist`（ESM + d.ts，可直接被 Node import）。
- 应用以 npm 依赖形式消费；内核改码后先 `npm run build`，宿主即可见。
- **一个进程一个活动世界**（见「多世界」）：事件总线为进程级设施，多世界隔离经 WorldRegistry。

## 快速开始

```ts
import { createWorld, InMemoryWorldStorage } from 'world-engine';

const world = createWorld({
  worldId: 'demo',
  playerName: '旅人',
  startLoc: 'plaza',
  savePort: new InMemoryWorldStorage(),   // 生产环境替换为数据库介质
});

// 只读查询
world.getState();                          // 完整世界状态
world.query.get_time();                    // 世界时钟读数
world.query.get_location();                // 当前位置

// 命令 = 唯一的状态改写入口
world.executeCommand({ type: 'move', actorId: 'player', targetId: 'forest' });
world.advanceTime(8);                      // 等价 advance_time 命令
world.executeCommand({ type: 'set_attitude', targetId: 'lita', amount: 20 });

// 世界事实与持久化
world.getEvents();                         // 最近的世界事实（新 → 旧）
world.container.save();                    // 经 SavePort 落盘
```

内置通用命令：`move / attack / talk / advance_time / change_weather / spawn_entity / set_attitude`。
应用玩法用自己的命令名注册规则，**无需修改内核**：

```ts
world.registerRule({
  name: 'PrayRule',
  for: 'pray',
  apply(ctx) {
    ctx.mutate.rep('temple', 5);                                    // 只经写入原语
    ctx.emit({ type: 'prayer_answered', actor: 'player' });        // day/tick 自动补全
  },
});
```

## 核心概念

- **状态信封**：内核只要求世界状态满足最小信封 `EngineWorldState`
  （时间 / 天气 / 玩家位置与背包 / 实体表 / 声望 / 见闻录…）。应用状态以 TypeScript
  结构化类型满足信封即可，自有字段内核不感知、不触碰。
- **Command ≠ Event**：命令是意图（可被规则拒绝），事件是事实（只发布、可追溯）。
- **受控写入**：一切字段改写经 `mutate` 原语；AI 只能**建议**命令，永远拿不到直接写状态的口子。
- **事件总线**：单 tick 配额、critical 独立熔断、因果链（为什么可向上追溯）、
  同一处理器幂等、语义事件延后重投、死信队列与观察者、计划事件按世界日结算。
- **世界时钟**：逐刻推进、状态效果衰减、日边界与时辰边界发布事实；历法标签
  （月名 / 时辰名 / 纪年）与宿主钩子经配置注入。

## 多世界（WorldRegistry）

```ts
import { createWorldRegistry } from 'world-engine';

const registry = createWorldRegistry();
const a = registry.create({ worldId: 'alpha', playerName: 'A' });  // 强制隔离作用域
const b = registry.create({ worldId: 'beta',  playerName: 'B' });

a.executeCommand({ type: 'move', targetId: 'forest' });   // A、B 互不可见
registry.list();  registry.get('alpha');  registry.close('alpha');
```

隔离范围：事件总线与事件 id 序号（不变量测试强制）。随机源与调度器为进程级共享执行设施。
所有权与鉴权属部署层。

## HTTP API（`world-engine/http`）

```ts
import { startWorldServer } from 'world-engine/http';

await startWorldServer({
  createOptions: { worldId: 'w1' },
  registry: createWorldRegistry(),  // 可选：多世界模式
  port: 8787,                       // 缺省仅绑定 127.0.0.1
});
```

| 路由 | 说明 |
|---|---|
| `POST /v1/worlds` | 创建世界 |
| `GET /v1/worlds` · `GET /v1/worlds/{id}` | 清单 / 概要 |
| `GET /v1/worlds/{id}/state` | 完整世界状态 |
| `POST /v1/worlds/{id}/commands` | 提交命令（载荷白名单净化） |
| `GET /v1/worlds/{id}/events?n=20` | 最近世界事实 |
| `POST /v1/worlds/{id}/time` | 推进时间 |

## 生态包

### world-gateway — OpenAI 兼容网关 · 模型路由 · 多模型管线

SillyTavern / 任意 Agent 用标准 OpenAI 客户端即可接入。能力标签路由
（`fast / cheap / reasoning / roleplay / narrative / memory / embedding / …`），
厂商只出现在配置条目；多模型编排管线用 JSON 描述 DAG，失败隔离 + 预算熔断。
详见 [gateway/README.md](gateway/README.md)。

### world-memory — 角色记忆引擎

事实摄取按感知边界（只有目击者记得）、传闻保真衰减、逐日衰减遗忘、
词面 + 可注入向量检索、持久化端口。**只读世界事实流，绝不直接写世界状态**——
检索结果喂给 AI，AI 的意图经 Command 落地。详见 [memory/README.md](memory/README.md)。

闭环示例：[examples/second-game/memory-loop.test.ts](examples/second-game/memory-loop.test.ts)。

## 构建你自己的世界（Adapter）

应用只需实现**四件套**，而非修改内核：

1. **Entity Mapping** — 应用状态结构化满足状态信封；创角与读档工厂注入容器
2. **Rule Registration** — 玩法命令经 `registerRule` 挂载
3. **Data Mapping** — SavePort 介质 / 分片字段表 / 历法标签 / 事件分级表
4. **Event Mapping** — 事件分级与通道表注册

完整步骤与示例见 [docs/ADAPTER-GUIDE.md](docs/ADAPTER-GUIDE.md) 与 [examples/second-game](examples/second-game/second-game.test.ts)。

## 测试

```bash
npm test                # 内核 68 用例（含架构不变量扫描）
cd gateway && npm test  # 网关 24 用例（含真实 socket 端到端）
cd memory  && npm test  # 记忆 8 用例
```

`tests/integration.test.ts` 内置**架构不变量扫描**：内核源码若出现
React / Zustand / 任何厂商 LLM SDK / 任何应用引用，测试直接失败——
「内核不知道任何应用与模型存在」由机器保证，不靠约定。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/WORLD-ROADMAP.md](docs/WORLD-ROADMAP.md) | 版本路线图（逐版工作项与完成定义） |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 架构决策记录（DR-001–004） |
| [docs/ADAPTER-GUIDE.md](docs/ADAPTER-GUIDE.md) | 接入开发指南 |
| [docs/COMMAND-EVENT-CONTRACT.md](docs/COMMAND-EVENT-CONTRACT.md) | 命令—事件契约底册 |
| [docs/WORLD-DEPENDENCY-AUDIT.md](docs/WORLD-DEPENDENCY-AUDIT.md) | 模块依赖审计 |
| [docs/WORLD-EXTRACTION-REPORT.md](docs/WORLD-EXTRACTION-REPORT.md) | 工程报告（含各版验收附录） |
| [docs/WORLD-EXTRACTION-BLOCKERS.md](docs/WORLD-EXTRACTION-BLOCKERS.md) | 偏差与阻塞记录 |

## 版本

| 包 | 版本 | 状态 |
|---|---|---|
| world-engine | 1.0.0 | **Core 边界定型**：多世界隔离 + World Definition + Core/RPG 命令边界 |
| world-gateway | 0.7.0 | OpenAI 兼容网关 + 模型路由 + 编排管线 |
| world-memory | 0.8.0 | 独立角色记忆引擎 |

安全模型：HTTP 与网关默认仅绑定 127.0.0.1（无鉴权不外露）；LLM 端点是管理员配置的可信面，
密钥经环境变量引用、永不进入配置文件；出站 URL 与用户输入严格分离。

## 路线图

- **V0.1–V1.0 ✅**：独立内核 → 接入层 → SDK → HTTP → OpenAI 兼容网关 → 模型路由 → 多模型管线 → 记忆引擎 → 多世界隔离 → **Core 边界定型（World Definition / 泛化验证 / 第二世界类型实证）**（逐版完成定义见 [docs/WORLD-ROADMAP.md](docs/WORLD-ROADMAP.md)）
- **后续（平台运营，未排期）**：容器化部署 · 数据库持久化 · 账号与多租户 · 管理控制台 · 用量计费

> 游戏提供世界，World Engine 负责让世界运行——内核自己从不定义任何具体的世界。

# Engine API Contract · 公开接口契约（冻结版）

> 状态：**冻结（2026-10-06）**——依据《World-Engine-当前阶段功能收束与核心引擎化方案》Phase 5。
> 纪律：**1.0 起公开 API 只增不改**（破坏性变更只允许出现在下一个主版本）。
> 本文是"接入方视角"的最小稳定面承诺；实现细节以源码为准，冲突时以本文声明的兼容承诺为准。

---

## 一、什么算"公开 API"

| 层 | 载体 | 冻结等级 |
|---|---|---|
| TS 内核 API | `world-engine` 包 exports `.` 与 `./http` | **冻结（只增不改）** |
| 引擎 HTTP/WS | 8787 `/v1/*`（§三） | **冻结（只增不改）** |
| 平台公共面 | 8790 `/v1/worlds*` 透传 + 鉴权/计量语义 | **冻结** |
| 平台管理面 | 8791 `/v1/admin/*`、`/v1/obs/*`（§六） | Control Plane 部分冻结；**Extension 部分不冻结** |
| AI Extension 面 | gateway / memory / `/v1/chat/completions`、`/v1/embeddings`、evolution tick|intent | **不冻结**（Extension 各自演化，见 §七） |

命名纪律：新增端点/字段一律只增；改名、删除、语义变更走主版本。废弃流程：标记 `deprecated`（文档+响应头提示）≥ 一个次版本 → 主版本移除。

---

## 二、TS 内核 API（`world-engine`）

### 2.1 入口

```text
import { … } from "world-engine"        // 内核全量（含 adapter）
import { … } from "world-engine/http"   // 传输层 startWorldServer / ws（核心桶刻意不导出）
```

仅此两个子路径；`src/` 内部路径不是公开 API（examples/second-game 测试自证"import 内部路径即失败"）。

### 2.2 世界生命周期

- `createWorld(opts?: CreateWorldOptions<W>): WorldHandle<W>` —— 单世界装配；缺省规则装配 = coreRules + rpgCompat（**2.0 起 rpgCompat 改为 opt-in**，见 ENGINE-CORE-SCOPE §3.1）。
- `createWorldRegistry(): WorldRegistry` + `registry.createWorld(...)` —— 多世界注册表（每世界独立事件总线与 id 序号）。
- `hostGameWorld(registry, adapter: GameAdapter, opts?)` —— G1 契约：`GameWorldSeed`（worldId/name/ownerGame/playerName/startLoc/locations/npcs/relations/facts）→ 纯映射 → 建世界 + NPC 落位 + 关系网 + 种子事实。**只做数据映射，玩法由接入方 `registerRule` 挂载。**
- 生命周期操作：`WorldHandle.dispose()`；注册表模式经 HTTP `DELETE /v1/worlds/{id}`、`POST …/pause|resume`。

### 2.3 WorldHandle 方法面（冻结）

```ts
interface WorldHandle<W> {
  id: string;                      // 世界 id
  getState(): W | null;            // 全量状态快照
  query: WorldQuery<W>;            // 只读查询（引擎单一实现点）
  executeCommand(cmd: WorldCommand): CommandResult;  // 唯一写路径入口
  advanceTime(ticks: number): CommandResult;         // = advance_time 命令的便捷形式
  getEvents(n?: number): WorldEvent[];               // 最近 n 条事件
  registerRule(rule: WorldRule<W>): void;            // 规则挂载（接入方玩法入口）
  emitEvent(draft: EventEmit): WorldEvent;           // 宿主直接发布事实（走同一总线）
  setSavePort(port: SavePort<W>): void;              // 持久化端口（六边形；介质可替换）
  mutate: KernelMutate<W>;         // 受控写入原语（规则实现用；世界状态唯一写入点）
  clock: WorldClock<W>;            // 世界时钟（历法/时辰/新的一天事实）
  runtime: WorldRuntime<W>;        // Command→Rules→Mutation→Event 驱动循环
  container: WorldContainer<W>;    // 状态容器（唯一事实来源槽位 need()）
  applyDefinition(def: WorldDefinition): void;
  dispose(): void;
}
```

### 2.4 命令契约（冻结）

```ts
interface WorldCommand {
  type: string;        // snake_case 意图名
  commandId?: string;  // 幂等键：同键重复提交返回首次结果（HTTP 重试安全）
  actorId?: string;    // 谁做的
  targetId?: string;   // 对谁 / 到哪
  amount?: number;     // 数值参数（刻数 / 增量……）
  payload?: object;    // 其余参数
}
interface CommandResult { ok: boolean; … }
```

Core 规则命令集（`rules/coreRules.ts`，任何世界可用）：

| type | 语义 | 失败事件 |
|---|---|---|
| `create_entity` | 建实体（payload: id 必填，type/name/location/attributes 可选） | `entity_create_failed` |
| `remove_entity` | 删实体（级联清理悬空关系） | `entity_remove_failed` |
| `update_attribute` | 改属性（targetId='player' 改玩家；payload: key/value 一层基本类型） | `attribute_update_failed` |
| `set_relation` | 设关系边（source/target/值） | `relation_set_failed` |
| `move_entity` / `move` | 移动（targetId 或 actor 到 location） | `move_failed` |
| `advance_time` | 时间推进（amount = 刻数；规则层有同口径上限钳制） | `time_advance_clamped` |
| `change_weather` | 天气 | `weather_change_failed` |

RPG 兼容命令（`rules/rpgCompat.ts`，自标 EXTENSION，非 Core 承诺）：`attack` / `talk` / `set_attitude` / `spawn_entity`。

### 2.5 事件契约（冻结）

- 事件结构：`WorldEvent { id: 'evt_<day>_<seq>', type, level(1|2), channel, ts?, cause?, actorId?, targetId?, data, chain? }`（`events/EventSchema.ts` 为准）。
- **事件类型表是宿主可扩展注册表**（`registerEventTables({levels, channels})`），不是固定枚举——游戏专属事件（如剧情事件）由接入方注册，**Core 不预置任何游戏语义事件**。
- Core 规则会发出的类型（underscore 风格，冻结）：`entity_created / entity_updated / entity_removed / entity_moved / player_moved / relation_set / time_advanced / time_advance_clamped / weather_changed` 及对应 `*_failed`。
- 总线保证：每世界独立 scope、seq 单调、溯源链（traceChain）可追、限流（MAX_EVENTS_PER_TICK）与防环（MAX_CHAIN_DEPTH）。

### 2.6 时间与历法（冻结）

- 常量：`CHEN_PER_DAY=48`、`DAYS_PER_YEAR=360`（12 月×30 日）、`TICKS_PER_YEAR`、`START_AGE`。
- `WorldClock`：`advanceTime` 发布 `time_advanced` / 跨时辰 / 新的一天事实；`shichenOf / dayOfTick / periodSeg / TICKS_PER_HOUR`。第二游戏可用自己的历法（Data Mapping / labels 覆盖，见 examples/second-game）。

---

## 三、引擎 HTTP/WS 面（8787，冻结）

鉴权：装配 `auth` 钥匙表后全路由 401 闸门，`Bearer <key>`；读 = `worlds:read`，写（commands/time/pause/resume/create/close）= `worlds:write`；越权返回 **404**（不泄露存在性）。

| 方法 | 路径 | 语义 |
|---|---|---|
| POST | `/v1/worlds` | 创建世界（注册表模式） |
| GET | `/v1/worlds` | 世界清单 |
| GET | `/v1/worlds/{id}` | 世界信息 |
| DELETE | `/v1/worlds/{id}` | 关闭世界 |
| POST | `/v1/worlds/{id}/pause` · `/resume` | 软暂停 / 恢复（暂停中拒绝 time 推进，409 `world_paused`；读不受影响） |
| GET | `/v1/worlds/{id}/state` | 全量状态 |
| GET | `/v1/worlds/{id}/events` | 事件史查询（`?n=`） |
| POST | `/v1/worlds/{id}/commands` | 提交命令（`commandId` 幂等；body = WorldCommand） |
| GET | `/v1/worlds/{id}/commands` | 命令日志 |
| GET | `/v1/worlds/{id}/scheduler` | 调度器视图（`?`查询参数过滤） |
| GET | `/v1/worlds/{id}/entities` | 实体清单（query 过滤） |
| GET | `/v1/worlds/{id}/entities/{eid}` | 实体详情 |
| GET | `/v1/worlds/{id}/locations` | 地点表 |
| GET | `/v1/worlds/{id}/relations` | 关系网 |
| POST | `/v1/worlds/{id}/time` | 时间推进 `{"ticks": n}`（缺省单次上限 1440 刻，`init.maxTicksPerAdvance` 可覆盖） |
| WS | `/v1/worlds/{id}/events/stream` | 单世界事实流（`?replay=N` 断线补发，30s 心跳判死） |
| WS | `/v1/stream` | 全部可见世界事实流 |

错误语义：401 未鉴权 / 403 无权限 / 404 不存在或越权 / 405 方法不允许 / 409 世界暂停冲突 / 400 参数错误。

---

## 四、平台公共面（8790，冻结部分）

- `GET /healthz`：免鉴权探活。
- `/v1/worlds`、`/v1/worlds/{id}/...`：**引擎权威透传** + API Key 鉴权 + 租户隔离（清单按 `ownerGame` 过滤、建世界强制归属盖章、非归属世界 404）+ 每请求计量。语义与引擎原面一致，客户端只需替换 base URL 与钥匙。
- Admin 前缀在公共口一律 **501**（管理面只在私有口）。

---

## 五、事件流语义（跨引擎/平台，冻结）

- 推送的事件即 §2.5 的 WorldEvent 结构；`replay=N` 从最近 N 条补发；心跳 30s；多代世界重建自动检测（世界 seed 指纹）。
- 事件消费纪律（接入方）：消费端自行幂等去重（参考 `platform/src/evolution/consumer.ts` 的公共件模式）。

---

## 六、平台私有管理面（8791；Control Plane 部分 = 冻结，Extension 部分 = 不冻结）

鉴权：`x-admin-token`（主令牌）或会话令牌（`POST /v1/admin/session/login`，角色 admin/operator/viewer + 权限码）。

**Control Plane（冻结）**：

| 组 | 端点 |
|---|---|
| Keys | `GET/POST /v1/admin/keys`；`PUT/DELETE /v1/admin/keys/:id` |
| 用量 | `GET /v1/admin/usage` |
| 会话 | `POST /v1/admin/session/login|refresh-token|logout`；`GET /v1/admin/session/me` |
| 用户/权限/设置 | `GET/POST /v1/admin/system/users`；`PUT /v1/admin/system/users/:id`；`GET /v1/admin/system/permissions`；`GET/PUT /v1/admin/system/settings[/:key]` |
| 观测 | `GET /v1/obs/logs`；`GET /v1/obs/errors`；`GET /v1/obs/events`；`GET /v1/obs/overview` |
| NPC 日程 | `GET/PUT/DELETE /v1/npc/worlds/:id/schedules`（确定性零 AI，写需 gateway:manage 权限码） |
| 运行时总览 | `GET /v1/admin/runtime` |

**Extension 面（不冻结，随 AI Extension 演化）**：`/v1/admin/model-config*`、`/v1/admin/providers/:id/credential`、`/v1/admin/models/:id/test`、`/v1/admin/routes/:capability(/test)`、`/v1/admin/pipelines(/test)`、`POST /v1/evolution/worlds/:id/tick`、`POST /v1/evolution/worlds/:id/intent`、`GET /v1/evolution/worlds/:id/runs|trace`。Admin Web 已不再为这些端点提供产品入口（Control Plane 收束）。

---

## 七、AI Extension 面（明确不冻结）

以下面属于 Extension，各自独立演化、独立升级，不承诺稳定：

- `world-engine/gateway`（world-gateway）：OpenAI 兼容 `/v1/chat/completions`（含 SSE）、`/v1/models`、`/v1/embeddings`。
- `world-engine/memory`（world-memory）：`/v1/memory/stores|records|retrieval|embedding`（只读+检索）。
- 平台公共口 AI 路由：`GET /v1/models`（仅 `world-agent` 虚拟模型）、`POST /v1/chat/completions`、`POST /v1/embeddings`。
- 天穹会话协议：8797 `/game/*`（游戏方自有协议，归游戏方）。

**纯托管部署承诺**（ENGINE-CORE-SCOPE §五）：不装配 Extension 时，§二～§六的冻结面完整可用；`/v1/chat/completions`、`/v1/embeddings`、`/v1/models` 不注册。

---

## 八、兼容性案例速查

| 变更 | 是否允许 | 通道 |
|---|---|---|
| 新增事件类型（宿主注册） | ✅ 随时 | registerEventTables |
| 新增命令 type（接入方 registerRule） | ✅ 随时 | 接入方自有规则 |
| 新增只读端点 / 查询参数 | ✅ 次版本 | 只增 |
| 新增 WorldHandle 方法 | ✅ 次版本 | 只增 |
| 修改既有字段语义 / 删除端点 / 改默认行为 | ❌ | 仅主版本 |
| rpgCompat 退出缺省装配 | 已排期 | 2.0（提前公告） |

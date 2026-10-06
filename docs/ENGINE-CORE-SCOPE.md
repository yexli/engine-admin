# Engine Core Scope · 内核范围裁定

> 状态：**已定稿（2026-10-06），即日起生效**
> 依据：《World-Engine-当前阶段功能收束与核心引擎化方案》Phase 2；事实基础见 `ENGINE-SCOPE-AUDIT.md`。
> 本文是**边界宪法**：之后任何新功能先对照本文裁定归属，再动代码。

---

## 一、一句话边界

> **World Engine 负责决定"世界客观上发生了什么"；凡不决定世界事实的东西，一律不进 Core。**

四条硬边界（现状已满足，长期保持）：

1. Core 不依赖 LLM / AI Memory / Narrative / 模型网关——不 import、不配置、不留钩子之外的任何耦合；
2. Core 的唯一写入路径是 `Command → Rules → Mutation`，任何来源（人、AI、Admin、脚本）在 Core 眼里只是命令发起方；
3. Core 不出现任何游戏专属语义词（ NPC 名、剧情事件、玩法规则）；
4. Core 的依赖只有 node 内建模块（当前零 npm dependencies）。

---

## 二、Core 内部结构（必须保留）

以下模块构成 Core 的完整闭环，**全部保留，且公开 API 冻结（1.0 起只增不改）**：

```text
world-engine/src/
├── state/        WorldState 容器 / WorldDefinition / Shards 分片
├── state/        storage.ts (SavePort 端口) + fileStorage.ts (FileSavePort 介质)
├── time/         TimeBase 历法常量 + WorldClock 世界时钟
├── events/       EventSchema 事件结构 + WorldEventBus 总线
├── command/      Command 契约（意图 ≠ 事实）
├── rules/        Rules.ts 契约 + coreRules.ts Core 规则
├── mutate/       WorldMutate 唯一写入实现点
├── runtime/      WorldRuntime 驱动循环（Command→Rules→Mutation→Event）
├── api/          WorldAPI / WorldQuery / WorldRegistry
├── adapter.ts    GameAdapter 契约（GameWorldSeed → WorldDefinition 纯映射）
├── http/         HTTP 协议层 + RFC6455 WebSocket 事件流（子路径导出，核心桶不导出）
├── types.ts / rng.ts / scheduler.ts
```

配套守卫（必须保留并持续生效）：

- `tests/integration.test.ts` 的两个源码扫描守卫（禁 LLM 关键词、禁 gateway/memory 依赖）；
- 零依赖纪律（package.json 不新增 dependencies）；
- `docs/COMMAND-EVENT-CONTRACT.md`、`CORE-BOUNDARY-AUDIT.md` 等既有边界文档。

---

## 三、模块处置总表

裁定口径：**保留**＝留在 Core 并冻结 API；**Extension**＝独立包或平台侧模块，Core 不依赖；**移出 Core**＝当前在 Core 位置但归属错误（列改造路径与目标版本）；**删除**＝确认无调用者的死代码。

### 3.1 world-engine 主包

| 模块 | 裁定 | 说明 |
|---|---|---|
| `src/` 全部（§二清单） | **保留** | Core 本体，API 冻结 |
| `src/rules/rpgCompat.ts`（attack/talk/set_attitude/spawn_entity） | **移出 Core（2.0）** | 自标 EXTENSION 的玩法语义，当前经 `runtime/BuiltinRules.ts` 缺省装配进 createWorld。因 1.x API 冻结暂不动行为；**2.0 起改为显式 opt-in**（createWorld 不再默认装配，接入方按需传入）。届时属 **非 AI 玩法扩展**，非删除 |
| `src/adapter.ts` | **保留** | 数据映射不含玩法语义，是 D 类契约本体 |
| `src/http/`（含 ws） | **保留** | 传输层，子路径隔离不污染核心桶 |
| `tests/`、`examples/` | **保留** | examples/second-game 是"第二游戏接入"的引擎侧证据链 |
| `docs/`（内核 12 篇） | **保留** | 含四分类底册 `CORE-EXTENSION-CLASSIFICATION.md` |

### 3.2 world-engine/gateway（AI 网关）

| 裁定：**Extension（独立包长期演化）** |
|---|
| 与主包零代码依赖，允许独立升级/独立不装。产品上不是 Core 的一部分；README/文档不再把它表述为引擎能力。当前阶段**冻结新功能**（方案 §二十：LLM Provider / 模型选择类不再加需求）。 |

### 3.3 world-engine/memory（角色记忆）

| 裁定：**Extension（独立包长期演化）** |
|---|
| 同上；向量检索仅以可注入 EmbeddingService 形式存在，属正确的端口化设计。AI Memory 不回 Core（方案 §八）。 |

### 3.4 platform

| 模块 | 裁定 | 说明 |
|---|---|---|
| `keys/`、`auth.ts`、`http/protocol.ts`（/v1/worlds 透传+隔离+计量段）、`usage/`、`config.ts` | **保留（C 类）** | 托管平台本体 |
| `schema/worldSchema.ts` | **保留（D 类）** | 游戏↔世界契约，双游戏实践产物 |
| `npc/`（scheduler/state/schedule/scheduleStore/profile/calendar） | **保留（B/D 类）** | 确定性零 AI 的 NPC 世界状态机制，属"世界客观状态" |
| `runtime/fingerprint.ts` | **保留（B 类）** | 世界代际自愈基础设施，AI/NPC/Memory 循环共用 |
| `evolution/`（15 文件） | **保留为 Extension（E 类）** | 不删（方案 §十），正式定名为 AI 扩展运行时；其宿主装配入口（run-managed.mjs / managed-runtime.ts）必须支持**整体不装配** |
| `worldagent/`、`router/`、`tasks.ts` | **保留为 Extension（E 类）** | 同上 |
| `upstream/engine.ts` | **保留（A 镜像面）** | 引擎 HTTP 客户端 |
| `upstream/gateway.ts`、`embeddings.ts` | **保留为 Extension（E 类）** | AI 出站唯一通道 |
| `memory/service.ts`、`memory/runtime.ts` | **保留为 Extension（E 类）** | 记忆联动（摄取循环零 AI 本体） |
| `admin/http.ts` 等管理面 | **保留（G 类）** | 但 AI 管理端点（model-config/pipelines/evolution tick|intent）随 Extension 定位标记为 extension-surface，纯托管部署不暴露 |
| `admin/managed-runtime.ts`、`model-config.ts`、`vendors.ts`、`secrets.ts`、`pipelines.ts` | **保留为 Extension（E 类）** | 受管模型控制面 |
| `evolution/perspective.ts`、`journal.ts`、`npc/profile.ts` | **保留（G 只读投影）** | 观测面 |

### 3.5 admin-web

| 模块 | 裁定 | 说明 |
|---|---|---|
| Dashboard / worlds / runtime 全部 / observability(logs,events,errors) / system 四页 / keys、games | **保留（G 类）** | Control Plane 完整面（方案 §十五） |
| evolution 控制台、gateway providers/models/router/pipelines、memory 四页、observability/ai-calls、gateway/usage 页 | **删除（本轮 Phase 4/6 执行）** | AI 产品页，与 Control Plane 定位冲突；后端 Extension API 不受影响，仅 Admin 不再提供产品入口 |
| `api/evolution.ts`、`api/memory.ts`、`api/modelControl.ts`、`api/pipeline.ts`、`composables/useModelControl.ts`、`tests/modelControl.test.ts` | **删除** | 随页面移除的孤儿客户端代码 |
| Dashboard AI 卡片、system/status 的 memory/gateway 探测 | **移除对应卡片/探测项** | 页面本体保留 |

### 3.6 tianqiong（游戏侧，登记不在本轮处理）

| 残余 | 裁定 |
|---|---|
| `file: ../world-engine` 机制库依赖（7 文件 import） | 游戏侧长期项：宿主与客户端共享源码 + 外部化逃生门。目标形态为游戏只经 HTTP 接入；由游戏方择期收敛，**引擎侧不为此改动** |
| `world-gateway` link 依赖（game-host AI 三档装配） | 合规：游戏自持 AI 属 F 类职责 |
| `scripts/world-host.mjs:7` stale 注释 | 修正指向（本轮顺手完成） |

### 3.7 scripts / deploy

| 项 | 裁定 |
|---|---|
| `scripts/run-demo-engine|run-demo-memory|run-g2-demo|run-g3-demo|run-trade-host|run-p12-walkthrough|keyctl` | 保留（引擎/托管验证） |
| `scripts/run-evolution-demo.mjs`、`platform/scripts/run-managed.mjs`、e2e-deepseek/fake-upstream 等 AI 脚本 | 保留为 Extension 演示/诊断工具；**不进纯托管部署路径** |
| `platform/scripts/dev-stack.mjs` | 保留；纯托管形态另给最小栈（见 §五） |
| `deploy/docker-compose.yml` | 保留现状（受管全栈）；纯托管 compose 变体在需要时新增，不改现有 |

---

## 四、冻结清单（方案 §二十，即刻生效）

自本文定稿起，以下方向**不再接受任何新增需求**，除非先修订本文并重新定性为独立 Extension：

```text
❌ NPC AI / NPC 自动思考          ❌ Narrative / AI Story
❌ AI World Evolution 新能力       ❌ Prompt 管理
❌ LLM Provider / Embedding Provider  ❌ AI Memory
❌ AI NPC Console / AI 推进世界    ❌ AI 自动事件
```

Core 侧的"允许清单"（继续做）：性能、稳定性、可观测、持久化可靠性、多租户隔离、API 兼容地补齐通用原语（时间/调度/规则/事件）。

---

## 五、部署形态裁定

| 形态 | 组成 | AI 组件 |
|---|---|---|
| **纯托管（Core Hosting）** | world-engine + platform（C/B/D 类）+ Admin(Control Plane) | **零 AI**：gateway/memory 不装配、evolution/worldagent/router 不装配、/v1/chat/completions 与 /v1/embeddings 不注册 |
| **受管全栈（现 dev-stack / compose）** | 纯托管 + Extension（evolution/worldagent/router/memory 联动 + 受管网关） | 全量 |

验收标准即方案 §二十二 Core 组：**关闭全部 AI 组件，引擎与托管面照常运行**。该形态由 platform 装配入口（`run-managed.mjs` 的组合根）以"不装配"实现，不需要新增运行时开关；后续若需要进程级开关，按"只增不改"补显式配置项。

---

## 六、修订流程

本文修订即边界变更，必须：① 写明变更模块与理由；② 过一遍 §四冻结清单确认不冲突；③ 涉及公开 API 的走"只增不改"，破坏性变更只允许出现在下一个主版本（如 2.0 的 rpgCompat opt-in）；④ 更新 `ENGINE-SCOPE-AUDIT.md` 对应条目。

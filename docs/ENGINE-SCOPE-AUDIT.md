# Engine Scope Audit · 引擎功能范围审计

> 状态：**已定稿（2026-10-06）**
> 依据：《World-Engine-当前阶段功能收束与核心引擎化方案》Phase 1 / Phase 3
> 方法：四路并行全仓扫描（引擎内核 / platform / admin-web / tianqiong+scripts+docs），逐文件盘点 + import 依赖追溯 + 关键词扫描（llm / openai / anthropic / model / embedding / memory / gateway / narrative / prompt / ai）。
> 本文档只盘点与裁定，**不做任何删除**；处置结论输入 `ENGINE-CORE-SCOPE.md`。

---

## 一、总体结论

1. **引擎内核已经是无 AI 的。** `world-engine/src/`（28 文件，约 4,514 行）非相对 import 仅有 `node:http/crypto/stream/fs/path`，零第三方依赖；AI 关键词在代码层零命中（命中均为注释中的边界声明或命名巧合，如 `InMemoryWorldStorage` 的"内存介质"）。该约束不是口头约定——`world-engine/tests/integration.test.ts` 内置两个源码扫描守卫：禁止 `openai|deepseek|qwen|anthropic|gemini`，禁止内核 import `gateway|memory` / `world-gateway` / `world-memory`。
2. **AI 能力已全部位于内核之外**，集中在三处：`world-engine/gateway/`（AI 网关独立包）、`world-engine/memory/`（角色记忆独立包）、`platform/src/`（演化运行时 / 模型路由 / worldagent / 记忆联动 / 受管模型控制面）。
3. **三包代码层完全平行**：主包不引用 gateway/memory，gateway 与 memory 也不引用主包。仅 monorepo 测试层（`examples/second-game/memory-loop.test.ts`）与禁止性守卫（`tests/integration.test.ts`）同时触达。
4. **当前真正的收束对象不是引擎内核，而是平台面与 Admin 面**：
   - `platform`（0.25.2，53 文件约 10,164 行）中约 2/3 的模块属于 AI Extension，与纯托管功能（Key/租户/计量/透传）混在同一进程、同一管理面之下；
   - `admin-web` 约 40% 的页面是 AI 产品功能（演化控制台、AI 网关四页、记忆库四页、AI 调用观测），与"Control Plane"定位冲突。
5. **游戏侧已默认外部化**：tianqiong 客户端默认走 HTTP/SSE 外部会话宿主（8797/8798），断线不回落本地引擎；残余的 `file: ../world-engine` 进程内依赖仅作为机制库与逃生门保留。

---

## 二、包级地图

| 包 | 版本 | 体量 | 定位判定 |
|---|---|---|---|
| `world-engine/` | 1.4.1 | src 28 文件 / 4,514 行；tests 17 文件 / 140 用例 | **A. Engine Core**（含 B. Runtime、D. Adapter） |
| `world-engine/gateway/` | 0.7.2 | 9 文件 / 1,405 行；6 测试文件 | **E. AI Extension**（OpenAI 兼容网关 / 模型路由 / 多模型管线） |
| `world-engine/memory/` | 0.9.0 | 6 文件 / 838 行；2 测试文件 | **E. AI Extension**（角色记忆引擎，向量检索可注入） |
| `platform/` | 0.25.2 | src 53 文件 / 10,164 行；tests 33 文件 / 约 371 用例 | **C. Platform/Hosting + B. 消费型 Runtime + E. AI Extension + G. Admin 面** 混合体 |
| `admin-web/` | 6.x | 约 185 源文件 | **G. Admin Control Plane**（混入 AI 产品页，待收缩） |
| `tianqiong/` | 独立项目 | 游戏客户端 + 会话宿主 | **F. Narrative / Game Logic**（已默认外部接入） |
| `scripts/`、`platform/scripts/`、`deploy/` | — | 演示/验收/部署脚本 | 混合（含 AI 演示脚本） |
| `docs/` | — | 29 篇 | 规划 / 验收 / 审计记录 |

---

## 三、A–G 分类总表

### A. Engine Core（世界状态 / 规则 / 命令 / 事件 / 时间 / 调度 / 持久化）

全部位于 `world-engine/src/`：

| 模块 | 文件 | 职责 |
|---|---|---|
| 状态容器 | `state/WorldState.ts`(145)、`state/WorldDefinition.ts`(98)、`state/Shards.ts`(51) | 唯一事实来源槽位 / 世界定义 / 存档分片 |
| 持久化 | `state/storage.ts`(69)、`state/fileStorage.ts`(228) | SavePort 端口 + FileSavePort 介质（写后置+原子写+损坏备份） |
| 时间 | `time/TimeBase.ts`(23)、`time/WorldClock.ts`(208) | 48 刻/日历法 + 世界时钟（跨时辰/新的一天事实） |
| 事件 | `events/EventSchema.ts`(199)、`events/WorldEventBus.ts`(320) | 事件标准结构 / 可追溯防环限流总线 |
| 命令 | `command/Command.ts`(44) | WorldCommand / CommandResult（意图与事实分离） |
| 规则 | `rules/Rules.ts`(62)、`rules/coreRules.ts`(263) | 规则契约 + Core 规则（实体/关系/移动/时间/天气） |
| 变更 | `mutate/WorldMutate.ts`(227) | 世界状态唯一写入实现点 |
| 运行时 | `runtime/WorldRuntime.ts`(205)、`runtime/BuiltinRules.ts`(38) | Command→Rules→Mutation→Event 驱动循环 |
| API 面 | `api/WorldAPI.ts`(382)、`api/WorldQuery.ts`(81)、`api/WorldRegistry.ts`(62) | createWorld / 查询 / 多世界注册表 |
| 基础件 | `types.ts`(150)、`rng.ts`(48)、`scheduler.ts`(32) | 类型宪法 / 可注入随机源 / 定时器抽象 |

### B. Engine Runtime（tick / 调度循环）

- 引擎侧：`world-engine/src/runtime/`（WorldRuntime 驱动循环）、`src/scheduler.ts`、`src/time/`。
- 平台侧消费型循环（非引擎 tick 本体）：`platform/src/memory/runtime.ts`（记忆摄取循环，零 AI 本体）、`platform/src/npc/scheduler.ts`（NPC 日程对齐循环，确定性零 AI）、`platform/src/evolution/triggerRuntime.ts`（AI 触发循环，**属 E**）、`platform/src/evolution/concurrency.ts`（tick 串行锁）、`platform/src/runtime/fingerprint.ts`（世界代际指纹，AI/NPC/Memory 三个循环共用）。

### C. Platform / Hosting（Key / 租户 / 计量）

| 模块 | 文件 | 职责 |
|---|---|---|
| Key 存储 | `platform/src/keys/keystore.ts`(211) | API Key 哈希落盘 / bootstrap 主密钥 |
| 鉴权 | `platform/src/auth.ts`(75) | Bearer 401/403 语义 |
| 公共协议 | `platform/src/http/protocol.ts`(421)、`http/server.ts`(214) | `/v1/worlds*` 引擎权威透传 + 租户隔离盖章 + 每请求计量 |
| 计量 | `platform/src/usage/recorder.ts`(140)、`usage/query.ts`(145) | JSONL 用量面（不落 Prompt 原文） |
| 配置 | `platform/src/config.ts`(107) | 环境变量 → PlatformConfig |

### D. Game Adapter（游戏 schema ↔ 世界 schema）

| 模块 | 文件 | 职责 |
|---|---|---|
| 适配器契约 | `world-engine/src/adapter.ts`(164) | GameWorldSeed → WorldDefinition 纯映射 + hostGameWorld 装配（只做映射，玩法由接入方 registerRule） |
| 世界 Schema | `platform/src/schema/worldSchema.ts`(195) | 通用 World Schema v1.0：6 规范属性键（writtenBy host/ai 归属）、游戏键命名纪律、符合性检查 |
| 日程数据 | `platform/src/npc/scheduleStore.ts`(117) | 游戏日程表注册（数据形态，非逻辑） |
| 消费公共件 | `platform/src/evolution/consumer.ts`(86) | 游戏宿主事件消费（幂等去重+分级） |
| 每世界围栏 | `platform/src/evolution/policy.ts`(80) | policyFor 按世界差异化围栏（P14 Extension 层，**服务对象是 E**） |

### E. AI Extension（AI 网关 / 演化 / 记忆 / 模型路由）

**独立包（平行，无反向依赖）：**

| 包 | 内容 |
|---|---|
| `world-engine/gateway/` | wire（OpenAI 线格式+SSE）、protocol、provider（六能力角色）、router（模型路由）、remote（fetch 出站）、routedProvider、pipeline（Multi-Model DAG）、server |
| `world-engine/memory/` | engine（4 因子召回+衰减遗忘）、types、storage、http（只读+检索协议） |

**platform 内（AI Extension 宿主侧）：**

| 模块 | 文件 | 职责 |
|---|---|---|
| 演化运行时 | `platform/src/evolution/`（15 文件，约 2,546 行）：runtime / types / context / driver / triggerRuntime / wake / journal / commands / ledger / observation / perspective / policy / consumer / index / concurrency | 观察→AI 提案→三层围栏→Rules 终审→落账；OOC/Narrative 永不成为世界事实；LLM 调用位在 `driver.ts` |
| 模型路由 | `platform/src/router/modelrouter.ts`(117)、`tasks.ts`(53) | capability→{primary,fallback}；任务分析（确定性） |
| worldagent | `platform/src/worldagent/pipeline.ts`(181)、`context.ts`(86) | `world-agent` 虚拟模型管线（世界上下文→路由→网关） |
| 出站客户端 | `platform/src/upstream/gateway.ts`(116)、`embeddings.ts`(123) | chat/proxyChat、RoutedEmbeddingService（平台全部模型出站都在 upstream，无直连厂商 SDK） |
| 记忆联动 | `platform/src/memory/service.ts`(321)、`runtime.ts`(202) | world-memory 按世界装配；摄取循环（零 AI 本体） |
| 受管模型控制面 | `platform/src/admin/managed-runtime.ts`(518)、`model-config.ts`(595)、`vendors.ts`(182)、`secrets.ts`(148)、`pipelines.ts`(115) | 网关+平台组合根、版本化模型配置、思考强度适配、凭证加密库、管线只读存储 |

### F. Narrative / Game Logic（游戏专属语义）

- **platform 刻意不含**（OOC/叙事在 `evolution/runtime.ts dispatchIntent` 被结构化隔离；游戏语义只以数据形态出现）。
- **tianqiong（游戏方职责，全部合规留在游戏侧）**：
  - `tianqiong/src/ai/*`：openaiCompat / ruleSim / persona / promptPreset / WorldReasoner / ConsequencePlanner / ContextBuilder / llmConfig / streaming；
  - `tianqiong/src/world/Narration.ts`、`NarrativeContext.ts`（叙事编织，恒为客户端表现层）；
  - `tianqiong/src/data/*`（世界书/对话/地区数据）、`src/systems/*`（24 个玩法系统）、`src/memory/*`（角色记忆全栈）。

### G. Admin Control Plane

- **platform 侧**：`admin/http.ts`(1,439，私有 loopback 管理监听)、`permissions.ts`、`sessions.ts`、`users.ts`、`settings.ts`、`errors.ts`；只读投影另有 `evolution/perspective.ts`、`evolution/journal.ts`、`npc/profile.ts`。
- **admin-web 侧**：详见 §六页面盘点。

---

## 四、依赖审计（Phase 3）

### 4.1 目标方向核对：`Core → AI` 必须为零

| 检查项 | 结果 |
|---|---|
| `world-engine/src` import AI/LLM/SDK 包 | **零**（非相对 import 仅 node 内建） |
| `world-engine/src` import gateway/memory 包 | **零**，且被 `tests/integration.test.ts` 源码扫描守卫永久封死 |
| `world-engine` package.json dependencies | **零** |
| gateway/memory 反向 import 主包 | **零**（三包平行，靠约定形状对接） |
| 引擎 CHANGELOG 是否有 AI 功能条目 | 无（全部为内核/HTTP/存档/不变量条目） |

**结论：`Core → AI` 已经归零且受测试固化；`AI → Core API` 单向数据流成立**（AI 建议只能落成 Command 经 Rules 校验进 Mutation；memory 只消费世界事实流）。

### 4.2 platform 的依赖关系

- platform 不直接依赖 world-engine 主包——引擎一律经 HTTP（`upstream/engine.ts` EngineClient）对话，进程边界即权限边界。
- platform 对外依赖仅两个 link：`world-gateway`（仅 `admin/managed-runtime.ts`、`admin/model-config.ts`、`admin/pipelines.ts` 引用）与 `world-memory`（仅 `memory/service.ts` 引用）。
- **C 类模块（keys/usage/http 透传）不 import 任何 E 类模块**；反向是 E 类经公共协议挂载。唯一的混合点是 `http/protocol.ts` 同时挂了 `/v1/worlds*`（C）与 `/v1/chat/completions`、`/v1/embeddings`（E）——托管面与 AI 面共享一个 HTTP 入口，属**可接受的组合根耦合**，但需要在部署形态上支持"纯托管模式"（见 ENGINE-CORE-SCOPE.md §五）。

### 4.3 tianqiong 的残余耦合（登记，不在本轮处理）

| 残余 | 位置 | 性质 |
|---|---|---|
| `file: ../world-engine` 进程内依赖 | `tianqiong/package.json` | 机制库四件套（EventBus/WorldState/WorldMutate/WorldClock 等 7 文件 import），为宿主与客户端共享源码 + 逃生门（`VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE=false`） |
| `world-gateway` link 依赖 | `tianqiong/package.json`、`server/game-host.ts:49` | 游戏侧 AI 三档装配（gateway 档 > 客户端转发档 > ruleSim 兜底），属游戏方自持 AI，不违反引擎边界 |
| 参考宿主依赖 `platform/dist` | 根 `scripts/run-tianqiong-host.mjs:12` | 演示脚本，非产品路径 |
| stale 注释 | `tianqiong/scripts/world-host.mjs:7` 指向已不存在的 `src/world-engine/adapter/tianqiongSeed.ts` | 文档性瑕疵，实际种子在 `scripts/lib/tianqiong-seed.mjs` |

### 4.4 AI 出站路径唯一性

平台无任何直连厂商 SDK；全部模型出站收敛为：`upstream/gateway.ts` chat / `upstream/embeddings.ts` embed（fetch 网关）与 `admin/managed-runtime.ts`（受管进程内网关）。模型身份（DeepSeek/GLM/Kimi/Qwen 思考强度适配在 `admin/vendors.ts`）对调用方不可见，客户端只认识 `world-agent` 虚拟模型与 13 个能力词表。

---

## 五、HTTP 面盘点

### 5.1 引擎（8787，`world-engine/src/http/protocol.ts` + `ws.ts`）——全部属 Core，无 AI

| 方法 | 端点 | 说明 |
|---|---|---|
| POST | `/v1/worlds` | 创建世界 |
| GET | `/v1/worlds` | 世界清单 |
| GET / DELETE | `/v1/worlds/{id}` | 世界详情 / 关闭 |
| POST | `/v1/worlds/{id}/pause` · `/resume` | 软暂停 / 恢复 |
| GET | `/v1/worlds/{id}/state` | 全量状态 |
| GET | `/v1/worlds/{id}/events` | 事件史查询 |
| POST / GET | `/v1/worlds/{id}/commands` | 提交命令（幂等）/ 命令日志 |
| GET | `/v1/worlds/{id}/scheduler` | 调度器视图 |
| GET | `/v1/worlds/{id}/entities` · `/entities/{eid}` | 实体清单 / 详情 |
| GET | `/v1/worlds/{id}/locations` | 地点表 |
| GET | `/v1/worlds/{id}/relations` | 关系网 |
| POST | `/v1/worlds/{id}/time` | 时间推进（`{ticks}`，上限钳制） |
| WS | `/v1/worlds/{id}/events/stream`、`/v1/stream` | 单世界 / 全局事实流（`?replay=N`） |

### 5.2 平台公共面（8790，`platform/src/http/protocol.ts`）

| 端点 | 分类 |
|---|---|
| GET `/healthz` | C（免鉴权探活） |
| GET `/v1/models` | E（只暴露 `world-agent` 虚拟模型） |
| POST `/v1/chat/completions` | E（world-agent 管线 / 网关保真代理，含 SSE） |
| POST `/v1/embeddings` | E（Router 单源选模） |
| `/v1/worlds`、`/v1/worlds/{id}/...` | C（引擎权威透传 + 租户隔离 + 计量） |
| `/v1/admin/*`（公共口） | 一律 501（真实管理面在私有端口） |

### 5.3 平台私有管理面（8791，`platform/src/admin/http.ts`）

- **纯 Control Plane**：keys 全套、`/v1/admin/usage`、session 全套、`system/users|permissions|settings`、`/v1/npc/worlds/:id/schedules`（日程注册，确定性执行）、`/v1/obs/logs|errors`、`GET /v1/evolution/worlds` 与 `runs|trace`（只读账本投影）。
- **AI 绑定**：`model-config` 全套（GET/PUT/rollback/credential/test）、`routes/:capability(/test)`、`pipelines(/test)`、`POST /v1/evolution/worlds/:id/tick`（AI 演化闭环）、`POST .../intent`（OOC 隔离闸）、`/v1/obs/overview|events`（聚合含 AI 调用统计）、`GET /v1/admin/runtime`（聚合 Evolution/Memory/NPC 状态）。

### 5.4 记忆服务（8789）与网关（受管内嵌 / 可独立 8788）

- 记忆：`world-engine/memory/src/http/protocol.ts`（只读 stores/records/retrieval/embedding）——**E**。
- 网关：`world-engine/gateway/src/server.ts`（OpenAI 兼容 `/v1/chat/completions|models|embeddings`）——**E**。

---

## 六、admin-web 页面盘点与处置建议

### 6.1 Control Plane（保留）

| 页面 | 端点 | 处置 |
|---|---|---|
| Dashboard 总览 | `/control-api/v1/obs/overview`、`/world-api/v1/worlds` | 保留；**裁剪 AI 用量卡** |
| 世界列表 / 世界详情 | `/world-api/v1/worlds(+/:id/time|pause|resume)` | 保留（"推进时间"按钮走引擎 Command API，属引擎时钟，**保留**） |
| Runtime 状态/实体/地点/关系/事件 | `/world-api/v1/worlds/:id/state|entities|locations|relations|events` | 保留 |
| Runtime 命令调试台 | `POST/GET /world-api/v1/worlds/:id/commands` | 保留（admin/operator） |
| Runtime 调度器 / 运行监视 | `.../scheduler`、`.../state|events|commands` | 保留 |
| Observability 日志 / 事件流 / 错误 | `/control-api/v1/obs/logs|events|errors` | 保留 |
| Gateway→API 密钥 | `/control-api/v1/admin/keys` | 保留，**迁出"AI 网关"菜单为 Access（接入管理）** |
| Gateway→游戏方 | `/world-api/v1/worlds` + `/admin/keys` 聚合 | 保留（租户面），同上迁出 |
| System 用户/权限/设置 | `/control-api/v1/admin/system/*` | 保留 |
| System 系统状态 | fetch 探测四服务 | 保留；**移除 `/memory-api`、`/gateway-api` 探测项** |

### 6.2 AI 产品功能（冻结 / 移除）

| 页面 | 端点 | 对应方案 §十三 |
|---|---|---|
| `/evolution/console` 演化控制台 | `POST /v1/evolution/worlds/:id/tick`、`runs`、`intent`、`trace` | AI Evolution Console / Evolution Run / AI 推进 |
| Gateway→提供方 `/gateway/providers` | `model-config`、`providers/:id/credential` | 模型角色配置 / 凭证管理 |
| Gateway→模型 `/gateway/models` | `model-config`、`models/:id/test` | 模型配置 / 实测 |
| Gateway→模型路由 `/gateway/router` | `routes/:capability(/test)` | 能力路由配置 |
| Gateway→管线 `/gateway/pipelines` | `admin/pipelines(/test)` | AI 多模型管线 |
| Gateway→用量 `/gateway/usage` | `admin/usage` | AI token 用量（并入/裁剪） |
| 记忆库 4 页 `/memory/*` | `/memory-api/v1/memory/*` + modelControl embedding 路由 | AI Memory 管理 / Embedding 配置 |
| Observability→AI 调用 `/observability/ai-calls` | `admin/usage?kind=chat` | AI 调用观测 |

**"推进世界"类功能核对**（方案 §十四）：世界列表与监视面板的推进按钮、命令调试台的 `advance_time` 走的都是引擎 `/v1/worlds/:id/time` 与 `/commands`（Admin 无自有世界逻辑）——**合规保留**。唯一"AI 推进"入口是演化控制台的 tick 按钮，随页面一并移除。

**测试影响**：`tests/modelControl.test.ts`（唯一单测，AI 模型配置客户端）随功能冻结失效；`e2e/smoke.spec.ts` 后半段（/gateway/router 改路由+回滚）与 `e2e/smoke.mjs` 的 `seedModelConfig()` 需同步收缩。

---

## 七、文档冲突点（登记）

| # | 位置 | 冲突 | 建议 |
|---|---|---|---|
| 1 | `world-engine/README.md` 标题"AI World Engine——面向 AI 原生应用的世界模拟内核" | 名称以 AI 自我命名，实体无 AI（且守卫固化） | 改为中性内核命名 + 边界释义 |
| 2 | 根 `README.md` 定位"AI 世界运行托管平台" | 与新定位"世界运行引擎托管平台（AI 是使用者不是核心）"有偏差 | 按方案 §二修订定位语 |
| 3 | `docs/EXTENSIONS.md:61`、`docs/RELEASE-V2.3.md:99`"V3.0 AI World Runtime 定版" | 易误读为引擎 Core 能力；实际代码全在 `platform/src/evolution/` | 表述澄清为"平台侧 AI 扩展运行时" |
| 4 | `docs/RELEASE-V2.3.md` 一句话叙事"AI 推动世界→NPC 自治" | 里程碑表述易误读为引擎能力 | 同上 |
| 5 | `tianqiong/scripts/world-host.mjs:7` stale 注释 | 指向不存在的文件 | 修正指向 |

---

## 八、结论

- **A/B/D/G 四类边界基本健康**：引擎内核干净且被测试固化；游戏 AI 全部在游戏侧；Admin 的 Control Plane 部分功能完整。
- **收束主战场按优先级**：① admin-web 移除 AI 产品页（Phase 4）；② platform 的 E 类模块在文档上正式定名为 Extension 层、托管面支持纯托管部署形态（不改代码行为，Phase 2/5 承载）；③ 根/引擎 README 定位修订与文档表述澄清（随本轮完成）；④ tianqiong 残余 `file:` 依赖登记为游戏侧长期项，不在引擎侧处理。
- **不做删除的 AI 代码**：`platform/src/evolution|worldagent|router|memory|upstream(AI 部分)` 与 `world-engine/gateway|memory` 两包——按方案 §十作为 Optional Extensions 保留演化，不粗暴删除。

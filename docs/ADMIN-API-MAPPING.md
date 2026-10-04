# Admin API 映射（ADMIN-API-MAPPING）

> 页面能力 → 前端 API 模块 → 后端端点的完整映射。
> 「真实」= 调用现有引擎/网关 HTTP API；「派生」= 基于真实 `GET /state` 在前端组装视图；
> 「Mock」= `/admin-api/*`（vite-plugin-fake-server），端点形状即目标契约，真实化见 ADMIN-API-GAP.md。

## 1. World 管理（真实）

| 页面能力 | API 模块 | 端点 |
|---|---|---|
| 世界清单（含元数据列） | `api/world.ts getWorlds` | `GET /v1/worlds` |
| 世界信息（详情头/详情 Tab 复用） | `getWorld` | `GET /v1/worlds/{id}` |
| 创建世界（Validate → POST → 跳详情；M1.5 起带 name/description） | `createWorld` | `POST /v1/worlds` |
| 完整状态（Raw JSON + 概览派生） | `getWorldState` | `GET /v1/worlds/{id}/state` |
| 世界事实列表（筛选/详情/因果链） | `getWorldEvents` / `api/event.ts listWorldEvents` | `GET /v1/worlds/{id}/events?n=` |
| 执行命令（调试台/列表快捷） | `executeWorldCommand` / `api/command.ts executeCommand` | `POST /v1/worlds/{id}/commands` |
| 最近命令历史（M1.4 真实：Runtime 环形缓冲，新 → 旧） | `getCommandHistory`（api/command.ts、api/world.ts） | `GET /v1/worlds/{id}/commands?n=` |
| 推进时间 | `advanceWorldTime` / `api/runtime.ts advanceTime` | `POST /v1/worlds/{id}/time` |

## 2. Runtime 观察视图（M1.3 起改真实独立端点；`GET /state` 仅 State 页保留）

| 页面 | API 模块 | 真实端点 |
|---|---|---|
| Entities（服务端分页/筛选 + 详情抽屉） | `api/entity.ts` | `GET /v1/worlds/{id}/entities?type=&q=&page=&pageSize=`、`GET /v1/worlds/{id}/entities/{eid}` |
| Locations（驻留统计 + 完整性告警） | `api/location.ts` | `GET /v1/worlds/{id}/locations?q=&page=&pageSize=` |
| Relations（状态关系表 + 实体关系边双视图） | `api/relation.ts` | `GET /v1/worlds/{id}/relations?q=&page=&pageSize=` |
| Scheduler（stats / scheduled / deferred / deadLetters） | `api/runtime.ts getSchedulerView` | `GET /v1/worlds/{id}/scheduler`（M1.2） |
| Runtime Monitor | `api/runtime.ts getRuntimeSummary` + `getSchedulerView` + `api/command.ts getCommandHistory` | `GET /state` + `GET /events` + `GET /scheduler` + `GET /commands?n=1` |
| Dashboard「引擎直读」卡与表 | `store/modules/world.ts` | `GET /v1/worlds` + `GET /v1/worlds/{id}` |

## 3. 命令目录（真实契约，前端静态）

`api/command.ts COMMAND_SPECS`：与引擎内置规则一一对应
（`coreRules.ts` / `rpgCompat.ts` 的 `for` 字段）：
`move / advance_time / change_weather / create_entity / remove_entity /
update_attribute / set_relation / move_entity / attack / talk / set_attitude / spawn_entity`。

命令载荷契约（HTTP 白名单，见 `world-engine/src/http/protocol.ts`）：
`type(≤64) + actorId(≤128) + targetId(≤128) + text(≤2000) + amount(number) +
payload（一层基本类型，≤32 键）`。

## 4. Memory 管理（M1.1 起真实，`/memory-api/*` → world-memory HTTP 适配层）

> 契约：`world-engine/memory/src/http/protocol.ts`（只读 + 检索面；store =
> 一个 MemoryEngine 实例，worldId 维度归宿主组合根）。
> 演示宿主：`scripts/run-demo-memory.mjs`（轮询引擎事件 ingestFact，127.0.0.1:8789）。

| 页面 | API 模块 | 真实端点 |
|---|---|---|
| Memory Stores（清单 + 真实统计 + 向量通道声明） | `api/memory.ts listMemoryStores` | `GET /v1/memory/stores` |
| Memories（分页筛选；行 = MemoryEntry 投影） | `listMemoryRecords` | `GET /v1/memory/records?store=&entity=&type=&q=&page=&pageSize=` |
| Retrieval（真实评分；无 entity 时聚合全部 owner） | `searchMemory` | `POST /v1/memory/retrieval` |
| Embedding（通道声明 + 检索统计，诚实口径） | `getEmbeddingInfo` | `GET /v1/memory/embedding` |

> 记录删除不在 API 内（M1 只读；引擎无删除原语），前端删除按钮已移除。

## 5. 管理面（M2 起全部真实化；Extensions 三页按诚实原则下线）

### 5a. Model Control Plane（真实，`/control-api/v1/admin/*`）

> 2026-09-30 落地。前端模块 `api/modelControl.ts` + `composables/useModelControl.ts`；
> 经同源反代（Vite dev / Nginx 生产）改写到私有 loopback 管理监听，
> 令牌由服务端注入 `x-admin-token`，浏览器不持有。见 platform/README.md。
> 旧的 `api/provider.ts` / `api/model.ts` / `api/router.ts` 与对应 Mock 路由
> 已删除——同一工作流不允许真/假两套处理器并存（见 ADMIN-API-GAP.md G6）。

| 页面能力 | API 模块 | 真实端点 |
|---|---|---|
| Providers 列表（ID/端点/凭证状态/启用态） | `modelControlApi.getConfig` | `GET /v1/admin/model-config`（脱敏投影） |
| 新建/编辑/删除供应商与模型（草稿） | 页面本地草稿 + `putConfig` | `PUT /v1/admin/model-config`（If-Match revision） |
| 上传/替换凭证（加密存储，不回显） | `putCredential` | `PUT /v1/admin/providers/{id}/credential` |
| 模型实测（有界真实调用，含禁用态） | `testModel` | `POST /v1/admin/models/{id}/test` |
| 能力路由实测（只用生效 primary） | `testRoute` | `POST /v1/admin/routes/{capability}/test` |
| 路由回滚（上一版本 + 密钥版本） | `rollback` | `POST /v1/admin/model-config/rollback`（If-Match） |
| revision 冲突处理 | 409 → 自动重载草稿丢弃 | 同 `PUT` 的 `revision_conflict` |

### 5b. API Key 生命周期（M2.1 起真实；0.5.1 起撤销语义移除，改为硬删除）

| 页面能力 | 真实端点 |
|---|---|
| Key 清单（脱敏前缀；分页） | `GET /v1/admin/keys?page=&page_size=` |
| 创建（明文仅创建响应一次，前端一次性保存框） | `POST /v1/admin/keys` `{name, permissions?, expiresAt?}` |
| 设置/清除过期（过期即 401，清除后恢复） | `PUT /v1/admin/keys/{id}` `{expiresAt: ISO\|null}` |
| **删除（硬删：记录移除，出站即 401，不可恢复）** | `DELETE /v1/admin/keys/{id}` |

> 0.5.1 破坏性变更：**撤销（revoked 软状态）语义移除**——KeyStore 不再有 status 字段，
> `PUT .../keys/{id} {status}` 显式 400 提示废弃；停用请设过期，彻底移除请 DELETE。
> Phase 1 纪律不变：落盘只有 SHA-256 哈希 + 展示前缀，清单投影不含 keyHash；
> 权限词表 = `chat:completions / worlds:read / worlds:write`（空数组被拒绝，
> 缺省 = 全量）。原 `POST /{id}/regenerate` 在真实语义中不存在，已从页面移除。

### 5c. 用量数据面（M2.2 真实，`api/usage.ts`；Usage 页 / Dashboard「AI 请求」卡 / AI Calls 页共用）

| 页面能力 | API 模块 | 真实端点 |
|---|---|---|
| Usage 页（行 + 汇总 + 分页；固定 kind=chat） | `api/usage.ts listUsage` | `GET /v1/admin/usage?kind=chat&page=&page_size=&model=&world_id=&capability=&status=` |
| AI Calls 页（同数据面；详情只有路由留痕） | `api/logs.ts listAiCalls`（= listUsage kind=chat） | 同上 |
| Dashboard「AI 请求 · 24h」卡 | `listUsage({from: 24h 前, page_size: 1})` 取 summary.requests | `GET /v1/admin/usage?kind=chat&from=&page_size=1` |
| 分组聚合（day/key/model/capability/world） | `group_by` 参数 | `GET /v1/admin/usage?group_by=day` |

> 数据面：平台公共侧每已鉴权请求记一条 JSONL（`data/usage.jsonl`，32MiB 轮转），
> requestId 与访问日志同源可对账；world-agent 记 capability/model_used/
> fallback/tokens（平台粗估口径），代理透传与 worlds 记录无 usage 数据 →
> tokens 留空不编造；**不落 Prompt/响应原文**（隐私边界）。cost 无计价来源，
> 不做列。审计失败（401）不计入。

### 5d. 管线（M2.3 真实：只读展示 + 有界试跑，`api/pipeline.ts`）

| 页面能力 | 真实端点 |
|---|---|
| 管线 spec 清单（nodes/role/dependsOn/output/optional，只读） | `GET /v1/admin/pipelines` |
| 有界试跑（入参键从 `{{input.*}}` 模板自动识别；时延封顶 30s、调用数封顶 32） | `POST /v1/admin/pipelines/{id}/test` `{input?, deadlineMs?, maxCalls?}` |

> 数据源 `data/pipelines.json`（`PLATFORM_PIPELINES_FILE`；`PLATFORM_PIPELINES_FILE`
> 缺省 `data/pipelines.json`），经 gateway V0.7 `parsePipelineSpec` fail-fast 校验，
> 每次请求读盘（手工编辑即生效）；坏文件 → 422 invalid_configuration 页面错误态。
> 试跑经受管配置的网关标签路由真实执行，出站校验未通过的模型剔除并留痕
> （`excludedModels`）；禁用管线（`enabled: false`）拒绝试跑 409。
> **不做 DAG 编辑器**（方案 §27）。

### 5e. 下线：Extensions / Rules / 扩展命令（M2.4 决策）

> 引擎 V1.0 的规则经代码注册（`world-engine/src/rules`），WorldAPI 无运行时清单
> 端点；且 Mock 数据模型中的「扩展分组 / 规则启停 / 优先级」在引擎中无对应概念。
> 按诚实原则（做不了就下线，不留 Mock）：路由模块 `extensions.ts`、视图 3 页、
> `api/extension.ts` / `api/rule.ts`、`mock/admin/extensions.ts` 已删除。
> 命令目录的真实契约保留在 `api/command.ts COMMAND_SPECS`（命令调试台仍在用）。
> 未来若引擎提供规则清单只读 API，可在后续里程碑恢复该组页面。

### 5f. 会话与系统服务（M3 真实，`api/user.ts` + `api/system.ts`）

| 页面能力 | API 模块 | 真实端点 |
|---|---|---|
| 登录（真实会话；响应形状与原 Mock 一致，前端零改动） | `api/user.ts getLogin` | `POST /v1/admin/session/login` |
| 会话刷新（轮换出全新 token 对） | `refreshTokenApi` | `POST /v1/admin/session/refresh-token` |
| 登出（吊销当前会话） | `logoutSession` | `POST /v1/admin/session/logout` |
| 当前身份与权限 | — | `GET /v1/admin/session/me` |
| Users 清单/创建/编辑（角色/状态/重置口令，即时吊销） | `api/system.ts listUsers/createUser/updateUser` | `GET/POST /v1/admin/system/users`、`PUT .../{id}` `[system:manage]` |
| 权限码目录与三档角色（只读真实契约；固定三档不在线编辑） | `getPermissions` | `GET /v1/admin/system/permissions` |
| Settings 目录/更新（白名单 + 校验，`data/settings.json`） | `listSettings/updateSetting` | `GET /v1/admin/system/settings`、`PUT .../{key}` `[system:manage]` |
| Status 服务连通性（真实探测四个同源代理，无编造字段） | `probeServices` | `GET /world-api/v1/worlds`、`/memory-api/v1/memory/stores`、`/gateway-api/v1/models`、`/control-api/healthz` |
| **记忆库 → 向量嵌入诊断页**（Embedding 统一治理后） | `api/memory.ts getEmbeddingInfo` + `api/modelControl.ts getRouteLive/testRoute` | `GET /memory-api/v1/memory/embedding`（只读观测）+ `GET /control-api/v1/admin/routes/embedding`（路由实况 `[gateway:manage]`）+ `POST .../routes/embedding/test`（embed 语义实测，返回 dimension）。旧 `memory/embedding-config` 代理已删除（410/404） |

> 双凭证模型：`x-admin-token`（主令牌，服务端反代注入，全权运维通道，保留不变）与
> `x-admin-session`（登录会话，12h/刷新轮换 7d）。**代理会话感知注入**（Vite dev 与
> Nginx 模板）：浏览器带会话头时不注入主令牌，服务端按角色强制权限码；viewer 只读
> 会话直访写端点实测 403。登录失败全局节流（60s ≥10 次 → 429）。内置账号为公开文档
> 默认口令（admin/admin123 等），非本机部署必须立即修改。
> 前端兜底：access 会话到期由拦截器经 refreshToken 自动轮换；管理端点收到 401
> （会话已吊销/刷新链也失效）时自动清除本地会话并跳转登录页。
> `mock/login.ts`、`mock/refreshToken.ts`、`mock/admin/system.ts` 已删除。

### 5g. 可观测聚合与 Dashboard（M4.1 真实，`api/logs.ts` / `api/event.ts` / `api/dashboard.ts`）

| 页面能力 | API 模块 | 真实端点 |
|---|---|---|
| Logs（平台请求日志 = M2.2 数据面投影；level/world/q 过滤） | `api/logs.ts listLogs` | `GET /v1/obs/logs` |
| 事件流（跨世界聚合，worldId 标注 + day/tick 降序 + 因果标记） | `api/event.ts listPlatformEvents` | `GET /v1/obs/events?world=&n=` |
| Errors（失败请求登记，只读——无确认/解决工作流） | `api/logs.ts listErrors` | `GET /v1/obs/errors?world=&kind=` |
| Dashboard 聚合（世界含 paused / 实体 / AI 24h 汇总 + 小时桶 / 最近错误） | `api/dashboard.ts getDashboardOverview` | `GET /v1/obs/overview` |
| Dashboard 记忆条目卡（memory 独立服务，前端直读） | `api/memory.ts listMemoryStores` | `GET /v1/memory/stores` |
| AI Calls 页 | `api/logs.ts listAiCalls` | `GET /v1/admin/usage?kind=chat`（M2.2 同一数据面） |
| **Embedding 路由实况/诊断**（统一治理后；只读面） | `api/modelControl.ts getRouteLive/testRoute` | `GET /v1/admin/routes/embedding`（实况 `[gateway:manage]`）、`POST /v1/admin/routes/embedding/test`（embed(['ping']) 实测，回 dimension）；配置唯一源 = `PUT /v1/admin/model-config` 的 routes.embedding |
| **模型思考强度**（M5 后特性；配置列） | 模型页内联下拉（thinking 元数据由配置投影下发） | `ModelConfigModel.thinking` 随 `PUT /v1/admin/model-config` 保存；出站由厂商适配器翻译 |

> 诚实边界：世界事件无墙钟时间（只有 day/tick），活动图为 AI 调用单序列；
> Logs 为平台请求日志投影（不含引擎/记忆进程内日志）；Errors 无工作流字段。
> `mock/admin/observability.ts`、`mock/admin/dashboard.ts` 已删除——**`/admin-api`
> 假路由全部清退**，`mock/` 仅剩 pure-admin 脚手架的 `asyncRoutes.ts`（后端路由
> 模式预留，与本后台数据无关）。

### 5h. 世界生命周期（M4.2 真实，`api/world.ts`；裁定见 docs/G1-PAUSE-DESIGN-REVIEW.md）

| 页面能力 | 真实端点 |
|---|---|
| 暂停（重复 409；暂停中 commands/time 409 `world_paused`，读照常） | `POST /v1/worlds/{id}/pause` |
| 恢复（未暂停 409） | `POST /v1/worlds/{id}/resume` |
| 关闭（注册表摘除，不可逆；关闭后一切访问 404） | `DELETE /v1/worlds/{id}` |
| 清单/详情状态标签（running/paused；关闭后从清单消失） | `GET /v1/worlds[/{id}]` 的 `WorldInfo.status` |

> 前端按钮权限门（`world:write`）是 UX；引擎公共面无鉴权（127.0.0.1-only 是唯一
> 防线，已知问题 #4，引擎侧独立工作项）。

## 6. 真实联通性测试点（非 Mock）

| 位置 | 行为 | 目标 |
|---|---|---|
| Models 页「实测」 | 有界真实 chat 调用，展示上游回复/错误码（脱敏） | `POST /v1/admin/models/{id}/test` → 受管出站链路 |
| Router 页「测试」 | 只测该能力当前生效 primary 链路 | `POST /v1/admin/routes/{capability}/test` |
| System Status 页「引擎直探」 | 实时 `GET /v1/worlds`，展示在线/离线与世界数 | `/world-api/v1/worlds`（8787） |
| 所有 World/Runtime 页面 | 真实引擎数据；引擎不可达时显示错误态而非假数据 | 同上 |

## 7. 请求基础设施

- 实例：`src/utils/http`（pure-admin PureHttp，axios 封装，带会话刷新逻辑）；
  请求拦截器同时附 `Authorization`（公共 API Key 语义）与 `x-admin-session`
  （M3.1 管理会话）；管理监听只认 `x-admin-session` / `x-admin-token`，
  `authorization` 一律忽略。
  Model Control Plane 用独立 `fetch` 客户端（`api/modelControl.ts`，无令牌头）。
- 代理：`vite.config.ts` `/world-api`、`/memory-api`、`/gateway-api` → `.env` 中
  `VITE_WORLD_API_URL`（默认 `http://127.0.0.1:8787`）、
  `VITE_MEMORY_API_URL`（默认 `http://127.0.0.1:8789`）、
  `VITE_GATEWAY_API_URL`（8788）；
  `/control-api` → `PLATFORM_ADMIN_TARGET`（默认 `http://127.0.0.1:8791`），
  令牌从进程环境 `PLATFORM_ADMIN_TOKEN` 服务端**会话感知注入**（浏览器带
  `x-admin-session` 时不再注入主令牌；绝不使用 `VITE_*`）。
  生产环境见 `admin-web/nginx.conf.template`（map 条件注入）。
- Mock：`vite-plugin-fake-server`（`include: "mock"`，`enableProd: true`；
  M1 清退 `mock/admin/memory.ts`，M2 清退 `gateway.ts` 与 `extensions.ts`，M3 清退
  `login.ts`、`refreshToken.ts`、`admin/system.ts`，M4 清退 `observability.ts` 与
  `dashboard.ts`——**admin 数据 Mock 已全部清退**，`mock/` 仅剩 pure-admin 脚手架的
  `asyncRoutes.ts`）。

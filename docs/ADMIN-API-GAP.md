# Admin API Gap（ADMIN-API-GAP）

> 记录管理后台建设过程中发现的后端能力缺口。按方案要求：**不为前端方便修改 World
> Engine Core**，所有缺口在此登记，等待平台侧决策。页面上凡是依赖下列缺口的数据，
> 均以 Mock 呈现并在界面标注。
>
> **落地状态标注（2026-09-30 · M1 只读数据面 + M2 Gateway 管理面/计量 + M3 鉴权会话 +
> M4 可观测聚合/生命周期）**：G1–G9 的管理面缺口**全部落地**（G1 软暂停见评审记录；
> G8 的 logs 为平台请求日志投影，应用级日志管道未建；G9 的引擎公共面鉴权为引擎侧
> 独立工作项）。端点见 ADMIN-API-MAPPING；下文保留原始登记内容作决策记录。

## API Gap 清单

### G1. World 生命周期控制 —— ✅ 已落地（M4.2 · 软暂停先行，裁定见 docs/G1-PAUSE-DESIGN-REVIEW.md）

- **页面**：世界列表 / Runtime Monitor / Dashboard
- **需要能力**：暂停、恢复、关闭世界；运行状态（running/paused/closed）查询
- **落地（引擎 1.0.3，零 Core）**：
  - `POST /v1/worlds/{id}/pause`（重复 409）、`POST /v1/worlds/{id}/resume`（未暂停 409）、
    `DELETE /v1/worlds/{id}`（走 V0.9 既有 `WorldRegistry.close()`；单世界模式 409）；
  - 暂停中 `POST .../commands`、`POST .../time` → 409 `world_paused`，全部读路由照常；
  - `WorldInfo.status?: 'running' | 'paused'`（可选字段）；关闭后的世界从清单消失；
  - 暂停为进程内服务面标记（重启即解除）——裁定与备选方案记录见评审文档；
  - 世界列表/Monitor 的暂停/恢复/关闭按钮已恢复并接真（按钮的前端权限门是 UX；
    引擎公共面无鉴权，见 G9 注意/已知问题 #4）。
- **Runtime 级 pause**：评审结论为不需要（决策点 4）；若未来持久化世界需要跨重启
  暂停，走 `state.metadata` 通道（契约已留好）。

### G2. World 元数据（创建/更新时间、名称、描述）—— ✅ 已落地（M1.5）

- **页面**：世界列表（Created/Updated At 列）、创建世界（Name/Description 字段）
- **需要能力**：世界级元数据存储与查询
- **当前 API**：`WorldInfo` 仅含 `worldId/location/entities/time`
- **建议接口**：`WorldInfo` 增加 `name`、`description`、`createdAt`、`updatedAt`；
  或 `GET /v1/worlds/{id}/meta`
- **是否需要修改 Core**：否（注册表层可挂元数据，metadata 已有 `state.metadata` 可借用）
- **落地（M1.5）**：`WorldInfo` 扩展四个可选字段；元数据经 World Definition 的
  `metadata` 通道挂载进 `state.metadata`（随 SavePort 持久化）；创建参数白名单新增
  `name(≤128)/description(≤512)`；成功的命令/推进刷新 `updatedAt`。零 Core 改动。

### G3. 实体 / 地点 / 关系独立查询端点 —— ✅ 已落地（M1.3）

- **页面**：Entities / Locations / Relations（当前由前端从 `GET /state` 全量派生）
- **需要能力**：分页、服务端筛选、单实体详情；世界实体量大时全量拉状态不可行
- **当前 API**：无独立端点
- **建议接口**：
  - `GET /v1/worlds/{id}/entities?type=&page=&pageSize=`
  - `GET /v1/worlds/{id}/entities/{eid}`
  - `GET /v1/worlds/{id}/locations`、`GET /v1/worlds/{id}/relations`
- **是否需要修改 Core**：否（WorldQuery 已具备读取能力，仅 HTTP 层暴露）
- **落地（M1.3）**：`GET /v1/worlds/{id}/entities`（q/type/page/pageSize + player 概要）、
  `GET /v1/worlds/{id}/entities/{eid}`（详情 + rels 关系边）、
  `GET /v1/worlds/{id}/locations`（驻留统计 + 位置完整性告警）、
  `GET /v1/worlds/{id}/relations`（状态关系表 + 实体关系边双视图，q 筛选）。
  前端 Entities/Locations/Relations 改服务端分页（已知问题 #3 关闭）。

### G4. Scheduler / 事件队列观测 —— ✅ 已落地（M1.2）

- **页面**：Scheduler（现为缺口占位页）、Runtime Monitor（Event Queue 仅见最近事实）
- **需要能力**：查看延迟调度事件、死信（deadLetters）、重试计数、bus 统计
- **当前 API**：无（`WorldEventBus.stats()/deadLetters()/deferredEvents()` 仅进程内）
- **建议接口**：`GET /v1/worlds/{id}/scheduler` →
  `{ scheduled: WorldEvent[], deadLetters: WorldEvent[], stats: {...} }`
- **是否需要修改 Core**：否（bus 已有查询面，HTTP 层暴露即可）
- **落地（M1.2）**：`GET /v1/worlds/{id}/scheduler` 返回
  `{ stats, scheduled: [{dueDay, event}], deferred, deadLetters }`；
  总线补了只读访问器 `scheduledEvents()`（增量、零语义变化）。Scheduler 页与
  Monitor「事件队列」卡接真。

### G5. Last Command / 命令历史 —— ✅ 已落地（M1.4）

- **页面**：Runtime Monitor（Last Command 字段）、命令调试台（历史回放）
- **需要能力**：最近执行的命令记录（类型/参数/结果/时间）
- **当前 API**：`CommandResult` 仅返回当次结果，无历史查询
- **建议接口**：`GET /v1/worlds/{id}/commands?n=50`（环形缓冲）
- **是否需要修改 Core**：否（可由 Runtime 侧记账）
- **落地（M1.4）**：Runtime `execute()` 侧环形缓冲（上限 100 条，快照留痕：
  seq/at/tick/day/command/ok/reason/events/tookMs），`WorldRuntime.recentCommands(n)`
  只读访问；`GET /v1/worlds/{id}/commands?n=50` 暴露。命令调试台历史、Monitor
  Last Command 接真。

### G6. AI Gateway 管理面 —— ✅ 已落地（Model Control Plane 2026-09-30；M2.1-M2.3 收口）

- **页面**：Providers / Models / Model Router（✅ M1 前落地）；API Keys / Usage / Pipelines（✅ M2 落地）；
  Extensions 三页（➖ M2.4 决策下线，见文末附注）
- **已落地能力**（受管模式，`platform/scripts/run-managed.mjs` + Admin Web `/control-api/*`）：
  - Provider 清单与凭证管理（AES-256-GCM 加密存储，脱敏投影）
  - 模型目录（内部 ID / wireModel / 标签 / 启用态）与有界连通性实测
  - 六能力路由表（primary/fallback → 物理模型 ID），保存即时生效无需重启
  - revision 乐观锁（If-Match / 409）、上一版本备份与回滚
  - API Key 生命周期（M2.1）：创建（明文仅一次）/ 撤销（终态）/ 过期 / 脱敏清单，
    沿 Phase 1 密钥纪律（落盘只有哈希 + 前缀）
  - 用量数据面（M2.2）：平台侧 JSONL 结构化用量记录（requestId 与访问日志可对账，
    不落 Prompt/响应原文），聚合端点供 Usage 页 / Dashboard「AI 请求」卡 / AI Calls 页共用
  - 管线只读展示 + 有界试跑（M2.3）：`data/pipelines.json` 经 gateway V0.7 校验，
    试跑经受管配置桥接网关标签路由真实执行（出站校验同闸、时延 ≤30s、调用数 ≤32），
    编辑器不做
- **端点**（前缀 `/v1/admin`，仅私有 loopback 管理监听）：
  - `GET/PUT /v1/admin/model-config`、`POST /v1/admin/model-config/rollback`
  - `PUT /v1/admin/providers/{id}/credential`
  - `POST /v1/admin/models/{id}/test`、`POST /v1/admin/routes/{capability}/test`
  - `GET/POST /v1/admin/keys`、`PUT /v1/admin/keys/{id}`
  - `GET /v1/admin/usage`（过滤/汇总/分组/分页）
  - `GET /v1/admin/pipelines`、`POST /v1/admin/pipelines/{id}/test`
- **明确不做**：DAG 编辑器（方案 §27）；native Anthropic 协议、embeddings 路由、
  预算/优先级强制执行（Model Control Plane 出界项）
- **是否需要修改 Core**：否（全部在平台侧；引擎核心零改动）
- **附注（M2.4 下线决策）**：引擎规则经代码注册，无运行时清单端点；Mock 数据模型的
  「扩展分组/启停/优先级」在引擎中无对应概念。按诚实原则（做不了就下线，不留 Mock），
  Extensions / Rules / 扩展命令三页连同 api/mock 已移除；引擎若在后续提供规则清单
  只读 API 可恢复。

### G7. Memory HTTP API —— ✅ 已落地（M1.1）

- **页面**：Memory Stores / Memories / Retrieval / Embedding（全部 Mock）
- **需要能力**：Store 清单与统计、记录分页/删除、向量检索调试、Embedding 模型与统计
- **当前 API**：`memory/` 为纯库（engine/memory/src），无 HTTP 传输层
- **建议接口**：
  - `GET /v1/memory/stores`
  - `GET /v1/memory/records?entity=&type=&store=&q=&page=`
  - `POST /v1/memory/retrieval` `{ query, entity?, topK }`
  - `GET /v1/memory/embedding`
- **是否需要修改 Core**：否（memory 独立包，加 HTTP 适配层即可，模式同 world-engine/src/http）
- **落地（M1.1）**：`world-engine/memory` 新增 `./http` 子路径导出（纯路由协议 +
  node 薄壳，默认 127.0.0.1:8789）；store = 一个 MemoryEngine 实例（worldId 维度
  归宿主）；records 分页筛选（store/entity/kind/q）；retrieval 走新增的
  `recallScored`（真实评分；无 entity 时聚合 store 内全部 owner）；embedding 返回
  向量通道声明 + 经本服务的检索统计（诚实口径，不编造调用数）。**只读 + 检索面**：
  记录删除不在 API 内（M1 只读；引擎亦无删除原语），前端删除按钮移除。
  `mock/admin/memory.ts` 已删除。

### G8. 平台可观测性聚合 —— ✅ 已落地（M4.1；ai-calls 自 M2.2 由用量数据面承担）

- **页面**：Logs / 事件流（跨世界）/ AI Calls / Errors / Dashboard 聚合指标
- **落地（M4.1，管理监听 `/v1/obs/*`）**：
  - `GET /v1/obs/logs`：平台请求日志 = M2.2 数据面投影（level 按 status 派生，
    requestId 与访问日志可对账）。**诚实边界**：不含引擎/记忆的进程内日志
    （结构化应用日志管道仍属未来运营工程，需求出现时按 M2.2 同款 JSONL 扩展）；
  - `GET /v1/obs/events`：跨世界事件流（引擎只读聚合，worldId 标注，day/tick 降序）；
  - `GET /v1/obs/errors`：失败请求登记（status≥400 投影，只读——Mock 时代的
    确认/解决工作流无真实支撑，已移除）；
  - `GET /v1/obs/overview`：Dashboard 聚合（世界统计含 paused / 实体 / AI 24h 汇总 +
    12 整点小时桶 / 最近错误）。世界事件无墙钟时间（只有 day/tick），活动图为
    AI 调用单序列，不编造事件时间线；
  - `GET /v1/obs/ai-calls`：由既有 `GET /v1/admin/usage` 承担（M2.2 起 AI Calls 页
    已接同一数据面），不重复建端点。
- **是否需要修改 Core**：否

### G9. 用户 / 权限 / 设置服务 —— 部分落地（M3：管理面会话/用户/设置真实；引擎面鉴权待做）

- **页面**：System Users / Permissions / Settings（✅ M3 接真）；登录（✅ M3.1 真实会话）
- **已落地（M3）**：
  - 登录签发真实会话：`POST /v1/admin/session/login`（本地三档用户，scrypt 存储
    `data/users.json`；会话 12h / 刷新轮换 7d / 登出吊销；login/refresh 响应形状与原
    Mock 一致，前端零改动）。`mock/login.ts`、`mock/refreshToken.ts` 已删除。
  - 服务端权限强制（M3.2）：管理监听写端点按权限码闸门（`gateway:manage` /
    `system:manage`），viewer 只读会话直访写端点实测 403；主令牌（服务端注入）
    等同超权，运维通道保留。
  - 用户管理（M3.3）：`GET/POST /v1/admin/system/users`、`PUT .../{id}`
    （改角色/状态/重置口令即时吊销会话；末位 admin 保护）。`mock/admin/system.ts` 删除。
  - 设置持久化（M3.4）：`GET/PUT /v1/admin/system/settings`（白名单目录 + 校验，
    `data/settings.json`；运行时生效项随 M4/M5 接线，各项说明注明口径）。
  - Status 页服务连通性改为真实探测（四个同源代理端点）。
- **仍属缺口**：**引擎/Gateway 公共 HTTP 面无鉴权**（方案 §3 明确本阶段不做；
  127.0.0.1-only 是唯一防线）——管理面会话不覆盖引擎直连流量，需引擎侧鉴权中间件
  （引擎里程碑，非本后台规划内）；平台 Phase 2 的完整用户体系（Tenant/User/
  Membership/配额）。
- **是否需要修改 Core**：用户/会话/设置服务否（平台侧已完成）；引擎面鉴权是
  引擎 HTTP 层工作（见已知问题 #4）。

## 优先级建议

1. ~~**G7（Memory HTTP）与 G4（Scheduler 观测）**：纯只读暴露、无需改 Core，收益最大~~（已落地 M1.1/M1.2）
2. ~~**G3（实体/地点/关系端点）**：数据量大后必需~~（已落地 M1.3）
3. ~~**G1（生命周期）**：涉及 Core 语义，需引擎侧设计评审（排期 M4）~~
   （已落地 M4.2——评审裁定软暂停零 Core，见 docs/G1-PAUSE-DESIGN-REVIEW.md）
4. ~~**G6/G8/G9**：属于「World Platform 平台化」范畴（M2/M3/M4 推进）~~
   （G6 落地 M2；G9 管理面落地 M3；G8 落地 M4。遗留：引擎公共面鉴权 =
   引擎侧独立工作项，见 G9 注意）

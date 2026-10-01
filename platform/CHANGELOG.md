# Changelog

本文件记录 World Platform 的版本演进。格式参考 Keep a Changelog。
版本策略（semver）：0.x 期间允许带 CHANGELOG 注明的 API 调整。

## [0.7.0] - 2026-10-01 · G3 · 用量的游戏方维度

### Added
- **`UsageEntry.gameId`**：用量记录盖章归属游戏方——公共面 meter 与流式
  代记从钥匙记录带出 `gameId`（null = 平台钥匙）；
- `GET /v1/admin/usage` 新增 `game_id` 过滤（`__platform__` 约定为平台钥匙）
  与 `group_by=game` 分组（平台记录聚合为 `(平台)` 键）；
- 测试：usage 查询增 1 用例（过滤/汇总/分组）。

## [0.6.0] - 2026-10-01 · G2 · 游戏方钥匙（gameId）

### Added
- **`ApiKeyRecord.gameId`**：非空 = 游戏方钥匙（对齐 world-engine 1.1.0 鉴权
  中间件的 `WorldAuthKey.gameId`）；`POST /v1/admin/keys` 接受 `gameId`
  （1-64 字符，非法 400），GET 清单回显（存量记录归一为 null = 平台管理钥匙）；
- 管理台「游戏方」聚合页（admin-web /gateway/games）：世界按 `ownerGame`、
  钥匙按 `gameId` 前端归组——健康（运行/暂停）、实体量、最近活动、接入钥匙；
- 测试：admin-http 增 1 用例（gameId 创建/回显/缺省 null/非法 400）。

### 语义
- 钥匙落盘文件版本不变（`version: 1`）——新字段可选，旧文件直接可读。

## [0.5.1] - 2026-10-01 · API Key：撤销语义移除，改为硬删除（破坏性 API 变更）

### Changed
- **`KeyStore.revoke` → `KeyStore.remove`（硬删）**：`ApiKeyRecord` 移除 `status`
  字段；`DELETE /v1/admin/keys/{id}` 直接移除记录（出站即 401，不可恢复）；
  `PUT .../keys/{id}` 不再接受 `status`（显式 400 提示废弃）；GET 清单移除
  `status` 筛选（删除后记录不存在，清单即在档全集）。停用仍走过期时间
  （可设可清）。keyctl.mjs 的 `revoke` 子命令同步改为 `delete`。

### 迁移说明
- keys.json 中历史 revoked 记录加载后仍可被删除（remove 按 id）；新代码不再
  产生 revoked 状态。管理台页面按钮/筛选已同步（撤销→删除，状态筛选移除）。

## [0.5.0] - 2026-10-01 · 模型思考强度 + 记忆嵌入配置（管理台可配置）

平台 122 → 133 用例（+11 全绿）。配套：world-memory 0.8.2（setEmbed + 配置端点）、
world-gateway 0.7.1（出站透传通道）、admin-web（模型页思考强度列 + 记忆库嵌入配置卡）。

### Added
- **厂商思考强度适配器（可复用注册表 `src/admin/vendors.ts`）**：
  - 抽象档位 off/low/medium/high → 各家请求字段；优先适配 DeepSeek（官方 thinking_mode
    参数化：thinking.type + reasoning_effort，原生 low/high/max 档）、GLM（thinking.type）、
    Kimi（思考版模型名，声明性提示）、Qwen（enable_thinking + thinking_budget）、
    generic（reasoning_effort 回退）；
  - **扩展方式**：新厂商 = VENDOR_PROFILES 追加一条 profile（match 前缀 + apply
    映射），检测/校验/出站/UI 档位全部自动生效；
  - `ModelConfigModel.thinking?`（可选字段，配置校验按 wireModel 检测出的厂商
    校验档位支持，不支持诚实 422）；出站经 remoteChat/Stream 的 extraPayload/
    modelOverride 透传（world-gateway 0.7.1）；
  - 配置投影新增 `thinking` 元数据（levels/vendors/前缀/提示）——前端下拉
    零改动扩展。
- **嵌入模型配置面（记忆库菜单）**：
  - memory 服务（0.8.2）：`GET/PUT /v1/memory/embedding-config` + `/test`
    （宿主回调承担热应用/持久化/实测；apiKey 明文不出服务，响应一律脱敏）；
  - 平台鉴权代理：`GET/PUT/POST( test) /v1/admin/memory/embedding-config`
    （GET 需已认证；PUT/test 需 system:manage；目标 PLATFORM_MEMORY_URL，
    缺省 8789；服务不可达 502 upstream_unreachable）；
  - 记忆演示宿主：配置文件持久化（管理台写入即事实来源，env 仅首次引导）、
    保存即热应用（engine.setEmbed，无需重启）、连通性实测端点；
    `seen` 去重集合持久化（修复重启后同 id 事件重复建档）。
- **`PLATFORM_MEMORY_URL`**：记忆库服务地址（嵌入配置代理目标）。

### 平台配置文件兼容性
- `model-config.json` 新增模型可选字段 `thinking`——旧文件照常加载（字段缺省）；
  旧版本平台读取新文件会忽略未知字段（白名单重建），双向兼容。

## [0.4.1] - 2026-10-01 · M5 · 容器化部署支撑（ADMIN-CONSOLE-ROADMAP M5.3）

### Added
- **管理监听非回环逃生阀**：`PLATFORM_ADMIN_ALLOW_NON_LOOPBACK=1` +
  `PLATFORM_ADMIN_HOST=0.0.0.0` 显式组合时，run-managed 允许管理监听绑定非回环
  地址（容器/内网隔离部署；启动大声告警，隔离责任移交部署层）。缺省行为不变
  （非回环拒绝启动，fail-closed）。
- **`ManagedRuntimeOptions.host`**：受管 Platform 公共监听地址透传
  （`PLATFORM_HOST`；容器部署传 0.0.0.0 供同网络反代访问）。
- `deploy/`（仓库根）：Dockerfile.base（全栈运行时镜像）、Dockerfile.admin
  （前端构建 + Nginx）、docker-compose.yml、仓库根 .dockerignore；
  `docs/DEPLOY.md` 从零拉起指南。配套前端：fake-server 清退（admin-web 侧）。

## [0.4.0] - 2026-09-30 · M4 · 可观测聚合（ADMIN-CONSOLE-ROADMAP M4.1）

平台 118 → 122 用例（+4 全绿）。引擎侧 G1（软暂停/恢复/关闭）见 world-engine 1.0.3；
`/v1/obs/ai-calls` 按路线图「吃 M2.2 数据面」的定位由既有 `GET /v1/admin/usage` 承担
（M2 起前端已接），不重复建端点。

### Added
- **可观测聚合端点（M4.1 · 管理监听）**：
  - `GET /v1/obs/logs`：平台请求日志 = M2.2 数据面投影（level 按 status 派生
    error/warn/info，service=platform，message 含方法/路径/状态/时延；
    level/world/q 过滤 + 分页）。requestId 与访问日志对账不变。
  - `GET /v1/obs/events`：跨世界事件流——经引擎只读聚合（`/v1/worlds` + 各世界
    `/events`），worldId 标注、day/tick 降序、单世界过滤、总量封顶 500。
  - `GET /v1/obs/errors`：失败请求登记（status≥400 投影，type=错误码或 http_xxx）。
    **诚实只读**：无 acknowledge/resolve 工作流（原 Mock 的工作流无真实支撑，已从前端移除）。
  - `GET /v1/obs/overview`：Dashboard 聚合——世界统计（含 paused，吃引擎 1.0.3 的
    status 字段）/ 实体合计 / AI 24h 汇总（requests/tokens/successRate/byProvider）、
    12 整点小时调用桶（UTC）/ 最近 5 条错误。引擎不可达时世界字段诚实归零。
- **`ManagedRuntime.engine`**：引擎客户端只读暴露（聚合用）。

### 诚实边界
- 世界事件无墙钟时间（只有 day/tick）：Dashboard 活动图为「AI 调用按小时」单序列，
  不编造事件时间线；`eventsPerMin` 卡片由「最近 1 小时 AI 调用」替代。
- 记忆条目数不在平台聚合内（memory 是独立服务），由前端直读 `/memory-api`。

## [0.3.0] - 2026-09-30 · M3 · 鉴权、会话与系统页（ADMIN-CONSOLE-ROADMAP M3）

平台 107 → 118 用例（+11 全绿）；管理台登录/用户/设置全部去 Mock。

### Added
- **管理会话（M3.1）**：
  - `src/admin/sessions.ts`：不透明随机令牌会话（非 JWT——无签名解析面，吊销即失效）；
    accessToken 12h / refreshToken 7d，刷新即**轮换**（旧对立即作废）；落盘
    `data/sessions.json`（重启不丢）；`revokeUser` 支持改密/停用后批量吊销。
  - 端点：`POST /v1/admin/session/login`（免鉴权 + 全局失败节流：60s 窗口 ≥10 次 → 429）、
    `POST /v1/admin/session/refresh-token`（免鉴权）、`POST /v1/admin/session/logout`、
    `GET /v1/admin/session/me`。login/refresh 响应形状与原前端 Mock 完全一致
    （`{success,data:{roles,permissions,accessToken...}}`）——前端零改动替换。
  - 鉴权门改双凭证：`x-admin-token`（主令牌，服务端注入，全权，运维通道保留不变）或
    `x-admin-session`（角色会话）；带错主令牌时即便同时带合法会话也 401（防降级混淆）；
    `authorization` 头依旧一律忽略。
- **本地用户服务（M3.3，决策点 3：「本地三档用户 + 文件存储」）**：
  - `src/admin/users.ts`：scrypt 加盐哈希 + timingSafeEqual 校验；
    `data/users.json`（`PLATFORM_USERS_FILE`）；首次启动播种三档内置账号
    （admin/admin123、operator/operator123、viewer/viewer123，公开文档矩阵，
    控制台显著告警要求修改）；末位保护（最后一名 active admin 不可停用/降级）。
  - 端点：`GET/POST /v1/admin/system/users`、`PUT /v1/admin/system/users/{id}`
    （改昵称/备注/角色/状态、重置口令；停用与重置口令即时吊销该用户全部会话）。
- **权限码服务端强制（M3.2）**：
  - `src/admin/permissions.ts`：三档角色 → 权限码目录（与 docs/ADMIN-PERMISSION.md 同源）。
  - 管理监听全部写端点按码强制：模型配置/凭证/实测/Keys/管线试跑 → `gateway:manage`，
    用户与设置写 → `system:manage`；viewer 只读会话直访写端点 403 `insufficient_permission`
    （浏览器实测通过）；读端点任意已认证身份。
- **系统设置服务（M3.4）**：
  - `src/admin/settings.ts`：白名单目录（8 项，类型/枚举/范围校验）+ 值持久化
    `data/settings.json`（`PLATFORM_SETTINGS_FILE`）；目录即契约，各项 description
    诚实标注生效口径（M3 交付持久化，运行时行为项随 M4/M5 接线）。
  - 端点：`GET /v1/admin/system/settings`、`PUT /v1/admin/system/settings/{key}`；
    另有 `GET /v1/admin/system/permissions`（权限码目录 + 三档角色，只读真实契约）。
- **配置**：`PLATFORM_USERS_FILE` / `PLATFORM_SESSIONS_FILE` / `PLATFORM_SETTINGS_FILE`。

### Changed
- Admin Web（M3 前端配套）：登录/登出/刷新指向真实会话端点（形状不变）；
  请求拦截器附 `x-admin-session`；代理（Vite dev 与 Nginx 模板）改**会话感知注入**——
  浏览器带会话时不再注入主令牌，服务端按角色强制权限；无会话的运维请求保留主令牌通道。
  Users / Permissions / Status 页接真；`mock/login.ts`、`mock/refreshToken.ts`、
  `mock/admin/system.ts` 删除。

## [0.2.0] - 2026-09-30 · M2 · Gateway 管理面收口与计量（ADMIN-CONSOLE-ROADMAP M2）

平台 84 → 107 用例（+23 全绿）；四包回归门禁全绿。

### Added
- **结构化用量数据面（M2.2）**：
  - `src/usage/recorder.ts`：JSONL 追加记录器（32MiB 单代轮转；写失败停写不拖垮请求路径；
    坏行跳过不污染读）；`src/usage/query.ts`：纯函数查询（过滤 / 汇总 / 分组 day|key|model|
    capability|world / 分页，pageSize 封顶 500）。
  - 公共侧全挂点计量：world-agent（capability/model_used/fallback/tokens，响应既有粗估口径）、
    保真代理（流式由 server 泵完代记，协议层挂 `usageMeta`）、worlds 透传（含 worldId 提取）、
    权限不足 403 亦留痕；**401 鉴权失败不计入**。每条记录带 `requestId`，与访问日志可对账。
    **不落 Prompt / 响应原文**（隐私边界）。
  - 管理监听端点：`GET /v1/admin/usage`（kind/status/route/model/capability/world_id/key_id/
    from/to 过滤 + summary + group_by + 分页；provider 由当前配置派生）。
  - Dashboard「AI 请求 · 24h」卡、Usage 页、AI Calls 页共用本数据面（前端 M2 同步接真）。
- **API Key 生命周期管理端点（M2.1）**：
  - `GET /v1/admin/keys`（脱敏投影，绝无 keyHash；status 筛选 + 分页）、
    `POST /v1/admin/keys`（明文仅创建响应一次；空 permissions 数组显式拒绝）、
    `PUT /v1/admin/keys/{id}`（撤销为终态；过期可设可清 `expiresAt`）。
  - `KeyStore.setExpiresAt(id, iso|null)` 新增；Phase 1 密钥纪律不变。
- **管线只读 + 有界试跑（M2.3）**：
  - `src/admin/pipelines.ts`：`PipelineStore`——`data/pipelines.json`
    （`PLATFORM_PIPELINES_FILE`）经 gateway `parsePipelineSpec` fail-fast 校验，每次请求
    读盘（手工编辑即生效）；坏文件 → 422 带逐条 issues；文件缺席 = 空清单。
  - `ManagedRuntime.runPipelineSpec`：受管配置 → 网关标签路由桥接（apiKeyRef 指向模型 ID、
    resolveEnv 桥接 SecretStore）；**出站校验同闸**（未过者剔除并留痕 `excludedModels`）；
    时延封顶 30s、调用数 ≤32 硬性封顶。端点：`GET /v1/admin/pipelines`、
    `POST /v1/admin/pipelines/{id}/test`（禁用管线 409 `pipeline_disabled`）。
- **配置**：`PLATFORM_USAGE_FILE`（缺省 `data/usage.jsonl`）、`PLATFORM_PIPELINES_FILE`
  （缺省 `data/pipelines.json`）；`run-managed.mjs` 装配新端点并在退出时 flush 用量记录。

### Fixed
- 公共端口 `/v1/admin/*` 维持 501 占位不变；管理面继续只经 loopback 管理监听
  （令牌 + Origin + 1MiB 体限既有姿态）。

### 决策记录（对应路线图 §3 决策点 1/2）
- Pipelines：只读展示 + 有界试跑落地，编辑器不做；spec 独立文件、不重开 ModelConfig。
- Extensions 三页：按诚实原则下线（引擎无规则清单端点、数据形状无对应概念），见
  docs/ADMIN-API-MAPPING §5e。

## [0.1.0] - 2026-09-30 · Phase 1 · 平台 API 标准化 + Model Control Plane

- Public API v1：`/v1/models`（只暴露 world-agent）、`/v1/chat/completions`（world-agent
  管线 + 保真代理）、`/v1/worlds*` 鉴权透传引擎；API Key 鉴权（SHA-256 + 前缀，明文仅一次）。
- world-agent 管线：世界上下文 → 任务分析 → 六能力路由（冷却 + fallback）→ 网关调用。
- Model Control Plane（受管模式）：版本化 ModelConfig（If-Match / .bak 回滚）、AES-256-GCM
  凭证库、受管 Gateway/Platform 双快照热替换、出站 SSRF 双闸、有界实测端点。

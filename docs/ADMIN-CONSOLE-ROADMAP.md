# Admin Console Roadmap（管理后台开发规划）

> 制定日期：2026-09-30 · 依据：ADMIN-ARCHITECTURE / ADMIN-API-GAP / ADMIN-API-MAPPING /
> ADMIN-PERMISSION / ADMIN-TEST-REPORT / PLATFORM-PHASE1-REPORT /
> `superpowers/plans/2026-09-30-model-control-plane.md`（已完成）
> 当前定位：**✅ 规划全部完成（2026-10-01）。M1–M5 五个里程碑全部落地：管理后台
> 24 页全部真实或下线、admin 数据 Mock 清零、生产构建零假路由、Playwright 生产
> 冒烟纳入流程、Docker Compose 部署定型（docs/DEPLOY.md）。本文件转为存档——
> 后续运营性工作（引擎公共面鉴权、应用级日志管道、SavePort 持久化世界宿主、
> 平台 Phase 2 租户体系）见各文档遗留标注，不在本规划范围内。**

---

## 0 · 当前基线盘点（M5 完成后终版）

| 模块 | 状态 | 证据 |
|---|---|---|
| world-engine 内核 | ✅ V1.0 定型（1.0.3：G1 软暂停/恢复/关闭 + emitEvent 记账修复） | 90 用例；CHANGELOG 1.0.0–1.0.3 |
| world-gateway | ✅ OpenAI 兼容 + 模型路由 + 多模型管线 | 27 用例；V0.5–V0.7 |
| world-memory | ✅ 纯库 + HTTP 适配层 | 15 用例；V0.8.1 |
| platform（Phase 1 + M2–M5） | ✅ 公共 API / 用量数据面 / 管线试跑 / 会话与用户设置 / 可观测聚合 / 容器化部署支撑 | 122 用例；CHANGELOG 0.1.0–0.4.1 |
| Model Control Plane | ✅ 全部真实（含回滚 UI 入口） | `platform/src/admin/*`；G1/G6/G8/G9(管理面) 落地 |
| admin-web | ✅ 24 页全部真实或下线 / 生产冒烟 `pnpm test:e2e` 通过 / 零 Mock | M5 逐页验证 |
| 部署 | ✅ deploy/ compose 全栈 + docs/DEPLOY.md（镜像待有 Docker 主机实测） | M5.3 |

**admin-web 真实 / Mock 分界（终版）：全部页面真实或下线；`/admin-api` 数据 Mock 清零；
生产构建零假路由（实测）。**
对应缺口台账：G1 ✅ / G2 ✅ / G3 ✅ / G4 ✅ / G5 ✅ / G6 ✅ / G7 ✅ / G8 ✅ /
G9 管理面 ✅（引擎公共面鉴权 = 引擎侧独立工作项）。

---

## 1 · 总体思路

1. **真实化优先**：按「只读 → 管理面 → 鉴权 → 聚合」顺序逐页去 Mock；切换点全部收敛在
   `src/api/*`，页面无需改动（既有架构红利）。
2. **诚实原则**：每去一处 Mock，同步删除对应 `mock/admin/*.ts` 数据与 `enableProd` 残留；
   暂时无法真实化的页面宁可下线也不留假数据。
3. **零 Core 改动优先**：M1/M2 全部在 HTTP 适配层与平台侧完成；唯一可能触碰引擎语义的
   G1（暂停/恢复/关闭）单独放 M4，先评审后动手。
4. **每里程碑独立可验收**：静态检查 + 构建 + 页面级回归 + mock 文件清点，基线只增不减。

---

## 2 · 里程碑

### M1 · 只读数据面真实化（零 Core 改动，收益最大）—— ✅ 已完成（2026-09-30）

> 落地记录：引擎 86（73 基线 + 13 新增）/ 记忆 15（8 + 7）/ 平台 84 / 网关 27 全绿；
> `mock/admin/memory.ts` 已删除，Memory 4 页 + Scheduler + Monitor 队列/Last Command +
> 三派生视图（服务端分页）+ 命令历史 + 世界元数据全部接真；
> 引擎 1.0.1 / memory 0.8.1（CHANGELOG 均有条目）；演示宿主 `scripts/run-demo-memory.mjs`，
> dev-stack 一键拉起 engine(8787) + memory(8789)。详见 ADMIN-API-GAP / ADMIN-API-MAPPING。

> 依据 ADMIN-API-GAP 优先级建议：G7 / G4 / G3 / G5 / G2 均为只读暴露或登记层挂载。

| # | 工作项 | 缺口 | 后端 | 前端落点 |
|---|---|---|---|---|
| M1.1 | Memory HTTP 适配层（模式同 engine http）：stores / records（分页筛选）/ retrieval 调试 / embedding 统计 | G7 | `world-engine/memory` 新增 http 子路径 | `api/memory.ts` 接真；Memory 4 页去 Mock |
| M1.2 | Scheduler 观测：bus 已有 `stats()/deadLetters()/deferredEvents()`，HTTP 层暴露 | G4 | `GET /v1/worlds/{id}/scheduler` | Scheduler 页（现为缺口占位）+ Monitor 事件队列 |
| M1.3 | 实体/地点/关系独立端点（分页 + 筛选 + 单实体详情），替代前端全量派生 | G3 | `GET /v1/worlds/{id}/entities|locations|relations` | `api/entity|location|relation.ts` 改真实；解决已知问题 #3 |
| M1.4 | 命令历史环形缓冲（Runtime 侧记账） | G5 | `GET /v1/worlds/{id}/commands?n=50` | 命令调试台历史、Monitor Last Command |
| M1.5 | 世界元数据（name/description/createdAt/updatedAt，注册表层挂载） | G2 | `WorldInfo` 扩展或 `/meta` | 世界列表列、创建表单字段 |

**DoD**：Memory 4 页 + Scheduler 真实数据；三个派生视图改服务端分页（大世界可用）；
`mock/admin/memory.ts` 删除；引擎 73 / 平台 36+ 基线全绿，新增端点带协议测试。

### M2 · Gateway 管理面收口与计量（平台侧）—— ✅ 已完成（2026-09-30）

> 落地记录：引擎 86 / 网关 27 / 记忆 15 / 平台 107（84 基线 + 23 新增）/
> admin-web 7 全绿；四包 typecheck + 双端构建通过；`mock/admin/gateway.ts`
> 与 `mock/admin/extensions.ts` 已删除；页面级抽测通过（dev-stack 全栈 +
> 浏览器逐页 + 计量对账实测）。
> M2.1 Keys 三端点接真（明文仅一次/撤销终态/过期可清，regenerate 与 disabled
> 随真实语义移除）；M2.2 新建平台用量数据面（JSONL 轮转 + 纯查询聚合，
> protocol/server 全挂点计量，requestId 与访问日志对账；不落 Prompt/响应原文），
> Usage 页 + Dashboard「AI 请求」卡 + AI Calls 页共用；M2.3 按决策点 1 落地
> 「只读展示 + 有界试跑」（`data/pipelines.json` + gateway parsePipelineSpec
> 校验 + 受管配置桥接网关标签路由，出站校验同闸、时延 ≤30s/调用 ≤32 封顶，
> 编辑器不做）；M2.4 按决策点 2 下线 Extensions 三页（引擎无规则清单端点且
> 数据形状无对应概念，路由/视图/api/mock 全清，见 ADMIN-API-MAPPING §5e）。
> 附带修复 M1 遗留：引擎 HTTP 适配层 `dy.rels` 单边形状被静默丢弃（relations
> 双视图对声明形状返回空），现单边/数组都接受——引擎 1.0.2，恢复 typecheck 门禁。

| # | 工作项 | 缺口 | 说明 |
|---|---|---|---|
| M2.1 | API Key 生命周期上管理台：platform KeyStore（已有文件级实现）经管理监听暴露创建（明文仅一次）/ 撤销 / 过期 / 脱敏列表 | G6 残留 | `api/apiKey.ts` 接真；沿用 Phase 1 密钥纪律 |
| M2.2 | 用量计量数据面：平台访问日志 + 路由留痕 → 结构化用量记录（先 JSONL，量级需要再 SQLite）→ 聚合端点（按 key/world/model/capability/天 分组） | G6/G8 前置 | Usage 页 + Dashboard「AI Requests」卡 + AI Calls 页共用同一数据面 |
| M2.3 | Pipelines 页决策（见 §3 决策点 1）：优先「真实管线 spec 只读展示 + 有界试跑」，编辑器不做 | G6 | gateway V0.7 已有 `createPipeline` 执行器，受管模式未接 |
| M2.4 | Extensions / Rules 页决策（见 §3 决策点 2）：接 definition 真实只读，或下线 | — | 现为纯 Mock |

**DoD**：Gateway 六页全部真实或移除，`mock/admin/gateway.ts` 删除；用量记录与路由日志可对账。✅

### M3 · 鉴权、会话与系统页（G9 最小真实版）—— ✅ 已完成（2026-09-30）

> 落地记录：平台 118（107 + 11 新增）/ admin-web 7 全绿；四包 typecheck + 构建通过；
> DoD 实测：真实登录（admin/operator/viewer）、viewer 会话直访写端点 403
> （经代理与直访 8791 双路径）、直访无凭证 401、主令牌运维通道 200。
> M3.1 真实会话（不透明随机令牌，12h/刷新轮换 7d/登出吊销；login/refresh 响应形状
> 与原 Mock 一致——前端零改动替换；登录失败全局节流 60s≥10 次 → 429；
> `mock/login.ts`、`mock/refreshToken.ts` 删除）；M3.2 服务端权限强制（管理监听全部
> 写端点按 `gateway:manage`/`system:manage` 闸门，viewer 直访实测 403；主令牌等同超权，
> 运维通道保留）；M3.3 本地三档用户（决策点 3 采纳：scrypt 存储 `data/users.json`，
> 首次启动播种公开文档默认口令并显著告警；改角色/重置口令/停用即时吊销该用户全部
> 会话；末位 admin 保护；无删除——停用代替）；M3.4 设置持久化（白名单目录 8 项 +
> 类型/范围校验，`data/settings.json`；各项 description 诚实标注生效口径——M3 交付
> 持久化，运行时行为项随 M4/M5 接线）。
> 前端配套：代理改**会话感知注入**（Vite dev 与 Nginx 模板：浏览器带 `x-admin-session`
> 时不注入主令牌，服务端按角色强制）；Users/Permissions/Status 页接真（Status 服务
> 连通性为四代理真实探测）；`mock/admin/system.ts` 删除。
> 诚实边界：引擎/Gateway 公共 HTTP 面仍无鉴权（127.0.0.1-only 是唯一防线，已知
> 问题 #4）——管理面会话不覆盖引擎直连流量，引擎侧鉴权中间件属引擎里程碑，不在本
> 后台规划内。

| # | 工作项 | 说明 |
|---|---|---|
| M3.1 | 登录去 Mock：管理监听签发真实会话（JWT/Session），`mock/login.ts` 删除；`control-api` 服务端注入令牌模式保留不变 | 浏览器不持有任何平台凭证 |
| M3.2 | 权限码落地到端点：按 ADMIN-PERMISSION 目录，viewers 只能获得只读会话；`world:write` / `command:execute` / `gateway:manage` 等在平台侧校验 | 菜单隔离之外增加服务端强制（当前唯一防线是 127.0.0.1） |
| M3.3 | 用户/角色最小实现：本地两~三档用户（admin / operator / viewer），文件或 SQLite 存储；完整用户 CRUD 与多租户推迟到平台 Phase 2（见 §3 决策点 3） | 权限码目录不变，未来租户体系直接复用 |
| M3.4 | Settings 页真实化：平台配置子集（轮询间隔、默认世界、日志级别等）持久化 | `api/system.ts` 接真 |

**DoD**：无 Mock 登录；viewer 会话直访写端点实测 401/403；`mock/admin/system.ts` 删除。✅

### M4 · 可观测性聚合与世界生命周期（G8 + G1）—— ✅ 已完成（2026-09-30）

> 落地记录：引擎 90（86 + 3 生命周期 + 1 回归）/ 网关 27 / 记忆 15 / 平台 122
> （118 + 4）/ admin-web 7 全绿；四包 typecheck + 构建通过；`mock/admin/
> observability.ts`、`dashboard.ts`（及随之失去引用的 `_utils.ts`）删除——
> **admin 数据 Mock 全部清退**。
> M4.1 四个 obs 端点接真（logs = M2.2 数据面投影；events = 引擎跨世界只读聚合；
> errors = 失败请求只读登记——Mock 时代的确认/解决工作流无真实支撑已移除；
> overview = Dashboard 聚合，`/v1/obs/ai-calls` 由既有 usage 端点承担不重复建）；
> Observability 四页 + Dashboard 全真实（六卡零 Mock；活动图诚实为 AI 调用单序列
> ——世界事件无墙钟时间；记忆条目卡由前端直读 /memory-api）。
> M4.2 按纪律先出评审记录（`docs/G1-PAUSE-DESIGN-REVIEW.md`）再动引擎：
> 软暂停/恢复/关闭零 Core 落地（HTTP 适配层闸门 + V0.9 既有 registry.close()；
> `WorldInfo.status` 可选字段），决策点 4 的答案=软暂停够用、Runtime 级 pause 不做；
> 世界列表/Monitor 暂停/恢复/关闭按钮恢复并接真，浏览器实操作验证（暂停 → 列表
> paused 标签 → 恢复 → running；关闭 → 从清单消失）。
> M4.3 验证中发现并修复两个真实缺陷：前端 `buildCausalChain` 字段名错误
> （parent → parentId，因果链 UI 从未真正可用）与引擎 `emitEvent` 事件环双记账
> （同一事件在 GET events 出现两份）；演示宿主以公开 API 串联三级因果链
> （talk_started → social_mood_shift → narrative_hook_opened），浏览器验证
> 因果链 UI 全链路渲染。

| # | 工作项 | 缺口 | 说明 |
|---|---|---|---|
| M4.1 | 可观测聚合服务（平台侧）：`/v1/obs/logs`、`/v1/obs/events?world=`、`/v1/obs/ai-calls`（吃 M2.2 数据面）、`/v1/obs/errors`、`/v1/overview` | G8 | Logs / 事件流 / Errors / Dashboard 聚合指标真实化 |
| M4.2 | 世界生命周期：引擎侧评审暂停语义 → 软暂停先行（拒绝 advance_time 之外的推进），再评估 Runtime pause/resume/close | G1 | **唯一可能触碰 Core 的工作项**：先出设计评审记录（BLOCKERS 纪律同款），再动引擎；完成后恢复世界列表/Monitor 的暂停关闭按钮 |
| M4.3 | 事件因果链真实数据验证（引擎已支持 parent/rootCause，演示数据未串联） | 已知问题 #5 | 与 M4.1 一并验证链 UI |

**DoD**：Observability 四页 + Dashboard 全真实；世界可暂停/恢复/关闭并反映到列表状态；
`mock/admin/observability.ts`、`dashboard.ts` 删除。✅

### M5 · 生产化收口 —— ✅ 已完成（2026-10-01 · 规划全部完成）

> 落地记录：M1–M5 全部完成，**admin 数据 Mock 清零、生产构建零假路由**。
> M5.1：vite-plugin-fake-server 插件与 `mock/` 全部移除（`/get-async-routes` 改前端
> 静态空路由——菜单全部来自 src/router/modules）；生产构建实测零 `fake-server`、
> 零 `admin-api` 引用；MockTag 组件此前已随 M2–M4 逐页清零。
> M5.2：Playwright 冒烟落地（`admin-web` `pnpm test:e2e`）——编排器拉起脚本化上游
> + 引擎演示宿主 + 受管平台（临时数据目录）+ **生产构建的 vite preview**，
> 对生产构建跑全流程：登录 → 世界详情 → 执行命令（advance_time）→ 修改路由
> （保存 revision+1）→ 回滚（revision+2），已跑通（6.2s passed）；
> 顺带补齐路由页缺失的「回滚上一版」按钮（MCP Task 5 要求项，此前仅有 API 无 UI 入口）。
> M5.3：`deploy/` 部署定型——Dockerfile.base（全栈运行时镜像：引擎/记忆/平台三服务
> 复用）+ Dockerfile.admin（前端构建 + Nginx 同源反代）+ docker-compose.yml
> （数据卷持久化平台全部状态；管理监听跨容器可达新增显式逃生阀
> `PLATFORM_ADMIN_ALLOW_NON_LOOPBACK=1`，启动大声告警、隔离责任移交部署层；
> 8790/8791 仅绑宿主回环、对外只暴露 8080）+ `docs/DEPLOY.md` 从零拉起指南
> （密钥生成 / 首次上线清单 / TLS / 备份）。**诚实标注：本机无 Docker，镜像构建
> 未实测，首次执行按报错微调。**
> M5.4：已知问题清零复查（TEST-REPORT 八节逐条标注：1/3/4半/5 已关，2 维持停用；
> 遗留半项=引擎公共面鉴权，引擎侧独立工作项）+ 全部文档同步。

| # | 工作项 | 说明 |
|---|---|---|
| M5.1 | Mock 全清退：`enableProd` 关闭并删除全部残留 mock 文件；页面 Mock 提示条随真实化逐页移除 | 已知问题 #1 |
| M5.2 | Playwright 冒烟 CI：登录 → 世界详情 → 执行命令 → 修改路由 → 回滚（复用 e2e-fake-upstream 脚本化上游） | ADMIN-TEST-REPORT 建议 #4 |
| M5.3 | 部署定型：Nginx 同源反代（world-api / control-api / 公共 API 三路由）+ TLS 文档；Docker Compose 全栈（engine + gateway + platform + admin-web） | Model Control Plane Task 5 已有底子 |
| M5.4 | 已知问题清零复查 + 文档同步（ARCHITECTURE/MAPPING/GAP 三份随每里程碑更新） | |

**DoD**：生产构建不含 fake-server ✅；冒烟 CI 纳入流程 ✅（`pnpm test:e2e`）；
一台新机器按文档可从零拉起全栈 ✅（`docs/DEPLOY.md`，镜像构建待有 Docker 的主机实测）。✅

---

## 3 · 决策点（启动对应里程碑前确认）

1. **Pipelines 页去留**（M2.3）—— ✅ 已决策（M2 落地）：做「真实管线 spec 只读展示 +
   有界试跑」。spec 存 `data/pipelines.json`（不经 ModelConfig，避免重开已完成的
   配置面）；试跑经受管配置桥接网关标签路由，与受管模式不冲突——能力路由管
   world-agent，管线是 gateway 侧编排面，两者并存在文档中明示。编辑器不做。
2. **Extensions / Rules 页去留**（M2.4）—— ✅ 已决策（M2 落地）：下线。引擎无运行时
   规则清单端点，且 Mock 数据模型（扩展分组/启停/优先级）在引擎中无对应概念；
   按诚实原则移除路由/视图/api/mock，不留假数据。未来引擎提供清单 API 可恢复。
3. **用户体系最小档位**（M3.3）—— ✅ 已决策（M3 落地）：「本地三档用户 + 文件存储」。
   scrypt 加盐哈希存 `data/users.json`，首次启动播种三档内置账号（公开文档默认口令 +
   控制台告警）；完整用户系统 / 租户 / 配额留给平台 Phase 2 统一设计，避免两套用户表。
4. **G1 暂停语义**（M4.2）—— ✅ 已决策（M4 落地，评审记录
   `docs/G1-PAUSE-DESIGN-REVIEW.md`）：软暂停（HTTP 适配层拒绝 commands/time）已够
   管理后台使用，Runtime 级 pause 不做；关闭 = V0.9 既有 `registry.close()` 的 HTTP
   暴露；暂停状态进程内（重启即解除），未来持久化世界如需跨重启暂停走
   `state.metadata` 通道。

## 4 · 明确不做（维持既有边界）

- 玩家端、NPC 聊天、地图编辑器、DAG 编辑器（方案 §27）；
- native Anthropic 协议、embeddings 路由、预算/优先级强制执行（Model Control Plane 出界项）；
- 多租户 / 配额 / 限流 / 审计（平台 Phase 2 与 Phase 9/10，另行排期）；
- PostgreSQL / Redis 持久化升级（平台 Phase 8，SavePort 端口已就位，属运营工程）；
- 天穹正式接入与 SillyTavern 兼容性验证（平台 Phase 6-7，独立于本后台规划）。

## 5 · 回归门禁（每里程碑固定动作）

1. `tsc --noEmit`（engine / memory / platform / admin-web 双端）+ `vite build` 全绿；
2. vitest 基线只增不减：引擎 90 / 网关 27 / 记忆 15 / 平台 122 / admin-web 7（M4 后）；
3. 页面级回归：本里程碑涉及页面逐一浏览器抽测（三态、轮询、权限可见性）；
4. Mock 清点：`mock/admin/` 文件数与本里程碑清退清单一一对应；
5. 文档同步：ADMIN-API-GAP 对应条目标注落地版本，ADMIN-API-MAPPING 更新端点映射。

## 6 · 顺序与理由

```text
M1 只读数据面 ──→ M2 Gateway 管理面/计量 ──→ M3 鉴权会话 ──→ M4 聚合/生命周期 ──→ M5 生产化
（零 Core 风险，    （全在平台侧，M2.2 计量     （公网部署安全前提，   （G8 吃 M2 数据面；      （收口清退）
 12 页 Mock 中       是 M4.1 ai-calls 的前置）    也给 M4 的写操作        G1 需引擎评审故后置）
 一半在此清退）                                    上权限闸门）
```

- M1 放最前：五个缺口全部「无需改 Core」，一次清退一半 Mock 页，后台观感提升最大；
- M2 紧随：全部工作在 platform 侧，与 M1 无耦合，可并行推进；
- M3 在 M4 之前：M4 的生命周期写操作与错误登记需要真实鉴权兜底；
- G1 是唯一触碰引擎语义的项，按项目纪律（§59 停止条件精神）单独评审、单独排期。

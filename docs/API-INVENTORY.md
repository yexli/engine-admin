# API-INVENTORY（QA-1.0 · Phase 3 资产，全量 73 条路由）

## 引擎 8787（16 HTTP + 2 WS；演示装配无鉴权，回环兜底；auth 中间件存在未接线）
| method path | 用途 | 幂等 | 写世界 | 前端调用 |
|---|---|---|---|---|
| POST /v1/worlds | 建世界（重复 409） | 否 | 是 | world.createWorld |
| GET /v1/worlds | 清单 | 是 | 否 | world/gameStudio/probe |
| GET /v1/worlds/:id | 信息 | 是 | 否 | world.getWorld |
| DELETE /v1/worlds/:id | 关闭 | 是 | 摘除 | world.closeWorld |
| POST .../pause · /resume | 软暂停（内存 pausedWorlds，重启即解） | 否(409) | 闸 | world.pause/resume |
| GET .../state | 全状态 | 是 | 否 | world/runtime |
| GET .../events?n≤500&filters | 事实窗口/全量史（log=1 或 filters → queryEvents） | 是 | 否 | world/event/runtime |
| POST .../commands | 命令链（白名单净化；commandId 幂等；暂停 409） | commandId | 经 Rules | command.executeCommand |
| GET .../commands?n | 命令历史（环 100） | 是 | 否 | command/world |
| GET .../scheduler?n | 总线观测 stats/scheduled/deferred/deadLetters | 是 | 否 | runtime |
| GET .../entities?page | 实体分页（type/q） | 是 | 否 | entity |
| GET .../entities/:eid | 实体详情 | 是 | 否 | entity |
| GET .../locations | 地点+驻留+unknown | 是 | 否 | location |
| GET .../relations | 关系表+边 | 是 | 否 | relation |
| POST .../time {ticks≥1} | 时间推进 | 否 | 是 | world/runtime |
| WS /v1/stream · /v1/worlds/:id/events/stream | 实时流（?replay=N） | — | 否 | observability/events |

## 平台公共口 8790（鉴权：API Key，权限 4 码）
| endpoint | 权限 | 说明 |
|---|---|---|
| GET /healthz、OPTIONS | 免 | 探活/预检 |
| GET /v1/models | Key | 只露 world-agent |
| POST /v1/chat/completions | chat:completions | world-agent 管线或保真代理；stream=true 400（world-agent） |
| POST /v1/embeddings | embeddings | 拒绝指定 model(400)；无路由 503；上游 502；fallback 自动接管 |
| /v1/worlds* 透传 | worlds:read/write | 租户隔离：清单过滤/建世界盖章/越权 404/引擎挂 502 |
| /v1/admin/* | Key | 501（管理面在 8791） |

## 平台管理面 8791（x-admin-token 或会话；Origin 回环校验；1MiB 限）
model-config GET(认证)/PUT(422 校验+409 If-Match+热替换)/rollback；providers/:id/credential PUT；models/:id/test（embedding 标签→embed 语义+dimension）；routes/:cap/test（503 无 primary）；routes/:cap GET（实况）；keys GET/POST/PUT(:id 过期;status→400)/DELETE；usage GET（kind 枚举现仅 chat/worlds → #1）；pipelines GET/test（409 禁用）；session login(免,节流 429)/refresh(免)/logout/me；system users GET/POST/PUT（停用/改密即吊销会话）/permissions/settings GET/PUT；obs logs/events/errors/overview GET；admin/runtime GET；npc schedules GET/PUT/DELETE（宿主用）；evolution worlds GET /:id/tick POST(gateway:manage,可真实 AI+写世界)/intent POST(ic/ooc/narrative)/runs GET /runs/:rid GET /:id/events/:eventId/trace GET（八环）。

## 记忆 8789（无鉴权只读面）
stores GET；records GET（分页 pageSize camelCase）；retrieval POST（query≤512/topK≤50）；embedding GET（attached/维度/dimensionChanged）；embedding-config GET|PUT|test → **410 gone**。

## 天穹宿主 8795（无鉴权，参考宿主）
healthz/schedule/view/events GET；input POST（意图解析→命令，等演化反应）。

## 无 UI 入口端点
引擎 WS 单世界流；8790 全部（admin-web 走 world-api 直连引擎）；管理面 session/me、admin/runtime、npc schedules、evolution/:id；memory 410；天穹全部 —— 消费方为宿主脚本/验收脚本/外部 API 使用者（非死代码，记录为 UI 缺口或设计边界）。

## 无鉴权写端点（部署红线记录）
引擎 8787 全部写（演示装配 auth 未接线，127.0.0.1 兜底）｜memory retrieval｜tianqiong/input｜管理面 login/refresh（设计免鉴权，节流+Origin 校验）。

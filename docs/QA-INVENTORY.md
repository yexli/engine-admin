# QA-INVENTORY（QA-1.0 · Phase 1 资产盘点）

> 基线：commit beaa947（gitee master / github main 同步）；栈 = dev-stack 六服务全绿（8787/8789/8790/8791/8795/8848）。
> 测试账号：admin/admin123（system:manage + gateway:manage 全权）、operator/operator123、viewer/viewer123；平台 bootstrapKey（dev-env.json）。

## 一、页面清单（35 路由 / 30 实页面）

| 路由 | 页面 | 角色 | 核心 API | 核心按钮 | 待测重点 |
|---|---|---|---|---|---|
| /login | 登录 | 免 | session/login | 登录/主题切换 | 错凭据 200+success:false、节流、防重复提交 |
| /dashboard | 总览 | 全 | obs/overview、memory stores、worlds | 轮询开关/查看全部/详情 | 引擎不可达兜底、空态 |
| /worlds/list | 世界列表 | 全 | worlds CRUD+time/pause/resume | 创建/推进/暂停/恢复/关闭 | labelsJson 校验、409 语义、错误提示口径 |
| /worlds/detail/:id | 世界详情 | 全 | 聚合 | 返回/8 tab | 头部状态恒 assumed-running（已知问题 #8） |
| /runtime/state·entities·locations·relations·events·scheduler | 运行面×6 | 全 | state/entities/locations/relations/events/scheduler | 刷新/筛选/分页/抽屉 | 空态/错误重试/前端过滤 |
| /runtime/commands | 命令调试台 | admin,operator | commands POST/GET | 执行(danger+confirm)/重置/回填 | 12 命令目录、payload 单层校验、commandId |
| /runtime/monitor | 运行监视 | 全 | runtime summary+time+pause | 推进时间/暂停恢复（world:write） | 轮询 5s、跳转链接 |
| /gateway/games | 游戏方 | admin | worlds+keys 前端归组 | 刷新 | 双路聚合、空态 |
| /gateway/providers | 供应商 | admin | model-config/credential | 新建/凭证/启停/删除/保存 | 新建禁用态、无凭证禁启用、If-Match 409 |
| /gateway/models | 模型 | admin | model-config+test | 新增(类型切换/标签互斥)/实测/启停/删除 | 嵌入专属适配三处、实测按类型选语义 |
| /gateway/router | 模型路由 | admin | model-config/rollback/routes test | 测试/清空/回滚/保存 | 13 能力、清空无确认（#9）、真实 fallback |
| /gateway/pipelines | 管线 | admin | pipelines+test | 有界试跑 | 试跑真实调用、 DAG 着色 |
| /gateway/keys | API 密钥 | admin | keys CRUD | 创建/过期/删除/复制明文 | 明文一次性、status 400、gameId |
| /gateway/usage | 用量 | admin | usage(kind=chat) | 刷新/重置 | **kind=embeddings 不可见（#2）** |
| /memory/stores·records | 记忆库 | 全 | stores/records | 刷新/筛选/抽屉 | 分页 pageSize(camelCase) |
| /memory/retrieval | 检索调试 | admin,operator | retrieval | Search | 评分/语义召回（经 Router） |
| /memory/embedding | 向量嵌入诊断 | 全 | embedding info + routes/embedding + test | 测试/前往模型路由 | 实况/维度变化告警/无配置表单 |
| /observability/logs·events·ai-calls·errors | 观测×4 | 全 | obs/*、WS /v1/stream | 刷新/轮询/实时(WS)/抽屉 | kind 过滤（#2）、WS 断线回落 |
| /evolution/console | 演化控制台 | admin,operator | evolution tick/intent/runs/trace | 演化一次/提交意图/查因果 | 真实 AI 闭环、OOC 隔离、trace 八环 |
| /system/users·permissions·settings·status | 系统×4 | admin | system/*、probeServices | 新增/编辑/停用/保存 | 角色矩阵、末位 admin 保护、服务探测 |
| /error/403·404·500 | 异常页 | 免 | — | 返回首页 | — |

按钮权限指令共 4 类：gateway:manage / command:execute / world:write / system:manage（无权限时 DOM 移除）。

## 二、模块清单（职责/入口/存储/Runtime 依赖）

| 模块 | 职责 | 入口 | 存储 | Runtime 依赖 |
|---|---|---|---|---|
| world-engine Core | 命令→Rules→Mutation→Event | 8787 HTTP/WS | FileSavePort(演示栈未接)/进程内 | 无外部 |
| platform 公共口 | 鉴权/计量/透传/embeddings 单源 | 8790 | usage.jsonl | ModelRouter+网关 |
| platform 管理面 | 配置/Key/观测/演化触发 | 8791 | model-config/secrets/keys/users/sessions/settings/schedules/evolution/*.jsonl | swapTo 热替换、四 runtime |
| gateway | 物理模型出站 | managed 内嵌 | — | providers 注册表 |
| memory | 4 因子召回+向量 | 8789+平台内嵌 | platform/data/memory/*.json | EmbeddingService→Router |
| evolution/trigger/schedule | AI 闭环/唤醒/确定性日程 | platform 进程内 | evolution/*.jsonl、schedules.json | engine client + Router + driver |
| admin-web | 管理台 | 8848(vite) | — | control-api/memory-api/world-api/gateway-api |
| 天穹宿主 | 参考游戏 | 8795 | — | 引擎+管理面 |

## 三、已知问题预登记（详见 QA-ISSUES.md）
#1 usage kind=embeddings 查询裂缝（P2）｜#2 EmbeddingInfo 类型缺字段（P2）｜#3 pointers.aiCalls 悬空（P3）｜#4 router 页"六能力"陈旧文案（P3）｜#5 evolution IC 硬编码 text:"rain"（P3）｜#6 lay-notice 假通知（P3）｜#7 MockTag/world.ts 死导出/过期注释（P3）｜#8 detail 页 assumed-running（P3）｜#9 router 清空无确认（P3）｜#10 pipelines 试跑未包 Perms（P3，路由限 admin 实际低危）｜#11 引擎 8787 演示装配无鉴权（P2，回环兜底，已知边界）｜#12 演示引擎内存态重启丢档（P3，opt-in 持久化已具备）

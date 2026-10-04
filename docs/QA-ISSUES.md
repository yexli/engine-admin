# QA-ISSUES（QA-1.0）

> 状态标记：未修复 / 已修复；回归结果在修复后回填。分级：P0 致命 / P1 严重 / P2 一般 / P3 优化。

## [P2] #1 usage/obs 的 kind 枚举缺 `embeddings`：功能在跑但观测面"看不见"
- 模块：platform usage + admin-web
- 页面/API：GET /v1/admin/usage、/v1/obs/errors；usage.ts/logs.ts kind 类型
- 复现：POST /v1/embeddings 成功（usage.jsonl 出现 kind=embeddings 行）→ GET /v1/admin/usage?kind=embeddings → 400 malformed；AI Calls 页固定 kind=chat 永不含 embeddings
- 预期：embedding 调用可查询/可过滤/类型自洽
- 实际：recorder 写入 'embeddings'（recorder.ts:26），但 query.ts:21 类型与 http.ts:429/861 校验只认 chat|worlds；前端 usage.ts:13/logs.ts:27 同缺
- 根因：Embedding 统一治理新增 kind 时只改了写入侧，未贯通查询/展示侧
- 数据影响：无｜Runtime 影响：无｜是否涉及架构：否
- 修复状态：已修复（query/admin 校验/前端类型/Usage 页 kind 筛选贯通 embeddings）
- 回归结果：PASS（单测 + 实测 kind=embeddings 可查）

## [P2] #2 memory.ts `EmbeddingInfo` 类型缺 `engineDimension`/`dimensionChanged`
- 模块：admin-web 契约
- 页面/API：GET /memory-api/v1/memory/embedding ↔ api/memory.ts:106-120
- 复现：诊断页实况工作正常（后端真下发），但前端类型未声明，vue-tsc 严格模式会报错；按类型改代码会破坏维度告警
- 根因：memory 0.9.0 新增字段后未同步前端类型
- 修复状态：已修复（补类型 + 诊断页消费）
- 回归结果：PASS

## [P2] #11 引擎 8787 演示装配全部写端点无鉴权
- 模块：world-engine http + scripts/run-demo-engine.mjs
- 复现：无任何头 POST /v1/worlds → 201
- 预期：机制存在（auth 钥匙表 + gameId 隔离）但演示宿主未接线；仅 127.0.0.1 绑定兜底
- 根因：宿主集成示例省略鉴权装配（平台转发面已单点强制租户隔离；直连引擎是本地开发形态）
- 是否涉及架构：否（auth 能力已有，接线属部署层）
- 修复状态：不修复（记录为部署红线：对外部署必须启引擎鉴权或只经平台访问）——与 README 安全须知一致
- 回归结果：N/A

## [P3] #3 /v1/admin/runtime pointers.aiCalls 指向不存在的 /v1/admin/overview
- 根因：笔误；实际 /v1/obs/overview。修复状态：已修复｜回归 PASS

## [P3] #4 router 页 info 文案「六个能力固定」，实际 13 能力
- 修复状态：已修复（文案改 13 项 + 主/备均限启用模型说明）｜回归 PASS

## [P3] #5 evolution 控制台 IC 意图载荷硬编码 text:"rain"
- 复现：IC 分支选 advance_time/move → 发出的命令语义与所选不符（固定 change_weather text=rain）
- 根因：演示分支未按命令类型构造载荷。修复状态：已修复（按命令类型给载荷：advance_time→amount、move→targetId，text 仅 change_weather）
- 回归结果：PASS（实测 tick/intent 全链）

## [P3] #6 顶栏通知铃铛渲染脚手架假通知
- lay-notice/data.ts 硬编码"小铭/李白/2024-05"。修复状态：已修复（清空演示数据→空态"暂无消息"）
- 回归结果：PASS

## [P3] #7 死代码/过期注释清理
- world.ts 三个死导出（getWorldEvents/executeWorldCommand/getCommandHistory 重复版）、types.ts WorldRuntimeStatus 过期注释、MockTag 全局死挂载。修复状态：已修复（删除/收敛）
- 回归结果：PASS（admin-web build 通过）

## [P3] #8 /worlds/detail 头部状态恒 assumed-running
- 已知展示缺陷（status 不联动 pause）。修复状态：未修复（P3，本轮不处理 UI 状态联动；记录）
- 说明：list/monitor 页状态徽标已动态，detail 页遗漏

## [P2] #14 Trigger 冷却窗口吞高优玩家事件（已修复）
- 模块：platform evolution/triggerRuntime
- 复现：admin 手动 tick 点燃 30s 冷却 → 冷却窗内玩家 High 事件（对话）到达 → markSeen 先于冷却检查，事件被标记已消费 → 冷却结束后永不补跑（复现 1/1）
- 预期：冷却只是延迟，事件应在其后执行
- 实际：Trigger 计数 cooldownSkips++ 但事件已从 seen 中消失
- 根因：「先标记后处理」顺序错误
- Runtime 影响：高优玩家交互的演化响应丢失（静默）
- 修复：改为「先看后吃」——只有策略性不唤醒（非 High/无人值得唤醒/无玩家发起）才消费；冷却跳过的批次不消费，到期后下一轮 poll 自动重试（triggerRuntime.ts consume()）
- 修复状态：已修复｜回归结果：PASS（实测：冷却窗注入对话 → 冷却过期后 auto run 补跑 completed，evo_muthuklu_8013dc98）

## [P3] #9 router 页「清空」无二次确认（直接改草稿）
- 缓解：仅脏草稿语义 + 保存需 If-Match。修复状态：未修复（P3 记录）

## [P3] #12 演示引擎进程内存态：重启丢档（多代世界语义）
- V2.4-01 已提供 opt-in 持久化（WORLD_ENGINE_DATA_DIR）；dev-stack 演示形态保持内存。修复状态：不修复（设计边界，文档已明示）

## [P3] #13 useModelControl 保存成功提示的 revision 为预计算值
- 保存跨多 revision 时提示错值（仅文案）。修复状态：未修复（P3 记录）

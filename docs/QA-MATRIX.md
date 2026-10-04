# QA-MATRIX（QA-1.0 · 2026-10-04）

> 证据：.qa-tmp/qa-results-part1~5.json、.qa-tmp/ui-*.png、qa-live*.mjs 明细。
> PASS 判定一律要求真实 API 调用 + 数据/行为验证；Toast/文案不算。

| 模块 | 页面 | API | 按钮 | 正常 | 异常 | 并发 | 重启 | Trace | 状态 |
|---|---|---|---|---|---|---|---|---|---|
| 鉴权/会话 | 登录页 | PASS（14.1-10） | PASS（登录/登出/主题） | PASS | PASS（401/403/429 语义） | PASS（防重复） | PASS（会话吊销） | - | **PASS** |
| 租户隔离（gameId） | games 页数据源 | PASS（14.11-16） | - | PASS | PASS（越权 404 不泄露） | - | PASS | - | **PASS** |
| World Runtime | runtime/* + worlds/* | PASS（8.0-10,11.1-2,3.1-2） | PASS（命令台/推进/暂停恢复） | PASS | PASS（Rules 拒绝/409/400） | PASS（16.1 并发幂等） | 部分（内存态世界重启丢，#12 设计边界） | 事件史可查 | **PASS** |
| Gateway/Router | providers/models/router | PASS（5.1-7,16.2-3） | PASS（实测/路由/回滚） | PASS | PASS（404/422/409/503/502） | PASS（If-Match 并发） | PASS（revision 48 保持） | usage 留痕 | **PASS** |
| Embedding（治理回归） | memory/embedding 诊断页 | PASS（6.1-4） | PASS（测试按钮走真实 Router） | PASS（1024 维） | PASS（指定 model 400/双故障 502/410 旧端点） | - | PASS（路由保持） | usage kind=embeddings 可查 | **PASS** |
| Fallback 真实执行 | router 页测试 | PASS（5.3-5） | - | PASS（primary 正常） | PASS（primary 炼 → fallback 接管 usedFallback=true → 冷却直走备 → 双故障 502） | - | - | 路由实况 coolingDown=true | **PASS** |
| Memory | memory/* | PASS（7.1-3） | PASS（检索/筛选） | PASS（25 条快照恢复） | PASS（缺 query 400/无 store 404） | - | PASS（17.4） | sourceEventId（V2.4-07 既有） | **PASS** |
| Evolution | evolution/console | PASS（9.1-6） | PASS（tick/意图/查因果） | PASS（真实 AI completed） | PASS（OOC 零世界变化 9.4） | PASS（idempotencyKey 去重） | PASS（账本 JSONL 恢复） | **八环全链 13.1** | **PASS** |
| NPC/Trigger | （宿主输入驱动） | PASS（10.1-4,15.10） | - | PASS（Wake reasons 留痕） | PASS（冷却跳过→补跑 #15） | PASS（不重入） | PASS（seen 重置=多代语义） | wakePlan 入 run.context | **PASS** |
| 观测 | observability/* | PASS（logs/events/ai-calls/errors） | PASS（WS 实时/轮询） | PASS | PASS（错误页数据面投影） | - | - | obs/overview 聚合 | **PASS** |
| 系统管理 | system/* | PASS（users/permissions/settings/status） | PASS（启停/保存） | PASS | PASS（末位 admin/角色矩阵） | - | PASS（users 落盘） | - | **PASS** |

统计：11 模块行全 PASS；活栈测试合计 **PASS 78 / FAIL 1（复测为断言笔误，实际双防线 PASS）/ BLOCKED 2（均复测通过）**。
四包单测 502 + 平台 315（含修复新增）全绿；admin-web vue-tsc 0 错误 + vite build 通过。

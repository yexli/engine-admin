# World Engine V2.3 发布说明（P0–P10 全链路）

> 发布日期：2026-10-03
> 一句话：**「世界会动 → AI 推动世界 → NPC 自治 → 世界持续运行 → 天穹完整运行」五个里程碑全部达成**——真实玩家输入经意图/命令/规则/事实，驱动触发、唤醒、上下文（预算+记忆+目标）、真模型个体决策、围栏落地、事实消费的完整闭环，全程可观测、可追溯、有界、自愈。

## 版本矩阵

| 包 | 版本 | 测试 | 本轮新增 |
|---|---|---|---|
| world-engine（内核） | 1.2.1 | 108/108 | HTTP 建世界支持地点表（additive） |
| world-platform（平台） | 0.18.0 | 251/251 | Trigger / Context 预算 / NPC 个体决策 / 调度循环 / 记忆联动 / 能力路由 13 项 / Admin 观测面与因果链 / 多代世界语义 |
| world-gateway | 0.7.1 | 30/30 | —（能力路由/embed 通道既有能力收口） |
| world-memory | 0.8.2 | 20/20 | —（本轮正式接入平台决策回路） |
| **合计** | | **409 项全绿** | |

里程碑：M1 世界会动 ✓　M2 AI 推动世界 ✓　M3 NPC 自治 ✓　M4 世界持续运行 ✓　**M5 天穹完整运行 ✓**（P10 验收 30/30，见 docs/P10-ACCEPTANCE.md）

## 分阶段成果（P0–P10）

| 阶段 | 交付 | 关键件（入口） | 验收 |
|---|---|---|---|
| P0 | 全量实现审计 | docs/CURRENT_IMPLEMENTATION_AUDIT.md（逐模块证据到行号） | 337 项测试实跑 |
| P1 | 演化运行时封口 | 并发 tick 互斥；running 中间态落账；幂等账跨重启重建（Journal 权威） | platform 专项 8 条 + live 重启判重 |
| P2 | 天穹最小真实链路 | 参考宿主（scripts/run-tianqiong-host.mjs）；引擎地点表；商人/注意力/商店经济；无硬编码触发 | 走查 35 项 + 真模型八问因果链 |
| P3 | Trigger Engine | `assessWake` 逐实体唤醒（HIGH/MEDIUM/LOW/NONE + reasons）；双重成本闸门；平台内触发循环（`createTriggerRuntime`） | 同一事件 3 NPC 恰 1 次 AI 调用 |
| P4 | Context Engine | `ContextBudget` 五项预算（maxTokens/Entities/Events/Relations/MemoryItems）；七级优先序裁剪；budgetReport | 同一 NPC 四维差异 + 预算逐项 |
| P5 | NPC Runtime MVP | 焦点作用域（冷却/指纹按 world\|focus 分域）；个体决策；金币禁令（forbiddenAttributeKeys）；`buildNpcProfile` | 双唤醒不连坐 + 禁止清单逐项 |
| P6 | World Time / Schedule | `npc/calendar` 历法唯一口径；日程注册持久化（ScheduleStore + 管理面端点）；`createScheduleRuntime` 调度循环（**零 AI**） | 模拟连续 3 天四项全过 |
| P7 | Memory 联动 | `createWorldMemoryService`（感知边界派生/幂等摄取/持久化）+ `createMemoryRuntime`；个体决策 `memoryRetriever` → context.memory | **Memory ≠ 第二世界状态**（逐字节不变断言）+ live 模型引用记忆 |
| P8 | Model Adapter 收口 | 能力词表对齐方案 §十一（13 项）；受管网关 embed 通道；`createEmbeddingsClient`；记忆语义召回接线 | **换 Provider 零业务代码改动**（live 热切换+回滚） |
| P9 | Admin Runtime / Causal Trace | `GET /v1/admin/runtime` 统一观测面；因果链八环呈现；多代世界语义（seed 指纹三层自愈） | live：引擎重启平台零重启自愈 |
| P10 | 天穹完整真实验收 | `scripts/run-p10-acceptance.mjs`（可复跑 + 世界自举） | **30/30 PASS**（三维验收，docs/P10-ACCEPTANCE.md） |

## 核心链路（V2.3 形态）

```text
玩家输入「我想去酒馆找米露」
  → Tianqiong Intent（宿主确定性解析；OOC/叙事隔离）
  → move 命令 → 引擎 Rules → Mutation → player_moved 事实
  → 平台 Trigger Runtime（幂等消费 → 玩家归因 → High 分级 → 逐实体唤醒评估）
      无值得唤醒 → 零 AI 调用
  → 个体演化 tick（wakePlan 入账；Context = 全局+位置+在场实体+关系+预算裁剪+goal+记忆召回）
  → 真模型 JSON 提案（可空；记忆是主观回忆、与在场事实冲突以后者为准）
  → 三层围栏（策略白名单/禁触玩家/金币禁令 → 内核翻译 → Rules 终审）
  → Mutation → 新事实 → 因果链入账（八环可查）→ 天穹消费呈现
  ← Schedule Runtime 平行：时间事实 → 日程对齐（确定性，零 AI）
  ← Memory Runtime 平行：事实 → 感知边界派生 → 记忆摄取（幂等/持久化/new_day 衰减）
```

## 不变式（本发布的架构承诺）

1. AI 只能建议：全部世界变化经 Proposal → 白名单 → Rules；Runtime 无状态写入口（依赖形状保证）。
2. 空提案合法：玩家行动 ≠ NPC 必须响应（真模型多次验证）。
3. Memory ≠ 第二世界状态：摄取只读世界；记忆只进上下文作动机，关系数值仍由 Rules 决定。
4. 确定性行为归 Scheduler（零 AI）；AI 只在 Trigger 判定「真正需要判断」时被调用。
5. 失败/裁剪/未唤醒全部可见：running 留痕、budgetReport、worldResets、触发计数、写失败计数。
6. 换 Provider 零业务代码改动：业务面只见能力名（Admin 热替换 + 回滚）。
7. 引擎零运行时依赖、玩法语义不进 Core；平台与引擎保持 HTTP 进程边界。

## 接入方速查

- **起全栈**：`node platform/scripts/dev-stack.mjs`（引擎 8787 / 记忆 8789 / 平台 8790·8791 / 宿主 8795 / 控制台 8848）
- **验收**：`node scripts/run-v21-walkthrough.mjs`（35 项冒烟）→ `PLATFORM_ADMIN_TOKEN=… node scripts/run-p10-acceptance.mjs`（30 项全链验收，自举重置世界）
- **观测**：`GET :8791/v1/admin/runtime`（单点）；因果链 `GET :8791/v1/evolution/worlds/:id/events/:eventId/trace`
- **日程注册**：`PUT :8791/v1/npc/worlds/:id/schedules`（游戏数据归宿主，确定性执行归平台）
- **环境变量**（新增）：`PLATFORM_TRIGGER_WORLDS` / `PLATFORM_TRIGGER_INTERVAL_MS` / `PLATFORM_MEMORY_WORLDS` / `PLATFORM_MEMORY_INTERVAL_MS` / `PLATFORM_SCHEDULE_INTERVAL_MS` / `PLATFORM_SCHEDULES_FILE` / `PLATFORM_EVOLUTION_CAPABILITY`
- **世界重建自愈**：引擎重启后平台自动检测（seed 指纹）并重置消费集——无需重启平台。

## 已知边界（诚实清单，P11+ 议题）

1. 引擎事件持久化未闭环（loadWorldLog 零调用）——重启丢事件史（状态与记忆/账本均持久）。
2. 宿主与平台各持一份日程数据副本（走查断言钉住一致）。
3. tianqiong 真实游戏本体仍为进程内接入，未走网络闭环。
4. 记忆语义召回为词面+可选向量；向量入库/索引未做（检索时现场计算）。
5. 传闻传播（spreadRumor）无社交事件源；talk/trade 等 NPC 动作按方案留后续批次。
6. Admin Web 能力配置 UI 仍为旧六项（API 已 13 项）；观测面无 UI 页。
7. 个体 tick 串行执行；多世界规模化的事件订阅（WS 化）属压测议题。

## P11 附录（2026-10-03 增补）：100 NPC 压力测试

**核心论题成立 ✓：AI 调用 10NPC→1 次、50NPC→1 次、100NPC→1 次**（每 NPC 占比 1%→0.02%→0.01%）；最坏情况探针（酒馆 5 关系 NPC 全 HIGH）→ 4 次调用，上限=在场 HIGH 数。失败率 0；Context 573→1537 tok（名册增长，千级需分页）；记忆库存 256→5717 条。成本量级：单玩家持续游玩的演化成本为分币级（触发漏斗是主闸门）。
详见 docs/P11-STRESS-REPORT.md（platform 0.18.1：压测发现并修复「平台重启后记忆摄取吞新世界事件」）。

## P12 附录（2026-10-03 增补）：第二游戏验证

**零 Core、零平台代码改动达成**——Game B「商路」（极简商贸世界：泉州/杭州/广州三城 + 两商人的低买高卖）以纯新增文件接入（`scripts/run-trade-host.mjs` + 验收脚本 `scripts/run-p12-walkthrough.mjs`），平台侧仅环境变量声明（`PLATFORM_*_WORLDS` 加一个世界名）。验收 20/20 PASS：贸易链路（买丝绸 -8 → 卖丝绸 +12，利润一致性含双方商人双向过账）、个体决策消费商贸状态与记忆（阿卜杜 goal/记忆进上下文）、双游戏同栈共存（触发/记忆独立计数）、OOC 隔离。P2-P9 全部通用件对第二个游戏即插即用。

## P13 附录（2026-10-03 增补）：通用 World Schema

**Schema 从双游戏实践提炼为正式契约**（docs/WORLD-SCHEMA.md v1.0 + `platform/src/schema/worldSchema.ts`）：六规范属性键（location/name/mood/attention/goal/money，含类型/写入者/语义）、引擎事实 26 类型分组、`inspectWorldSchema` 只读符合性检查——双游戏真实形状 conforming=true 有测试钉住。
**同源检查发现并修正 P3 漂移**：触发分级表的 `attitude_changed`/`combat` 键不匹配引擎真实事实（态度变化发 `npc_attitude_shift`）→ 缺省分级表修正（态度/战斗事实回归 High），`quest`/`schedule_changed` 显式标注为前瞻键。

## P14 附录（2026-10-03 增补）：Extension 层

**按世界差异化围栏落地**（`policyFor` + `PLATFORM_POLICIES_FILE`，platform 0.20.0）——关闭 P12 遗留「多游戏差异化策略」；检讨表（docs/EXTENSIONS.md）：NPC/Relationship 已由 Schema/引擎覆盖、Item/Inventory 推迟（无差异证据）、Quest 前瞻不做。**V3.0 抽象门槛已到。**

## 下一步

V3.0 AI World Runtime 定版（后续能力按真实需求逐个进 v3.x）。

# AI World Evolution Runtime 架构（Phase A/B/C 落地文档）

> 对应方案：《World Engine 当前阶段调整、优化与完善方案》§四-§九、§十六 Phase A-C。
> 本文回答一个问题：**AI 为什么能够让世界演化，同时世界不会被 AI 搞乱。**

## 一、核心概念（方案 §五/§六/§七 的类型化落地）

五个必须严格区分的概念（定义在 `platform/src/evolution/types.ts`）：

| 概念 | 一句话 | 谁产生 | 谁裁决 | 能否改变世界 |
|---|---|---|---|---|
| **Intent** | 我想做什么 | 玩家/游戏方 | 演化层按 kind 分类 | ic_action 经 Command 可；ooc/narrative 永不 |
| **Command** | 请引擎尝试执行 | 意图翻译 / AI 提案翻译 | 引擎 Rules | 是（唯一途径） |
| **Evolution Proposal** | AI 认为可能发生什么 | AI World Driver | 只有被翻译成 Command 后才进 Rules | 否（单独存在时对世界零影响） |
| **Mutation** | 世界真正发生的状态变化 | 引擎写入原语（Rules 链内） | — | 是（事实本体） |
| **Event** | 世界刚刚发生了什么 | 引擎命令链 emit | — | 否（广播事实） |

三个**永远不是世界事实**（World Fact）的东西，类型上就被隔离：

```text
OOC（玩家场外话）  → IntentKind.ooc        → 只留档，永不进引擎
Narrative（叙事）  → IntentKind.narrative  → 只留档，永不进引擎
AI Proposal        → EvolutionProposal     → 只有经白名单翻译成 Command 并被 Rules 放行才生效
```

## 二、闭环（方案 §四 的实现）

```text
游戏系统 / 玩家
   │ 事实 / 状态 / 意图
   ▼
World Engine（权威：State / Rules / Mutation / Event，不改）
   │ GET /state, GET /events
   ▼
Context Builder        platform/src/evolution/context.ts（结构化事实，逐字陈述，不编不猜）
   ▼
AI World Driver        platform/src/evolution/driver.ts（网关驱动=真模型；脚本化驱动=测试/演示）
   │ EvolutionProposal
   ▼
白名单翻译             platform/src/evolution/commands.ts（动作不在白名单 → 原地拒，不进引擎）
   ▼
引擎命令链             POST /v1/worlds/{id}/commands → Rules 校验 → Mutation → Event
   │ 每条变化的裁决 + 事实 id
   ▼
Evolution Journal      platform/src/evolution/journal.ts（JSONL 账本，可反向追溯）

> **写失败纪律**：Journal JSONL 落盘失败时**不炸运行时**（演化账本损坏不能反过来
> 伤害世界进程）——失败计数经 `writeFailures()` 暴露，Admin Runtime 观测面可查。
> 这是设计决定而非缺口：世界正确性 > 账本完整性。若需强一致账本，
> 应替换为事务性介质（PostgreSQL）而非改变失败语义。
   ▼
Admin 演化控制台        /v1/evolution/* + admin-web「AI 演化」页（触发 / 留痕 / 因果链）
   │
   └─ 新的世界事实 → 下一轮观察窗口（↺）
```

## 三、「AI 不得直接修改 World State」的结构保证

这不是注释，是依赖形状：

1. **进程边界**：演化层在 platform 进程，引擎在引擎进程；演化层对引擎的全部影响力 =
   `EngineClient.executeCommand()`——与任何游戏方客户端同权，零特权、无状态写入口。
2. **白名单闸**（`commands.ts`）：`ProposedChange.action` 必须命中内核白名单
   （move_entity / update_attribute / set_relation / create_entity / remove_entity /
   advance_time / change_weather）才能翻译成 Command；游戏方可用自己的规则收紧或扩充语义。
3. **Rules 终审**：翻译过的 Command 仍要过引擎规则链；规则拒绝（如 remove 不存在的实体），
   变化就不存在。HTTP 200 ≠ 接受——拒绝语义在 `result.ok=false`，runtime 如实落账。
4. **两级拒绝留痕**：`ChangeOutcome.rejectedBy = 'translate' | 'rules'`，每条建议的生死都可解释。
5. **失败零影响**：观察失败 / 模型失败 / 提案非法 → run.status=failed，世界分毫不动。
6. **变化数硬上限**：`maxChangesPerRun`（缺省 6）在 runtime 侧铁闸，超限截断。

## 四、AI 与确定性的分工（方案 §十一）

- **不交给 AI**（确定性代码）：金币/数量/HP、权限、距离、时间推进、库存、规则判定、状态写入。
- **交给 AI**（语义推演）：NPC 下一步行为、跨系统关系发现、潜在事件、长期趋势、剧情方向。
- 网关驱动缺省走 **reasoning** 能力通道（`gatewayDriver`），受管模式下与 world-agent
  共用模型路由与计量；未配模型时 tick 诚实地 `failed[model_unavailable]`。

## 五、因果链（方案 §九）

一次 `EvolutionRun` 记录（JSONL 落盘 `platform/data/evolution/{worldId}.jsonl`）：

```text
observationWindow（读了哪些事实，head 事件 id）
  → context（AI 当时看到的完整世界快照：实体/关系/事件）
  → proposal（AI 的判断 reason + 依据 observations + 建议 changes）
  → outcomes[]（每条：翻译出的 command / 接受与否 / 拒绝环节与原因 / 产生的事件 id）
  → eventIds（本次运行最终产生/关联的全部世界事实）
```

**回答「为什么世界会发生这个变化」**：从事件 id 反查 run → 看提案 → 看依据 → 看裁决。

## 六、意图与 OOC 隔离（方案 §七）

`dispatchIntent(worldId, intent)`：只有 `kind: 'ic_action'` 且携带 command 的意图被提交引擎；
`ooc` / `narrative` 只返回回执 `{kind}`，**结构上不可能**进引擎。管理台「演化控制台 → 意图处置」
可现场验证：提交 OOC 后世界事件数不变。

如需 GM 强制修改世界（方案 §七 审计链），走管理台命令调试台（Runtime → 命令），不与演化混道。

## 七、API 面（管理监听 8791，鉴权同既有管理面）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/v1/evolution/worlds` | 已认证 | 账本世界清单（含引擎内/外标注与最近状态） |
| POST | `/v1/evolution/worlds/:id/tick` | gateway:manage | 触发一次演化闭环，返回完整 run |
| GET | `/v1/evolution/worlds/:id/runs?n=20` | 已认证 | 运行留痕（新 → 旧） |
| GET | `/v1/evolution/worlds/:id/runs/:rid` | 已认证 | 单次运行完整因果链 |
| POST | `/v1/evolution/worlds/:id/intent` | gateway:manage | 意图处置（OOC 隔离闸） |

未装配演化运行时 → `404 not_configured`（与 keys/usage/pipelines 同姿态）。

## 八、接入真实模型

```ts
import { createEvolutionRuntime, gatewayDriver } from "world-platform";

const evolution = createEvolutionRuntime(
  {
    engine, // createEngineClient({ baseUrl: 引擎地址 })
    driver: gatewayDriver({
      gateway: createGatewayClient({ baseUrl: 网关地址 }),
      router, // ModelRouter：reasoning 通道 primary/fallback
      capability: "reasoning",
      maxChanges: 6,
    }),
  },
  createEvolutionJournal({ dir: "platform/data/evolution" }),
);
await evolution.tick("w-main", "admin");
```

模型必须输出 JSON 提案（提示词由驱动下发）；解析宽容（容忍围栏/闲话）、校验严格
（缺 reason/changes、引用不存在的观察 ref → `invalid_proposal`，宁失败不放行）。

## 九、验收对照（方案 §十九）

| 验收项 | 落点 | 验证 |
|---|---|---|
| AI 可以观察统一 World Context | context.ts | evolution.test.ts 实验 A/B |
| AI 可以产生 Evolution Proposal | driver.ts | 脚本驱动 + 网关驱动（JSON 围栏解析）用例 |
| Proposal 不能直接修改 State | runtime.ts 依赖形状 | 演示第三幕：实体表不变 |
| Rules 可以拒绝 AI 的非法建议 | 引擎命令链 | 用例：RemoveEntityRule 拒绝 ghost |
| Accepted Proposal 形成 Mutation | 命令链 | 用例断言 attributes/relations 变化 |
| Mutation 产生 Event | 引擎事件总线 | 用例断言 run.eventIds 可在事件流反查 |
| 外部游戏可消费 Event | 引擎既有 `/events` + WS 流（G3，未改） | 既有测试 |
| OOC 默认不改 World Fact | dispatchIntent | 用例断言事件数不变 |
| 可追踪完整因果链 | journal + admin 路由 | 用例 + 管理台因果链抽屉 |
| 多游戏共用 Core | 未改引擎一行 | 全量引擎测试通过 |

## 十、边界与后续（方案 §十六 D-F 前不动）

- 演示/测试用脚本化驱动（确定性）；真模型走 gatewayDriver，未配模型诚实失败。
- 周期自动演化（auto trigger / scheduler 挂钩）与记忆库接入（演化上下文带 NPC 记忆）
  留待闭环验证后；本阶段只做手动触发 + 因果链（方案 §十七：先解决核心命题）。

---

# V2.0 收口（方案 V2：从 Demo Runtime 到真实驱动天穹世界）

## 一、架构收口（方案 §二）

1. **因果关联以 Journal 为权威**：引擎 Event 不携带 Evolution 专属字段（Core 纪律不动）；
   反向追溯走管理面 `GET /v1/evolution/worlds/:id/events/:eventId/trace`，从账本还原
   `Event → EvolutionRun → Proposal → Change → Command → Rules Result`（`causation` 凭据）。
2. **Change/Command 全程带 ID**：每条变化有 `changeId`（chg_*）、派发凭据 `commandId`（cmd_*），
   裁决独立记录 `status / rejectedBy(translate|policy|rules|duplicate) / reason / eventIds`。
3. **状态机**（禁止「失败不知道原因」「部分成功显示全部成功」）：
   `completed`（全放行，含零变化提案）/ `partially_applied` / `rejected`（全拒但逐条有因）/ `failed`。
   `duplicate` 是幂等跳过，不计入失败面。
4. **幂等保护**：提案指纹（reason+changes 哈希）与幂等键双重去重——重复提案/重复 tick 返回
   既有 run（`deduplicated: true`），绝不重复 Mutation；run 内重复 change → `duplicate` 跳过。
   游戏侧事件消费经 `createEventConsumer`（seen 集 + 分级），断线重放不重复消费。

## 二、NPC 演化围栏（方案 §四：修复「自由行动强制米露回复」）

- **空提案合法化**：`changes: []` 是合法结论（「米露没有注意」），落账 completed 而非失败。
- **第一阶段策略** `NPC_EVOLUTION_POLICY`：
  - 允许动作仅 `update_attribute / set_relation / move_entity`（attention/mood/relationship/location/schedule）；
  - **AI 完全不可触碰玩家**（位置/属性/关系都归游戏与玩家本人）；
  - `maxChangesPerProposal = 3`、`maxEntitiesAffected = 3`（超限逐条 policy 拒绝，不静默丢弃）；
  - 冷却 30s（auto/api 受限，admin 手动不受限）。
- 三层围栏：策略（policy）→ 内核白名单（translate）→ 引擎规则（rules）。

## 三、Context 收敛与触发分级（方案 §五）

- **Context 不是 SELECT \***：Global（时间/天气/玩家）+ 当前地点 + 在场实体（完整字段）
  + 其余实体轻量名册 + 相关关系边（涉及玩家/在场实体）+ 最近事实窗口。
- **触发分级**（`policy.ts`）：High（玩家进入 NPC 所在地/主动交互/重大关系变化，且玩家在场）
  立即触发；Medium（时间/天气）延迟或批量；Low 后台。**只有玩家发起的 High 事件才自动触发演化**；
  演化产物（actor=NPC）绝不反向触发——结构性断开无限循环。

## 三.5、Trigger Engine（P3 · 方案 §六：哪些实体值得被 AI 唤醒）

分级回答「这批事实值不值得打断 AI」，唤醒评估（`wake.ts`）进一步回答
「**谁**值得被考虑」——Trigger 只决定是否值得考虑，绝不决定 NPC 做什么
（被唤醒 ≠ 必须反应，反应与否仍由 AI 提案 + Rules 裁决）。

- **逐实体裁决**（`assessWake`，纯函数可解释）：距离/地点（同地）、感知边界
  （事件 witnesses：列名者才看见）、事件牵涉（actor/target）、关系值、met/att。
  每个实体 HIGH / MEDIUM / LOW / NONE + reasons；「谁没被唤醒」与「为什么」同样入账
  （run.wakePlan）。远处无关系商人 → NONE；同地陌生人 → MEDIUM；同地熟人/被直接牵涉 → HIGH。
- **双重成本闸门**：世界级非 High 不调用 AI；High 但无人达到 HIGH 唤醒 → **零 AI 调用**。
  方案验收「同一个 Event 不能导致所有 NPC 同时调用 AI」由此成立：一批事实至多一次
  世界级 tick，且只发生在有人真正值得唤醒时。
- **平台内触发循环**（`triggerRuntime.ts`，P3 起自动触发的正式宿主）：轮询事实
  （幂等消费）→ 只认玩家发起的事件（AI 禁触玩家 ⇒ 玩家归因的事件不可能是演化
  产物——结构性断环 + born 集合双保险）→ 分级 → 唤醒评估 → `tick(auto,
  idempotencyKey=auto:{world}:{eventId}, wakePlan)`。世界显式声明
  （`PLATFORM_TRIGGER_WORLDS`）——多世界托管面不为未声明的世界默默烧 AI；
  游戏方宿主若同时触发同键，演化幂等层保证只执行一次。
- 测试：`platform/tests/trigger-engine.test.ts`（方案 §六示例逐条 + 计数驱动集成：
  3 NPC 恰好 1 次调用 / 空地点零调用 / NPC 事实零调用 / Medium 零调用 / 重放幂等）。

## 三.6、Context Engine（P4 · 方案 §七：被唤醒后看到什么，有预算）

Trigger 决定「谁被唤醒」，Context 决定「被唤醒后看到什么」。组成照方案 §七
全项到位：全局（时间/天气/玩家）+ 当前事件（触发段）+ 当前位置 + 相关实体 +
直接关系 + 近期事实 + 相关记忆 + 当前目标。

- **五项预算**（`ContextBudget`）：maxTokens / maxEntities / maxEvents /
  maxRelations / maxMemoryItems。裁剪优先级照方案 §七：当前事件 > 当前位置 >
  相关实体 > 直接关系 > 近期事件 > 长期记忆 > 全局信息——触发事件永不裁；
  实体超限**降级名册不丢名字**；token 超限从近期事件最旧端逐步裁到记忆、
  再到名册，裁无可裁如实超限（宁超限不撒谎）。
- **预算报告**（`context.budgetReport`）：各段携带量与裁剪量入账 run——
  「AI 实际看到了什么、被裁了什么」可审计。
- **触发段**（`context.trigger`）：wakePlan 注入时产出当前事件 + 被唤醒实体，
  渲染为事实段首行；实体细节按被唤醒者优先。
- **记忆/目标通路**：`memory` / `goal` 字段与预算、渲染全通；记忆源 P7 接线、
  目标事实 P5 落地（缺事实不编造，字段留空）。
- **接入纪律**：runtime 级 `contextBudget` 可选——未配置 = 不设限，行为与
  P3 前一致；run-managed 装配缺省预算（6000 tokens / 12 实体 / 16 关系 /
  8 记忆）。`estimateTokens`：CJK 逐字、ASCII 1/4（保守确定性口径）。
- 测试：`platform/tests/context-engine.test.ts`（15 条：方案验收四维差异——
  同一 NPC 在不同地点/关系/时间/触发事件下 Context 产生合理差异；五项预算
  逐项；优先级底线；runtime 集成与向后兼容）。

## 三.7、NPC Runtime MVP（P5 · 方案 §八：个体决策与围栏收紧）

核心循环「NPC Event → Trigger → Context → AI → Proposal → Rules → Mutation →
Event」从世界级提案收窄为**按唤醒实体的个体决策**：

- **焦点作用域**（`evolution/runtime.ts`）：wakePlan 恰有一个 HIGH 唤醒 =
  个体决策，冷却与提案指纹按 `world|focus` 分域——同一事件唤醒两个 NPC 时
  互不挤兑冷却、互不指纹串挡；世界级 tick 行为不变（向后兼容）。
- **触发器 per-NPC tick**：每个 HIGH 唤醒实体各跑一次聚焦 tick，幂等键
  `auto:{world}:{eventId}:{npc}`。「100 个 NPC 存在 ≠ 100 个 NPC 同时思考」：
  一个事件至多产生 woken.length 次调用，且只有真正被唤醒的才思考。
- **goal 真实来源**：个体决策聚焦唯一唤醒实体时 `context.goal` 取该实体
  引擎 `goal` 属性（宿主约定、AI 可维护），驱动器提示词注入「以它的视角
  判断」个体纪律——方案 §七 Current Goal 组成项就此有事实来源。
- **金币禁令**（方案 §八「禁止 AI 直接修改金币」的落地）：
  `EvolutionPolicy.forbiddenAttributeKeys`（缺省 ['money','gold']）在翻译层
  对任何目标原样拒回——经济属性归游戏经济规则，AI 提案改了也不存在。
- **NpcProfile**（`npc/profile.ts`）：方案 §八状态清单 → 既有事实的只读组装
  （Identity/Location/Mood/Attention/Goal/Relationship/Schedule +
  Knowledge/Memory 接入位如实标注）。
- 测试：`platform/tests/npc-runtime.test.ts`（单唤醒聚焦 + goal 来源、双唤醒
  冷却不连坐、方案 §八禁止清单逐项、个体指纹隔离、NpcProfile）。

## 三.8、World Time / Schedule（P6 · 方案 §九：确定性归 Scheduler，AI 只管异常）

分工落地：Engine 拥有时间与时钟事实；**Schedule 归平台确定性循环**（零 AI）；
AI 只在 Trigger 判定「真正需要判断」时被唤醒——禁止每分钟调用一次 AI。

- **历法唯一口径**（`npc/calendar.ts`）：48 刻/日的平台侧唯一出处；
  与引擎的跨包一致性由测试钉住（推进 48 刻 → new_day），不引包依赖。
- **日程注册**（`npc/scheduleStore.ts` + 管理面 `GET/PUT/DELETE
  /v1/npc/worlds/:id/schedules`）：日程表是游戏数据——游戏方注册给平台，
  JSON 持久化（原子写）、形状校验、写失败计数可查。
- **调度循环**（`npc/scheduler.ts`）：轮询事实（幂等消费）→ 时间类新事实
  （new_day / hour_advanced / time_advanced）或启动 → `applyNpcSchedule`
  对齐（已对齐零命令）。运行中注册的世界动态纳管。**确定性对齐零 AI**；
  AI 调用只属于 P3 触发器（玩家发起 High + 有人值得唤醒）。
- **宿主关系**：游戏数据归宿主、确定性执行归平台——天穹宿主启动时注册
  日程，保留输入时立即对齐做快速反馈（对齐幂等，双驱动竞态只多读一次状态）。
- 验收（方案原文「模拟连续 3 天」）：`tests/scheduler.test.ts`——错位归位、
  作息/营业/休息逐刻采样、三天推进零 AI 调用、幂等、存储、端点、历法一致性。

## 三.9、Memory 联动（P7 · 方案 §十：记忆影响判断，但不是第二世界状态）

自洽的 world-memory 包（4 因子召回）正式进入决策回路：

- **写侧**（`memory/service.ts` + `memory/runtime.ts`）：平台内摄取循环
  （零 AI）——轮询事实 → 读状态快照 → **感知边界派生**（引擎不填 witnesses
  时：actor/target + 事实地点同场实体）→ 逐目击者建亲历记忆。事实 id 幂等
  （去重账持久化）；new_day → 衰减遗忘（同日幂等）；JSON 原子写持久化。
- **读侧**：个体决策（恰一个 HIGH 唤醒）时为焦点实体召回，查询 = 主事件
  type+actor+target；`applyContextMemory` 注入 context.memory（maxMemoryItems
  截断 + token 预算全量重算，报告同源）。驱动提示词纪律：记忆是聚焦实体自己的
  主观回忆，可作动机依据，与「在场实体/最近事实」冲突时以后者为准。
- **纪律（方案 §十原文）**：World State = 世界实际上是什么，Memory = 某个实体
  记得什么——摄取对世界零命令只读（测试断言逐字节不变）；「玩家帮助过我」
  不直接等于 relationship = 100，关系数值仍由 set_relation 提案经 Rules 决定。
- 接入开关：`PLATFORM_MEMORY_WORLDS`（空 = 记忆关闭，行为与 P6 前一致）。
- 测试：`tests/memory-link.test.ts`（感知边界派生、幂等摄取、非第二世界状态、
  注入与预算、无焦点不检索、失败不炸、衰减幂等、持久化往返）。

## 三.10、Model Adapter / Gateway 收口（P8 · 方案 §十一：换 Provider 零业务代码改动）

- **能力词表对齐方案 §十一**：平台 Capability = roleplay + 11 项标准能力
  （intent / world_reasoning / evolution / npc_behavior / reasoning / narrative /
  memory / embedding / fast / cheap / long_context / structured_output）。
  业务代码只出现能力名——演化驱动走 `evolution` 或既有 `reasoning`，
  NPC 个体决策可走 `npc_behavior`，记忆语义召回走 `embedding`。
- **受管配置兼容**：原六能力键磁盘必需（既有配置文档无损装载），新七能力
  可选键——未配置 = 诚实 503（受管模式语义），Admin 配置即生效（热替换）。
- **embedding 通道**：受管网关 buildManagedProvider 实现 embed（与 chat 同
  纪律）；平台 embeddings 客户端 → 记忆服务 EmbedHook（select('embedding')
  → 网关 /v1/embeddings；未配置/失败 → null 回纯词面）。P7 的语义召回
  自此有真实通道可配。
- **厂商适配层**：Runtime 无 if-OpenAI/if-DeepSeek——厂商差异收敛在网关
  wire/remote（协议与出站形状）与 platform vendors（thinking 档位映射），
  业务面只见能力名。验收：Admin API 热切换 reasoning 路由到不同物理模型
  → 同一演化运行时直接生效（live：deepseek-chat → deepseek-reasoner → 回滚）。
- 测试：`tests/p8-model-adapter.test.ts`（能力词表、六必需/七可选、embed
  通道、EmbedHook 热替换、换 Provider 零代码改动）。

## 三.11、Admin Runtime / Causal Trace（P9 · 方案 §十二：数据面，不是 CRUD）

- **统一观测面** `GET /v1/admin/runtime`：worlds + evolution（各世界 run
  汇总与最新 run）+ trigger / schedule / memory 三循环状态 + AI Calls /
  因果链指针。装配哪个子系统就出现哪个分区，未装配如实缺省。
- **因果链完整呈现**：trace 响应 `chain` 按方案 §十二 全链组装——
  World Event → Trigger → Context → Model → Proposal → Validation →
  Command → Mutation → New Events，全部来自 run 留痕（不补叙事）。
- **多代世界语义**（关闭「确定性事件 id vs 持久幂等账」遗留）：世界实例
  指纹 = state.seed。三层：①消费 runtime 周期比对（fingerprintEvery），
  变更即重置消费集（worldResets 计数）；②触发幂等键含代际
  `auto:{world}:{gen}:{event}:{npc}`；③记忆服务 resetSeen（旧世界记忆
  保留为角色过去，新世界同 id 事实重新记忆）。平台零重启自愈。
- 测试：`tests/admin-runtime.test.ts`（观测面分区聚合与未装配缺省、
  因果链八环、多代世界重建→重置→恢复触发）。

## 三.12、天穹完整真实验收（P10 · 方案 §十三：M5 里程碑）

`scripts/run-p10-acceptance.mjs`——可复跑的三维验收脚本（含世界自举）：
真人全流程（进入→移动→酒馆→观察→自由行动→交流→离开→购买→等待→时间
推进→返回→检查 NPC 变化），产出 `docs/P10-ACCEPTANCE.md`。

- **世界一致性**：每步前后快照对照（位置/时间/金钱/物品/关系/NPC 状态）；
  购买双向过账；OOC/叙事零副作用；变化全量可归类（日程/演化/经济）。
- **AI 稳定性**：run id 唯一、次数有界、Context ≤ 预算、Proposal ≤ 白名单上限；
  触发器全程计数（tick / 零唤醒跳过 / 非玩家跳过 / 冷却 / 世界重置）。
- **因果性**：每个演化落地事实经因果链端点答方案八问（八环齐全）；
  空提案由 proposal.reason 留痕回答「为什么没发生」。
- 首轮验收 **PASS（30/30）**，并修复宿主 OOC 词表缺口（越权请求识别）。
  **里程碑 M5「天穹完整运行」达成。**

## 四、天穹最小真实接入（方案 §三，`scripts/run-tianqiong-host.mjs`）

```text
玩家输入「我想去酒馆找米露。」
  → Tianqiong Intent（宿主确定性解析）→ move 命令 → 引擎 Rules → 玩家进入酒馆 → Event
  → 平台内 Trigger Engine 消费 Event（幂等）→ 判定 High → 唤醒评估（谁值得考虑）
  → 演化 tick（幂等键 = auto:{world}:{eventId}，wakePlan 入账）
  → Context（酒馆作用域：米露/老板）→ AI 判断（可以不行动）→ Proposal → 三层围栏
  → Mutation → Event → 天穹消费 → 玩家看到符合因果链的世界变化
```

宿主端口 8795：`POST /tianqiong/input`（玩家输入）、`GET /tianqiong/view`（玩家视图）、
`GET /tianqiong/events`（已消费事实）。买酒等确定性经济归宿主（价格归游戏），
但每步状态变化仍经引擎命令链；触发演化归平台（P3 起），宿主只做显示与日程对齐。
dev-stack 已自动拉起（8795）。

## 五、验证（方案 §七/§八）

- `platform/tests/evolution-v2.test.ts`：§七 异常与安全矩阵 11 项（含模型故障、重复提案/事件、
  OOC 变强、越权触碰玩家）+ 状态机 + 冷却 + 因果链 + 触发分级 + 上下文收敛。
- `platform/tests/carpet.test.ts`：真人式地毯流程 11 步（进村→酒馆→找米露→聊天→离开→商店→
  购买→时间推进→次日返回→再找米露→终检），脚本化驱动恰好 6 步——出现无限触发第 7 次即抛错暴露。

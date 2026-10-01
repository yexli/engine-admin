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

## 四、天穹最小真实接入（方案 §三，`scripts/run-tianqiong-host.mjs`）

```text
玩家输入「我想去酒馆找米露。」
  → Tianqiong Intent（宿主确定性解析）→ move 命令 → 引擎 Rules → 玩家进入酒馆 → Event
  → 宿主消费 Event（幂等）→ 判定 High → 自动触发演化（幂等键 = auto:{world}:{eventId}）
  → Context（酒馆作用域：米露/老板）→ AI 判断（可以不行动）→ Proposal → 三层围栏
  → Mutation → Event → 天穹消费 → 玩家看到符合因果链的世界变化
```

宿主端口 8795：`POST /tianqiong/input`（玩家输入）、`GET /tianqiong/view`（玩家视图）、
`GET /tianqiong/events`（已消费事实）。买酒等确定性经济归宿主（价格归游戏），
但每步状态变化仍经引擎命令链。dev-stack 已自动拉起（8795）。

## 五、验证（方案 §七/§八）

- `platform/tests/evolution-v2.test.ts`：§七 异常与安全矩阵 11 项（含模型故障、重复提案/事件、
  OOC 变强、越权触碰玩家）+ 状态机 + 冷却 + 因果链 + 触发分级 + 上下文收敛。
- `platform/tests/carpet.test.ts`：真人式地毯流程 11 步（进村→酒馆→找米露→聊天→离开→商店→
  购买→时间推进→次日返回→再找米露→终检），脚本化驱动恰好 6 步——出现无限触发第 7 次即抛错暴露。

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

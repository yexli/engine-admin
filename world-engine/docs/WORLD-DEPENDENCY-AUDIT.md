# WORLD-DEPENDENCY-AUDIT（世界引擎抽取 · 依赖审计）

> Phase 0 产出 · 审计对象：`tianqiong/src/world`（11 个文件）及其依赖面
> 审计方式：逐文件通读 + 全仓 import 扫描 + 门禁测试（arch-deps / arch-infra / eslint flat config）核对
> 本阶段未修改任何业务代码。

---

## 1. 总体判断

`src/world` **不是一个现成的通用世界内核**，而是"通用世界机制 + 天穹游戏层"的混合体：

- **真正的通用机制**（可独立运行、换游戏可复用）：时间推进循环、世界事件总线（因果链/配额/幂等/死信/计划事件）、状态容器（含受控落盘与分片）、随机源、调度器、受控写入原语中的通用部分。
- **天穹游戏层**（换游戏不可复用）：世界书驱动的创角/存档水合、命令分发路由（30+ 游戏 case）、查询门面（绑定插件/执行器/世界书）、叙事编织（AI 文本层）。

全仓约 **100+ 文件** 从 `@/world`（或 `@/world/具体文件`）导入——任何切换都必须保持模块路径与导出面不变，否则等于重做天穹（方案 §59/§60 禁止）。

## 2. 逐文件职责与归属判定

判定标准（方案 §9）：「如果未来做另一个完全不同的游戏，这段代码还能不能直接使用？」

| 文件 | 职责 | 对外依赖 | 被谁调用 | World Engine | Tianqiong | 处理方式 | 风险 |
|---|---|---|---|---|---|---|---|
| `TimeBase.ts` | 纯常量：48 刻/日、360 日/年、起始年龄 | **零依赖** | WorldState / WorldClock / Academy | ✓ | | **抽取**（作为引擎默认历法常量） | 低 |
| `Shards.ts` | 存档分片拆/拼/判别（纯逻辑） | 仅类型（WorldState / PluginInterface） | WorldState.save / repo/index / repo/sqlite / shards.test | ✓ | | **抽取**（分片字段参数化），天穹侧薄适配 | 低 |
| `WorldState.ts` | ① 容器 core/need ② sync/flushSave/save（节流落盘+分片）③ newState/hydrate（世界书创角+旧档迁移）④ HMR | WB、EventBus、EventSchema、Economy、Factions、savePort、Shards | 全仓（core/need/save/sync） | ①②④的**机制** ✓ | ③ + HMR | **拆分抽取**：容器机制进引擎；newState/hydrate 留天穹（游戏 schema 构造器） | **高** |
| `WorldClock.ts` | ① advance/tillMorning/newDay 推进循环 + 状态效果衰减 ② sceneTime/seasonName/timeStr（历法换算+月名/时辰名） | WB、EventBus、EventSchema、EventProcessor(directorTick) | 全仓（advance/sceneTime/timeStr） | ① ✓（日边界走 worldBus，钩子注入 directorTick） | ②（历法标签来自世界书） | **拆分抽取**：推进循环进引擎；历法标签经配置注入 | 中 |
| `WorldMutate.ts` | 受控写入原语（唯一写入实现点）：资源类（hp/gold/exp/钱包…）+ 实体类（npcEntry/npcAtt/npcBag…）+ 文本类（pushLog/appendRecap/weaveLogs） | WB（关系种子投影）、WorldState、EventBus(clamp)、WorldClock(timeStr) | 全部系统模块 | 实体/文本类 ✓（引擎另备通用版） | 资源类 + WB 种子投影 | **本期保留天穹原样**（0 改动）；引擎另建通用写入原语，两套边界在报告中说明 | 低 |
| `WorldAPI.ts` | 查询门面 query.* + command() + execute()/plan()（插件/执行器/世界史） | WB、WorldRuntime、EventStore、CapabilityRegistry、PluginRegistry、WorldExecutor | ai/ContextBuilder、WorldReasoner、UI、测试 | ✗（绑定插件与执行器体系） | ✓ | **保留天穹**；引擎另建自己的 createWorld 门面 | 低 |
| `WorldRuntime.ts` | 命令分发 dispatch（30+ 游戏 case）+ newGame/continueSave/importState/resetWorld | 全部 20+ systems、Narration、Memory、dice… | WorldAPI.command、UI、测试 | ✗（纯游戏层） | ✓ | **保留天穹**（方案 §59：重写命令层触发停止条件） | 低 |
| `Narration.ts` | 叙事编织（AI 文本层，动 log 文本不动状态字段） | AiPort、bus、WB、WorldState/Mutate/Clock、RunLog | WorldRuntime、ActionParser、openaiCompat.test | ✗（方案 §6：叙事 ≠ 世界） | ✓ | **保留天穹** | 低 |
| `NarrativeContext.ts` | 叙事上下文装配（纯函数） | context.json、types | Narration、openaiCompat | ✗ | ✓ | **保留天穹** | 低 |
| `index.ts` | GameCore 公共出口（re-export 全部系统） | 全部 | UI / main / 测试 | ✗ | ✓ | **保留天穹**（本期不动） | 低 |
| `narration.test.ts` | 叙事编织测试 | Narration | — | ✗ | ✓ | **保留天穹**（方案 §39：不机械复制） | 低 |

## 3. 关键横向依赖（world 之外但被 world 依赖）

| 模块 | 性质 | 判定 |
|---|---|---|
| `events/EventBus.ts` | **混合体**：UI 信号总线（bus/toast/emitChanged）+ 富文本出口（esc/rich）+ **通用设施**（rng/scheduler/clamp）+ **世界事件总线 worldBus**（§30 配额/幂等/因果链/死信/计划事件，约 340 行，零游戏语义，仅 runLog 一处日志依赖） | rng/scheduler/clamp/worldBus → **抽取**（日志改注入）；bus/toast/esc/rich → 留天穹 |
| `events/EventSchema.ts` | WorldEvent 结构 + 工厂 + 序号 + traceChain（**通用**）；LEVEL_TABLE/CHANNEL_TABLE/isNamedPerson（**天穹表**） | 结构 → **抽取**（分级/通道表改为可注册）；表 + isNamedPerson → 留天穹并注册进引擎 |
| `types/world.ts` | 1078 行，**零依赖层**（eslint arch-data 强制），含天穹世界观字面量（FactionId、天气、六维） | **不动**。引擎定义最小状态信封 `EngineWorldState`，天穹 WorldState **结构化满足**信封（TS 结构类型），类型层零改动 |
| `plugins/PluginInterface.ts` | AiPort/SavePort 端口 | 留天穹；引擎定义自己的最小 SavePort，二者结构兼容（方法双变） |
| `devlog/RunLog.ts` | 运行日志（零依赖层） | 留天穹；引擎 worldBus 日志改注入钩子 |
| `data/worldBook` | 世界书（内容权威） | 留天穹；引擎经配置注入历法标签，不认识 WB |

## 4. WorldState 写入位置盘点（方案 §24.4）

- **受控写入**：全部系统模块经 `world/mutate`（唯一写入实现点，eslint arch-state-write 守卫，含计算属性/自增盲区补丁）。
- **直接赋值 `core.S =`**：仅 WorldRuntime 的 newGame/continueSave/importState/resetWorld（生命周期四口）+ 测试。符合"明确入口"不变量。
- **`core.CB =`**：仅 Combat.ts（战斗态，非持久世界状态）+ 测试。
- 结论：状态入口纪律已经成立，抽取容器机制不改变写入路径。

## 5. 硬门禁（抽取必须绕开的红线）

1. **arch-deps.test.ts**：`src/world/WorldState.ts` 对 `systems/*` 的导入必须**恰好等于** `[systems/economy/Economy, systems/faction/Factions]`——重接后的 WorldState.ts 必须保留 newState/hydrate（它们引用这两个系统）。
2. **arch-infra.test.ts**：读 `WorldRuntime.ts` 源码断言路由字面量存在 → WorldRuntime.ts 不动。
3. **eslint arch-data**：`types/**`、`data/**` 零依赖 → types/world.ts 不许 import 引擎。
4. **eslint arch-engine**：world/events/... 禁 React/Zustand/UI → 引擎源码同样自禁（不变量测试固化）。
5. **sync.test.ts**：SAVE_THROTTLE_MS 节流行为（N 次命令 1 次落盘、changed 不节流）、`core.S/CB/curShop` 可直接赋值（测试装置依赖）→ 容器接口必须保留这三个槽位。
6. **time.test.ts**：历法换算（12 月轮回/跨年/seasonName/periodSeg 切点）→ 换算函数留在天穹 WorldClock，引擎只接管推进循环。
7. **shards.test.ts**（repo/）：分片拆拼判别行为 → 引擎实现必须逐行为等价（缺片回落、`isShardedMain` 判据）。
8. **事件序号**：`setEventSeq(max(eventSeq(), s.evtSeq))` 的读档续接语义 → 序号状态在引擎，行为不变。

## 6. World Kernel 边界（依审计确定）

```
┌─ World Engine（独立项目 world-engine/）────────────────┐
│ types        状态信封 EngineWorldState / 实体 / 日志 / 事件行 │
│ rng/scheduler/clamp   随机源·调度器·工具（自 EventBus 抽出）      │
│ events       WorldEvent 结构 + worldBus（配额/因果/幂等/死信）   │
│ time         TimeBase 常量 + 推进循环（历法标签/时辰钩子可注入）   │
│ state        容器（need/save/sync/节流）+ 分片 + SavePort + 内存存储 │
│ mutate       通用受控写入原语（实体/文本/天气/位置/声望）           │
│ command/rules/runtime  Command → Rule → Mutation → State → Event │
│ api          createWorld 门面（§63 最小 API）                    │
└──────────────────────────────────────────────┘
          ▲ 结构化类型兼容（天穹 WorldState 满足信封）
┌─ Tianqiong Adapter（天穹 src/world 重接层）────────────┐
│ WorldState.ts = 引擎容器 + 天穹 newState/hydrate/HMR      │
│ WorldClock.ts = 引擎推进循环 + 天穹历法标签 + directorTick 钩子│
│ EventSchema.ts = 引擎事件结构 + 天穹分级/通道表注册          │
│ EventBus.ts   = 引擎 rng/scheduler/worldBus + 天穹 UI 总线   │
│ TimeBase.ts / Shards.ts = 引擎实现的薄再导出                │
└──────────────────────────────────────────────┘
          ＋ 原样保留：WorldMutate / WorldAPI / WorldRuntime /
             Narration / NarrativeContext / index.ts（游戏层）
```

## 7. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| WorldState 容器拆分破坏落盘/节流/HMR 行为 | 高 | 行为逐行照搬；sync.test/shards.test/core.test 作回归门禁 |
| 事件分级表注册时序（先 emit 后注册会用默认表） | 中 | 天穹 EventSchema.ts 模块加载即注册；emit 路径全部经过它 |
| 引擎常量与天穹字面量漂移（48/360/16/4） | 低 | 天穹 TimeBase 改为再导出引擎常量，单一来源 |
| 双 runtime（§32 禁止） | 中 | 引擎容器/时钟/事件总线成为天穹**唯一运行实现**（非并行副本）；WorldMutate/WorldAPI/WorldRuntime 作为游戏层保留并在报告说明演进路径 |

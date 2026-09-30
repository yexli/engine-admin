# CORE-BOUNDARY-AUDIT（Core 边界审计 · Phase 1）

> 依据《World-Driving-Engine V0.9→V1.0 Core Boundary Refactor》方案 §3/§11 执行。
> 本阶段只读：未修改任何核心代码。基线：tag `v0.9-pre-core-boundary`（94f4003，68 测试全绿）。
> 四类归属定义：**CORE**（任何世界都需要）/ **EXTENSION**（可跨游戏复用的领域能力）/
> **ADAPTER**（应用↔引擎转换层）/ **APPLICATION**（具体应用自身逻辑）。

---

## 1. 审计范围与方法

扫描范围：`src/`（18 模块）、`gateway/`、`memory/`、`examples/`、`tests/`。
方法：逐文件依赖分析 + 类型字段逐一过 §2.3 判据（「接入一个完全不同的世界还需要它吗？」）
+ 既有不变量测试（tests/integration.test.ts 架构扫描）交叉验证。

## 2. 内核源码逐模块归属

| 模块 | 现状 | 归属 | 依据 / 备注 |
|---|---|---|---|
| `src/types.ts` | 状态信封 EngineWorldState + EntityDynamic/LocationRecord 等 | CORE（骨架）+ **含 EXTENSION 语义字段**（见 §3） | 信封机制本身是通用的；字段需逐个裁决 |
| `src/rng.ts` | 可注入随机源 | CORE | 方案 §一 明列 |
| `src/scheduler.ts` | 定时器抽象 | CORE | 同上 |
| `src/events/EventSchema.ts` | WorldEvent 结构 / 分级表 / 序号（V0.9 已作用域化） | CORE（表内容=宿主世界观，经注册注入） | §7.1 |
| `src/events/WorldEventBus.ts` | 总线：配额/因果/幂等/死信/计划事件（V0.9 工厂化） | CORE | §7.3 全部能力已在位并有测试 |
| `src/time/TimeBase.ts` | 常量：CHEN_PER_DAY=48 / DAYS_PER_YEAR=360 / START_AGE=16 | CORE（数值）+ **START_AGE 属 RPG 语义** | START_AGE 应为宿主配置；48/360 为「默认历法」可保留 |
| `src/time/WorldClock.ts` | 推进循环 / 衰减 / 边界事件 / 历法标签注入 | CORE | 历法标签已注入化 ✓ |
| `src/state/WorldState.ts` | 容器（need/save/sync）+ createBaseState | CORE | createBaseState 含 `recap`/`logSeq` 等字段——见 §3 |
| `src/state/Shards.ts` | 分片拆拼 | CORE | 分片字段表由宿主声明 ✓ |
| `src/state/storage.ts` | SavePort / InMemoryWorldStorage | CORE | §40/§41 |
| `src/mutate/WorldMutate.ts` | 受控写入原语 17 个 | CORE 骨架 + **EXTENSION 语义原语**（bag/gold/att/rep → 见 §3） | 方案 §五：inventory/economy 属 Extension |
| `src/command/Command.ts` | WorldCommand 契约 | CORE | |
| `src/rules/Rules.ts` | RuleRegistry / RuleContext | CORE | §六：Core 只管注册/执行/上下文 |
| `src/rules` 内置规则分布 | 见 §4（Command 边界） | **部分应为 EXTENSION** | |
| `src/runtime/WorldRuntime.ts` | 命令链执行器 | CORE | 不含任何具体玩法 ✓ |
| `src/api/WorldAPI.ts` | createWorld 门面 / 查询 | CORE | |
| `src/api/WorldQuery.ts` | 只读查询 | CORE | |
| `src/api/WorldRegistry.ts` | 多世界注册表 | CORE | §42 兑现 |
| `src/http/protocol.ts` + `server.ts` | HTTP 传输 | CORE | §64 路由 |
| `src/index.ts` | 公共出口 | CORE | |

## 3. EngineWorldState 字段逐一裁决（Phase 3 输入）

| 字段 | 裁决 | 说明 |
|---|---|---|
| worldId / ver / seed / evtSeq | **CORE** | 世界身份与确定性 |
| t（时间刻） | **CORE** | §4.2 time |
| weather | **CORE** | §7.1 world.weather.changed 属 Core Event |
| player（名字/位置/背包/标记/效果） | 骨架 **CORE**；`bag`/效果语义 = **EXTENSION candidate** | 玩家即 id='player' 的实体；bag 是容器语义，可泛化为 entity.attributes |
| npcs（att/mem/met/rels/bag/gold/effects） | att→**EXTENSION（relationship）**；bag/gold→**EXTENSION（inventory/economy）**；mem→**EXTENSION（memory/认知）**；met/rels→**CORE（relation 泛化）**；effects→CORE（状态效果通用） | 逐字段标注 candidate-extension，保留兼容（§4.3） |
| rep（声望表） | **EXTENSION candidate**（reputation） | 保留兼容层 |
| events / history | **CORE** | 世界事实与历史 |
| log / logSeq | **CORE**（世界见闻记录，通用日志语义） | 文案内容由宿主给 |
| recap / recapSeq | **APPLICATION/ADAPTER candidate**（叙事摘要——为讲故事服务） | 标记 candidate-narrative；兼容保留 |
| locations / relations / variables / metadata（V1.0 新增） | **CORE** | §4.2 目标形态，Phase 6 实现 |

## 4. Command 边界现状（Phase 4 输入）

内置规则（src/runtime/BuiltinRules.ts）逐条：

| 命令 | 裁决 |
|---|---|
| move / advance_time / change_weather / spawn_entity | **CORE**（§5.1：move_entity/advance_time/create_entity；weather 属 §7.1） |
| attack / talk | **EXTENSION candidate**（§5.2 明列 combat/social）——现状：位于内置集，兼容保留 |
| set_attitude | **EXTENSION candidate**（relationship）——同上 |
| 缺失的 Core 命令 | `remove_entity / update_attribute / set_relation / move_entity(实体)` —— Phase 6 补齐 |

## 5. Rule / Event 边界现状（Phase 5 输入）

- Rule Registry / 上下文 / 装配：**CORE 结构已符合方案 §六**（注册/执行/上下文/Mutation/Event，无玩法硬编码；§6.1 的反例在本内核不存在——内置规则本身即插件形态）。
- Event Bus 能力对照方案 §7.3：最大传播深度（MAX_CHAIN_DEPTH=6）✓ / 单 tick 预算（64+critical 16）✓ / 处理器幂等（processedBy）✓ / 延后重投（deferred+attempts）✓ / 死信（deadLetters+hook）✓ / 计划事件 ✓ / **递归事件保护**=深度上限+配额 ✓。**无缺口**。
- Core Event 命名建议（§7.1）：`player_moved/entity_created/…` 现为 snake_case 事实名，与 §7.1 形状一致；`time.advanced` 对应现 `time_advanced`（保留现名，兼容优先）。

## 6. gateway / memory / examples / tests

| 范围 | 归属 | 备注 |
|---|---|---|
| `gateway/`（线格式/注册表/路由器/管线） | 独立包 = **EXTENSION/AI Cloud Layer** | §十：本次不动；内核对其零依赖 ✓（不变量扫描含 gateway 排除验证） |
| `memory/`（摄取/生命周期/检索/端口） | 独立包 = **EXTENSION** | §十：本次不动；只读事实流 ✓ |
| `examples/basic-world` | APPLICATION 示例 | |
| `examples/second-game`（铁与沙） | APPLICATION 示例（贸易/锻造） | Phase 8 另建**不同类型**（殖民）以证明泛化 |
| `tests/`（68 用例含 invariants） | 质量守卫 | Phase 9 扩展 |

## 7. 初步结论

1. 内核**结构与机制层**（信封机制/总线/时钟循环/命令链/注册表/HTTP）已完全符合方案目标形态；
2. 差距集中在三处：**状态信封的 RPG 语义字段**（bag/gold/att/rep/mem——标 candidate-extension 并保留兼容）、**内置规则中的 RPG 命令**（attack/talk/set_attitude——移入兼容扩展模块）、**缺 Core 实体/关系/位置命令与 World Definition**（Phase 6 新建，非迁移）；
3. `recap` 标记 candidate-narrative（叙事摘要），保留兼容；
4. gateway / memory 边界正确，本次不动（§十）。

以上结论由 Phase 2–5 的四份报告展开为可执行分类。

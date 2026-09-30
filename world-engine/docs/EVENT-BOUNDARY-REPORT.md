# EVENT-BOUNDARY-REPORT（事件边界报告 · Phase 5）

> 方案 §七：Event 系统能力保留 + 边界（Core/Extension/Application 事件划分）+ 可控性验证。

---

## 1. 三类事件划分

### Core Event（内核内置规则/时钟产生）

| 事件 | 产生者 |
|---|---|
| entity_created / entity_removed / entity_updated / entity_moved | Core 内置规则（V1.0 新增命令） |
| relation_set | Core 内置规则 set_relation |
| player_moved | Core 兼容规则 move（player 视图） |
| time_advanced | Core 兼容规则 advance_time |
| hour_advanced / new_day | 世界时钟日/时辰边界 |
| weather_changed | Core 兼容规则 change_weather |

### Extension Event（领域扩展产生；示例）

铁与沙：item_forged / hunt_done / npc_attitude_shift…；殖民模拟：production_done…
天穹：character_died / quest_completed / large_trade / abyss_breach…（分级表注册制）

### Application Event（应用经 emitEvent / registerRule 发布）

任意 snake_case 事实；未注册分级按 L1/ambient 处理。

## 2. 可控性验证（方案 §7.3 / §十六 F）——全部已有实现与测试

| 要求 | 内核实现 | 测试 |
|---|---|---|
| 最大传播深度 | MAX_CHAIN_DEPTH=6（causalDepth，超限死信） | world-bus.test：因果链深度超限死信 |
| 单 Tick Event Budget | MAX_EVENTS_PER_TICK=64 + critical 独立熔断 16 | world-bus.test：配额/熔断 |
| 事件优先级 | 通道制（critical / semantic / ambient） | world-bus.test：semantic 延后重投 |
| 递归事件保护 | 深度 + 配额 + 同 tick 去重 | world-bus.test：duplicate 判定 |
| 处理器幂等 | processedBy 记账（同一处理器不重复消费） | world-bus.test |
| Retry | semantic 延后重投（原 id + 原深度，attempts 上限） | world-bus.test：延后重投 |
| Dead Letter | 死信队列 + 观察者 + clearDeadLetters | world-bus.test：死信断言 |
| 无限递归禁止 | `A→B→C→A` 在深度 6 处截断进死信 | world-bus.test：链超限 |

**结论：§7.3 要求的六项能力全部在位且有测试，无缺口。** Core/Extension/Application 事件
通过「分级表注册制」划分（同天穹模式）：内核只内置上表 Core 事件，其余由宿主注册。

## 3. 边界纪律

- 事件命名：snake_case 事实名；Core 事件以实体/时间/天气为主语（§7.1）。
- 事件不是无限通信总线：跨系统协调优先走 Command（意图）而非发事件链；
  预算与深度保证 `A→B→C` 可以、`A→B→C→A` 必死。
- Extension/Application 事件经 `registerEventTables` 注册分级（critical 须显式声明并论证量级）。

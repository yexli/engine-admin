# CORE-EXTENSION-CLASSIFICATION（Core/Extension/Adapter/Application 分类 · Phase 2）

> 方案 §3.2：所有核心代码、类型、命令、事件、规则归入四类之一。
> 判据（§2.3）：「接入一个完全不同的世界，它是否仍然需要？」——不是明确需要，默认不进 Kernel。
> 迁移风险：低=纯移动；中=需兼容层；高=涉及存档/宿主行为。

## 1. 内核源码分类

| 模块 / 能力 | 当前归属 | 建议归属 | 原因 | 迁移风险 |
|---|---|---|---|---|
| types.ts 状态信封机制 | Core | Core | 通用骨架 | 低 |
| types: EntityDynamic（att/mem/met/rels/bag/gold/effects） | Core | **Core 骨架 + 字段标注**：rels/effects/attributes=Core；att=Relationship-Ext；bag=Inventory-Ext；gold=Economy-Ext；mem=Cognition-Ext | 字段泛化：通用容器 attributes 为正解，旧字段保留兼容 | 中 |
| types: locations/relations/variables/metadata（V1.0 新增） | Core（新增） | Core | §4.2 目标形态 | 低 |
| types: rep（声望表） | Core 字段 | **Extension candidate（Reputation）** | RPG 语义 | 中（兼容保留） |
| types: recap/recapSeq | Core 字段 | **Application candidate（叙事摘要）** | 服务讲故事 | 低（兼容保留） |
| rng / scheduler | Core | Core | 方案明列 | 低 |
| events/EventSchema（结构+工厂+序号） | Core | Core | 通用 | 低 |
| events/EventSchema（分级/通道表内容） | Core 机制 | **宿主世界观经注册注入**（表=Extension/Application 数据） | 已注入化 ✓ | 低 |
| events/WorldEventBus | Core | Core | 配额/因果/幂等/死信通用 | 低 |
| time/TimeBase 数值（48/360） | Core（默认历法） | Core（数值可配置化演进） | 默认历法 | 低 |
| time/START_AGE=16 | Core 字段 | **Extension candidate（角色创生）** | RPG 角色语义 | 低（标记+文档） |
| time/WorldClock 推进循环 | Core | Core | 通用 | 低 |
| state/WorldState 容器与落盘 | Core | Core | 通用 | 低 |
| state/Shards 分片 | Core | Core | 通用机制，字段表宿主声明 | 低 |
| state/storage SavePort/InMemory | Core | Core | §40/41 | 低 |
| mutate：playerLoc/playerFlag/tick 类 | Core | Core | 信封字段写入 | 低 |
| mutate：playerBag/npcBag | Core | **Extension candidate（Inventory）** | 容器=背包语义 | 中（兼容保留） |
| mutate：rep | Core | **Extension candidate（Reputation）** | 声望语义 | 中（兼容保留） |
| mutate：npcAtt/npcMet | Core | **Extension candidate（Relationship）** | 态度/见面=社交语义 | 中（兼容保留） |
| mutate：npcGold | Core | **Extension candidate（Economy）** | 货币语义 | 中（兼容保留） |
| mutate：addEffect/removeEffect | Core | Core | 状态效果通用 | 低 |
| mutate：pushLog/appendRecap/weaveLogs | Core（文本记录） | Core + **recap 标记 narrative candidate** | 日志通用；recap 服务叙事 | 低 |
| command/Command 契约 | Core | Core | 通用 | 低 |
| rules/Rules 注册与上下文 | Core | Core | §六 | 低 |
| runtime/WorldRuntime | Core | Core | 无玩法硬编码 ✓ | 低 |
| api/createWorld/Query/Registry | Core | Core | 通用 | 低 |
| http/protocol+server | Core | Core | 传输层 | 低 |
| 内置规则：move/advance_time/change_weather/spawn_entity | Core | Core | §5.1 | 低 |
| 内置规则：attack/talk/set_attitude | Core（现状） | **Extension（Combat/Social/Relationship）** | §5.2 明列 | 低（V1.0 移入 rpg 扩展模块，兼容保留） |
| **新增**：create_entity/remove_entity/update_attribute/set_relation/move_entity | Core（新增） | Core | §5.1 Core Command | 低 |

## 2. 子包与外围分类

| 范围 | 归属 | 说明 |
|---|---|---|
| gateway/（网关/路由/管线） | **EXTENSION（AI Cloud Layer 独立包）** | §十：本次不动 |
| memory/（记忆引擎） | **EXTENSION（独立包）** | §十：本次不动；只读事实流 ✓ |
| examples/basic-world | APPLICATION 示例 | |
| examples/second-game（铁与沙） | APPLICATION 示例（贸易锻造） | |
| examples/colony（V1.0 新增） | APPLICATION 示例（殖民模拟——不同类型泛化验证） | |
| tests/* | 质量守卫 | Phase 9 扩展内核禁令 |
| docs/* | 工程档案 | |

## 3. 天穹侧对照（ADAPTER / APPLICATION，不属本仓库）

| 内容 | 归属 |
|---|---|
| src/world 6 个重接文件（容器/时钟/事件/分片绑定） | **ADAPTER** |
| WorldMutate 资源类原语 / 世界书 / PromptConfig / 各 systems/* | **APPLICATION + ADAPTER** |
| 米露 / 剧情 / 专属任务 / UI | **APPLICATION** |

迁移风险结论：天穹侧**零改动**即满足方案 Phase 7（它已运行在引擎上）；「Core 不再包含天穹专属逻辑」的差距全部在引擎内標注为 candidate-extension 并保留兼容层——无高风險迁移项。

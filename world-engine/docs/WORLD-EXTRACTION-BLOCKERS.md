# WORLD-EXTRACTION-BLOCKERS（阻塞与偏差记录）

> 按方案 §59/§73 第六条：不确定的、做不到的、没做的，都记录在此等待确认。
> 本阶段**无阻断级阻塞**（抽取已完成并通过全部验收）；以下为执行中的裁决偏差与遗留事项。

---

## B1 · Tianqiong Adapter 的物理位置

- **现象**：方案 §61 的理想目录把 `adapters/tianqiong/` 放在 world-engine 项目内。
- **问题**：Adapter 同时 import 引擎与天穹类型；放进引擎会让引擎的独立编译/测试反向依赖天穹，直接违反不变量 7（引擎可脱离天穹独立运行）。
- **裁决**：Adapter 以「天穹侧 6 个重接文件」的形态落在天穹仓库内（`src/world/` × 4、`src/events/` × 2），依赖方向仍严格为 `天穹 → Adapter → 引擎`（§49）。
- **候选方案**：将来把天穹接成 monorepo / npm 包时，再把这 6 个文件迁入 `world-engine/adapters/tianqiong/` 并以包依赖声明两边。
- **推荐**：维持现状至 V0.3（World SDK）阶段再动。

## B2 · 天穹 WorldState「结构化满足」引擎信封，而非类型继承

- **现象**：理想形态是 `interface WorldState extends EngineWorldState`，让类型系统锁住两边同源。
- **问题**：`types/world.ts` 是 eslint arch-data 强制的零依赖内容权威层，不许 import 引擎；改它会破天穹的门禁并制造反向类型依赖（引擎 → 天穹语义）。
- **裁决**：引擎定义最小信封，天穹 WorldState 以 **TS 结构化类型**满足之（assignability 在容器/时钟/原语的泛型约束处校验）。类型层的同源由 `tests/world-state.test.ts` 的往返用例 + `tests/integration` 的不变量扫描看住。
- **风险**：天穹未来给 player/npcs 删改信封字段（loc/bag/flags/att/mem/met 等）时，会在天穹的 typecheck 处当场报错（不会静默）——错误方向是安全的。

## B3 · 留在天穹未抽取的部分（本阶段明确不做，方案 §3/§59）

| 模块 | 未抽取原因 | 触发的停止条件（若强抽） |
|---|---|---|
| `world/WorldMutate.ts` | 资源类原语绑定天穹世界书（关系种子投影 / 成长 / 转职） | 需要重写写入层 |
| `world/WorldAPI.ts` | 绑定插件注册表 / 能力注册表 / WorldExecutor / 世界书查询 | 需要重写插件体系 |
| `world/WorldRuntime.ts` | 30+ 游戏命令的路由即游戏玩法本身 | 改变游戏玩法 / 重写命令层 |
| `world/Narration.ts`、`NarrativeContext.ts` | 叙事层（方案 §6：AI 文本 ≠ 世界状态） | 无（设计上就不属于 Kernel） |
| `world/index.ts` | GameCore 门面（表现层出口） | 无（保留导入面即零回归） |

**引擎侧已备好对应扩展点**（`createMutate` / `createWorld` 查询面 / `registerRule`），后续逐块迁移，每次迁移配一轮全量回归。

## B4 · worldBus 是进程级单例（Multi-World 未隔离）

- **现象**：引擎的 worldBus / rng / scheduler / 事件序号沿用天穹既有形态——模块级单例。
- **影响**：同一进程创建多个 `createWorld()` 实例时，事件总线与随机流共享（引擎 API 的事件环已按「世界存在才记录」收窄，但跨世界事件仍会互见）。
- **状态**：**已裁决（V0.3 · DR-001）**——保持进程级单例，文档声明「一进程一活动世界」，实例隔离按 §42 在 V0.9 以 worldId 为键落地。详见 `docs/DECISIONS.md` DR-001。

## B5 · 天穹记忆体系不迁入 world-memory（V0.8 审计裁决，§59 第 4 条）

- **审计事实（W8.1）**：天穹记忆体系共 18 文件约 1815 行（lifecycle/propagation/belief/retrieval/vector/context 七个子系统）+ 1026 行专项测试。域模型（Memory/Belief/PerceivedFact，types/world.ts §833-956）设计良好，但：① 记忆/感知/信念/案件四张表 **resident 于 WorldState 存档**（memSeq/memTickAt 随档走），迁移 = 改存档格式 + 全量回归；② MemoryEngine 直接 import worldBook、law.json、Perception、core——**游戏数据与感知系统耦合**；③ 1026 行行为测试是硬门禁。
- **裁决**：整体迁移触发方案 §59 第 4 条（需要修改大量 Memory 系统）→ **暂停迁移**。world-memory 按路线图 W8.2-W8.4 建为**独立通用记忆引擎**（事实摄取/衰减遗忘/检索/embedding 钩子/持久化端口），供 second-game、第三方游戏与云平台使用；天穹记忆本期保持原生（与 V0.1 保留 WorldMutate 同构），其测试全绿即门禁。
- **演进路径**：待 §16 数据流（事实流 → Memory → 检索 → AI → Command）在多游戏上验证后，再评估把天穹记忆的**通用子系统**（lifecycle/propagation/retrieval）迁到 world-memory 并以 Adapter 接回——那是独立的一刀，配独立回归。

## 遗留与演进（下一阶段候选，均不阻塞）

1. **WorldMutate 通用子集切换**：天穹 `mutate` 的通用原语（npcEntry/npcAtt/npcBag/npcGold/weather/playerLoc/playerFlag/addEffect/removeEffect/pushLog/appendRecap/weaveLogs）与引擎 `createMutate` 逐一同名同语义；下一刀把天穹对象改为「引擎版 + 天穹资源版」合并，调用面 100% 兼容。
2. **事件序号/世界史入引擎 SavePort**：天穹 EventStore（世界史环形缓冲）仍在天穹侧；引擎 SavePort 已预留 loadWorldLog/saveWorldLog 通道。
3. **引擎 npm 包化**：解除 `@wengine/*` 源码别名，改 workspace/registry 依赖（V0.3 World SDK 的前置）。
4. **规则注册机制对齐**：天穹 WorldRuntime 的 case 路由可逐步迁成引擎 `registerRule` 形态（每迁一条跑一轮回归），最终让天穹命令层成为「一组游戏规则」而不是硬编码 switch。

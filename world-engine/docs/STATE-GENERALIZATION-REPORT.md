# STATE-GENERALIZATION-REPORT（状态泛化报告 · Phase 3）

> 方案 §四：EngineWorldState 逐字段裁决——Kernel / Extension / Adapter / Application。
> 原则（§2.1/§4.3）：不推倒重来；RPG 字段不进 Kernel 但也不强制删除——标记 candidate-extension、保留兼容层、后续迁移。

---

## 1. 裁决总表

| 字段 | Kernel | Extension | Adapter/Application | 说明 |
|---|---|---|---|---|
| worldId | ✅ | | | §42 世界身份 |
| ver / seed / evtSeq | ✅ | | | 版本 / 确定性 / 事件序号 |
| t（时间刻） | ✅ | | | §4.2 time |
| weather | ✅ | | | §7.1 world.weather.changed |
| locations（V1.0 新增） | ✅ | | | §4.2 Location { id, type, attributes } |
| relations（V1.0 新增） | ✅ | | | §4.2 Relation { source, target, type, value, metadata } |
| variables（V1.0 新增） | ✅ | | | 世界变量 |
| metadata（V1.0 新增） | ✅ | | | 宿主元数据 |
| entities.attributes（V1.0 新增） | ✅ | | | §4.2 Entity { id, type, attributes } |
| player.name / .loc / .flags | ✅ | | | 玩家=实体 id 'player' 的兼容视图 |
| player.bag / npcs.*.bag | | ✅ Inventory-Ext | | 容器=背包语义（保留兼容） |
| npcs.*.att / player 态度语义 | | ✅ Relationship-Ext | | 态度=社交语义 |
| npcs.*.gold / econ | | ✅ Economy-Ext | | 货币/价格 |
| npcs.*.mem / knowledge / beliefs | | ✅ Cognition/Memory-Ext | | 认知体系（另见 world-memory 包） |
| npcs.*.effects / player.effects | ✅ | | | 状态效果通用（tick 衰减） |
| rep（声望表） | | ✅ Reputation-Ext | | 声望语义（保留兼容层） |
| log / logSeq | ✅（世界见闻记录） | | | 文本由宿主写 |
| recap / recapSeq | | | ✅ Adapter/Application（叙事摘要） | 标记 candidate-narrative |
| events / history | ✅ | | | 世界事实与历史 |
| 天穹自有字段（quests/legal/abyss/…） | | | ✅ Application | 经信封扩展携带，内核不感知 |

## 2. V1.0 落地内容（本次实现）

状态信封**新增可选通用容器**（全部向后兼容，旧档/旧用例零影响）：

```ts
locations?: Record<string, { id: string; type?: string; attributes?: Record<string, unknown> }>;
relations?: Array<{ source: string; target: string; type: string; value?: number; metadata?: Record<string, unknown> }>;
variables?: Record<string, unknown>;
metadata?: Record<string, unknown>;
// EntityDynamic 新增：
type?: string;
attributes?: Record<string, unknown>;
```

## 3. RPG 字段的兼容策略

- `bag / gold / att / rep / mem` 等既有字段**原地保留**（天穹 1716 回归的门禁），但在分类档案中标注 Extension 归属；
- 新通用容器（attributes/relations/locations/variables）是**正解方向**：新游戏与新规则一律用它们，
  旧字段由各 Extension 在宿主侧自行映射；
- 判据引用：这些字段不满足 §2.3（「不同世界仍需要？」——声望/背包/态度不是任何世界都需要），
  故不新增任何以它们为主题的内核原语或规则。

## 4. World Definition 的角色（§八）

World Definition 是「应用提供世界数据」的正式入口（Phase 6 实现）：
创建空世界 → 注入 entities/locations/relations/variables → 运行。
它使 Kernel 彻底回答不了「这个世界有哪些 NPC、叫什么名字」——内核只知道 id/type/attributes。

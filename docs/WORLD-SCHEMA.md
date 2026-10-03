# 通用 World Schema（P13 · v1.0）

> 提炼自两个真实游戏的完整接入实践：**天穹**（RPG，P2/P10）与**商路**（商贸，P12）——非前瞻设计。
> 机器可校验定义：`platform/src/schema/worldSchema.ts`（`inspectWorldSchema` / `CANONICAL_ATTRIBUTES` / `CORE_EVENT_TYPES`）；
> 符合性测试：`platform/tests/world-schema.test.ts`（双游戏真实形状逐项验证）。
>
> 铁律：**Core 不知道本 Schema 的存在**——引擎只认 Entity/Relation/Attribute 泛型结构；
> 本 Schema 是平台与宿主之间的约定（平台哪些环节读哪些键）。

## 1. 结构面（引擎已实现；此处只声明归属）

| 概念 | 归属 | 说明 |
|---|---|---|
| World / State | 引擎 | 多世界注册表、最小状态信封（worldId/t/weather/player/npcs/relations/locations…） |
| Entity / Relation | 引擎 | `EntityDynamic`（att/mem/met/rels/bag/gold/effects/type/attributes）+ 世界关系表 |
| Command / Rule / Mutation | 引擎 | 命令链 = Rules 校验 → Mutation 写入 → Event 广播；拒绝也发事实 |
| Event | 引擎 | 因果字段组（cause/parentId/sourceId/witnesses/origin）+ 配额/重投/死信 |
| Time / Scheduler | 引擎 | 48 刻/日；new_day/hour_advanced/time_advanced 事实；bus.schedule/due |
| Memory | 平台（world-memory 包） | 角色记忆 ≠ 世界状态；摄取/衰减/召回/持久化（P7） |
| Location | 引擎结构 + 宿主语义 | 地点表（id/type/attributes.desc）；「在哪」的语义由 attributes.location 约定 |

## 2. 规范属性键（平台识别；v1.0 六键）

| 键 | 类型 | 适用 | 谁写 | 语义（平台消费点） |
|---|---|---|---|---|
| `location` | string | 实体=attributes.location；**玩家=引擎原生 player.loc** | host | 触发唤醒评估 / 上下文地点作用域 / 日程对齐 |
| `name` | string | both | host | 上下文事实段与观测面呈现 |
| `mood` | string | 实体 | host + AI | 心情（AI 提案可维护；上下文完整字段呈现） |
| `attention` | string | 实体 | host + AI | 当前注意对象（实体 id / "player" / "无人"）——P10 验收的注意力状态 |
| `goal` | string | 实体 | host + AI | 当前目标 → 个体决策的 `context.goal`（P5） |
| `money` | number | both | **host 专属** | 货币——经济归宿主与 Rules；AI 被 `forbiddenAttributeKeys` 禁改（P5） |

纪律：
- 缺属性是**合法选择**（缺事实不编造）——缺 location 的实体不参与唤醒/作用域/日程；缺 goal 的个体决策无目标段。
- `money` 类经济键对 AI 全域禁改（`NPC_EVOLUTION_POLICY.forbiddenAttributeKeys: ['money','gold']`）。

## 3. 游戏自有属性（命名纪律）

玩法键由游戏自定，平台**不解释、只透出**（观测面 `gameKeys`）：`item_silk`、`spice_stock`、`ale_stock`…
命名纪律：`/^[a-z][a-z0-9_]{0,63}$/`。跨游戏共享的键建议显式登记进 v1.x（随实际第二/第三游戏实践演进，不做前瞻设计）。

双游戏实践对照：

| 键 | 天穹（RPG） | 商路（商贸） |
|---|---|---|
| `item_ale` / `item_rice` | ✓（玩家物品） | — |
| `item_silk` / `item_spice` | — | ✓（玩家行囊） |
| `ale_stock` / `goods_rice` | ✓（商人库存） | — |
| `silk_stock` / `spice_stock` | — | ✓（商人库存） |

## 4. 事实类型面（引擎 emit 全集，26 类型按组）

- **entity**：entity_created / entity_removed / entity_updated / entity_moved（+ 各自 _failed 与 attribute_update_failed）
- **player**：player_spawned / player_moved / move_failed
- **relation**：relation_set / relation_set_failed
- **talk（扩展层）**：talk_started / talk_failed
- **combat（扩展层）**：attack_succeeded / attack_failed / npc_attitude_shift
- **spawn（扩展层）**：npc_spawned / spawn_failed
- **time**：new_day / hour_advanced / time_advanced
- **weather**：weather_changed / weather_change_failed

触发分级缺省表（`policy.ts`）引用以上类型——**P13 同源修正**：`attitude_changed`→`npc_attitude_shift`、`combat`→`attack_`（原键不匹配真实事实，态度/战斗事实被漏判为 low）。前瞻键（`quest` / `schedule_changed`）为 P14/P6 预留，当前不匹配任何事实（有测试钉住该清单）。

## 5. 符合性检查

```ts
import { inspectWorldSchema } from 'world-platform';
const report = inspectWorldSchema(state);   // 只读，不产生命令
// report.conforming / errors / warnings
// report.stats: { entities, locations, relations, canonicalKeys, gameKeys }
```

- `errors`：类型违反契约 / 游戏键命名违纪（阻断项）；
- `warnings`：缺规范键（合法选择，但相关平台能力对该实体不生效——如缺 location 不参与唤醒）；
- 双游戏真实形状均为 `conforming: true`（有测试钉住，Schema 演进不得破坏）。

## 6. 演进纪律

1. 新规范键 / 新事实类型：必须先有两游戏之一的真实用例，再进 v1.x（防前瞻抽象）；
2. 不兼容变更递增 `SCHEMA_VERSION`；
3. 引擎 Core 永不感知本文件的键——Schema 漂移由「分级表同源测试 + 双游戏符合性测试」双向钉住。

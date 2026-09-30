# COMMAND-BOUNDARY-REPORT（命令边界报告 · Phase 4）

> 方案 §五：Core Command 只保留最基本世界操作；attack/talk/trade 等玩法命令属领域扩展。
> §5.3：兼容优先——不一次删除，走 Legacy → Extension → Core 的收敛路径。

---

## 1. 三类命令划分

### Core Command（内核内置，任何世界都需要）

| 命令 | 语义 | 产生事件 |
|---|---|---|
| `create_entity` | 创建实体（id/type/name/attributes/location） | entity_created |
| `remove_entity` | 移除实体 | entity_removed |
| `update_attribute` | 更新实体/玩家通用属性（attributes 容器） | entity_updated |
| `set_relation` | 设置实体间关系（source/target/type/value） | relation_set |
| `move_entity` | 移动实体（player 走 loc，实体走 attributes.location） | entity_moved / player_moved |
| `advance_time` | 推进世界时间 | time_advanced + 时辰/日节律 |
| `change_weather` | 变更天气 | weather_changed |

### Extension Command（领域扩展提供；V1.0 起源码归入扩展模块）

| 命令 | 所属扩展 | 现状 |
|---|---|---|
| `attack` | Combat-Ext | 源码移入 `src/rules/rpgCompat.ts`（兼容保留，默认装配） |
| `talk` | Social-Ext | 同上 |
| `set_attitude` | Relationship-Ext | 同上 |
| `spawn_entity` | 兼容别名 → `create_entity` | 保留（既有测试/示例使用） |

### Application Command（宿主经 registerRule 注册，不经内核）

天穹的 30+ 游戏命令、铁与沙的 forge/hunt、殖民模拟的 produce/build 等——
一律 `registerRule` 注册，内核零感知（契约底册 COMMAND-EVENT-CONTRACT.md 持续记账）。

## 2. 本期落地（V1.0 Phase 4）

1. **新增 Core 内置规则**：`create_entity / remove_entity / update_attribute / set_relation / move_entity`
   （源码 `src/rules/coreRules.ts`，只操作内核通用容器：实体表 / attributes / relations / locations / player.loc）；
2. **兼容策略**：既有 `attack / talk / set_attitude / spawn_entity` 移入 `src/rules/rpgCompat.ts`
   （标注 EXTENSION），`createWorld` 缺省仍装配（§5.3 兼容），`noBuiltinRules` 或新选项可排除；
3. **内核语义收缩验证**：`src/runtime` 与 `src/rules/coreRules.ts` 中不含 attack/talk/quest/craft 字样
   （不变量扫描新增断言，Phase 9）。

## 3. 迁移路径（存量命令的收敛）

```text
Legacy（内置默认装配）
   ↓ V1.0：源码移入 rpgCompat（EXTENSION 标注，行为不变）
Extension Command（独立模块，可选装配）
   ↓ 后续大版本：宿主显式注册，缺省不再装配
Core API（create_entity 等纯内核命令）
```

天穹不受影响：其 dispatch 仍走自己的命令层（§59 第 7 条），经 `world.command` 提交的
命令最终落在 WorldRuntime 的规则表上——规则表是开放的，收敛不删入口。

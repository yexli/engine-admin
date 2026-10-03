# Extension 层（P14 · 方案 §十七：Core → Extension → Adapter）

> 依据纪律：方案 §22「不为未来需求提前实现大量 Extension」——本层只收编
> **双游戏实践已经证明的共享需求**，其余逐项检讨并明确「不做」。
> 证据基础：天穹（RPG，P2/P10）与商路（商贸，P12）两个完整接入。

## 1. P14 交付：按世界解析演化围栏（policyFor）

**唯一有双游戏实证的共享需求**：AI 围栏的差异化。P12 遗留「商贸游戏或需禁 AI
改库存类属性——per-game policy 属 Extension 议题」就此关闭。

```ts
const evolution = createEvolutionRuntime({
  engine,
  driver,
  policy: NPC_EVOLUTION_POLICY,          // 共享缺省
  policyFor: (worldId) => {              // P14：按世界覆盖（返回 undefined = 用缺省）
    if (worldId === 'trade-road') {
      return { ...NPC_EVOLUTION_POLICY, forbiddenAttributeKeys: ['money', 'gold', 'silk_stock', 'spice_stock'] };
    }
    return undefined;
  },
}, journal);
```

- 解析优先级：`policyFor(worldId)` → `opts.policy` → `FULL_CORE_POLICY`；
  `maxChangesPerRun` / `cooldownMs` 装配覆盖仍优先于策略值（装配方最后一道闸）。
- 零共享代码改动：同一演化运行时、同一驱动、同一触发器，围栏随世界切换
  （测试：`platform/tests/extensions.test.ts`——商贸世界拒改库存、RPG 世界
  同提案放行）。
- 生产装配（`run-managed.mjs`）支持 `PLATFORM_POLICIES_FILE`
  （data/policies.json：`{ "trade-road": { "forbiddenAttributeKeys": [...],
  "allowedActions": [...] } }`，按世界合并到共享缺省之上，改文件即生效需重启平台）。

## 2. P14 检讨表（NPC / Item / Inventory / Relationship / Quest 依次考虑）

| 候选 | 结论 | 依据 |
|---|---|---|
| **NPC** | ✅ 已覆盖，无需新抽象 | P13 Schema 规范键（location/name/mood/attention/goal）+ P5 `buildNpcProfile` + 触发唤醒评估已构成 NPC 的完整平台契约；个体形状=实体泛型 + 属性约定 |
| **Relationship** | ✅ 已覆盖（引擎一等公民） | `RelationRecord` 世界关系表 + `set_relation` 规则 + `relation_set` 事实 + 上下文相关边裁剪（P4）——无需 Extension 层 |
| **Item / Inventory** | ⚠️ 部分覆盖，抽象推迟 | 双游戏均为宿主约定键（`item_*` / `*_stock`）+ P13 gameKeys 透出 + policyFor 可禁 AI 改库存。**完整抽象（容器/堆叠/耐久/定价）无第二游戏差异证据 → 不做**（方案 §22） |
| **Quest** | ❌ 前瞻，不做 | 零实践（分级表 `quest: high` 是 P14 显式登记的前瞻键）——待真实需求出现再设计 |

## 3. 分层归属（本发布后的完整图景）

```text
Core（world-engine，玩法无关）
  └─ Extension（platform 机制 + 声明式数据）
       ├─ 演化围栏策略        policyFor / PLATFORM_POLICIES_FILE（P14）
       ├─ 通用 World Schema   规范属性键 + 事实类型面（P13）
       ├─ 触发分级缺省表      policy.ts（游戏方可覆盖 grades）
       └─ 日程/记忆/预算      机制在平台，数据在宿主
  └─ Adapter（游戏宿主）
       └─ 天穹（RPG）│ 商路（商贸）│ …下一个游戏
```

## 4. V3.0 门槛判断

P14 完成后，方案 §16 的通用 Schema 清单（World/State/Entity/Relation/Command/
Rule/Mutation/Event/Time/Scheduler/Memory）全部有实现、文档与测试三方对应；
Extension 层最小自洽。**V3.0「AI World Runtime」的抽象门槛已到**——后续能力
（Quest、物品容器、多游戏计费）按真实需求逐个进 v3.x，不再以「V3.0 前必须」
驱动。

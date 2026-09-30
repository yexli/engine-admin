# ADAPTER-GUIDE（第三方接入指南 · World SDK）

> 如何把一个游戏接到 AI World Engine 上——**不改引擎一行**（方案 §22/§23/§62/§67）。
> 受众：在天穹之外接入自己的游戏的开发者。两份参照实现：
> · **examples/second-game**（最小第三方游戏：不同历法/分级/自定义规则，20 分钟读完）
> · **tianqiong2 的 6 个重接文件**（生产级：分片存档/旧档迁移/叙事编排全都有）

## 安装

```bash
npm install world-engine   # 发布后从 registry；当前本地协作用 file:../world-engine
```

- 消费面是**构建产物**（dist，ESM + d.ts），引擎改码后先在其仓库 `npm run build`（DR-002）。
- 一个进程一个**活动世界**：worldBus / 随机源是进程级单例（DR-001）；多世界同进程是 V0.9（Multi-World）的工程。
- 版本节奏：semver + CHANGELOG（V0.x 期间 API 允许带注明的调整，1.0 后冻结）。

## 快速开始（60 秒）

```ts
import { createWorld, InMemoryWorldStorage } from 'world-engine';

const world = createWorld({
  worldId: 'demo',
  playerName: '旅人',
  savePort: new InMemoryWorldStorage(),
});
world.executeCommand({ type: 'move', targetId: 'forest' });  // 命令 = 唯一改写入口
world.advanceTime(8);
console.log(world.query.get_time(), world.getEvents());
```

内置通用命令：`move / attack / talk / advance_time / change_weather / spawn_entity / set_attitude`。
你的玩法用 `registerRule` 挂进去（步骤 4）。完整最小游戏见 **examples/second-game**（"铁与沙"）。

## 总览

```text
游戏 UI / 系统（游戏自己写）
        │
        ▼
游戏 Adapter（本指南的 6 步产出，住在游戏仓库里）
        │  注入：存档介质 / 创角工厂 / 事件分级 / 历法标签 / 游戏规则
        ▼
AI World Engine（npm 包 world-engine，引擎不认识任何游戏）
```

依赖方向铁律（§49）：`游戏 → Adapter → 引擎`。引擎永远不 import 游戏。

## 步骤 1 · 存档介质（SavePort）

实现引擎的 `SavePort<W>`：`load / save / clear` 必须实现；`loadShards/saveShards`（分片）、
`loadWorldLog/saveWorldLog`（世界史）、`onError` 可选——不实现则整档往返、世界史退化为内存，不会出错。

```ts
import type { SavePort } from 'world-engine';
export class SqliteSavePort implements SavePort<GameWorldState> { /* 你的介质 */ }
```

内存介质 `InMemoryWorldStorage` 开箱即用（测试与最小运行）。
参照：second-game 直接用它；天穹 `src/repo/`（localStorage + SQLite 双介质）。

## 步骤 2 · 状态容器（holder + 创角/水合工厂）

引擎容器只管机制（need / sync 尾节流 / save 分片落盘 / 事件序号随档走）；
**状态里有什么字段是游戏的事**。把游戏的 core 对象作 `holder` 传入（可带任意额外槽位，如战斗态），
创角与旧档水合作为游戏工厂留在游戏侧：

```ts
// 天穹 src/world/WorldState.ts 的实际形态（节选）
export const core: { S: WorldState | null; CB: CombatState | null; curShop: string | null } = { S: null, CB: null, curShop: null };
const container = createWorldContainer<WorldState>({
  holder: core,                       // ← 游戏自己的槽位对象
  getSavePort: () => savePort(),      // ← 步骤 1 的介质
  onChanged: () => emitChanged(),     // ← 游戏的 UI 信号总线
  shardFields: SHARD_FIELDS,          // ← 步骤 5 的分片表
});
export const need = container.need;
export const save = container.save;
export const sync = container.sync;
export function newState(ch: CharSpec): WorldState { /* 游戏创角：种族/职业/初始装备 */ }
export function hydrate(s: WorldState): WorldState { /* 游戏旧档迁移 */ }
```

游戏的 `WorldState` 只需**结构化满足**引擎信封 `EngineWorldState`
（t / weather / player{name,loc,bag,flags} / npcs{att,mem,met,…} / rep / log / logSeq / events / history），
其余字段（数值表、任务、法律……）引擎不感知。

## 步骤 3 · 世界观注册（事件分级 / 通道 / 历法 / 实体建档）

引擎保证事件**结构**（幂等/因果/配额/死信/计划事件）；「什么算大事」是游戏的世界观，注册进去：

```ts
// 事件分级与通道（天穹 src/events/EventSchema.ts）
registerEventTables(
  { new_day: 2, character_died: 2, hour_advanced: 0 /* …游戏全表 */ },
  { new_day: 'critical', hour_advanced: 'critical' },   // critical 必须显式声明
);
```

```ts
// 历法标签 + 时辰边界钩子（天穹 src/world/WorldClock.ts）
const clock = createWorldClock<WorldState>({
  need,
  labels: { months: WB.months, shichen: WB.shichen, periodOf: WB.periodOf, baseYear: 612 },
  onHourTick: (s) => directorTick(s),   // 游戏确需的同步钩子（先广播事实，后跑钩子）
});
```

```ts
// 写入原语的世界观钩子（天穹 src/world/WorldMutate.ts）
const engineMutate = createMutate<WorldState>(need, {
  entryOf: (s, id) => npcEntry(id, s),  // 实体建档副作用（如关系种子投影）必须经此注入
  stamp: (s) => timeStr(s),             // 见闻录时间戳
});
export const mutate = { ...engineMutate, npcEntry, /* 游戏资源类原语 */ };
```

## 步骤 4 · 游戏规则注册（Rule Registration）

命令链：`Command → Runtime → Rule → Mutation → State → Event`。引擎内置最小通用规则
（move/attack/talk/advance_time/change_weather/spawn_entity/set_attitude）；
游戏玩法用自己的命令名注册规则，**不动引擎**：

```ts
runtime.registerRule({
  name: 'PrayRule',
  for: 'pray',
  apply(ctx) {
    if (ctx.state.player.gold < 100) { ctx.emit({ type: 'pray_failed' }); return false; }
    ctx.mutate.rep('temple', 5);              // 只经写入原语
    ctx.emit({ type: 'prayer_answered', actor: 'player' });  // day/tick 自动补全
  },
});
```

复杂游戏（如天穹）可以在 Adapter 层保留自己的 dispatch，把规则化逐步迁移
（见 `COMMAND-EVENT-CONTRACT.md` §6 台账）——迁移是渐进的，行为门禁是全量回归。

## 步骤 5 · 数据映射（Data Mapping：分片 / 查询 / 命令）

- **分片**：声明「随规模增长的表 + 缺片空值」，`splitShards/mergeShards/isShardedMain` 由引擎实现：
  `export const SHARD_FIELDS: ShardFieldSpec = [['npcs', () => ({})], ['cases', () => []]];`
- **查询**：通用查询（state/time/weather/location/log/history…）用引擎 `createQuery({ getState, clock })`；
  依赖游戏数据的查询（地点表/关系种子/能力清单）留在游戏侧追加。
- **命令面**：游戏的 GameCommand 类型与 dispatch 留在游戏侧；想做 SDK 对外一致面，
  参考 `createWorld()` 的门面形状（§63 最小 API）。

## 步骤 6 · 禁止事项（§23/§30/§48）

- 禁止 `if (game === 'tianqiong')` 式分支进入引擎——引擎不知道任何游戏存在（不变量扫描测试守着）。
- 引擎 Core 不 import：React / 任何 UI / zustand / 任何 LLM SDK / Memory / 游戏世界书。
- Adapter ≠ Rule：Adapter 解决「游戏怎么接入」（数据转换/实体映射/配置）；
  Rule 解决「世界怎么运行」；Plugin 解决「给引擎加可选能力」。别把游戏玩法塞进引擎当规则。

## 自检清单（接入完成后逐条过）

- [ ] 删掉游戏仓库，引擎仍能 `npm install && npm test && npm run example`（独立性 §71.A）
- [ ] 引擎源码扫描无 react/游戏/LLM 依赖（引擎 tests/integration 的不变量测试）
- [ ] 游戏全量回归绿（行为不变 §71.H）
- [ ] 新存档 → 存 → 读 → 再存 往返一致；旧档 hydrate 后可玩（§40-§41）
- [ ] 事件分级/通道表已注册；节律事件走 critical 且量级可论证
- [ ] 只 import 包入口 `world-engine`，没有伸进引擎内部路径（SDK 消费面纪律，DR-002）

## 四件套速查（§67）

| 接入件 | 引擎入口 | second-game 示例 | 天穹参照 |
|---|---|---|---|
| Entity Mapping | `spawn_entity` / `set_attitude` 内置命令 + `EntityDynamic` 结构化扩展 | spawn + hunt 校验 | `newState`/`hydrate`（世界书创角） |
| Rule Registration | `rules: []` / `registerRule` | ForgeRule / HuntRule | 6 文件 Adapter + 契约底册（渐进迁移） |
| Data Mapping | `labels`（历法）/ `SHARD_FIELDS`（分片）/ SavePort | 10 月×20 日/纪年 3024 | 分片五表 + localStorage/SQLite |
| Event Mapping | `registerEventTables(levels, channels)` | storm_brewing=critical | 分级表 30+ 事件 |

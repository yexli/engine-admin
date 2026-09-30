# WORLD-EXTRACTION-REPORT（世界引擎抽取报告）

> 交付物：`world-engine/` 独立项目（V0.1）+ 天穹 Adapter 重接
> 配套文档：`WORLD-DEPENDENCY-AUDIT.md`（审计）、`WORLD-EXTRACTION-BLOCKERS.md`（偏差与遗留）、`../README.md`（使用说明）

---

## 1. 一句话结论

天穹的「世界运行能力」（时间推进 / 世界事件总线 / 状态容器与分片存档 / 受控写入）已抽离为与游戏无关的独立 World Engine；天穹经 6 个 Adapter 文件重接后**运行在引擎之上**（引擎是唯一运行实现，不是并行副本），全量回归 1704/1704 通过，行为无变化；引擎自身可独立创建世界、执行命令、产生事件（`npm install && npm test && npm run build && npm run example` 全绿）。

## 2. 交付物清单（方案 §70 对照）

| # | 交付物 | 位置 | 状态 |
|---|---|---|---|
| 1 | 独立 World Engine 项目 | `world-engine/` | ✓ 独立 package.json / tsconfig / vitest，零运行时依赖 |
| 2 | 依赖审计 | `docs/WORLD-DEPENDENCY-AUDIT.md` | ✓ Phase 0 产出 |
| 3 | 抽取报告 | `docs/WORLD-EXTRACTION-REPORT.md`（本文） | ✓ |
| 4 | 阻塞与偏差记录 | `docs/WORLD-EXTRACTION-BLOCKERS.md` | ✓（无阻断级阻塞，3 项已登记偏差） |
| 5 | README | `README.md` | ✓ 含架构 / 安装 / API / Adapter 开发 / 测试 / 演进规划 |
| 6 | 独立测试 | `tests/`（8 个文件 46 用例） | ✓ 含架构不变量扫描（§35 不变量 1–5 机器可查） |
| 7 | 最小可运行世界 | `examples/basic-world/` | ✓ §36 全场景（创建世界/玩家/NPC → 推进时间 → 移动 → NPC 状态 → 事件 → 存档读回） |
| 8 | Tianqiong Adapter | 天穹侧 `src/world/TimeBase·Shards·WorldState·WorldClock` + `src/events/EventSchema·EventBus`（6 文件重接层） | ✓（放置理由见 BLOCKERS #1） |

## 3. 抽取了什么（引擎内核 → 来源映射）

| 引擎模块 | 来源（天穹） | 改造 |
|---|---|---|
| `src/types.ts` 状态信封 `EngineWorldState` | `types/world.ts` 的字段面 | 新建最小信封；天穹 WorldState **结构化满足**它，类型层零改动 |
| `src/rng.ts` / `src/scheduler.ts` | `events/EventBus.ts` | 原样搬移（含种子 LCG、注入语义） |
| `src/events/EventSchema.ts` | `events/EventSchema.ts` 结构部分 | 分级表/通道表从硬编码改为 `registerEventTables` 注册 |
| `src/events/WorldEventBus.ts` | `events/EventBus.ts` 的 worldBus 部分 | runLog 依赖改为 `setWorldBusLogger` 注入；配额/熔断/幂等/因果/死信/计划事件逐行保留 |
| `src/time/TimeBase.ts` | `world/TimeBase.ts` | 原样（48/360/16 作为引擎默认历法） |
| `src/time/WorldClock.ts` | `world/WorldClock.ts` 推进循环 | 历法标签经 `CalendarLabels` 注入；`onHourTick` 钩子承接 directorTick；日边界仍走 worldBus |
| `src/state/WorldState.ts` 容器 | `world/WorldState.ts` 机制部分 | `createWorldContainer`：holder 注入（天穹 core 三槽位）、SavePort 注入、onChanged 注入、尾节流 1000ms 保留 |
| `src/state/Shards.ts` | `world/Shards.ts` | 字段表参数化 `ShardFieldSpec`；缺片回落 / isShardedMain 判据逐行等价 |
| `src/state/storage.ts` | `plugins/PluginInterface.ts` 的 SavePort 形状 | 引擎自有最小 SavePort + `InMemoryWorldStorage`（§40 内存介质） |
| `src/mutate/WorldMutate.ts` | `world/WorldMutate.ts` 通用子集 | 引擎版通用原语（位置/旗帜/背包/实体/声望/天气/效果/见闻录/编织替换） |
| `src/command·rules·runtime·api` | 无既有对应（天穹命令层是游戏层） | 按方案 §12/§13/§63 新建最小链路 + 7 条内置规则 |

## 4. 天穹如何重接（Adapter 层）

依赖方向：`UI → Tianqiong → Adapter(6 文件) → World Engine`（方案 §49）。
全仓 100+ 处 `@/world`、`@/events` 导入**一行未改**——模块路径与导出面完全不变。

| 天穹文件 | 重接后内容 |
|---|---|
| `world/TimeBase.ts` | 再导出引擎常量（数值逐位一致，单一来源） |
| `world/Shards.ts` | 引擎拆装算法 + 天穹分片字段表（npcs/memories/beliefs/knowledge/cases） |
| `events/EventSchema.ts` | 引擎事件结构再导出 + 天穹分级/通道表模块加载时注册 + `isNamedPerson`（依赖世界书，留在天穹） |
| `events/EventBus.ts` | 引擎 rng/scheduler/worldBus 再导出 + 天穹 UI 总线（bus/toast/emitChanged）与富文本出口（esc/rich）原样保留 + `setWorldBusLogger(RunLog)` 桥接 |
| `world/WorldState.ts` | 引擎容器（holder=天穹 core 三槽位、savePort、分片表、onChanged→bus）+ 天穹 newState/hydrate/HMR 原样保留；对 systems/* 导入仍恰为 [Economy, Factions]（arch-deps 门禁保持通过） |
| `world/WorldClock.ts` | 引擎推进循环（onHourTick→directorTick）+ 天穹历法标签（WB 月名/时辰名/时段名/纪年 612）+ periodSeg/timeOfDayOf 表现分组原样保留 |

引擎经路径别名源码直连（`@wengine/*` → `../world-engine/src/*`，已配 tsconfig / vite / vitest 三处）。无构建产物同步问题；升级为正式 npm 包是 SDK 阶段（V0.3）的事。

## 5. 刻意不抽取（留在天穹，理由见审计 §2）

- `WorldMutate.ts` 全部原语、`WorldAPI.ts` 查询门面、`WorldRuntime.ts` 命令分发、`Narration.ts` / `NarrativeContext.ts`（叙事层，方案 §6）、`index.ts` 门面、`types/world.ts`（eslint arch-data 强制零依赖）。
- 原则：这些文件与天穹世界书 / 插件 / 执行器 / AI 端口深度互锁，强行抽取必然触发方案 §59 停止条件（重写命令层 / 重写事件系统 / 大规模改动）。引擎侧已备好对应位置（mutate / API / rules），后续阶段逐块迁移。

## 6. 验证结果（双运行验证，方案 §33/§38）

### World Engine 独立运行
```
npm install        ✓ 36+12 packages
npm test           ✓ 46/46（8 文件：state/clock/bus/mutate+runtime/api/integration/invariants/example）
npm run typecheck  ✓ tsc --noEmit 零错误
npm run build      ✓ dist/（d.ts + js）
npm run example    ✓ basic-world 全场景
```
不变量验收（方案 §58/§71）：
- [x] 独立编译 / 独立测试 / 独立运行（不经天穹，`tests/integration` 用纯引擎装配）
- [x] 不依赖 React / UI / Zustand / 具体LLM / Memory / Tianqiong（`invariants` 测试源码扫描固化，注释不计）
- [x] Command → Runtime → Rule → Mutation → State → Event 全链（`mutate-runtime`/`integration` 测试逐环断言）
- [x] Core 无天穹 if/else、无游戏专属代码（引擎源码不知任何游戏存在）
- [x] worldId 预留（§42）、事件 eventId/day/tick/type/data（§43）、内存存储（§40）

### 天穹回归（抽取后行为不变）
```
npx tsc --noEmit   ✓ 零错误
npx eslint         ✓（含 arch-deps / arch-infra / arch-state-write / arch-data 分层守卫）
npx vitest run     ✓ 113 文件 / 1704 用例全部通过（含 time/sync/shards/core/arch-* 等直接钉住被抽取行为的测试）
npm run build      ✓ tsc + vite 生产构建
```
关键回归点：存档分片往返（repo/shards.test 492 行）、落盘节流（sync.test 实测窗口合并）、历法换算（time.test 12 月轮回/跨年/季节切点）、事件配额与幂等（arch-infra 750 行）、HMR 世界保持（dev 环境机制未动）。

## 7. 与方案的重合与偏差

逐条对照方案 §72 的 Step 1–14 全部执行；Step 6（逐个解决跨项目依赖）的解法是「结构化类型信封 + 注入」而不是「改天穹类型」，这是本报告最重要的一个设计裁决：天穹 `types/world.ts`（1078 行，被 eslint arch-data 强制零依赖）一字未动，天穹 `WorldState` 以 TS 结构化类型满足引擎信封——解耦在**运行时边界**完成，而不是在**类型声明**上完成。

## 8. 下一步（不在本阶段，方案 §69 路线图）

见 `WORLD-ROADMAP.md`。

---

## 附录 A · V0.2 验收复查记录（2026-09-29，方案 §58 清单）

V0.2（Adapter 收尾）按 `WORLD-ROADMAP.md` 完成工作项 V2.1–V2.6：

| 工作项 | 结果 |
|---|---|
| V2.1 写入原语统一 | ✓ 天穹 WorldMutate = 引擎 createMutate（13 通用原语，经 entryOf/stamp 钩子注入天穹世界观）+ 天穹资源原语；调用面零改动 |
| V2.2 查询面下沉 | ✓ 引擎抽 createQuery；天穹 world.query 通用子集（get_world_state/time/weather/location/history + 引擎新增 entities/entity/player/log）与 createWorld 门面同源 |
| V2.3 世界史通道核对 | ✓ 天穹 EventStore 走 SavePort.loadWorldLog/saveWorldLog 单一通道；引擎 InMemoryWorldStorage 补齐该通道并加往返断言（47 用例） |
| V2.4 契约登记 | ✓ docs/COMMAND-EVENT-CONTRACT.md（dispatch → 事件 → 原语底册 + 规则化迁移台账，本期零迁移） |
| V2.5 测试矩阵补齐 | ✓ 天穹新增 src/tests/engine-adapter.test.ts（9 用例：容器槽位/历法注入/分级注册/entryOf-stamp 桥接/查询同源/分片表） |
| V2.6 Adapter 指南 | ✓ docs/ADAPTER-GUIDE.md（六步接入 + §23/§30/§48 禁止事项 + 自检清单） |

**§58 架构验收清单复查（V0.2 末）**：World Engine 独立编译 ✓ / 独立测试 ✓（47）/ 独立运行 ✓（example 2/2）/ 不依赖 React ✓ / 不依赖 UI ✓ / 不依赖 Tianqiong ✓（invariants 扫描）/ 不依赖具体 LLM ✓ / 不依赖 Memory ✓ / Tianqiong 正常使用 ✓（1713 回归）/ Tianqiong 行为无明显变化 ✓ / Command→Runtime→Rule→Mutation→State→Event 完整 ✓ / 存在 Tianqiong Adapter ✓ / Core 无 Tianqiong if/else ✓ / Core 无游戏专属代码 ✓ / 可未来封装 HTTP ✓ / 可未来被其他游戏接入 ✓（V3.4 第二游戏为实证项）。

**回归基线更新**：天穹 **1713**（+9）、引擎 **47**（+1）。eslint（含 arch-deps/arch-state-write/arch-data）与双端 typecheck 全绿。

---

## 附录 B · V0.3 验收复查记录（2026-09-29，方案 §58 清单）

V0.3（World SDK）按 `WORLD-ROADMAP.md` 完成工作项 V3.1–V3.5：

| 工作项 | 结果 |
|---|---|
| V3.1 包化 | ✓ dist（ESM+d.ts）成唯一消费面；引擎内部导入 `.ts` 化 + 构建重写，dist 经 node 直接 import 实证；`npm pack` 产物 → 临时目录安装 → import 跑通完整世界；天穹删三处 `@wengine` 别名改 `file:` 依赖，7 文件统一包入口导入 |
| V3.2 版本与发布 | ✓ semver 策略入 CHANGELOG；0.3.0 + tag |
| V3.3 实例隔离裁决 | ✓ `docs/DECISIONS.md` DR-001（保持进程级单例、声明「一进程一活动世界」、隔离归 V0.9）；BLOCKERS B4 关闭 |
| V3.4 第二个最小游戏 | ✓ `examples/second-game`「铁与沙」：不同历法（3024/10月×20日）、不同分级（storm_brewing=critical）、自定义规则（forge/hunt）——全程公共 API，引擎零改动，3 用例独立全绿 |
| V3.5 接入指南 | ✓ ADAPTER-GUIDE 升级第三方 SDK 文档：安装/快速开始/四件套速查/DR 声明 |

**§58 清单复查（V0.3 末）**：独立编译 ✓ / 独立测试 ✓（50）/ 独立运行 ✓（example + pack 实证）/ 不依赖 React ✓ / 不依赖 UI ✓ / 不依赖 Tianqiong ✓ / 不依赖具体 LLM ✓ / 不依赖 Memory ✓ / Tianqiong 正常使用 ✓（改包消费后 1713 回归 + vite 构建全绿）/ Tianqiong 行为无明显变化 ✓ / 命令链完整 ✓ / 存在 Tianqiong Adapter ✓ / Core 无游戏 if/else ✓ / Core 无游戏专属代码 ✓ / 可封装 HTTP ✓ / **可被其他游戏接入 ✓（second-game 实证）**。

**回归基线更新**：天穹 **1713**、引擎 **50**（+3）。§3 不做清单零越界（HTTP/鉴权/多租户仍未做）。

---

## 附录 C · V0.4 验收复查记录（2026-09-29，方案 §58 清单）

V0.4（HTTP API）按 `WORLD-ROADMAP.md` 完成（该版为单工作项，§19/§64）：

| 项 | 结果 |
|---|---|
| 传输层与核心分离 | ✓ 核心桶零 HTTP 痕迹（invariants 扫描含 src/http 仍全绿）；`world-engine/http` 子路径出口 |
| §64 六条路由 | ✓ POST/GET /v1/worlds、GET /{id}、GET /{id}/state、POST /{id}/commands、GET /{id}/events?n、POST /{id}/time |
| World API 形状不变 | ✓ 协议适配器只是 WorldHandle 的另一张皮，引擎核心零改动 |
| 真实传输实证 | ✓ node:http + fetch 端到端（127.0.0.1 临时端口）：创建→命令→状态→时间→事件全链；dist 子路径 node 直 import 实证 |
| 安全基线 | ✓ 默认只绑 127.0.0.1（DR-003）；体上限 1 MiB→413；坏 JSON→400；意外异常→500 不裸奔 |
| 一服务器一世界 | ✓ DR-003（与 DR-001 一致）；重复创建 409；`{id}` 不匹配 404，V0.9 多世界就位时客户端零改动 |

**§58 清单复查（V0.4 末）**：独立性各条 ✓（57 用例 + build + example + dist 子路径实证）；Tianqiong 1713 回归 ✓（核心未动）；不依赖 React/UI/Tianqiong/LLM/Memory ✓（invariants 覆盖新增 src/http）；Core 无游戏专属代码 ✓；可封装 HTTP → **已封装** ✓。

**回归基线更新**：天穹 **1713**、引擎 **57**（+7）。§3 零越界：鉴权/多租户/HTTPS 终结仍不做（DR-003 安全基线已按最小面处理）。

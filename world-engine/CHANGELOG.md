# Changelog

本文件记录 AI World Engine 的版本演进。格式参考 Keep a Changelog；版本线见 `docs/WORLD-ROADMAP.md`（方案 §69）。
版本策略（semver）：0.x 期间允许带 CHANGELOG 注明的 API 调整；**1.0 起冻结公开 API**。

## [1.0.0] - 2026-09-30 · Core Boundary 定型（V0.9→V1.0 Core Boundary Refactor）

内核边界收敛 + 泛化验证（《V0.9-to-V1.0 Core Boundary Refactor》Phase 0–11 全部完成）。
**公开 API 自本版起冻结。**

### Added
- **World Definition（§八）**：`applyDefinition` + `createWorld({ definition })`——
  应用在创建时注入实体/地点/关系/变量/元数据；内核只知道 id/type/attributes。
- **Core 命令补齐（§5.1）**：`create_entity / remove_entity / update_attribute / set_relation / move_entity`
  （coreRules.ts，只操作内核通用容器）；`move_entity` 支持实体级移动。
- **状态信封通用容器（§4.2）**：`locations / relations / variables / metadata`（状态级）+
  `EntityDynamic.type / .attributes`（实体级）——全部可选、向后兼容。
- **RPG 兼容规则模块（§5.2/§5.3）**：`rpgCompat.ts`（attack/talk/set_attitude/spawn_entity 标注 EXTENSION，
  缺省仍装配，可经 `noBuiltinRules` 排除）——Core 内置集不再含玩法语义。
- **架构不变量扩展（§11）**：内核禁依赖 AI 层包（gateway/memory）+ Core 规则与运行时禁 RPG 语义词。
- **examples/colony**：太空殖民模拟——与既有示例完全不同类型的世界（火星历/殖民者/生产配给/建造），
  全程零内核改动，覆盖方案 §十二 十项验收。
- 五份边界报告：CORE-BOUNDARY-AUDIT / CORE-EXTENSION-CLASSIFICATION / STATE-GENERALIZATION-REPORT /
  COMMAND-BOUNDARY-REPORT / EVENT-BOUNDARY-REPORT。

### Changed
- 内核源码完成去宿主化（0 处应用指称）；事件总线/事件模式工厂化沿袭 V0.9。

### 验收（§十六 A–G）
- A 独立性 ✓（删应用后创建世界/实体/时间/命令/规则/事件/存读档全通）
- B 泛化 ✓（两个不同类型应用零内核改动接入）
- C Core 纯净 ✓（不变量扫描：无游戏/UI/模型/AI 层依赖，无 RPG 语义词）
- D State 泛化 ✓（通用容器为正解，RPG 字段标注 candidate-extension 保留兼容）
- E Command 泛化 ✓（Core 只要求 §5.1 七命令，玩法命令由扩展提供）
- F Event 可控 ✓（深度/预算/幂等/重试/死信全有测试）
- G AI 解耦 ✓（不变量扫描强制）

## [0.9.0] - 2026-09-30 · Multi-World：作用域隔离 + WorldRegistry（V0.9，方案 §42）

引擎核心自 V0.1 以来首次大改：事件总线与事件 id 序号作用域化（DR-001 兑现）。
**既有宿主零改动**：模块级导出绑定为全局缺省作用域，天穹（单世界）1716 回归全绿。

### Added
- `createWorldEventBus()` / `createEventSchema()`：事件总线与事件模式（分级表/通道表/序号）的独立作用域工厂；
  模块级 `worldBus` / `makeEvent` 等绑定为全局缺省作用域（DR-004）。
- `createWorld({ isolated: true })`：每世界独立总线 + 独立事件 id 序号；`WorldHandle.bus / .events` 暴露作用域。
- `createWorldRegistry()` / `WorldRegistryError`：多世界注册表（worldId 必填唯一、get/list/close；强制 isolated 作用域）。
- `world-engine/http` 注册表模式：`startWorldServer({ registry })` / `createWorldHttp({ registry })`——
  `POST /v1/worlds` 可多次（每世界独立作用域），六条路由形状不变（DR-003 兑现）。
- `WorldClockOptions / WorldRuntimeOptions` 增加可选 `bus / events` 注入。
- tests/registry.test.ts：**双世界隔离不变量**（事件环互不含同条事实、事件 id 分域起算、总线订阅互不可见、
  隔离世界不进全局总线）+ WorldRegistry 语义 + HTTP 注册表 E2E。

### Changed
- 事件总线/模式内部重构为工厂；全局缺省作用域逐字节保留既有行为（天穹 1716 回归全绿）。
- `rng / scheduler` 明确为**进程级共享执行设施**（DR-001/DR-004 语义声明；隔离范围为事件域）。

## [0.4.1] - 2026-09-29 · HTTP 载荷净化（安全加固）

安全审计（Mimosa）标记 HTTP 命令入口的不可信对象透传为高危。引擎没有 SQL（持久化走 SavePort 抽象），
注入归类不成立；但「不可信对象不裸进运行时」的担忧成立，按纵深防御修复：

### Changed
- `POST /v1/worlds/{id}/commands`：命令体改为**白名单重建**——只放行 `type/actorId/targetId/amount/text/payload`
  契约字段；字符串限量（type≤64、id≤128、text≤2000）；`payload` 只收**一层基本类型**（≤32 键、串≤2000），
  嵌套对象/数组不再透传；缺 `type` 或超长 → 400。
- `POST /v1/worlds`：创建参数白名单化（worldId/playerName/startLoc/weather + labels 逐字段校验），
  未知键（含 `rules`）一律不透传。
- 语义提示：HTTP 命令载荷契约收敛为「一层基本类型」——此前嵌套结构能进引擎属未定义行为，现明确拒绝。

### Added
- 协议测试 +2：净化路径（未知键丢弃/嵌套剔除/超长 400/labels 白名单）。
- 安全扫描留档（Mimosa deep，密封）：`scan-2026-09-29T14-08-55.606Z-64d0cfcfe09b`
  （seal `sha256:d8db2ea8…d0b31`）。残留 2 high：`executeCommand`/`advanceTime` 被命名启发式
  判为 `sink:sql-injection`——**已知误报**：全仓零 SQL（持久化走 SavePort 抽象，依赖扫描
  63 包零 SQL 组件），污点链终点只是方法名；HTTP 入口已完成上述白名单净化。
  处置（放行/改名/保留拦截）属宿主安全策略，待裁决后在该条目回填结论。

## [0.4.0] - 2026-09-29 · HTTP API（V0.4）

传输层落地（方案 §19/§64）：**World API 形状不变，只加传输层**。核心桶保持环境中性，HTTP 走独立子路径出口。

### Added
- `world-engine/http` 子路径出口：
  - `createWorldHttp`：纯协议适配器——§64 全部六条路由（创建/清单/概要/state/commands/events/time）映射到 World API，输入已解析请求、输出状态码+载荷，无 socket 可全量测试；
  - `startWorldServer`：node:http 薄壳（解析 URL/JSON、体上限 1 MiB→413、坏 JSON→400、意外异常→500），**默认只绑 127.0.0.1**（无鉴权端口不默认外露）。
- `docs/DECISIONS.md` DR-003：一服务器一世界（与 DR-001 一致，多世界等 V0.9 隔离）；路由 `{id}` 自 V0.4 起为真实参数。
- `tests/http.test.ts`：协议路由 7 用例，含 node:http + fetch 真实 socket 端到端。

### 边界（§3）
- 不做鉴权 / 多租户 / HTTPS 终结（反代的事）；`rules` 不可跨 HTTP 注入（规则属宿主代码）。

### 验收
- 引擎 typecheck 0 错；57 用例（50+7）+ build + example 全绿；dist 子路径 `dist/http/index.js` 可被 node 直接 import。
- 天穹回归不受影响（核心未动）：1713 用例全绿。

## [0.3.0] - 2026-09-29 · World SDK（V0.3）

引擎从「源码别名直连」升级为正式 npm 包，并以第二个游戏实证可复用（方案 §64/§67）。

### Added
- **包化**：`main/types/exports` 指向 `dist`（ESM + d.ts）；`files` 收敛发布内容；dist 可被 node 直接 import（内部相对导入带 `.ts` 扩展名 + `rewriteRelativeImportExtensions` 构建重写）（V3.1）。
- `examples/second-game`：「铁与沙」——与天穹无关的最小游戏，实证接入四件套：不同历法（10 月×20 日/纪年 3024）、不同事件分级（storm_brewing=critical）、自定义规则（forge/hunt）；全程公共 API，不改引擎一行（V3.4）。
- `docs/DECISIONS.md`：DR-001 实例隔离推迟至 V0.9（关闭 BLOCKERS B4）；DR-002 消费面 = 构建产物（V3.3/V3.1）。
- `docs/ADAPTER-GUIDE.md` 升级为第三方 SDK 接入文档：安装、60 秒快速开始、四件套速查表（V3.5）。

### Changed
- 天穹消费方式：删除 `@wengine/*` 源码别名（tsconfig/vite/vitest 三处），改为 `file:../world-engine` 包依赖，7 个 Adapter 文件统一从包入口 `world-engine` 导入；**引擎改码后必须先 `npm run build` 宿主才能见到变化**（构建顺序纪律）。
- `package.json` 摘掉 `private`（SDK 语义）。

### 验收
- `npm pack` 产物 → 临时目录安装 → `import('world-engine')` 跑通完整世界场景（独立安装实证）。
- 引擎 50 用例（47 + 3 第二游戏）+ build + example 全绿；天穹 typecheck / eslint / **1713 用例** / vite 生产构建全绿。

## [0.2.0] - 2026-09-29 · Tianqiong Adapter 收尾（V0.2）

按 `WORLD-ROADMAP.md` V0.2 工作项 V2.1–V2.6 完成；天穹与引擎之间的双实现收敛为单一来源。

### Added
- `createQuery` / `WorldQuery` / `QuerySource`：通用只读查询的单一实现点，`createWorld` 与宿主共用（V2.2）。
- `MutateOptions`：`createMutate` 新增 `entryOf`（实体建档钩子，宿主可带建档副作用）与 `stamp`（见闻录时间戳钩子）（V2.1）。
- `InMemoryWorldStorage` 补齐世界史通道 `loadWorldLog/saveWorldLog` + 往返断言（V2.3）。
- `docs/COMMAND-EVENT-CONTRACT.md`：dispatch → 事件 → mutate 原语契约底册与规则化迁移台账（V2.4）。
- `docs/ADAPTER-GUIDE.md`：六步接入指南（V2.6）。
- 天穹 `src/tests/engine-adapter.test.ts`：9 条缝合面测试（V2.5）。

### Changed
- 天穹 `WorldMutate`：13 个通用原语（playerLoc/playerFlag/playerBag/npcEntry/npcAtt/npcMet/npcBag/npcGold/rep/weather/addEffect/removeEffect/pushLog/appendRecap/weaveLogs）切换到引擎实现；资源类原语与关系种子投影留在天穹（V2.1）。
- 天穹 `WorldAPI.query`：get_world_state/time/weather/location/history 五处重复实现删除，委托引擎 `createQuery`（V2.2）。

### 验收
- 引擎 47 用例 ✓（含不变量扫描）；天穹 1713 用例 ✓；双端 typecheck / eslint 全绿。
- 行为不变：全部改动调用面零变化，全量回归通过。

## [0.1.0] - 2026-09-29 · 独立项目抽取（V0.1）

- 从天穹抽离独立 World Engine：状态信封 / rng+scheduler / 世界事件总线（配额·因果·幂等·死信·计划事件）/ 世界时钟推进循环 / 状态容器（need·尾节流·分片存档·SavePort）/ 受控写入原语 / Command→Rule→Mutation→State→Event 命令链 / createWorld 门面。
- 天穹经 6 个重接文件运行在引擎上；全量回归 1704/1704 通过。
- 文档：依赖审计 / 抽取报告 / 偏差记录 / README。

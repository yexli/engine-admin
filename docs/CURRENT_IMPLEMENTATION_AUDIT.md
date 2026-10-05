# 当前实现审计（P0 · 方案 §三）

> 生成时间：2026-10-03
> 审计方式：代码逐模块走读（4 路并行深度审计）+ 全量测试实跑取证。不以 README / 设计文档代替代码验证。
> 测试证据（实跑）：

| 包 | 版本 | 测试结果 |
|---|---|---|
| `world-engine/`（内核） | 1.2.0 | **18 文件 107/107 通过**（vitest，7.4s） |
| `platform/`（平台面） | 0.10.0 | **13 文件 180/180 通过**（vitest，23.9s） |
| `world-engine/gateway/` | 0.7.1 | **6 文件 30/30 通过**（3.3s） |
| `world-engine/memory/` | 0.8.2 | **2 文件 20/20 通过**（1.1s） |

模块总览：**10 个内核模块全部有真实实现，非空壳**。Evolution Runtime V2 的 7 项验收中 6 项已实现且有真引擎级测试覆盖；天穹最小链路（参考宿主）已真实跑通且无硬编码触发旁路。主要缺口集中在：触发引擎只有世界级分级、Context 无预算与记忆段、Memory 包零接线、参考宿主缺商人 NPC 与地点表、引擎事件持久化未闭环。

---

## 一、world-engine 内核（v1.2.0）

### 1. World Registry —— ✅ 真实实现
- **已实现**：`createWorldRegistry()` → `create/get/list/close/size`；`worldId` 必填唯一；**强制 `isolated: true`**（每世界独立事件总线 + 独立事件 id 序号）。
- **代码**：`world-engine/src/api/WorldRegistry.ts`（57 行；强制隔离 L36）。
- **调用关系**：`adapter.ts` hostGameWorld L124 → registry.create；HTTP 注册表模式（`src/http/protocol.ts` L496-514 创建 / L552 DELETE 关闭）；全局 WS 流世界集合（`src/http/ws.ts` L131）。
- **测试**：`tests/registry.test.ts` 6 用例（双世界事件互不可见、事件 id 分域、总线不串扰、全生命周期）。
- **缺失/风险**：`close()` 不做资源收尾（不 flushSave、不 dispose SavePort、不 bus.reset），悬垂句柄仍可执行命令。

### 2. State / Entity / Relation —— ✅ 真实实现
- **已实现**：`EngineWorldState` 最小信封（worldId/ver/evtSeq/seed/t/weather/player/npcs/rep/events/history/log/recap + V1.0 扩展 locations/relations/variables/metadata）；实体 `EntityDynamic`（att/mem/met/rels/bag/gold/effects/type/attributes）；关系 `RelationRecord`（source/target/type/value/metadata）。`createWorldContainer`：need() 守卫、save 随档带 evtSeq、sync 写后置 + 1000ms 节流、分片介质通道。`applyDefinition` 物化 entities/locations/relations/variables/metadata，幂等。
- **代码**：`src/types.ts` L115-147 / L37-83；`src/state/WorldState.ts`；`src/state/WorldDefinition.ts` L52-98。
- **测试**：`tests/world-state.test.ts` 11 用例（need 抛错、evtSeq 随档、节流合并、分片拆拼、世界史往返）；`tests/http-readonly.test.ts`（实体/地点/关系端点）。
- **风险**：无读档版本迁移机制（`ver` 字段存在但无 migration 钩子）；`playerBag` 无法管理独立实例（uid 行）。

### 3. Command —— ✅ 真实实现
- **已实现**：`WorldCommand { type, actorId?, targetId?, amount?, text?, payload? }` → `WorldRuntime.execute` 唯一入口：beginTick 重置配额 → rules.forCommand 匹配（零匹配拒绝）→ RuleContext（state/command/mutate/clock/emit）→ 逐规则 apply（异常转可读拒绝、false 拒绝）→ container.sync()。命令历史环形缓冲（100 条含快照）。HTTP 门面叠加白名单净化（type≤64 字符、payload 一层基本类型 ≤32 键）。
- **代码**：`src/command/Command.ts`；`src/runtime/WorldRuntime.ts` L74-135；`src/http/protocol.ts` L130-166（sanitizeCommand）。
- **测试**：`tests/mutate-runtime.test.ts` 6 用例（move 全链、原地 move 拒、未注册命令、规则抛错转拒绝）；`tests/http.test.ts`（净化：未知键/嵌套/超长被截）。
- **风险（最重要）**：**命令链无事务性**——规则 B 在规则 A 已改状态后拒绝/抛错，A 的变更保留、已发事实不撤。`ok:false ≠ 零副作用`。对世界模拟语义可辩护（事实不可撤），但必须记录在案。

### 4. Rules —— ✅ 真实实现
- **已实现**：`WorldRule { name, for, apply(ctx): boolean|void }`；RuleRegistry（先注册先接，同名按序全执行）；RuleContext 刻意只给 mutate/clock/emit——**没有绕过写入层的口子**。缺省装配 builtinRules = coreRules(8 条) + rpgCompat(4 条 EXTENSION，文件头明确标注领域语义不进内核集)。拒绝语义：emit(`*_failed`) 事实照发 + `return false` → `ok:false, reason=规则 X 拒绝了命令 Y`。
- **代码**：`src/rules/Rules.ts`；`src/rules/coreRules.ts`（create/remove_entity、update_attribute、set_relation、move_entity、move、advance_time、change_weather）；`src/rules/rpgCompat.ts`（attack/talk/set_attitude/spawn_entity）。
- **测试**：`tests/api.test.ts`（自定义规则生效）；`tests/integration.test.ts` L147-153 **源码扫描断言** coreRules/WorldRuntime 不含 attack/talk/quest/inventory 等 RPG 词——Core/Extension 边界被机器钉住。
- **风险**：`advance_time` 无上限（`{"ticks":1e9}` 同步阻塞——云部署 DoS 面）；moveRule 不校验地点存在（走进不存在的地点也成功）。

### 5. Mutation —— ✅ 真实实现
- **已实现**：`createMutate` 16 个写入原语（playerLoc/playerFlag/playerBag/npcEntry/npcAtt/npcMet/npcBag/npcGold/rep/weather/effects/pushLog/appendRecap/weaveLogs），全部 need() 守卫，夹取策略明确（att ±100、gold≥0、rep 已知键才生效）。宿主注入点 entryOf/stamp。
- **代码**：`src/mutate/WorldMutate.ts`（220 行）。
- **测试**：`tests/mutate-runtime.test.ts`（playerBag 堆叠/透支清行、npcAtt 夹取、rep 未知键忽略、pushLog 窗口）。

### 6. Event —— ✅ 真实实现（因果字段齐全；持久化未闭环）
- **已实现**：`WorldEvent { id, type, day, tick, level, actor, target, location, cause, witnesses, data, parentId, sourceId, processedBy, origin }`——**有 cause / parentId / sourceId 通用因果链 + witnesses 感知边界**。事件总线：单 tick 配额 64 / critical 独立熔断 16 / 链深 6、semantic 超限延后重投（attempts≤8）、processedBy 幂等、causality.withParent 自动挂父、死信队列、schedule/due 按世界日投递。traceChain 沿 parentId 追溯防环。
- **代码**：`src/events/EventSchema.ts` L14-45（结构）、L122-133（traceChain）；`src/events/WorldEventBus.ts`（320 行）。
- **测试**：`tests/world-bus.test.ts` 6 用例（派发顺序契约、duplicate 幂等、延后重投、critical 熔断死信、withParent 挂父）；`tests/integration.test.ts`（traceChain 断言）。
- **缺失（P0 级）**：**事件持久化未闭环**——`SavePort.loadWorldLog/saveWorldLog` 接口与两个介质实现都在，但 **src 内零调用**（grep 证实）；事件环仅内存 200 条，重启即失；WS `?replay=N` 只是内存环重放。
- **说明**：引擎 Event 不携带 Evolution 专属字段（evolutionRunId 等）是**记录在案的设计决定**（`platform/src/evolution/types.ts:190-192`：Core 纪律；反向追溯经管理面 trace API 在 Journal 完成）。

### 7. Scheduler / Time —— ✅ 真实实现
- **已实现**：`TimeBase`（48 刻/日、360 日/年）+ `WorldClock`（advance 逐刻推进：效果衰减 → 日边界 new_day + 到期计划事件结算 → 时辰边界 hour_advanced + 钩子，顺序契约「先广播后钩子」；tillMorning 防零成本刷休息；历法换算）。世界时间的「调度」= bus.schedule/due，由时钟日边界驱动。`src/scheduler.ts` 只是挂钟定时器抽象（落盘节流用）。
- **代码**：`src/time/TimeBase.ts`、`src/time/WorldClock.ts`（208 行）。
- **测试**：`tests/world-clock.test.ts` 7 用例（跨时辰、日边界结算、顺序契约、衰减、tillMorning 双分支、历法轮回）。

### 8. Adapter（G1） —— ✅ 真实实现
- **已实现**：`GameAdapter { gameId, name, seed(): GameWorldSeed }`；seed 字段 worldId/name/ownerGame?/playerName?/startLoc?/locations[]（必填）/npcs?/relations?/facts?；`definitionFromSeed` 纯映射（地点名→attributes.desc 截 128）；`hostGameWorld` 装配：registry.create → NPC 走 create_entity 落位 → 关系走 set_relation → facts 上总线。
- **代码**：`src/adapter.ts`（164 行）。
- **测试**：`tests/adapter.test.ts` 5 用例（映射、装配落位/关系/事实、坏种子抛错、pause/resume 闸门）。外部消费者：`tianqiong/package.json` `file:` 依赖 + 集成验证测试。
- **风险**：`npc.data` 展开进 payload 后除 attributes 外的键被 create_entity 静默丢弃（反直觉）；两处类型洞（`as never`）。

### 9. HTTP / WebSocket —— ✅ 真实实现
- **已实现**：端点全齐（worlds CRUD、state、commands、events、scheduler、entities、locations、relations、time、pause/resume）；WS 零依赖 RFC6455（握手/帧编解码/16MiB 入站上限/30s ping/90s 判死），`/v1/worlds/{id}/events/stream` 与全局 `/v1/stream`、`?replay=N`；鉴权 401 全路由闸门 + 403 worlds:write + ownerGame 可见域（越权 404）+ 归属盖章。
- **代码**：`src/http/protocol.ts`（670 行纯路由）、`src/http/server.ts`（130 行薄壳，默认 127.0.0.1）、`src/http/ws.ts`（294 行）。
- **测试**：http.test 10、http-readonly.test 13、http-lifecycle.test 3、auth.test 5、ws-stream.test 3（真实 socket）。

### 10. Persistence —— ✅ 真实实现（原子写确认）
- **已实现**：SavePort 六边形端口（引擎不认识介质）；FileSavePort **tmp+rename 原子写**（L88-91）、写后置防抖 500ms + flush + exit 钩子 + dispose；损坏档 `*.corrupt-<ts>` 备份 + onError、不静默覆盖；快照分离。
- **代码**：`src/state/storage.ts`、`src/state/fileStorage.ts`。
- **测试**：file-storage.test 4（防抖/重启接续/损坏备份/exit 钩子）。

---

## 二、platform（v0.10.0）· Evolution Runtime V2 —— P1 验收对照

### 4.1 完整闭环 —— ✅
`createEvolutionRuntime().tick()`（`platform/src/evolution/runtime.ts:102`）：
观察（context.ts:52 buildEvolutionContext，读引擎 getState/getEvents）→ AI Driver（driver.ts:44 网关驱动 / :259 脚本驱动）→ 策略围栏 + 白名单翻译（commands.ts:51 translateChange，translate/policy 两级拒绝）→ 幂等检查 → 逐条 POST `/v1/worlds/{id}/commands`（upstream/engine.ts:82-83；HTTP 200 + result.ok=false 识别为 Rules 拒绝）→ 状态机落账 → Journal 留痕。
生产装配：`platform/scripts/run-managed.mjs:109-125`（Journal JSONL + gatewayDriver + NPC_EVOLUTION_POLICY）。HTTP 数据面：`platform/src/admin/http.ts:909-1026`（tick/intent/runs/trace 端点）。
测试：`tests/evolution.test.ts`（实验 A/B、真网关解析）、`tests/evolution-v2.test.ts`（真引擎全矩阵）、`tests/carpet.test.ts`（11 步真人流程）。

### 4.2 因果追踪 —— ✅（Journal 权威式）
- Event → Run → Proposal → Change → Command → Context → Model 全链可反向追溯：`runtime.ts:286-299` traceEvent + admin 端点（`admin/http.ts:951-957`）。
- **设计决定**：引擎 Event 不携带 evolution 专属字段（`types.ts:190-192` 明文 Core 纪律）；causation 以 Journal 为权威（`EvolutionCausation`，types.ts:193-198），满足方案的「建议 Event 支持 causation」的**目标**（反向可答）而不污染 Core。
- 缺口：模型原始请求/响应不落 Journal（可由 context + 提示词模板确定性重建，但不是留痕重建）；trace 只扫内存环 200 条，超窗后 JSONL 有档但不可 trace。
- 测试：evolution-v2.test.ts:352-371（causation 逐字段）、:465-487（端点 200/404）。

### 4.3 Change 独立结果 —— ✅
`ChangeOutcome`（types.ts:206-224）：changeId / status('accepted'|'rejected'|'duplicate') / rejectedBy('translate'|'policy'|'rules'|'duplicate') / reason / commandId / eventIds。超限不静默丢弃，逐条 policy 拒绝（runtime.ts:209-215）。
测试：evolution-v2.test.ts:111-156（rules/policy/translate 各环节拒绝原因）、:284-287（run 内 duplicate）。

### 4.4 Run 状态机 —— ✅（附一条本次 P1 修复的缺口）
running/completed/partially_applied/rejected/failed（types.ts:227-232）；流转 runtime.ts:132/:152/:173/:256-267（零变化或零拒绝=completed 含空提案；有拒有收=partially_applied；全拒=rejected）。
**缺口（本次 P1 修复）**：journal.append 只在 finish 时调用——'running' 态不可观测、中途崩溃零留痕。

### 4.5 幂等 —— ✅（附两条本次 P1 修复的缺口）
- 已实现：幂等键（runtime.ts:104-110）、提案指纹 sha256（driver.ts:233-246 + runtime.ts:178-185）、run 内 change 去重（:199-208）、冷却（:113-124，admin 豁免）、事件消费幂等（consumer.ts:45-54 seen 集合）。
- **缺口（本次 P1 修复）**：① 同一世界并发 tick 无互斥（冷却/指纹都在 finish 才写，并发窗口内双重执行）；② 幂等账纯进程内存，重启即失（Journal 有历史但不参与去重）。
- 引擎侧无命令级幂等键（commandId 只进 Journal）——防护依赖提案指纹；「reason 不同、效果相同」的两次提案不会被挡（已知边界，见风险清单）。
- 测试：evolution-v2.test.ts:226-350（重复提案/幂等键/run 内重复/冷却）、:385-401（consumer 重复投递）。

### 4.6 AI 边界 —— ✅
结构性保证：EngineClient 接口只有 proxy/getState/getEvents/executeCommand（types.ts:123-142），**不存在状态写方法**；驱动拿不到引擎句柄。双层白名单（内核 commands.ts:26-34 + NPC_EVOLUTION_POLICY：3 动作、禁触玩家、3 变化/3 实体、30s 冷却）。OOC/Narrative 永不进引擎（dispatchIntent runtime.ts:277-284）。
测试：evolution-v2.test.ts:117-177（触玩家被拒/OOC 无变化/mind_control 白名单拒）、carpet.test.ts:263-274（OOC 穿透试探失败）。

### 4.7 NPC 不被强制触发 —— ✅
空提案合法（types.ts:126-127、driver.ts:126-137、runtime.ts:261-262 completed）；提示词纪律（driver.ts:63-66「玩家行动 ≠ NPC 必须响应」）；触发分级 high/medium/low + witnesses 感知边界（policy.ts:17-77）。
真实模型验证：DeepSeek 7 次独立判断「玩家只是移动」→ 空提案（docs/V2.1-PHASE-REPORT.md:98-104）。
测试：evolution-v2.test.ts:326-330、:373-401；carpet.test.ts:159-170（进酒馆米露没注意——空提案、世界分毫未动）。

### NPC Runtime / Trigger / Context / Schedule 现状（对照 P3-P7）
- **Trigger**：只有世界级分级（决定「是否触发一次演化 tick」），**没有 per-NPC 唤醒**；且 runtime 只记录 triggerGrade 不用它 gate 执行（medium/low 也跑全量 AI tick）。平台进程内无事件订阅循环——「High 事件→触发」的接线在参考宿主（3s 轮询）。
- **Context**：演化上下文有地点作用域（在场实体完整字段、其余轻量名册）+ 相关关系边裁剪；**无 token 预算**（全仓库无 maxTokens 概念，只有条数上限 20/200）；无 Memory 段、无 Goal 段。聊天上下文（worldagent/context.ts）连实体上限都没有（列全部 NPC）。
- **NPC Runtime**：`platform/src/npc/` 只有 schedule.ts（107 行日程对齐：读权威状态 → tickOfDay 比对 → 不一致才发 move_entity）。NPC 的 Mood/Attention/Goals 无引擎专字段（mood/location 是宿主约定塞 attributes 的）；`met/att` 是仅有的注意力/关系信号。日程表不持久化、日程只支持 location 行为。
- **Memory 联动 = 0**：world-memory 包自洽（4 因子召回 + 向量嵌入 + HTTP 只读面 + 20 测试），但 **platform/内核/网关三处均未依赖**；唯一喂事实的是 demo 脚本 run-demo-memory.mjs；任何决策路径都不调用 recall。`EntityDynamic.mem` 与 MemoryEngine 双轨无桥。

---

## 三、天穹接入现状（P2 起点）

### 已跑通（参考宿主 scripts/run-tianqiong-host.mjs，8795 端口）
四条真实链路（全程 HTTP、与引擎不同进程、零特权）：
1. 玩家输入 → 确定性 Intent（正则词典）→ `move`/`talk`/`advance_time` 命令 → Rules → Mutation → 事实；
2. 幂等消费事件（createEventConsumer，seen 集合，断线重放不重复）；
3. 玩家发起的 High 事件 → 自动触发演化（幂等键 `auto:{world}:{eventId}`，演化产物事件进 evolutionBorn 集合**结构性断环**）；
4. 演化 → Rules → Mutation → 事件 → 天穹消费。

**无硬编码触发旁路**：进酒馆只产生 `player_moved` 事实；米露是否回应由演化 tick 判断（可空提案）。走查脚本 `scripts/run-v21-walkthrough.mjs` 30 项检查（含「进入酒馆后 NPC 未被强制回复」）。

### 与方案 P2 的差距（本次 P2 修复对象）
1. **最小世界缺商人 NPC**：计划要求 米露/酒馆老板/商人 三人，宿主只有前二（keeper 兼卖酒）；地毯测试（carpet.test.ts）里有商人老葛，宿主没有。
2. **地点表不在引擎**：tianqiong-village 经 HTTP 建世界不带 locations（引擎建世界白名单不收），地点只存在于宿主视图映射（PLACE_NAMES）——引擎地点表为空、AI 上下文无地点描述、GET locations 查不到。
3. **无注意力（attention）状态**：计划 P2 状态清单含注意力；当前只有 met/att 与触发分级雏形。
4. **商店购买链路缺失**：宿主只能在酒馆买酒；真人验收路线「离开→商店→购买」在宿主层走不通（测试里有、宿主没有）。
5. **世界不持久化**：tianqiong-village 全内存（引擎重启即失，宿主自动重建——可接受但需知晓）。
6. **事件名差异**：引擎事实是 `player_moved`（带 location），方案示例写的 `player_entered_tavern` 不存在；语义等价（地点进事实 data），按「事件类型不进 Core、语义由接入方解释」的纪律保留 `player_moved`，不新增游戏专属事件。
7. **演化提案无法产生对话**：白名单只有 update_attribute/set_relation/move_entity；「米露说什么」目前只能以 proposal.reason（叙事）呈现给玩家，不进世界事实——符合 P5 第一批动作边界，talk 留待后续阶段。

### tianqiong 真实游戏本体
进程内接入（`file:` 依赖 + createWorldContainer 同总线），**未走 8787/8790 HTTP/WS 闭环**（双状态问题，docs/V2.1-PHASE-REPORT.md:115-117 已列为下一阶段首要工作）；游戏内仍有酒馆硬编码（song→selina 直接开对话、观察文案写死）——属游戏本体内部，不在引擎链路上。真实游戏接入网络闭环不在本次 P2 范围（参考宿主即方案 P2 的验收载体）。

---

## 四、gateway / memory / admin-web 现状

- **gateway（0.7.1，30 测试）**：按标签路由（fast/cheap/reasoning/roleplay/narrative/memory/embedding/structured-output/long-context），六标准角色 intent→[fast] / npc→[roleplay] 等；选型确定性（匹配数降序→prefer→配置序）；缺密钥模型剔除留痕；`explain()` 全轨迹；**换 Provider 只动配置不动业务代码**（网关 route config / 平台 router.json / 受管 Admin Web 热替换三途径）。
- **memory（0.8.2，20 测试）**：4 因子召回（置信 0.4 + 重要 0.3 + 新近 0.2 + 词面 0.15/词 + 可选向量 0.2）；ingestFact 按 witnesses 逐人建亲历记忆；传闻传播衰减；tickDay 衰减 + 遗忘 + 每 owner 200 条上限；HTTP 只读面。**孤岛，未接入任何决策路径**（P7 目标）。
- **admin-web**：Vue3，e2e 冒烟；事件页已直连 WS。本次未改动。

---

## 五、P1 验收结论与本次修复清单

**结论**：P1 七项验收 6 项已达标；第 4.4/4.5 存在三条工程缺口，全部在 platform 层修复（零 Core 改动）：

| # | 缺口 | 修复 |
|---|---|---|
| 1 | 同一世界并发 tick 无互斥，冷却/指纹窗口内可双重执行 | runtime 加 per-world in-flight 锁：并发 tick 串行化，后到者重走幂等检查 |
| 2 | 'running' 态不可观测、中途崩溃零留痕 | journal.append 改 upsert 语义；tick 开始即落 running 记录，finish 原位覆盖 |
| 3 | 幂等账纯内存，重启即失 | run 记录 idempotencyKey；runtime 首次触碰某世界时从 Journal 重建指纹/幂等键账 |

## 六、P2 修复清单（游戏侧 + 引擎 additive）

| # | 缺口 | 修复 |
|---|---|---|
| 1 | 引擎 HTTP 建世界不收 locations | POST /v1/worlds 白名单增加 `locations`（additive，走 WorldDefinition 既有通道） |
| 2 | 宿主最小世界缺商人 | 播种 `trader`（商人老葛 @ shop，goods_rice/money），日程归位 |
| 3 | 商店购买链路缺失 | 宿主确定性经济：买干粮（-3 钱，goods_rice-1，item_rice+1），全走引擎命令链 |
| 4 | 无注意力状态 | NPC 播种 `attention` 属性；驱动提示词声明可用 update_attribute 维护注意力 |
| 5 | 交流结果玩家不可见 | /tianqiong/input 返回附带最近演化 run 的 reaction（叙事呈现，明确标注非世界事实） |
| 6 | 走查脚本未覆盖商店购买 | run-v21-walkthrough.mjs 按方案真人路线扩展（商店购买/注意力/反应可见/无硬编码回复复检） |

## 七、遗留风险清单（不阻塞 P1/P2 验收，按优先级记录）

1. **引擎事件持久化未闭环**（P0 级缺口）：loadWorldLog/saveWorldLog 零调用，重启丢事件史。建议 P3 前闭环。（P3 未含，仍开放——见第十节）
2. **命令链无事务性**：`ok:false ≠ 零副作用`（半成品状态可能残留）。世界模拟语义下可辩护，但需在文档层明确。
3. ~~**触发分级不 gate 执行**~~ → **P3 已解决**：分级 + 唤醒双重 gate（非 High 零调用；High 无人值得唤醒零调用）。
4. ~~**无 per-NPC 唤醒**~~ → **P3 已解决**：`assessWake` 逐实体裁决（HIGH/MEDIUM/LOW/NONE + reasons），wakePlan 入账 run。
5. **Context 无 token 预算、无 Memory/Goal 段** → P4/P7 议题。
6. **Memory 包零接线** → P7 议题。
7. **/intent 端点是白名单旁路**（ic_action 直通引擎，闸门只有权限）——游戏侧通道设计，需在部署文档警示。
8. **库级缺省策略 FULL_CORE_POLICY 全开**：run-managed 已显式传 NPC_EVOLUTION_POLICY，但库级缺省无结构性强制。
9. **Journal 写失败静默**（P1 已加失败计数暴露，仍不炸运行时——纪律如此）。
10. **advance_time 无上限 / registry.close 不收尾 / moveRule 不校验地点存在**：内核已知边界，云部署前处理。
11. **tianqiong 真实游戏未接网络闭环**（双状态）——P2 后的独立工作项。
12. **平台/演化/日程三处各自复制「1 日=48 刻」常量**——漂移风险，P6 Time/Schedule 收口时统一导出。

---

## 八、P0 审计签字

- 审计覆盖：world-engine src 28 文件 / platform src（evolution、npc、worldagent、upstream、router、admin）/ gateway src / memory src / scripts / tianqiong 接入面 / 全部测试文件。
- 方法：4 路并行代码走读（证据到文件:行号）+ 337 项测试实跑 + 源码扫描断言核对（Core/Extension 边界）。
- 结论：**P0 通过**。P1 进入封口修复（三条工程缺口），P2 按第六节清单执行。

---

## 九、P0→P1→P2 执行结果（2026-10-03，方案 §十九 Step 5 报告）

### P1 封口（platform 0.10.0 → 0.11.0）—— 全部完成
| 缺口 | 修复 | 证据 |
|---|---|---|
| 并发 tick 无互斥 | per-world in-flight 锁，后到者重走幂等/冷却检查 | `evolution/runtime.ts`；测试「冷却与并发叠加」「同键并发」 |
| running 态不可观测、崩溃零留痕 | journal.append 改 upsert；tick 开始即落 running；影子 run 落 completed(deduplicated) 终态 | `evolution/journal.ts` + `runtime.ts`；测试「running 中间态留痕」×2 |
| 幂等账重启即失 | run 记录 idempotencyKey；按世界从 Journal 惰性重建（键/指纹/冷却）；崩溃 running 阻塞重试 | `runtime.ts` ensureLedger；测试「重启后三重生效」 |
| Journal 写失败静默 | writeFailures() 计数暴露 | 测试「写失败可见」 |

必测场景（方案 §4 必测 9 项）全部由既有 `evolution.test.ts` / `evolution-v2.test.ts` / `carpet.test.ts` 覆盖并通过；新增 `evolution-p1-closure.test.ts` 8 条。**platform 188/188 通过**。
线上复证（live）：宿主重启后事件回放重发同幂等键 → 「幂等命中，世界未重复变化」；冷却 429 如实拒绝。

### P2 天穹最小真实链路 —— 全部完成
| 缺口 | 修复 | 证据 |
|---|---|---|
| 引擎建世界不收 locations | `POST /v1/worlds` 支持 locations（additive，走 WorldDefinition 既有通道） | world-engine 1.2.1；`tests/http.test.ts` +1；live：GET locations 返回村庄/酒馆/商店 |
| 缺商人 NPC | 宿主播种 trader（商人老葛 @ shop，goods_rice/money/attention）+ 日程 | 走查 [13] |
| 商店购买缺失 | 宿主确定性经济「买干粮」（校验商人在场，-3 钱/干粮+1/库存-1/商人+3） | 走查 [15]-[17]（50→47 钱，rice 0→1） |
| 无注意力状态 | NPC 播种 attention 属性；驱动提示词声明可用 update_attribute 维护 | 走查 [14]；真模型提案 `{"key":"attention","value":"player"}` |
| 交流结果不可见 | /tianqiong/input 附 reaction（narrative=true 标记，10s 窗口，非世界事实） | 走查 [21]；live reaction 全文 |
| 走查未覆盖商店购买 | 走查按方案真人路线扩展（35 项检查） | **35/35 全部通过**（干净环境复跑 2 次） |
| （验收中发现）模型载荷形状不符被 translate 拒 | 驱动提示词补 payload schema（翻译器保持严格不猜） | platform 0.11.0 Fixed；真模型复测提案落地 |

**全链路真模型验收**（DeepSeek，非脚本）：「我想去酒馆找米露」→ ic_action → move → Rules → `player_moved` 事实 → 宿主幂等消费 → High 触发演化 tick → Context（地点作用域+注意力字段）→ AI 判断（多次空提案：「玩家只是移动，米露注意力无人」）→ 显式交谈后 AI 提案 `milu attention=player` → 白名单翻译 → Rules 放行 → Mutation → `evt_2_52` → **trace 端点反向还原**：Event → run `evo_mus9h642_9d4a0c11` → proposalId → changeId `chg_81112fff-088` → commandId `cmd_8b479cb2-456` → 世界状态 `attention:"player"`。
**无硬编码触发验证**：进入酒馆（含重复进出）零 NPC 回复事件（走查 [06][09]）；NPC 是否反应完全由 Trigger→Context→AI 决定（可为空）。

### 版本与测试汇总
- world-engine 1.2.0 → **1.2.1**（additive）：**108/108**；platform 0.10.0 → **0.11.0**：**188/188**；gateway 30/30；memory 20/20。合计 **346 项测试全部通过**。
- Core 架构纪律检查：引擎仅 additive API（locations）；演化 causation 仍以 Journal 为权威（Event 不携带 evolution 专属字段，Core 纪律）；游戏语义全部在宿主/Adapter；AI 无状态写入口。**无违反**。

---

## 十、P3 执行结果（2026-10-03，Trigger Engine · 方案 §六）

### 交付（platform 0.11.0 → 0.12.0，零引擎改动）
| 项 | 内容 | 证据 |
|---|---|---|
| 逐实体唤醒评估 | `evolution/wake.ts` 纯函数：同地/感知边界（witnesses）/牵涉/关系/met·att → HIGH/MEDIUM/LOW/NONE + reasons；「谁没被唤醒」同样可查 | `tests/trigger-engine.test.ts` 方案 §六示例逐条（米露 HIGH、远处商人 NONE、同地陌生人 MEDIUM、在后厨 NONE） |
| 双重成本闸门 | 非 High 零调用；High 但无人 HIGH 唤醒 → 零 AI 调用 | 集成测试：空地点 0 调用、Medium 0 调用 |
| 平台内触发循环 | `evolution/triggerRuntime.ts`：轮询（幂等消费）→ 只认玩家发起（结构性断环 + born 双保险）→ 评估 → tick(auto, wakePlan)；世界显式声明 PLATFORM_TRIGGER_WORLDS | run-managed 装配、dev-stack 守护 tianqiong-village；宿主不再自行 tick |
| wakePlan 入账 | `EvolutionRun.wakePlan`（TickOptions 传入），管理面 runs 可查 | live：`["milu:high","keeper:none","trader:none"]` |

### 方案验收
**「同一个 Event 不能导致所有 NPC 同时调用 AI」**：一批事实至多一次世界级 tick，且只在有人真正值得唤醒时发生。计数驱动实测：3 NPC 场景玩家进酒馆 → **恰好 1 次 AI 调用**（其余 2 NPC 未唤醒）；NPC 事实/时间推进/事件重放 → 0 次。

### Live 真实验收（DeepSeek + 平台内触发器）
走查 **35/35 通过**（触发全部由平台完成，宿主只做显示/日程）。触发日志如实记录每一次裁决：陌生人进酒馆「无人值得唤醒（3 实体中 1 个 low/medium）——零 AI 调用」×4；直接对话「唤醒 milu（其余 2 实体未唤醒）→ tick」×1，模型提案落地 `milu.update_attribute`（applied=1），wakePlan 入账。

### 测试与版本
platform **202/202**（188 + 14 新增）；world-engine 108/108 不变。宿主行为变化：自动触发职责移交平台（`run-tianqiong-host.mjs` 删除 triggerEvolution），反应展示改为等待平台侧新 run（≤6s）。

### P3 遗留（进入 P4 前记录）
- 触发循环与 Context 仍读全量状态投影（wakeStateViewOf 每批一次 getState）——P4 Context Engine 收口 token 预算时一并考虑复用。
- 「NPC 目标」「世界时间作息」暂无引擎事实，唤醒评估未使用（缺因素不编造）——P5 Goals / P6 Schedule 落地后接入。
- 引擎事件持久化仍未闭环（审计风险 #1，独立工作项）。

---

## 十一、P4 执行结果（2026-10-03，Context Engine · 方案 §七）

### 交付（platform 0.12.0 → 0.13.0，零引擎改动）
| 项 | 内容 | 证据 |
|---|---|---|
| 五项预算 | ContextBudget：maxTokens/maxEntities/maxEvents/maxRelations/maxMemoryItems，按方案 §七七级优先序裁剪 | `tests/context-engine.test.ts` 五项逐条 |
| 裁剪纪律 | 实体超限降级名册（不丢名字）；触发事件永不裁；token 超限最旧事件先裁→记忆→名册，裁无可裁如实超限 | 「优先级底线」用例 |
| 预算报告 | budgetReport（各段携带量+裁剪量）入账 run.context，失败必须可见 | live：estimatedTokens=499/6000，carried 如实 |
| 触发段 | EvolutionContext.trigger（当前事件+被唤醒者），事实段渲染首行，实体细节被唤醒者优先 | live：`{"primaryEventId":"evt_1_31","woken":["milu"]}` |
| 记忆/目标通路 | memory（maxMemoryItems 截断+「相关记忆」渲染）与 goal（P5 接入位）——方案 §七组成全项到位 | 注入即出现用例 ×2 |

### 方案验收
**「同一 NPC 在不同 地点/关系/目标/时间/事件 下 Context 产生合理差异」**：地点（位置段/在场实体/地点描述）、关系（相关边有/无）、时间（tick/day）、触发事件（trigger 段）四维实测差异成立；目标维度引擎事实 P5 落地，本阶段验证注入通路。

### Live 验收（DeepSeek + 平台内触发器 + 预算上下文）
走查 **35/35 通过**；run.context 带 trigger 段与 budgetReport（maxTokens 6000 为 run-managed 缺省），模型基于裁剪后的同一份事实作判断。

### 测试与版本
platform **217/217**（202 + 15 新增）；其余包不变。向后兼容：runtime 未配预算 + 无 wakePlan → 行为与 P3 前完全一致（专项用例钉住）。

### P4 遗留（进入 P5 前记录）
- 记忆源未接（P7）：memory 段通路就绪，等 MemoryEngine 接线后由调用方检索注入。
- goal 无引擎事实来源（P5）：NPC Goals 状态落地后由 runtime 注入。
- token 估算是保守口径（非模型分词器精确值），预算语义是「裁剪依据」而非计费口径。

---

## 十二、P5 执行结果（2026-10-03，NPC Runtime MVP · 方案 §八）

### 交付（platform 0.13.0 → 0.14.0，零引擎改动）
| 项 | 内容 | 证据 |
|---|---|---|
| 个体决策 | 核心循环收窄为按唤醒实体：触发器 per-NPC tick（wakePlan 单 HIGH + 幂等键 `auto:{world}:{event}:{npc}`），驱动器以该实体视角判断 | live：run `evo_musfcb77` 键 `auto:…:evt_2_50:milu`，模型以米露视角判断 |
| 焦点作用域 | 冷却与提案指纹按 `world\|focus` 分域：双唤醒互不挤兑冷却、指纹不跨 NPC 串挡 | 测试「米露冷却中跳过、老板照常决策」「个体指纹隔离」 |
| goal 真实来源 | 个体决策时 `context.goal` 取唤醒实体引擎 `goal` 属性（P4 通路接通）；驱动提示词注入目标与个体纪律 | live：goal 段 =「把酒馆经营好，弄清常客们的来历」；测试同 |
| NpcProfile | 方案 §八状态清单 → 既有事实只读组装；Knowledge/Memory（P7）如实标注未接 | `buildNpcProfile` 测试 ×2 |
| 金币禁令（合规缺口修复） | 方案 §八「禁止 AI 直接修改金币」此前未落地——`forbiddenAttributeKeys: ['money','gold']` 翻译层对任何目标拒回 | 测试：AI 提 milu money=99999 → policy 拒，世界分毫未动 |

### 方案 §八验收对照
- 第一批允许动作（move_entity/update_attribute/set_relation）：P1 起即白名单，本轮加金币键级禁令后仍一致 ✓
- 禁止清单逐项落断言：创建/删除 NPC、改玩家核心属性、直接改金币、advance_time/change_weather、未知动作 → 全部围栏拒绝 ✓（权限/系统配置类命令不存在于白名单，结构性不可能）
- 核心循环 NPC Event→Trigger→Context→AI→Proposal→Rules→Mutation→Event：live 走查 35/35 + 个体 tick 落地注意力变化 ✓

### 测试与版本
platform **224/224**（217 + 7 新增）；其余包不变。宿主种子补米露 goal 属性。

### 已知边界（新）
**确定性事件 id vs 平台持久幂等账**：引擎重启后世界重建从 evt_1_1 重新计 id，长驻平台进程的幂等账/消费集会把新世界事件判重（宁阻塞不重复的正确行为，但静默吞触发）。dev 循环同时重启平台即可；多代世界 id 语义（世界实例指纹）留待 P6/P9 收口。

### P5 遗留（进入 P6 前记录）
- Knowledge/Memory 接入位未接（P7）。
- talk/trade/use_item/start_quest 动作按方案留待后续批次。
- 个体 tick 是串行的（同事件多 NPC 顺序执行）——并发批量属 P11 压测议题。

---

## 十三、P6 执行结果（2026-10-03，World Time / Schedule · 方案 §九）

### 交付（platform 0.14.0 → 0.15.0，零引擎改动）
| 项 | 内容 | 证据 |
|---|---|---|
| 历法唯一口径 | `npc/calendar.ts`（CHEN_PER_DAY/tickOfDay/dayOfTick），context/schedule 统一引用；跨包一致性测试钉住（不引包依赖） | 审计遗留 #12 平台内收口；测试「引擎推进 48 刻 = 平台口径」 |
| 日程注册+持久化 | ScheduleStore：管理面 PUT 注册（游戏数据归宿主）、JSON 原子写持久化、形状校验 | `tests/scheduler.test.ts` 存储用例；live：宿主注册 → data/schedules.json → 平台重启自动恢复守护 |
| 平台内调度循环 | ScheduleRuntime：时间事实 → applyNpcSchedule（幂等）→ move_entity 命令；**零 AI 调用**；运行中注册动态纳管 | live：keeper 被挪出日程 → 推进一刻 → 平台自动归位 village |
| 管理面端点 | GET/PUT/DELETE `/v1/npc/worlds/:id/schedules`（PUT 需 gateway:manage） | 端点全矩阵测试（含 401/400/未装配 404） |

### 方案 §九验收（原文：模拟连续 3 天）
- **NPC 作息正常**：错位 NPC 首轮归位；三天逐刻采样全员在日程位置 ✓
- **商店营业正常**：营业时段商人/老板在店（现场可交易），打烊时段归家 ✓
- **NPC 休息正常**：凌晨时段全员在家 ✓
- **AI 调用没有无意义爆炸**：三天纯时间推进 + 触发器参与轮询 → **零次 AI 调用**（Scheduler 确定性对齐；Trigger 只认玩家发起的 High 事实）✓ live：两天推进零 AI 唤醒
- 禁止「每分钟调一次 AI」：调度循环零 AI 设计 + 分工落地（Scheduler → Trigger → AI）✓

### 测试与版本
platform **232/232**（224 + 8 新增）；其余包不变。宿主行为：启动时注册日程给平台（数据归宿主、执行归平台），保留输入时立即对齐做快速反馈（对齐幂等，双驱动安全）。

### P6 遗留（进入 P10 全链路验收前记录）
- 宿主与平台各持一份日程数据副本（宿主用于显示/立即对齐、平台用于权威循环）——漂移风险由走查 [26][34] 的日程比对断言钉住；单一数据源留待 P9 Admin Runtime（日程管理 UI/API 收口）。
- 定时事件（引擎 bus.schedule/due）仍未被平台消费——当前作息只需位置对齐；任务型定时（「某刻发生某事」）留待后续按需接。

---

## 十四、V2.x 基线复核（2026-10-03，P0–P6 全链路回归验收）

基线报告见 **docs/V2-BASELINE-REPORT.md**。要点：

- 自动化：四包 **390 项测试全绿**（108+232+30+20），引擎/平台类型检查通过（复核中修复引擎测试 2 处既有类型瑕疵）。
- live：dev-stack 六服务健康；真人走查**双轮 35/35**（干净起栈 + 全栈重启）；P1–P6 逐阶段证据复核通过（账本落盘与重启幂等判重、地点表/三人组、触发裁决日志与 wakePlan、触发段/goal 段/预算报告、个体幂等键、日程持久化与恢复守护、因果 trace）。
- 跨阶段组合边界实测确认：确定性事件 id vs 持久幂等账（宁阻塞不重复正确工作；多代世界 id 语义登记 P9）。
- **结论：V2.x 基线成立，进入 P7（Memory 联动）。**

---

## 十五、P7 执行结果（2026-10-03，Memory 联动 · 方案 §十）

### 交付（platform 0.15.0 → 0.16.0；审计最大缺口「Memory 包零接线」就此关闭）
| 项 | 内容 | 证据 |
|---|---|---|
| 包接入 | platform 依赖 world-memory（link:，与 world-gateway 同模式）；PLATFORM_MEMORY_WORLDS 显式声明记忆世界 | 构建+测试通过 |
| 摄取侧 | WorldMemoryService：每世界引擎 + JSON 原子写持久化 + 感知边界派生（actor/target + 同场实体）+ 事实 id 幂等（去重账持久化）；MemoryRuntime 平台内循环（零 AI） | live：「摄取 2 条记忆（事实 1 条）」；data/memory/*.memory.json+seen.json |
| 检索侧 | memoryRetriever 注入个体决策：恰一个 HIGH 唤醒时为焦点实体召回 → applyContextMemory 注入 context.memory（maxMemoryItems + token 预算重算同源） | live：run.context.memory 5 条第一人称记忆（"player talk_started → 你"） |
| 方案纪律 | **Memory ≠ 第二世界状态**：摄取零命令、只读世界（测试断言摄取前后状态逐字节不变）；记忆内容只能经 AI 提案 → Rules 影响；驱动提示词声明记忆是主观回忆、与在场事实冲突以后者为准 | 测试「摄取前后世界状态分毫未动」 |
| 合规修正 | P4 token 裁剪顺序修正为方案 §七优先序（名册→记忆→事件最旧先） | 既有 232 测试零回归 |

### 方案 §十验收
- 流程全链：Event →（MemoryRuntime 派生目击者）→ Memory Candidate → Store（幂等+持久化）→ Retrieval（个体决策 4 因子召回）→ Ranking → Budget（maxMemoryItems/token）→ NPC AI ✓
- 「玩家昨天帮助过我」≠ relationship = 100：记忆只进上下文，关系数值仍由 set_relation 提案经 Rules 决定 ✓
- live 闭环：模型推理明确引用记忆（"有与玩家交谈的记忆"）与 goal ✓

### 测试与版本
platform **241/241**（232 + 9 新增）；其余包不变。

### P7 遗留（进入 P8 前记录）
- 检索查询是词面拼接（事件 type+actor+target）；语义召回需注入 EmbedHook（world-memory 已支持热替换，网关 embedding 通道待 P8 收口后接）。
- 传闻传播（spreadRumor）未接：跨 NPC 口口相传需要「谁告诉谁」的社交事实，引擎暂无对应事件——留待后续批次。
- 记忆文本是英文 id 拼接（describe 的 world-min 面），游戏方可用 remember() 自定义文案；中文叙事化属游戏 Adapter 层。
- 感知边界派生取摄取时刻快照（非事实发生时刻）：轮询间隔内 NPC 移动可致 witnesses 偏差。
  缓解=事实自带 location 优先；修正需事件溯源（V2.5）。判定=可接受设计边界，不修代码（P2 卡片10）。

---

## 十六、P8 执行结果（2026-10-03，Model Adapter / Gateway 收口 · 方案 §十一）

### 交付（platform 0.16.0 → 0.17.0，零引擎改动）
| 项 | 内容 | 证据 |
|---|---|---|
| 能力词表 | Capability = roleplay + 方案 §十一 11 项（13 项全集）；缺省路由对齐网关标准角色 | 测试「能力词表与缺省路由」 |
| 受管配置兼容 | 六能力键磁盘必需（既有配置可载）、新七能力可选（未配置=诚实 503）；MANAGED_CAPABILITIES=13 | 测试「六必需/七可选」；live revision 26 配置无损装载 |
| embedding 通道 | 受管网关 buildManagedProvider.embed（与 chat 同纪律）+ 平台 createEmbeddingsClient + 记忆服务 EmbedHook（构造注入/setEmbed 热替换/失败回词面）——P7 遗留语义召回关闭 | 测试 embed 三件套 |
| 换 Provider 验收 | 业务代码只出现能力名；路由经 Admin 热替换 | 单测（mdl-A→mdl-B 同一运行时）+ **live**（见下） |

### 方案 §十一验收（原文：替换 Provider 时不修改 World Runtime 业务代码）
**Live 实证**（revision 26→27→28）：Admin API 加挂 mdl-deepseek-reasoner（R1）+ reasoning 路由热切换 → 同一套演化运行时直接用上新模型（run.modelUsed=mdl-deepseek-reasoner，推理文风可见差异）→ rollback → 恢复 mdl-deepseek。全程零业务代码改动、零重启。
Runtime 无 if-OpenAI/if-DeepSeek：厂商差异收敛在网关 wire/remote（厂商适配层）与 platform vendors（thinking 档位），业务面只见能力名 ✓（源码扫描沿用 integration.test 边界断言）。

### 测试与版本
platform **247/247**（241 + 6 新增）；四包合计 **405 项全绿**。

### P8 遗留（进入 P10 全链路验收前记录）
- 受管 Admin Web 配置界面可配置能力集合为旧六项（API 已支持 13 项）——UI 收口归 P9 Admin Runtime。
- thinking/reasoning_effort 等 Adapter 参数由网关 wire + platform vendors 厂商适配层承担（DeepSeek 实测 off 档）；逐厂商档位矩阵补全按需进行。

---

## 十七、P9 执行结果（2026-10-03，Admin Runtime / Causal Trace · 方案 §十二）

### 交付（platform 0.17.0 → 0.18.0，零引擎改动）
| 项 | 内容 | 证据 |
|---|---|---|
| 统一观测面 | `GET /v1/admin/runtime`：worlds + evolution（各世界 run 汇总）+ trigger/schedule/memory 三循环状态 + AI Calls/因果链指针；装配哪个出现哪个 | live：4 世界 / 45 runs / 三循环 / 52 条磁盘恢复记忆一屏可见 |
| 因果链完整呈现 | trace 响应 `chain`：World Event → Trigger → Context → Model → Proposal → Validation → Command → Mutation → New Events（全 run 留痕组装） | live 8 环：trigger(admin/high)→context(D1 刻16@village,533tok)→model(deepseek-reasoner)→proposal→validation(accepted)→command→mutation(keeper)→new_events(evt_1_22) |
| 多代世界语义（关 P5 遗留） | 世界实例指纹=state.seed；三消费 runtime 周期检测→重置消费集（worldResets 计数）；触发幂等键含代际；记忆 resetSeen | live：引擎重启→三循环全检测（resets=1×3）→新世界 25 条事实恢复摄取→交互正常，平台零重启自愈 |
| 单一数据源 | 宿主 /tianqiong/schedule 改读平台日程存储（回退本地种子） | 宿主改造 |
| Admin Web | 能力表同步 13 项 | admin-web/src/api/modelControl.ts |

### 附带修复（live 验收发现）
**P7 集成缺陷**：模型引用记忆 ref 被误判「编造事实」→ 驱动校验合法引用集纳入记忆 ref + 提示词声明；真编造引用仍被拒。

### 测试与版本
platform **251/251**（247 + 4 新增）；四包合计 **409 项全绿**。

### P9 遗留（进入 P10 全链路验收前记录）
- Admin Web 尚无 /v1/admin/runtime 的展示页（数据面 API 已就绪，UI 归产品化批次）。
- 触发/调度的指纹检测周期性读状态（每 N 轮一次）——多世界规模化时改订阅制（引擎 WS 流）属 P11 压测议题。

---

## 十八、P10 执行结果（2026-10-03，天穹完整真实验收 · 方案 §十三）

验收记录见 **docs/P10-ACCEPTANCE.md**（由可复跑脚本 `scripts/run-p10-acceptance.mjs` 生成，含世界自举）。**结论：PASS——30/30 项检查全部通过。**

### 三维验收（方案原文逐项）
| 维度 | 结果 | 证据 |
|---|---|---|
| 世界一致性 | ✅ | 位置逐步迁移无跳变；购买双向过账（玩家 -3 钱/干粮+1 ↔ 商人 goods-1/钱+3）；时间引擎权威（D1→D2）；OOC/叙事零副作用；NPC 状态变化全部可归类（日程/演化/经济），无不可解释漂移 |
| AI 稳定性 | ✅ | 全程 **2 次** AI 调用（有界）；run id 唯一（无重复执行）；Context 506/643 tokens（≤6000 预算）；Proposal ≤3 变化；触发器全程 tick 8｜零唤醒跳过 15｜非玩家事实跳过 16｜冷却跳过 0 |
| 因果性 | ✅ | 演化落地事实 evt_1_23 八问可答（为什么/谁触发/哪个AI/哪个Proposal/哪个Rule/哪个Command/哪个Mutation/哪个Event），因果链八环齐全；空提案 run 由 proposal.reason 留痕回答「为什么没发生」 |

### 真人流程覆盖（方案 §十三 全项）
进入（基线村庄）→ 移动（「我想去酒馆找米露」）→ 酒馆 → 观察 NPC（可见 mood/attention/关系；**无强制回复**）→ 自由行动（OOC/叙事隔离、世界分毫未动）→ NPC 交流（显式 talk → 个体演化）→ 离开 → 购买 → 等待 → 时间推进 → 返回 → 检查 NPC 变化 ✓

### 验收中发现并修复
1. **宿主 OOC 词表缺口**：「把等级调到 99 级」类越权请求未被识别为 OOC（落入 narrative）→ 词表补 等级/变强/作弊/外挂/无敌/调到/改成/金币/给我。P10 验收脚本永久钉住此场景。
2. 验收脚本自身：run 差集改 id 集合差（对分页免疫）；增加世界自举（非初始状态自动重启引擎+宿主，平台保持运行顺带验证 P9 指纹自愈——本轮 worldResets=2 次自愈）。

### 里程碑
**M5「天穹完整运行」达成**——World Engine 作为天穹世界驱动层完整运行：真实玩家输入 → 意图 → 命令 → 规则 → 事实 → 触发 → 唤醒 → 上下文（含预算/记忆/目标）→ 真模型个体决策 → 围栏 → 落地 → 事实 → 消费呈现，全程可观测、可追溯、有界、自愈。

---

## 十九、V2.3 发布固化（2026-10-03）

P0–P10 收拢为 **V2.3 发布**：

- **发布说明**：docs/RELEASE-V2.3.md（里程碑 M1–M5 全达成；分阶段成果表；核心链路；七条架构不变式；接入方速查；诚实边界清单）。
- **README**：核心能力刷新（演化 V2 / NPC Runtime / Admin Runtime）+ 发布文档与验收记录链接。
- **DEPLOY.md**：能力路由 13 项同步；新增「平台运行时能力开关」一节（Trigger/Memory/Schedule 环境变量表）；冒烟清单接入 walk-through + P10 验收脚本。
- **发布冒烟**：dev-stack 六服务起栈 → 三循环（Trigger/Schedule/Memory）全部启动确认 → 真人走查 35/35。
- **最终全量**：四包 **409 项测试全绿**（platform 251 / world-engine 108 / gateway 30 / memory 20），平台类型检查通过。

**V2.3 发布就绪。** 下一阶段：P11（100 NPC 压力测试）。

---

## 二十、P11 执行结果（2026-10-03，100 NPC 压力测试 · 方案 §十四）

验收记录见 **docs/P11-STRESS-REPORT.md**（可复跑脚本 scripts/run-p11-stress.mjs）。**核心论题成立 ✓：AI 调用 10NPC→1 次、50NPC→1 次、100NPC→1 次**——与 NPC 总数无关，与被唤醒实体相关（每 NPC 占比 1%→0.02%→0.01%）。

| NPC 数 | Event 数 | Trigger tick | 零唤醒跳过 | 冷却抑制 | AI 调用 | 平均 Context | 平均响应 | 失败率 | 记忆库存 |
|---|---|---|---|---|---|---|---|---|---|
| 10 | 33 | 1 | 3 | 5 | 1 | 573 tok | 1896ms | 0 | 256 |
| 50 | 72 | 2 | 2 | 3 | 1 | 1081 tok | 1511ms | 0 | 2298 |
| 100 | 123 | 1 | 0 | 1 | 1 | 1256 tok | 1711ms | 0 | 5717 |

- 最坏情况探针（100 NPC 世界，酒馆 5 名有关系 NPC 全部可达 HIGH）：AI 调用 4 次——上限=在场 HIGH 数，与总 NPC 数无关。
- 成本：三档合计 3+4 次调用、输入侧 Context ≈ 数千 tokens——单玩家持续游玩的演化成本为分级到分币量级，触发漏斗是成本主闸门。
- 压测发现并修复：**平台重启后记忆摄取吞新世界事件**（去重账持久化 vs seed 映射易失）→ `setWorldSeed` 种子持久化 + 变更自动清账（platform 0.18.1）；世界重建自愈自此覆盖全部场景。
- 观察项（不阻塞）：Context 随 NPC 数温和增长（565→1537 tok，名册膨胀）——千级 NPC 时需名册分页，属 P13 Schema 议题。

**P11 通过。** 路线剩余：P12（第二游戏验证）→ P13/P14（通用 Schema/Extension）。

---

## 二十一、P12 执行结果（2026-10-03，第二游戏验证 · 方案 §十五）

**硬性要求达成：不修改 World Engine Core。** 本轮新增文件仅两个——`scripts/run-trade-host.mjs`（Game B「商路」宿主，8796）与 `scripts/run-p12-walkthrough.mjs`（验收脚本）；平台与引擎零代码改动，全部能力经环境变量声明复用（`PLATFORM_TRIGGER_WORLDS` / `PLATFORM_MEMORY_WORLDS` 加一个世界名）。

### Game B「商路」世界（方案 §十五清单逐项）
城市（泉州港/杭州集市/广州商馆）✓ 商人（胡商阿卜杜/浙商沈万）✓ 商品（香料/丝绸）✓ 库存（双向过账）✓ 价格（行情表归宿主，低买高卖）✓ 关系/心情/注意力/目标（与天穹同款属性约定，AI 可维护）✓ 时间（引擎时钟）✓

### 验收（run-p12-walkthrough.mjs，20/20 PASS）
- **贸易链路**：移动三城 → 买丝绸（-8 钱/丝绸+1/沈万库存-1/钱+8，卖方收钱）→ 回泉州 → 卖丝绸（+12 钱/丝绸-1/阿卜杜库存+1/钱-12）→ **利润一致性：低买高卖一循环净赚 4 钱（100→104）**。
- **AI 个体决策对商贸状态生效**：talk 唤醒阿卜杜（wakePlan/trigger.woken 命中），Context 携带其记忆段（多次交谈的第一人称记忆）与目标段（"把香料卖个好价钱，收满一船丝绸"），模型=mdl-deepseek，Context 608/6000 tok。
- **双游戏共存**：同一平台同时守护 tianqiong-village 与 trade-road（纯配置）；天穹宿主同栈在线；商贸世界记忆独立摄取（101 条/3 owner）。
- **OOC/时间**：越权请求隔离；世界日引擎权威。

### 架构验证结论（方案 §十五「如果接入困难优先检查 Adapter/Extension/Schema/Rules/Event」）
**接入零困难**：P2-P9 的全部通用件（HTTP 世界创建/命令链/触发漏斗/预算上下文/个体决策围栏/记忆/能力路由/观测面/多代自愈）对第二个游戏**即插即用**——印证「玩法语义不进 Core、游戏差异收敛在 Adapter/宿主」的分层纪律。贸易价格语义留在宿主（价格归游戏），AI 只能经白名单影响商人属性/关系/位置。

### P12 遗留（进入 P13 前记录）
- 商贸世界未接日程（商人固定守城）——市场日巡城属可选玩法，机制已备（schedule 端点）。
- 多游戏差异化演化策略（商贸游戏或需禁 AI 改库存类属性）——单平台单策略的现状下靠宿主约定，per-game policy 属 Extension 议题。

---

## 二十二、P13 执行结果（2026-10-03，通用 World Schema · 方案 §十六）

**Schema 从双游戏实践提炼为正式契约**（防前瞻抽象：方案 §22 纪律）——docs/WORLD-SCHEMA.md v1.0 + `platform/src/schema/worldSchema.ts`（platform 0.19.0，零引擎改动）。

| 项 | 内容 | 证据 |
|---|---|---|
| 规范属性键 | 六键（location/name/mood/attention/goal/money）含类型/适用对象/写入者/语义；游戏自有键命名纪律（GAME_KEY_PATTERN） | `CANONICAL_ATTRIBUTES`；双游戏真实形状 conforming=true |
| 事实类型面 | 引擎 emit 全集 26 类型按 8 组归类（CORE_EVENT_TYPES） | 归类无重叠测试 |
| 符合性检查 | `inspectWorldSchema`（只读）：errors/warnings/stats——宿主自检/观测面/升级核对 | 契约违规可查、缺省如实提示两组用例 |
| **同源修正** | **触发分级表 P3 时代键漂移**：attitude_changed/combat/schedule_changed 非引擎真实事实 → 缺省表修正（npc_attitude_shift: high / attack_: high）+ 前瞻键显式标注（quest/schedule_changed） | 分级表同源测试（258 项零回归） |
| 玩家位置语义 | canonical location 对玩家 = 引擎原生 player.loc（符合性检查映射） | 双游戏形状 location 覆盖 4/4 |

**P13 通过。** 剩余：P14（Extension 抽象，最小化）→ V3.0。


---

## 二十三、P14 执行结果（2026-10-03，通用 Extension · 方案 §十七）

**Extension 层最小自洽**（platform 0.20.0，零引擎改动）：唯一有双游戏实证的抽象——按世界解析演化围栏 `policyFor(worldId)`（P12 遗留「多游戏差异化策略」关闭）；检讨表（docs/EXTENSIONS.md）：NPC/Relationship 已覆盖、Item/Inventory 推迟、Quest 前瞻不做。生产装配 `PLATFORM_POLICIES_FILE`。测试 `tests/extensions.test.ts`（3 条：商贸拒改库存/RPG 放行/向后兼容）。**四包 412 项全绿**（platform 254）。

**P14 通过——方案路线 P0–P14 全部完成，V3.0「AI World Runtime」抽象门槛达成。**

---

## 二十四、Admin Web 缺陷修复（用户报告：模型路由页卡死导航）

**现象**：打开「AI 网关 → 模型路由」页后，点击任何菜单都停留在该页（Vue Router 被毒化）。
**根因**：P8 能力表扩至 13 项时，admin-web 的 `CAPABILITY_META`（能力中文名映射）未同步——模型路由页模板对每行取 `CAPABILITY_META[cap].desc/.zh`，7 个新能力取到 `undefined` → 渲染抛 TypeError → 路由卡死。Vite 开发模式不做类型检查，故编译期未拦截。
**修复**：① 补全 7 项能力的 META（与 platform Capability 语义对齐）；② 模板/逻辑全部改为可选链 + 回退（未来加能力不可能再崩页面）；③ 顺手修复 games 页两处既有模板类型错误并让 `npm run typecheck` 全绿。
**教训**：双端共享的枚举（Capability）扩展必须同步双端映射表——admin-web typecheck 应纳入发布核验清单。

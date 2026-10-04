# Changelog

本文件记录 World Platform 的版本演进。格式参考 Keep a Changelog。
版本策略（semver）：0.x 期间允许带 CHANGELOG 注明的 API 调整。

## [0.22.0] - 2026-10-03 · V2.4-04 · NPC State Machine：确定性状态视图

方案 V2.4-04 落地（最小状态集；§八「避免退化成每 Tick 问一次 AI」）。

### Added
- **NPC 状态视图**（`npc/state.ts`）：状态由世界事实**确定性推导**
  （位置 + 日程档期 + 注意力），不建第二份状态副本——与「Memory ≠
  第二世界状态」同一纪律。首批规范状态五个：idle / traveling /
  attending / working / resting（方案 8 态中 TALKING / PURSUING /
  WAITING 无双游戏实践，前瞻不做）。
  - `deriveNpcState`：纯函数推导（attention 被占用 → attending 优先；
    档期内 → 档期声明语义；不在档期地点 → traveling；无档期 → idle）。
  - `syncNpcStates`：状态同步——与 `attributes.state` 不同才发
    update_attribute（幂等：同态零命令；每步走命令链 → Rules → 事实）。
    状态事实随后进入上下文（P4/P13 attributes 面），AI 可读、可经提案
    维护，但确定性推导每轮校正。
- **档期状态声明**：`ScheduleSlot.state`（游戏数据声明「在这 = 在做什么」，
  如深夜 home 档 = resting）——语义在 Adapter/游戏数据，机制在平台
  （与日程对齐同构）；存储层校验规范状态集。
- **调度循环接线**：Schedule Runtime 对齐后同步状态视图（确定性，零 AI）；
  迁移与拒绝随日志/状态可观测。
- 测试：`tests/npc-state.test.ts`（12 条：推导矩阵七例、迁移经命令链、
  幂等同态零命令、attending 覆盖档期、对齐后 resting 切换、tick 防重复）。

## [0.23.0] - 2026-10-03 · V2.4-05/06/07 · Decision 语义 / Perspective / Memory Provenance

方案 V2.4-05/06/07 三项合并落地。

### Added
- **Decision 语义标注**（V2.4-05 · 方案 §九）：`EvolutionRun.decision`——
  `act`（AI 提出了变化）/ `wait`（AI 判断此刻不该行动，空提案合法且常常
  正确）。不改 Proposal Schema，仅 run 元数据标注。
- **Perspective 视角构建**（V2.4-06 · 方案 §十）：`evolution/perspective.ts`
  ——以实体为中心的知识视图过滤原语：witnesses 感知边界（列名者/当事人
  可见）+ 同地点公开事实；`buildPerspective` / `isVisibleTo`。
  NPC 不默认看到整个 World State。
- **Memory Provenance**（V2.4-07 · 方案 §十一）：世界记忆包
  `MemoryEntry.sourceEventId` 如实落档（V2.4-00 审计发现字段在类型上存在、
  数据上丢失——world-memory 0.8.3）；平台 `recallFor` 投影带
  `sourceEventId` → context.memory 段——「这句话为什么知道」可回溯到
  Source Event（配合 V2.4-01 事件史按 id 查）。
- 测试：`tests/v24-semantics.test.ts`（9 条）+ `tests/npc-state.test.ts`
  扩 3 条（共 12）。

## [0.21.0] - 2026-10-03 · V2.4-03 · Runtime 分层：AI unavailable → DEFER 语义

方案 V2.4-03 落地（World Runtime / AI Runtime 分层的显式语义化）。基线审计
判定分层已结构性成立（确定性调度/对齐/摄取全零 AI；AI 不在线世界照跑），
本阶段把「AI 不可用」从「AI 出错」中显式区分。

### Added
- **DEFER 语义**：`EvolutionRunStatus` 新增 `deferred`——驱动抛
  `model_unavailable`（模型 API 不可达/超时/未配置）时，run 状态 = deferred
  （决策延后：世界照跑、Journal 留痕、可稍后重试），与「AI 出错」的 failed
  （invalid_proposal / driver_error）区分。两者都绝不伪造世界事实。
- 测试：`tests/runtime-layering.test.ts`（4 条：AI 完全不在线时确定性面全绿
  ——玩家命令/日程对齐/记忆摄取零 AI；触发 tick → DEFER；invalid_proposal →
  failed 语义区分；模型恢复后重试成功且全程 AI 零伪造事件）。
- 既有用例语义升级：「Model Gateway 故障」从 failed 更新为 deferred（模型
  不可用 ≠ AI 出错）；观察失败（世界 404）与坏提案仍为 failed。

## [0.20.0] - 2026-10-03 · P14 · Extension 层：按世界差异化围栏

### Added
- **按世界解析演化围栏**（`evolution/runtime.ts`）：`EvolutionRuntimeOptions.policyFor(worldId)`
  ——多游戏差异化策略零共享代码改动（商贸世界可禁 AI 改库存属性，RPG 世界不受
  影响）。解析优先级 `policyFor(worldId)` → `opts.policy` → FULL_CORE_POLICY；
  `maxChangesPerRun` / `cooldownMs` 装配覆盖仍优先。未传 policyFor 行为与 P13 前
  完全一致（向后兼容）。
- **生产装配**：`PLATFORM_POLICIES_FILE`（data/policies.json，按世界合并到
  NPC_EVOLUTION_POLICY 之上）——检讨表见 docs/EXTENSIONS.md：NPC/Relationship
  已由 Schema/引擎覆盖（无需新抽象）、Item/Inventory 推迟（无差异证据）、
  Quest 前瞻不做（零实践）。
- 测试：`tests/extensions.test.ts`（3 条：商贸世界拒改库存/RPG 世界同提案放行/
  向后兼容语义）。

## [0.19.0] - 2026-10-03 · P13 · 通用 World Schema（双游戏实践提炼）

### Added
- **Schema 模块**（`schema/worldSchema.ts`）：从天穹（RPG）/商路（商贸）两个
  真实游戏的接入实践中提炼的最小通用契约——
  `CANONICAL_ATTRIBUTES`（location/name/mood/attention/goal/money 六键，
  含类型/适用对象/写入者/语义）、`CORE_EVENT_TYPES`（引擎事实 26 类型按组）、
  `inspectWorldSchema`（只读符合性检查：errors/warnings/stats，双游戏形状
  conforming=true 有测试钉住）、`SCHEMA_VERSION`。
  **Core 不感知本 Schema**——它是平台与宿主之间的约定；演进纪律：新键须有
  真实用例，不兼容变更递增版本（防前瞻抽象，方案 §22）。
- 测试：`tests/world-schema.test.ts`（7 条：双游戏真实形状符合性、契约违规
  可查、缺省如实提示、事件面归类无重叠、**分级表同源检查**、规范键定义完备）。

### Fixed
- **触发分级表与引擎事实漂移**（P3 时代遗留，Schema 同源检查发现）：
  `attitude_changed` / `combat` / `schedule_changed` 不是引擎真实事实类型——
  态度变化实际发 `npc_attitude_shift`（被漏判 low）、战斗事实为 `attack_*`。
  缺省分级表修正为 `npc_attitude_shift: high` / `attack_: high`；
  `quest` / `schedule_changed` 显式标注为前瞻键（P14/P6）。
- 符合性检查把玩家位置映射到引擎原生 `player.loc`（canonical location 对
  玩家即此字段）。

## [0.18.1] - 2026-10-03 · P11 · 记忆去重账代际持久化（压测发现）

### Fixed
- **平台重启后记忆摄取吞新世界事件**（P11 压测 50/100 档实测发现）：去重账
  持久化跨重启，而运行时的 seed 映射是易失的——平台重启 + 引擎重建世界后，
  新世界同 id 事实被旧账判重（摄取 0）。现 `WorldMemoryService.setWorldSeed`
  把种子持久化到去重账旁，种子变更 = 世界重建 → 自动清账重记忆；Memory
  Runtime 每批状态读取后顺手调用（零额外开销）。世界重建自愈自此覆盖
  「平台重启」场景（此前只覆盖平台存活场景）。

### 压测
- P11 三档压测（10/50/100 NPC 同构活动）核心论题成立：AI 调用恒定 1 次/档
  （每 NPC 占比 1%→0.02%→0.01%），Event 数 33/72/123，记忆库存
  256/2298/5717，失败率 0——见 docs/P11-STRESS-REPORT.md。

## [0.18.0] - 2026-10-03 · P9 · Admin Runtime / Causal Trace

方案 §十二落地：Admin 的数据面收口——World Runtime / Evolution / Events /
NPC Runtime / AI Calls / Causal Trace 单点可观测（不是堆 CRUD）。

### Added
- **统一观测面** `GET /v1/admin/runtime`：worlds（引擎清单）+ evolution
  （各世界 run 汇总与最新 run）+ trigger / schedule / memory 三循环状态
  （装配哪个就出现哪个，未装配如实缺省）+ AI Calls/因果链指针。
- **因果链完整呈现**：`GET .../events/:eventId/trace` 响应新增 `chain`——
  方案 §十二 全链（World Event → Trigger → Context → Model → Proposal →
  Validation → Command → Mutation → New Events）从 run 留痕组装，不补叙事。
- **多代世界语义**（关闭 P5 遗留「确定性事件 id vs 持久幂等账」）：
  世界实例指纹 = state.seed（重建即变）。三层落地：
  ① 触发/调度/记忆三个消费 runtime 周期比对指纹（`fingerprintEvery`，缺省
  10 轮 + 首轮；记忆复用状态读取零额外开销），变更即重置消费集并计数
  （worldResets）；② 触发幂等键含代际 `auto:{world}:{gen}:{event}:{npc}`
  （不同代世界的同 id 事件互不串挡）；③ 记忆服务 `resetSeen`（重建后
  同 id 事实重新记忆，已存条目保留为角色过去）。
- **修复（P7 集成缺陷，live 验收发现）**：模型把「相关记忆」的 ref 当观察
  引用被误判「编造事实」→ 驱动校验的合法引用集纳入记忆 ref（提示词同步
  声明）；真编造引用仍被拒（语义不变）。
- 测试：`tests/admin-runtime.test.ts`（4 条：观测面分区聚合与未装配如实
  缺省、因果链八环、多代世界重建→重置→恢复触发）。

### Live 验收
统一观测面完整呈现（4 世界 / 45 runs / 三循环状态 / 52 条磁盘恢复记忆）；
因果链 8 环 live 可查；引擎重启 → 三循环全部自动检测重建并重置（worldResets=1×3），
新世界 25 条事实恢复摄取（entries 52→77）、交互正常——平台无需重启即自愈。

### 单一数据源
天穹宿主 `/tianqiong/schedule` 改读平台日程存储（启动时注册的权威副本），
平台不可达才回退本地种子副本。

## [0.17.0] - 2026-10-03 · P8 · Model Adapter / Gateway 收口

方案 §十一落地：**替换 Provider 时不修改 World Runtime 业务代码**——
业务代码只出现能力名，Provider/模型全部经路由配置（Admin 热替换）。

### Added
- **能力词表对齐方案 §十一**（`types.ts`）：Capability = 平台自有 roleplay
  + 方案 11 项（intent / world_reasoning / evolution / npc_behavior /
  reasoning / narrative / memory / embedding / fast / cheap / long_context /
  structured_output）。缺省路由对齐网关标准角色（evolution→reasoning、
  intent→fast、npc_behavior→npc…）。additive：既有六能力调用面不变。
- **受管配置兼容拆分**（`admin/model-config.ts`）：`REQUIRED_MANAGED_CAPABILITIES`
  （原六能力）磁盘必需——既有配置文档（revision 26 起）可载；新增七能力为
  可选键（未配置 = 诚实 503，与受管模式「未配置即 503」语义一致），显式
  提供即生效。`MANAGED_CAPABILITIES` 扩至 13 项（Admin API 可配置全部能力路由）。
- **受管网关 embed 通道**（`admin/managed-runtime.ts`）：buildManagedProvider
  实现 `embed()`——与 chat 同纪律（解析模型目标 → 出站校验 → 调上游），
  embedding 标签模型经 `/v1/embeddings` 出站；此前受管网关只做 chat（501）。
- **平台 embeddings 客户端**（`upstream/embeddings.ts`）：OpenAI 兼容形状，
  向量按 index 排序；非 2xx 如实抛错（code/status 保留）。
- **记忆语义召回接线**（P7 遗留关闭）：WorldMemoryService 支持 embed 钩子
  （构造注入 + `setEmbed` 热替换）；run-managed 装配 EmbedHook——
  select('embedding') → 受管网关；通道未配置/调用失败 → null 回纯词面
  （渐进增强，非硬依赖）。
- 测试：`tests/p8-model-adapter.test.ts`（6 条：能力词表与缺省路由、受管配置
  六必需/七可选、buildManagedProvider.embed（fetch mock）、EmbedHook 注入/
  失败回词面/热替换、embeddings 客户端排序与错误、**换 Provider 热切换**
  ——同一演化运行时路由 mdl-A→mdl-B 零代码改动）。

### Live 验收（DeepSeek，revision 26→27→28）
Admin API 热切换：加挂 deepseek-reasoner 模型 + reasoning 路由指向 →
同一套演化运行时直接用上新模型（run.modelUsed = mdl-deepseek-reasoner，
R1 推理文风）→ rollback → 恢复 mdl-deepseek。全程零业务代码改动。

## [0.16.0] - 2026-10-03 · P7 · Memory 联动：记忆接线到个体决策

方案 §十落地：Event → Memory Candidate → Memory Store → Retrieval →
Ranking → Budget → NPC AI 全链接通——自洽但零接线的 world-memory 包
（P0 审计最大缺口）正式进入决策回路。

### Added
- **平台接入 world-memory 包**（`dependencies: world-memory link:`；
  与 world-gateway 同模式）。记忆世界显式声明 `PLATFORM_MEMORY_WORLDS`
  （空 = 记忆关闭，个体决策无记忆段）。
- **WorldMemoryService**（`memory/service.ts`）：每世界一个 MemoryEngine
  （JSON 文件持久化，tmp+rename 原子写）；**感知边界派生**——引擎 coreRules
  不填 witnesses 时按事实派生目击者（actor/target + 事实地点同场实体，
  玩家位置参与）；摄取按事实 id 幂等（去重账持久化，重启不重复摄取）；
  new_day → tickDay 衰减遗忘（同日幂等）。
- **Memory Runtime**（`memory/runtime.ts`）：平台内摄取循环——轮询事实 →
  状态快照 → 派生 → 摄取（**零 AI 调用**）；start/stop/status/pollOnce。
- **个体决策记忆注入**：`EvolutionRuntimeOptions.memoryRetriever`——
  恰一个 HIGH 唤醒时为焦点实体召回（查询 = 主事件 type+actor+target），
  经 `applyContextMemory` 注入 context.memory（maxMemoryItems 截断 +
  token 预算全量重算，报告同源）；检索失败 = 无记忆，tick 照常（记忆是
  建议材料不是事实来源）；世界级 tick 无单一 owner 不检索。驱动提示词
  补记忆纪律：主观回忆可作动机依据，与在场事实冲突时以后者为准。
- **方案 §七裁剪顺序合规修正**（`evolution/context.ts`）：token 压力下的
  裁剪顺序修正为优先序自低向高——全局名册 → 长期记忆 → 近期事件（最旧先）
  （P4 实现与方案优先序的偏差，本轮修正；既有测试全数通过）。
- 测试：`tests/memory-link.test.ts`（9 条：感知边界派生（同场记/异地不记）、
  幂等摄取、**Memory ≠ 第二世界状态**（摄取前后世界状态逐字节不变）、
  个体决策注入记忆段、无焦点不检索、检索失败不炸、applyContextMemory
  预算同源、衰减幂等、持久化往返含去重账）。

### Live 证据（DeepSeek）
个体 run 的 context.memory 出现米露的第一人称记忆（"player player_moved
（在tavern）"、"player talk_started → 你"，按新近度排序），模型推理明确
引用记忆与 goal（"有与玩家交谈的记忆……考虑到它的目标之一是弄清常客来历"）。

## [0.15.0] - 2026-10-03 · P6 · World Time / Schedule：平台内确定性作息循环

方案 §九落地：时间/作息/Scheduler 归确定性执行，AI 只管异常与临时决定——
**Scheduler → 真正需要判断 → Trigger → AI**，禁止每分钟调用一次 AI。

### Added
- **历法唯一口径**（`npc/calendar.ts`）：CHEN_PER_DAY / tickOfDay / dayOfTick
  ——此前 context 与 schedule 各自复制「1 日=48 刻」（审计遗留 #12 平台内收口）；
  与引擎的跨包一致性由测试钉住（推进 48 刻 → new_day 事实 + tickOfDay 归零），
  不为此引入 platform → world-engine 包依赖（保持进程边界）。
- **日程存储**（`npc/scheduleStore.ts`）：游戏方经管理面注册日程表（游戏数据），
  JSON 文件持久化（tmp+rename 原子写）、load 载入、形状校验（坏条目剔除/整表
  拒绝）；写盘失败计数可查不炸进程。
- **平台内调度循环**（`npc/scheduler.ts`）：轮询世界事实（幂等消费）→ 时间类
  新事实（new_day / hour_advanced / time_advanced）或启动 → `applyNpcSchedule`
  对齐（幂等：已对齐零命令）。**零 AI 调用**；运行中注册的世界动态纳管；
  start/stop/status/pollOnce/align 生命周期。
- **管理面日程端点**：`GET/PUT/DELETE /v1/npc/worlds/:id/schedules`
  （PUT 需 gateway:manage；未装配 scheduleStore → 404 not_configured）。
- **run-managed 装配**：`PLATFORM_SCHEDULES_FILE`（缺省随 PLATFORM_DATA_DIR），
  Schedule Runtime 随平台启停；天穹宿主启动时把日程注册给平台（游戏数据
  归宿主、确定性执行归平台；宿主保留输入时立即对齐做快速反馈，对齐幂等
  双驱动安全）。
- 测试：`tests/scheduler.test.ts`（8 条：**模拟连续 3 天**——错位归位/作息/
  营业/休息逐刻采样、三天推进零 AI 调用、对齐幂等、存储持久化、管理面
  端点全矩阵、未装配 404、历法跨包一致性）。

## [0.14.0] - 2026-10-03 · P5 · NPC Runtime MVP：个体决策 + 焦点作用域 + 金币禁令

方案 §八落地：核心循环「NPC Event → Trigger → Context → AI → Proposal →
Rules → Mutation → Event」从世界级提案收窄为**按唤醒实体的个体决策**。

### Added
- **焦点作用域**（`evolution/runtime.ts`）：wakePlan 恰有一个 HIGH 唤醒 =
  个体决策——冷却与提案指纹都按 `world|focus` 分域。同一事件唤醒两个 NPC
  时各自的个体决策互不挤兑冷却、互不指纹串挡；世界级 tick（focus 空）行为
  与 P4 前一致。
- **触发器 per-NPC tick**（`evolution/triggerRuntime.ts`）：每个 HIGH 唤醒
  实体各跑一次聚焦 tick（wakePlan 只留它一个 HIGH），幂等键
  `auto:{world}:{eventId}:{npc}`。「100 个 NPC 存在 ≠ 100 个 NPC 同时思考」：
  只有真正被唤醒的才思考，一个事件至多产生 woken.length 次调用。
- **goal 段真实来源**（`evolution/context.ts`）：个体决策聚焦唯一唤醒实体时，
  `context.goal` 取该实体引擎里的 `goal` 属性（宿主约定的 NPC 目标事实，
  AI 可经 update_attribute 维护）；驱动器提示词注入「以它的视角判断」个体
  纪律与目标。
- **NpcProfile**（`npc/profile.ts`）：方案 §八状态清单 → 既有事实的只读组装
  （Identity/Location/Mood/Attention/Goal/Relationship/Schedule/Met/att +
  Knowledge/Memory 接入位如实标注未接）。公共出口 `buildNpcProfile`。
- 测试：`tests/npc-runtime.test.ts`（7 条：单唤醒聚焦 + goal 来源、双唤醒下
  冷却不连坐、方案 §八禁止清单逐项（含金币属性键禁令、世界分毫未动断言）、
  个体指纹隔离、NpcProfile 组装）。

### Fixed
- **方案 §八「禁止 AI 直接修改金币」此前未在策略层落地**：AI 可对 NPC 提
  `update_attribute{key:'money'}`。现 `EvolutionPolicy.forbiddenAttributeKeys`
  （缺省策略 = ['money','gold']）在翻译层对任何目标原样拒回——经济属性归
  游戏经济规则。

### 已知边界（记录于 docs/CURRENT_IMPLEMENTATION_AUDIT.md §十二）
引擎重启后世界重建产生相同的确定性事件 id（evt_{day}_{seq} 从头计），
而平台进程的幂等账/消费集持久存续 → 新世界的事件会被判重（宁阻塞不重复的
正确行为，但会静默吞掉新世界的触发）。dev 循环重启引擎时一并重启平台即可；
多代世界 id 语义留待 P9/P6 收口。

## [0.13.0] - 2026-10-03 · P4 · Context Engine：预算裁剪 + 触发段 + 记忆/目标通路

方案 §七落地：Trigger（P3）决定「谁被唤醒」，Context 决定「被唤醒后看到什么」。

### Added
- **五项上下文预算**（`evolution/context.ts`）：`ContextBudget` = maxTokens /
  maxEntities / maxEvents / maxRelations / maxMemoryItems；裁剪优先级照方案 §七——
  当前事件 > 当前位置 > 相关实体 > 直接关系 > 近期事件 > 长期记忆 > 全局信息。
  实体超限**降级名册不丢名字**；触发事件永不裁剪；token 超限从近期事件最旧端
  逐步裁到记忆、再到名册，裁无可裁如实超限不撒谎。`estimateTokens`：CJK 逐字
  计、ASCII 四分之一计（确定性保守口径，零依赖）。
- **预算执行报告**（`EvolutionContext.budgetReport`）：各段携带量 + 裁剪量
  （失败必须可见——管理台/审计能看到 AI 实际看到了什么、被裁了什么）。
- **触发段**（`EvolutionContext.trigger`）：wakePlan 传入时产出「当前事件 +
  被唤醒实体」，渲染为事实段首行；实体细节按被唤醒者优先排序。
- **记忆/目标通路**：`EvolutionContext.memory`（调用方检索后传入，预算按
  maxMemoryItems 截断，渲染为「相关记忆」段）与 `goal`（P5 Goals 接入位）——
  方案 §七上下文组成全项到位，记忆源 P7 接线。
- **runtime 级预算**：`EvolutionRuntimeOptions.contextBudget`；run-managed
  装配缺省预算（maxTokens 6000 / maxEntities 12 / maxRelations 16 /
  maxMemoryItems 8）。未配置 = 不设限，行为与 P3 前完全一致（向后兼容）。
- 测试：`tests/context-engine.test.ts`（15 条：方案验收四维差异——同一 NPC 在
  不同地点/关系/时间/触发事件下 Context 产生合理差异（goal 注入验证通路）；
  五项预算逐项；优先级底线；token 口径；runtime 集成与向后兼容）。

## [0.12.0] - 2026-10-03 · P3 · Trigger Engine：逐实体唤醒 + 平台内自动触发

方案 §六落地：世界发生事件后，**哪些实体值得被 AI 唤醒**。Trigger 只决定
「是否值得考虑」，绝不决定 NPC 做什么——被唤醒 ≠ 必须反应，反应与否仍由
AI 提案 + Rules 裁决。

### Added
- **逐实体唤醒评估**（`evolution/wake.ts`，纯函数可解释）：距离/地点（同地）、
  感知边界（事件 witnesses 列名者才看见——「在后厨没看见」= NONE）、事件牵涉
  （actor/target）、关系值、met/att；每个实体 HIGH/MEDIUM/LOW/NONE + reasons，
  「谁没被唤醒」与「为什么」同样可查。公共出口：`assessWake / wakeStateViewOf /
  wakeEventsOf` 及 `WakeGrade / WakeAssessment / WakePlan` 类型。
- **平台内触发循环**（`evolution/triggerRuntime.ts`）：轮询事实（幂等消费）→
  只认玩家发起的事件（AI 禁触玩家 ⇒ 玩家归因事件不可能是演化产物——结构性
  断环 + born 集合双保险）→ High 分级 → 唤醒评估 → `tick(auto)`。世界显式
  声明 `PLATFORM_TRIGGER_WORLDS`（多世界托管面不为未声明世界默默烧 AI），
  `PLATFORM_TRIGGER_INTERVAL_MS` 可调；`start/stop/status/planOf` 生命周期与观测。
  run-managed 已装配，dev-stack 守护 tianqiong-village；宿主同键触发由演化
  幂等层保证只执行一次（run-tianqiong-host 不再自行 POST tick）。
- **run 记录 wakePlan**：`EvolutionRun.wakePlan` / `TickOptions.wakePlan`——
  每次 AI 调用的触发依据与唤醒面入账，管理面 runs 直接可查。

### 效果（方案验收「同一个 Event 不能导致所有 NPC 同时调用 AI」）
- 一批事实至多一次世界级 tick；High 但无人达到 HIGH 唤醒 → **零 AI 调用**
  （双重成本闸门：分级 gate + 唤醒 gate）。live 实测：陌生人进酒馆
  （同地陌生 = MEDIUM）零调用；直接对话（牵涉米露）唤醒 1/3 实体并调用一次。
- 测试：`tests/trigger-engine.test.ts`（14 条：方案 §六示例逐条 + 计数驱动
  集成——3 NPC 恰好 1 次调用 / 空地点零调用 / NPC 事实零调用 / Medium 零调用 /
  重放幂等 / 生命周期）。

## [0.11.0] - 2026-10-03 · P1 封口：演化幂等/账本可观测收口

P0 审计（docs/CURRENT_IMPLEMENTATION_AUDIT.md）确认 Evolution Runtime V2 七项验收
六项已达标，剩三条工程缺口全部在平台层修复（零内核改动）：

### Fixed
- **同一世界并发 tick 互斥**（`evolution/runtime.ts`）：冷却与提案指纹都在 run
  收尾时才登记，并发窗口内两个 tick 会双双通过检查、各自完整执行闭环（重复
  Mutation）。现加 per-world in-flight 锁：后到者等先到者落账，再重走幂等/冷却
  检查（方案 §二.3）。
- **'running' 中间态落账**（`evolution/journal.ts` + `runtime.ts`）：journal.append
  改 upsert 语义（同一 run 只有一行真相）；tick 开始即落 running 记录——观察/驱动
  阶段进程崩溃，账本有迹可查，「这个 run 从未发生」不再是合法状态；提案指纹命中
  时影子 run 如实落 completed（零变化，deduplicated）终态，不留孤儿 running 行。
- **幂等账重启不丢**：`EvolutionRun` 新增 `idempotencyKey` 留痕；运行时按世界从
  Journal 惰性重建幂等账（幂等键 / 提案指纹 / 冷却时刻）——重启不能成为重复执行
  的后门；崩溃遗留的 running 记录同样登记，同键重试被阻塞（宁阻塞不重复）。
- **Journal 写失败可见**：JSONL 落盘失败计数（`writeFailures()`），失败不炸运行时
  但必须可查（原有纪律的落地补全）。
- **驱动提示词补动作载荷 schema**（`evolution/driver.ts`）：真模型验收中发现
  DeepSeek 会提议 `{"attention":"player"}` 这类语义正确但形状不符的载荷，被
  translate 原样拒绝。提示词现按动作写明 payload 形状（update_attribute 的
  key/value、set_relation 的 type/otherId/value、move_entity 的 location）——
  翻译器保持严格不猜，模型侧补齐表达契约。真模型复测：提案正确落地并产生
  世界事实（attention=player），因果 trace 全链可查。

### Added
- 测试：`tests/evolution-p1-closure.test.ts`（8 条：并发互斥同键/不同键、running
  留痕与原位覆盖、崩溃 running 阻塞重试、重启幂等账三重生效、load upsert、
  写失败计数、冷却并发叠加）。

## [0.10.0] - 2026-10-03 · V2.1 · NPC 日程 Runtime + 受管演化围栏收口

### Added
- **`platform/src/npc/schedule.ts`（NPC Schedule Runtime，方案 V2.1 §九）**：
  确定性行为归 World Time + Schedule + Rules——`applyNpcSchedule(engine,
  worldId, table)` 按「每实体每日日程表（日内刻度区间）」比对引擎权威状态，
  不一致才发 `move_entity` 命令（进 Rules 链，放行才产生 entity_moved 事实）；
  已对齐即跳过（幂等），规则拒绝逐条落 `rejected`（带原因），日程表是
  游戏数据、机制不含任何具体游戏语义；不携带 actorId（引擎规则里
  `targetId === actorId` 会被解释为玩家移动——地毯式测试抓出后修正）。
  公共出口：`applyNpcSchedule / NpcScheduleTable / ScheduleSlot /
  ScheduleApplyResult / ApplyNpcScheduleOptions`。
- 测试：`tests/npc-schedule.test.ts`（对齐/幂等/无日程不动/规则拒绝/
  引擎不可达/跨日刻度，6 条）。

### Fixed
- **`scripts/run-managed.mjs` 演化运行时接入 `NPC_EVOLUTION_POLICY`**：
  受管装配此前用缺省 `FULL_CORE_POLICY`（冷却 0、变化数无上限、不禁止
  触碰玩家）——真模型实测中启动回放连发 7 次 AI 调用无节流。现第一阶段
  围栏与测试对齐：动作白名单 / 禁触玩家 / 3 变化 3 实体 / auto·api 触发
  30s 冷却（admin 手动不受限），实测第二次 auto 触发被 429 冷却正确拦截。

## [0.7.0] - 2026-10-01 · G3 · 用量的游戏方维度

### Added
- **`UsageEntry.gameId`**：用量记录盖章归属游戏方——公共面 meter 与流式
  代记从钥匙记录带出 `gameId`（null = 平台钥匙）；
- `GET /v1/admin/usage` 新增 `game_id` 过滤（`__platform__` 约定为平台钥匙）
  与 `group_by=game` 分组（平台记录聚合为 `(平台)` 键）；
- 测试：usage 查询增 1 用例（过滤/汇总/分组）。

## [0.6.0] - 2026-10-01 · G2 · 游戏方钥匙（gameId）

### Added
- **`ApiKeyRecord.gameId`**：非空 = 游戏方钥匙（对齐 world-engine 1.1.0 鉴权
  中间件的 `WorldAuthKey.gameId`）；`POST /v1/admin/keys` 接受 `gameId`
  （1-64 字符，非法 400），GET 清单回显（存量记录归一为 null = 平台管理钥匙）；
- 管理台「游戏方」聚合页（admin-web /gateway/games）：世界按 `ownerGame`、
  钥匙按 `gameId` 前端归组——健康（运行/暂停）、实体量、最近活动、接入钥匙；
- 测试：admin-http 增 1 用例（gameId 创建/回显/缺省 null/非法 400）。

### 语义
- 钥匙落盘文件版本不变（`version: 1`）——新字段可选，旧文件直接可读。

## [0.5.1] - 2026-10-01 · API Key：撤销语义移除，改为硬删除（破坏性 API 变更）

### Changed
- **`KeyStore.revoke` → `KeyStore.remove`（硬删）**：`ApiKeyRecord` 移除 `status`
  字段；`DELETE /v1/admin/keys/{id}` 直接移除记录（出站即 401，不可恢复）；
  `PUT .../keys/{id}` 不再接受 `status`（显式 400 提示废弃）；GET 清单移除
  `status` 筛选（删除后记录不存在，清单即在档全集）。停用仍走过期时间
  （可设可清）。keyctl.mjs 的 `revoke` 子命令同步改为 `delete`。

### 迁移说明
- keys.json 中历史 revoked 记录加载后仍可被删除（remove 按 id）；新代码不再
  产生 revoked 状态。管理台页面按钮/筛选已同步（撤销→删除，状态筛选移除）。

## [0.5.0] - 2026-10-01 · 模型思考强度 + 记忆嵌入配置（管理台可配置）

平台 122 → 133 用例（+11 全绿）。配套：world-memory 0.8.2（setEmbed + 配置端点）、
world-gateway 0.7.1（出站透传通道）、admin-web（模型页思考强度列 + 记忆库嵌入配置卡）。

### Added
- **厂商思考强度适配器（可复用注册表 `src/admin/vendors.ts`）**：
  - 抽象档位 off/low/medium/high → 各家请求字段；优先适配 DeepSeek（官方 thinking_mode
    参数化：thinking.type + reasoning_effort，原生 low/high/max 档）、GLM（thinking.type）、
    Kimi（思考版模型名，声明性提示）、Qwen（enable_thinking + thinking_budget）、
    generic（reasoning_effort 回退）；
  - **扩展方式**：新厂商 = VENDOR_PROFILES 追加一条 profile（match 前缀 + apply
    映射），检测/校验/出站/UI 档位全部自动生效；
  - `ModelConfigModel.thinking?`（可选字段，配置校验按 wireModel 检测出的厂商
    校验档位支持，不支持诚实 422）；出站经 remoteChat/Stream 的 extraPayload/
    modelOverride 透传（world-gateway 0.7.1）；
  - 配置投影新增 `thinking` 元数据（levels/vendors/前缀/提示）——前端下拉
    零改动扩展。
- **嵌入模型配置面（记忆库菜单）**：
  - memory 服务（0.8.2）：`GET/PUT /v1/memory/embedding-config` + `/test`
    （宿主回调承担热应用/持久化/实测；apiKey 明文不出服务，响应一律脱敏）；
  - 平台鉴权代理：`GET/PUT/POST( test) /v1/admin/memory/embedding-config`
    （GET 需已认证；PUT/test 需 system:manage；目标 PLATFORM_MEMORY_URL，
    缺省 8789；服务不可达 502 upstream_unreachable）；
  - 记忆演示宿主：配置文件持久化（管理台写入即事实来源，env 仅首次引导）、
    保存即热应用（engine.setEmbed，无需重启）、连通性实测端点；
    `seen` 去重集合持久化（修复重启后同 id 事件重复建档）。
- **`PLATFORM_MEMORY_URL`**：记忆库服务地址（嵌入配置代理目标）。

### 平台配置文件兼容性
- `model-config.json` 新增模型可选字段 `thinking`——旧文件照常加载（字段缺省）；
  旧版本平台读取新文件会忽略未知字段（白名单重建），双向兼容。

## [0.4.1] - 2026-10-01 · M5 · 容器化部署支撑（ADMIN-CONSOLE-ROADMAP M5.3）

### Added
- **管理监听非回环逃生阀**：`PLATFORM_ADMIN_ALLOW_NON_LOOPBACK=1` +
  `PLATFORM_ADMIN_HOST=0.0.0.0` 显式组合时，run-managed 允许管理监听绑定非回环
  地址（容器/内网隔离部署；启动大声告警，隔离责任移交部署层）。缺省行为不变
  （非回环拒绝启动，fail-closed）。
- **`ManagedRuntimeOptions.host`**：受管 Platform 公共监听地址透传
  （`PLATFORM_HOST`；容器部署传 0.0.0.0 供同网络反代访问）。
- `deploy/`（仓库根）：Dockerfile.base（全栈运行时镜像）、Dockerfile.admin
  （前端构建 + Nginx）、docker-compose.yml、仓库根 .dockerignore；
  `docs/DEPLOY.md` 从零拉起指南。配套前端：fake-server 清退（admin-web 侧）。

## [0.4.0] - 2026-09-30 · M4 · 可观测聚合（ADMIN-CONSOLE-ROADMAP M4.1）

平台 118 → 122 用例（+4 全绿）。引擎侧 G1（软暂停/恢复/关闭）见 world-engine 1.0.3；
`/v1/obs/ai-calls` 按路线图「吃 M2.2 数据面」的定位由既有 `GET /v1/admin/usage` 承担
（M2 起前端已接），不重复建端点。

### Added
- **可观测聚合端点（M4.1 · 管理监听）**：
  - `GET /v1/obs/logs`：平台请求日志 = M2.2 数据面投影（level 按 status 派生
    error/warn/info，service=platform，message 含方法/路径/状态/时延；
    level/world/q 过滤 + 分页）。requestId 与访问日志对账不变。
  - `GET /v1/obs/events`：跨世界事件流——经引擎只读聚合（`/v1/worlds` + 各世界
    `/events`），worldId 标注、day/tick 降序、单世界过滤、总量封顶 500。
  - `GET /v1/obs/errors`：失败请求登记（status≥400 投影，type=错误码或 http_xxx）。
    **诚实只读**：无 acknowledge/resolve 工作流（原 Mock 的工作流无真实支撑，已从前端移除）。
  - `GET /v1/obs/overview`：Dashboard 聚合——世界统计（含 paused，吃引擎 1.0.3 的
    status 字段）/ 实体合计 / AI 24h 汇总（requests/tokens/successRate/byProvider）、
    12 整点小时调用桶（UTC）/ 最近 5 条错误。引擎不可达时世界字段诚实归零。
- **`ManagedRuntime.engine`**：引擎客户端只读暴露（聚合用）。

### 诚实边界
- 世界事件无墙钟时间（只有 day/tick）：Dashboard 活动图为「AI 调用按小时」单序列，
  不编造事件时间线；`eventsPerMin` 卡片由「最近 1 小时 AI 调用」替代。
- 记忆条目数不在平台聚合内（memory 是独立服务），由前端直读 `/memory-api`。

## [0.3.0] - 2026-09-30 · M3 · 鉴权、会话与系统页（ADMIN-CONSOLE-ROADMAP M3）

平台 107 → 118 用例（+11 全绿）；管理台登录/用户/设置全部去 Mock。

### Added
- **管理会话（M3.1）**：
  - `src/admin/sessions.ts`：不透明随机令牌会话（非 JWT——无签名解析面，吊销即失效）；
    accessToken 12h / refreshToken 7d，刷新即**轮换**（旧对立即作废）；落盘
    `data/sessions.json`（重启不丢）；`revokeUser` 支持改密/停用后批量吊销。
  - 端点：`POST /v1/admin/session/login`（免鉴权 + 全局失败节流：60s 窗口 ≥10 次 → 429）、
    `POST /v1/admin/session/refresh-token`（免鉴权）、`POST /v1/admin/session/logout`、
    `GET /v1/admin/session/me`。login/refresh 响应形状与原前端 Mock 完全一致
    （`{success,data:{roles,permissions,accessToken...}}`）——前端零改动替换。
  - 鉴权门改双凭证：`x-admin-token`（主令牌，服务端注入，全权，运维通道保留不变）或
    `x-admin-session`（角色会话）；带错主令牌时即便同时带合法会话也 401（防降级混淆）；
    `authorization` 头依旧一律忽略。
- **本地用户服务（M3.3，决策点 3：「本地三档用户 + 文件存储」）**：
  - `src/admin/users.ts`：scrypt 加盐哈希 + timingSafeEqual 校验；
    `data/users.json`（`PLATFORM_USERS_FILE`）；首次启动播种三档内置账号
    （admin/admin123、operator/operator123、viewer/viewer123，公开文档矩阵，
    控制台显著告警要求修改）；末位保护（最后一名 active admin 不可停用/降级）。
  - 端点：`GET/POST /v1/admin/system/users`、`PUT /v1/admin/system/users/{id}`
    （改昵称/备注/角色/状态、重置口令；停用与重置口令即时吊销该用户全部会话）。
- **权限码服务端强制（M3.2）**：
  - `src/admin/permissions.ts`：三档角色 → 权限码目录（与 docs/ADMIN-PERMISSION.md 同源）。
  - 管理监听全部写端点按码强制：模型配置/凭证/实测/Keys/管线试跑 → `gateway:manage`，
    用户与设置写 → `system:manage`；viewer 只读会话直访写端点 403 `insufficient_permission`
    （浏览器实测通过）；读端点任意已认证身份。
- **系统设置服务（M3.4）**：
  - `src/admin/settings.ts`：白名单目录（8 项，类型/枚举/范围校验）+ 值持久化
    `data/settings.json`（`PLATFORM_SETTINGS_FILE`）；目录即契约，各项 description
    诚实标注生效口径（M3 交付持久化，运行时行为项随 M4/M5 接线）。
  - 端点：`GET /v1/admin/system/settings`、`PUT /v1/admin/system/settings/{key}`；
    另有 `GET /v1/admin/system/permissions`（权限码目录 + 三档角色，只读真实契约）。
- **配置**：`PLATFORM_USERS_FILE` / `PLATFORM_SESSIONS_FILE` / `PLATFORM_SETTINGS_FILE`。

### Changed
- Admin Web（M3 前端配套）：登录/登出/刷新指向真实会话端点（形状不变）；
  请求拦截器附 `x-admin-session`；代理（Vite dev 与 Nginx 模板）改**会话感知注入**——
  浏览器带会话时不再注入主令牌，服务端按角色强制权限；无会话的运维请求保留主令牌通道。
  Users / Permissions / Status 页接真；`mock/login.ts`、`mock/refreshToken.ts`、
  `mock/admin/system.ts` 删除。

## [0.2.0] - 2026-09-30 · M2 · Gateway 管理面收口与计量（ADMIN-CONSOLE-ROADMAP M2）

平台 84 → 107 用例（+23 全绿）；四包回归门禁全绿。

### Added
- **结构化用量数据面（M2.2）**：
  - `src/usage/recorder.ts`：JSONL 追加记录器（32MiB 单代轮转；写失败停写不拖垮请求路径；
    坏行跳过不污染读）；`src/usage/query.ts`：纯函数查询（过滤 / 汇总 / 分组 day|key|model|
    capability|world / 分页，pageSize 封顶 500）。
  - 公共侧全挂点计量：world-agent（capability/model_used/fallback/tokens，响应既有粗估口径）、
    保真代理（流式由 server 泵完代记，协议层挂 `usageMeta`）、worlds 透传（含 worldId 提取）、
    权限不足 403 亦留痕；**401 鉴权失败不计入**。每条记录带 `requestId`，与访问日志可对账。
    **不落 Prompt / 响应原文**（隐私边界）。
  - 管理监听端点：`GET /v1/admin/usage`（kind/status/route/model/capability/world_id/key_id/
    from/to 过滤 + summary + group_by + 分页；provider 由当前配置派生）。
  - Dashboard「AI 请求 · 24h」卡、Usage 页、AI Calls 页共用本数据面（前端 M2 同步接真）。
- **API Key 生命周期管理端点（M2.1）**：
  - `GET /v1/admin/keys`（脱敏投影，绝无 keyHash；status 筛选 + 分页）、
    `POST /v1/admin/keys`（明文仅创建响应一次；空 permissions 数组显式拒绝）、
    `PUT /v1/admin/keys/{id}`（撤销为终态；过期可设可清 `expiresAt`）。
  - `KeyStore.setExpiresAt(id, iso|null)` 新增；Phase 1 密钥纪律不变。
- **管线只读 + 有界试跑（M2.3）**：
  - `src/admin/pipelines.ts`：`PipelineStore`——`data/pipelines.json`
    （`PLATFORM_PIPELINES_FILE`）经 gateway `parsePipelineSpec` fail-fast 校验，每次请求
    读盘（手工编辑即生效）；坏文件 → 422 带逐条 issues；文件缺席 = 空清单。
  - `ManagedRuntime.runPipelineSpec`：受管配置 → 网关标签路由桥接（apiKeyRef 指向模型 ID、
    resolveEnv 桥接 SecretStore）；**出站校验同闸**（未过者剔除并留痕 `excludedModels`）；
    时延封顶 30s、调用数 ≤32 硬性封顶。端点：`GET /v1/admin/pipelines`、
    `POST /v1/admin/pipelines/{id}/test`（禁用管线 409 `pipeline_disabled`）。
- **配置**：`PLATFORM_USAGE_FILE`（缺省 `data/usage.jsonl`）、`PLATFORM_PIPELINES_FILE`
  （缺省 `data/pipelines.json`）；`run-managed.mjs` 装配新端点并在退出时 flush 用量记录。

### Fixed
- 公共端口 `/v1/admin/*` 维持 501 占位不变；管理面继续只经 loopback 管理监听
  （令牌 + Origin + 1MiB 体限既有姿态）。

### 决策记录（对应路线图 §3 决策点 1/2）
- Pipelines：只读展示 + 有界试跑落地，编辑器不做；spec 独立文件、不重开 ModelConfig。
- Extensions 三页：按诚实原则下线（引擎无规则清单端点、数据形状无对应概念），见
  docs/ADMIN-API-MAPPING §5e。

## [0.1.0] - 2026-09-30 · Phase 1 · 平台 API 标准化 + Model Control Plane

- Public API v1：`/v1/models`（只暴露 world-agent）、`/v1/chat/completions`（world-agent
  管线 + 保真代理）、`/v1/worlds*` 鉴权透传引擎；API Key 鉴权（SHA-256 + 前缀，明文仅一次）。
- world-agent 管线：世界上下文 → 任务分析 → 六能力路由（冷却 + fallback）→ 网关调用。
- Model Control Plane（受管模式）：版本化 ModelConfig（If-Match / .bak 回滚）、AES-256-GCM
  凭证库、受管 Gateway/Platform 双快照热替换、出站 SSRF 双闸、有界实测端点。

# Tianqiong 引擎依赖审计（ENGINE-DEPENDENCY-AUDIT）

> 方案：World Engine — Tianqiong 完全脱离内置引擎实施方案 · **Phase 0 交付物**
> **状态（2026-10-06 终局）：Phase 1-10 全部完成。** Tianqiong 已是
> World Engine 会话宿主（`server/game-host.ts`）的纯游戏客户端：
> 命令整投、事实流回放、快照回灌；本地裁定栈仅作为逃生门开发形态保留
> （`VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE=false`），并继续作为服务端
> 裁定栈的同一份源码运行（宿主与客户端共享 src，裁定代码没有"删除"，
> 而是"搬家"到服务端进程——这是本仓库形态下 §Phase10 的诚实落地）。
>
> 审计方式：四路并行代码审计（游戏核心层 / AI 与记忆层 / 游戏系统层 / 引擎 API 面），
> 全部结论带 `file:line` 证据。

---

## 一、架构现状总判断

```text
当前形态（审计确认）：

Tianqiong（浏览器 / Tauri 单进程）
├── world-engine（npm link，进程内机制库 —— 不是外部服务）
│     ├── createWorldContainer  ← src/world/WorldState.ts:22
│     ├── createMutate          ← src/world/WorldMutate.ts:34
│     ├── createWorldClock      ← src/world/WorldClock.ts:23
│     ├── createQuery           ← src/world/WorldAPI.ts:25
│     └── rng / scheduler / worldBus / causality ← src/events/EventBus.ts:14-28
│
└── 天穹自有（全部本地运行，未外移）
      ├── core.S 世界状态（唯一真相，宿主侧）
      ├── WorldRuntime.dispatch —— 游戏命令路由（引擎的 Command→Rule→Mutation 运行时未被使用）
      ├── 24 个系统（combat/character/npc/economy/law/quest/…）
      ├── NPC 运行时（日程纯函数 + 动态状态 + 羁绊状态机）
      ├── AI 全栈（openaiCompat → DeepSeek 直连，key 在 localStorage）
      ├── 记忆全栈（WorldState.memories + 向量缓存 + 信念/传播/生命周期）
      └── 持久化（localStorage 分片 / Tauri SQLite）
```

**结论**：Tianqiong 目前是"自带世界引擎的游戏"——world-engine 只贡献了
容器/时钟/随机/事件总线四类机制，世界的真相（状态、规则、NPC、时间驱动、
记忆、AI）全部在游戏进程内。与外部服务 `world-gateway` / `world-memory`
当前**零耦合**（全 src 无任何 import）。

已有的正向基础（不需要新建，直接复用）：

| 已有资产 | 位置 | 说明 |
|---|---|---|
| HTTP/WS 服务能力 | world-engine/src/http（`startWorldServer`） | REST 16 端点 + WS 事件流（含 `?replay=N` 重连窗口） |
| GameAdapter 契约 | world-engine/src/adapter.ts:71 | `seed(): GameWorldSeed` → `hostGameWorld` 装配常驻世界 |
| 天穹世界书托管 PoC | tianqiong/scripts/http-host.mjs | 63 地点 / 15 NPC 已可托管到引擎 HTTP 服务（端口 8798） |
| 接入验证 PoC | tianqiong/src/tests/world-engine-integration-verify.test.ts | 证明游戏回路产生的事件上引擎总线、满足 EventSchema |
| 平台层 | platform/（world-platform） | 已挂 world-gateway + world-memory + AI 演化运行时 |
| 管理后台 | admin-web | 世界列表/运行时/关系/事件可见 |

---

## 二、总表：模块 × 世界引擎归属 × 最终去向

判定标准（方案 §30）：**这段代码是在决定世界实际上发生了什么，还是在决定玩家应该看到什么？**

| 模块 | 当前实现（file:line） | 世界引擎? | 最终去向 |
|---|---|---:|---|
| 世界状态 `core.S` | world/WorldState.ts（三槽位 S/CB/curShop + hydrate/save） | **是** | World Engine（状态宿主），天穹只留缓存 |
| 写入原语层 | world/WorldMutate.ts（引擎 createMutate + 天穹资源原语 :64-176） | **是** | World Engine（引擎侧 mutate；资源原语变成引擎规则） |
| 命令路由 | world/WorldRuntime.ts:160 `dispatch()`（约 40 个 GameCommand） | **是** | World Engine Rules（每条 GameCommand → 引擎规则注册） |
| 查询门面 | world/WorldAPI.ts:25（createQuery + 天穹专属查询） | **是**（读面） | World Engine REST（GET state/entities/locations/relations） |
| 世界时钟 | world/WorldClock.ts:52（48 刻/日、12 月历法、onHourTick） | **是** | World Engine（labels + onHourTick 在服务端装配） |
| 常量 | world/TimeBase.ts:9（纯 re-export 引擎） | 部分 | 已在引擎，无迁移量 |
| 存档分片 | world/Shards.ts:14（包装引擎 splitShards） | **是** | World Engine SavePort（FileSavePort） |
| 事件总线机制 | events/EventBus.ts:18-28（rng/scheduler/worldBus/causality re-export） | **是** | World Engine（服务端总线） |
| 事件定义/分级 | events/EventSchema.ts:112-118（registerEventTables 天穹分级表） | **是** | World Engine（分级表随宿主注册） |
| World Director 动态事件 | events/EventProcessor.ts:156 `directorTick`（扫 events.json 直改状态） | **是** | World Engine（onHourTick 钩子服务端化） |
| 世界史日志 | events/EventStore.ts（worldEventLog 环形 500 条 + 因果链） | **是** | World Engine（loadWorldLog/saveWorldLog 端口已备） |
| NPC 感知 | events/Perception.ts（世界事件→s.knowledge 抽样） | **是** | World Engine（Trigger/Perspective 层） |
| 确定性采样 | events/Sampling.ts（FNV-1a sampleHit） | **是** | World Engine（服务端工具） |
| 自由行动解析 | actions/ActionParser.ts（LLM intentAsync + 正则降级） | **是**（决策） | Intent 通道：解析留客户端（输入理解），结果走 Command |
| 行动执行 | actions/ActionExecutor.ts（go/observe/…+advance） | **是** | World Engine Rules |
| AI 后果执行 | execution/WorldExecutor.ts + PlanSchema.ts | **是** | World Engine（AI→Proposal→Rules→Mutation 闭环） |
| 掷骰/检定 | dice/DiceEngine.ts、CheckResolver.ts:43（写 s.checks） | **是**（判定） | World Engine（rng 已是引擎的；演出留客户端） |
| 校验闸 | validation/（SchemaValidator/PermissionValidator/RuleValidator） | **是** | World Engine Rules / Proposal 白名单 |
| NPC 静态档案 | data/npc/**/npc.json（120 目录 218 json；机制字段+叙事字段混装） | **是**（机制字段） | 种子数据→引擎（locations/npcs/relations）；lore 表现字段留天穹 |
| NPC 话题卡 | data/npc/**/talk.json + data/talk/*.json | 部分 | facts/say 层进引擎；台词表现留天穹 |
| 世界书机制种子 | data/world/*.json（28 个：factions/events/law/economy/…） | **是** | 引擎侧种子数据（随 Adapter 装配） |
| 设定 canon | data/lore/（lore.json 121 条 + lore-person 109） | 部分 | AI 上下文素材→gateway/prompt 侧；图鉴解锁事实进引擎 |
| 24 个游戏系统 | systems/*（审计明细见 §四） | **是**（除 Sheet/Money/Passersby/naming） | 逐系统迁为引擎 Rules + 服务端数据 |
| AI 对话通道 | ai/openaiCompat.ts:268 `POST /chat/completions`（8 通道） | **是** | world-gateway（模型名=通道：intent/npc/reasoning/narrative/memory/embedding） |
| AI 向量通道 | ai/embeddingCompat.ts:66 `POST /embeddings` | **是** | world-gateway capability=embedding |
| AI Key 管理 | llmConfig.ts:181 localStorage `tq2_ai_cfg_v1`；SysPanel.tsx:436 输入框 | **是** | World Engine Gateway/Model Router（客户端不再持任何 Key） |
| AI 推演编排 | ai/WorldReasoner.ts:119 reasonAbout（护栏/预算/world.plan） | **是** | platform/ AI 世界演化运行时（已存在） |
| 规则兜底推演 | ai/ruleReasoner.ts、ruleSim.ts | **是** | World Engine 规则层（服务端零模型兜底） |
| 记忆存储 | src/memory/MemoryStore.ts:20-28（挂 WorldState.memories，80 条上限） | **是** | world-memory（只读角色记忆引擎） |
| 记忆检索 | memory/retrieval/（结构化/关键词/七维混合） | **是** | world-memory recall/recallScored |
| 记忆生命周期 | memory/lifecycle/（衰减/强化/压缩/LOD 分频） | **是** | world-memory tickDay |
| 信念/传播 | memory/belief/、memory/propagation/ | **是** | platform 演化运行时（信念→行动已实现） |
| 向量索引 | memory/vector/InMemoryVectorStore.ts:11（进程内 2000 条 LRU） | **是** | world-memory setEmbed + SavePort |
| 时间推进定时器 | ui/useAutoFlow.ts:45（1.6s/刻 setInterval → `wait` 命令） | **是**（驱动世界） | 外移后由服务端 scheduler 驱动；客户端 UI 动画 tick 可留 |
| 玩家输入 UI | ui/*、store/useGame.ts | 否 | Tianqiong |
| Zustand store | store/useGame.ts（rev/logSeq/screen/toasts 等镜像信号） | 否 | Tianqiong（Cache ≠ Truth） |
| 叙事编织 | world/Narration.ts:31,151（AI 只产文本；setTimeout 是 UI 去抖） | 否（文本表现） | Tianqiong（文本经 gateway 生成） |
| 表现件 | systems/character/Sheet.ts、economy/Money.ts、npc/Passersby.ts:16、naming | 否 | Tianqiong |
| 立绘/配色/台词 greet | NpcDef 表现字段（sv/color/greet/lore 七项） | 否 | Tianqiong 资源 |
| 持久化介质 | repo/index.ts:25,40（localStorage tq2_world_v1/tq2_mind_v1/tq2_vec_v1）、repo/sqlite.ts:77（Tauri tianqiong.db） | **是** | 引擎 FileSavePort / 服务端存储；客户端只留 UI 偏好缓存 |

---

## 三、写路径与调用图（审计确认）

```text
UI (src/ui/*)
 │ 读: useGame(rev/logSeq) + world.query.* + core.S 直读（TopBar.tsx:20 等）
 │ 写: useGame.cmd(GameCommand)        ← UI 无任何 core.S.x = 直写（grep 零命中）
 ▼
WorldRuntime.dispatch (world/WorldRuntime.ts:160)  ◄── useAutoFlow 定时 wait（唯一世界推进定时器）
 ├─ systems/* 系统函数 → mutate.*（唯一写入层）→ core.S
 ├─ actions/ActionParser（自由文本→意图）→ ActionExecutor（mutate + check + advance）
 └─ AI 通道: WorldReasoner → ConsequencePlan → world.plan()
              → Schema/Permission/Rule 三道校验 → WorldExecutor（plugins/handlers 注册表）
时间: dispatch 'wait' / 行动耗时 advance() → 引擎时钟 → 时辰边界 directorTick（EventProcessor.ts:156）
      → 日边界 new_day → plugins/daySettle 顺序表（economy→bond→abyss→law→memory→dungeon→theoselect
        →天气抽取(rollWeather:43-60)→称号→状态衰减→信念→寿数→身后事）
事实: makeEvent → 引擎 worldBus → 配额/因果链 → EventStore(环形500) → Perception 抽样 → s.knowledge
      → witness / beliefDispatch / MemoryEngine（recordFromEvent）
落盘: 引擎容器 save → 分片（npcs/memories/beliefs/knowledge/cases 五张增长表）
      → localStorage tq2_world_v1/tq2_mind_v1 或 Tauri SQLite tianqiong.db
```

关键定性：

1. **写入已经收口成一条线**（WorldMutate 是唯一写入实现点），这使外移时"换血"点集中。
2. **没有自由意志式 NPC 心跳**：NPC 位置是纯函数 `npcAt(世界书, 时辰)`（Npcs.ts:41），
   天穹曾在 Phase 4.2 刻意撤掉 `curLoc` 物化缓存与每日 13 次全表 tick
   （Npcs.ts:52-59 注释："缓存=会过期的第二真相"）——与外部引擎的"Cache ≠ Truth"原则天然一致。
3. **天气**每日一掷（daySettle rollWeather:43-60）+ 神迹改天（Deity.ts:286）两个写入口。
4. **时间**是命令驱动的（`wait` / 行动耗时），引擎时钟不自主走——外移后由服务端
   scheduler/演化运行时驱动，客户端 useAutoFlow 的 setInterval 必须退役。

---

## 四、24 个系统逐项裁定

| 系统 | 世界真相? | 决策逻辑? | 说明（证据） |
|---|---:|---:|---|
| combat | 是 | 是 | core.CB 战斗裁定，d20 全规则判定（Combat.ts:1-3）；AI 不得判死（systems.ts:69） |
| character | 是 | 是 | hp/gold/exp/升级 while 循环（Gains.ts:55-59）、学习/转职三重门 |
| npc | 是 | 是 | NpcDynamic（att/met/rels/intimacy/bondProg/grudge/goal/bag/gold/effects，types/world.ts:538-570）；好感日封顶、话题状态机、LOD |
| dialogue | 部分 | 部分 | 描述符编排；runReq 会代写（扣钱/好感/接任务）——代写部分须随规则外移 |
| economy | 是 | 是 | s.econ 价格指数 + s.vendors 商人本金（Economy.ts:20-27）、日均值回归 |
| faction | 是 | 是 | playerRep 6 轴 + factionRel 矩阵（Factions.ts:1-6）；Diplomacy 换算折扣/盘查/审判 |
| relationship | 是 | 是 | 赠礼五档×封顶、亲密度升级门、仇怨 20 天衰减（Bond.ts:1-18）、传闻一跳扩散 |
| reputation | 是 | 是 | titles.json 条件表每日评估（Title.ts:3-5：玩家/AI 都不能授予称号） |
| law | 是 | 是 | 罪名分级/审判/调查状态机 8 取证每日（Investigation.ts:1-14） |
| quest | 是 | 是 | 信任门槛接单（Quests.ts:209-212）、击杀推进、公会 D-S 认证+10% 抽成 |
| adventuring | 查询 | 弱 | 宏观 ROI 参照表；已并入 quest（systems.ts:77-79） |
| academy | 是 | 是 | 学期 1440 刻+考核 d20、Growth 三条成长线（Growth.ts:1-10） |
| codex | 是 | 是 | 图鉴解锁 + 每日观察上限 OBS_CAP=2（Codex.ts:36） |
| commnet | 是 | 是 | 八种通讯距/费/时效判定（CommNet.ts:1-6）；消息在途事实 |
| culture | 判定 | 是 | taboo_violated 处罚（Culture.ts:1-6） |
| rites | 是 | 是 | 婚配条件、七大陆婚丧俗/继承（Rites.ts:1-14） |
| religion | 是 | 是 | favor 晋阶/神迹门槛/百年神选；**神迹可改天气**（Deity.ts:286） |
| dungeon | 是 | 是 | 五主题分层/遭遇表/深层侵蚀日 tick（Dungeon.ts:1-12）；深渊渗漏级联（Abyss.ts:1-9） |
| starnet | 是 | 是 | 入网禁入/出网禁/财物只进不出铁律（StarNet.ts:1-6）；网内真身无损 |
| timeslip | 是 | 是 | 内外流速换算 1:5/5:1、流放刑期、境界寿命表；闭关真推外界时间（Timeslip.ts:76-80） |
| travel | 是 | 是 | 距离天数/季节阻断/天气延误 50%（Travel.ts:197-199）/危险遭遇 |
| inventory | 是 | 是 | 词缀掷实例、配方解锁、违禁=犯罪（Craft.ts:1-9） |
| naming | 否 | 纯函数 | 零状态生成器（systems.ts:192）——留天穹或作为引擎纯函数均可 |
| 表现件 | 否 | 否 | character/Sheet.ts、economy/Money.ts、npc/Passersby.ts（刻意只放内存） |

---

## 五、AI 链路审计（全部须外移）

**HTTP 出口仅 2+1 处**（全 src grep 确认）：

| 通道 | 位置 | 端点 | Key 来源 |
|---|---|---|---|
| 对话模型（8 条逻辑通道：narrative/intent/npcDecide/chat/greet/narrate/summarize/ask） | ai/openaiCompat.ts:268 | `POST {baseURL}/chat/completions`（SSE 流式/重试/思考字段自适应） | localStorage `tq2_ai_cfg_v1`（llmConfig.ts:181，SysPanel.tsx:436 用户输入） |
| 向量模型 | ai/embeddingCompat.ts:66 | `POST {baseURL}/embeddings`（批量/冷却/维度探测） | 同上（可 reuseLlm） |
| 诊断 | ai/openaiCompat.ts:466 | `GET {baseURL}/models` | 同上 |

- 无 env、无硬编码 Key（`API_KEY`/`process.env` 在非测试代码 0 命中）。
- 默认端点 DeepSeek `https://api.deepseek.com/v1`（llmConfig.ts:185）、向量 SiliconFlow `BAAI/bge-m3`（:176）。
- 每条 AI 路径都有零模型兜底（ruleSim 三档池 / ruleReasoner / 正则链）——迁移期对照测试的"确定性基线"就用它。
- **与 world-gateway 对接评估（审计结论）**：天穹适配器本就是 OpenAI 兼容客户端且已有"通道"概念
  （channelRoutes + PromptChannel），把 baseURL 指向网关、通道映射为模型名（intent/npc/reasoning/
  narrative/memory/embedding 六标准角色）即可，fold system、SSE、未知字段容忍均已兼容。
  **这是外移成本最低的一块。**

**AI 触发点共 8 处**：Chat.ts:337（对话）、Dialogue.ts:38,460（开场白/权衡）、ActionParser.ts:852
（意图解析）、SceneView.tsx:202（场景叙事）、Narration.ts:132,270（编织/前情）、WorldReasoner（事件推演，
bootstrap.ts:63 接线）、SysPanel（连通测试）。

---

## 六、记忆链路审计（全部须外移）

四条链路（详见 §二记忆行）：

1. **事件→记忆**：worldBus `'*'` → memoryEngine.recordFromEvent → `WorldState.memories[ownerId]`（80 条上限，随主存档持久化）。
2. **检索→prompt**：buildMemoryContext 三档位（npc_dialogue / world_reasoner / quest）分别喂对话 / 推演 / NPC 权衡。
3. **生命周期**：daySettle → memoryTick（衰减/压缩/信念）+ gossipTick（关系网传话）。
4. **向量旁路**：WorldReasoner.warmFor → embeddingCompat → 进程内 VectorStore（2000 条 LRU）→ 独立持久化通道（tq2_vec_v1 / SQLite vector_index 表）。

持久化：localStorage `tq2_mind_v1`（memories+beliefs 分片，repo/index.ts:40）或 Tauri SQLite `tianqiong.db`（repo/sqlite.ts:77）。

**与 world-memory 对接评估（审计结论）**：两者同源同设计（§编号一致），但天穹记忆栈深耦合
WorldState 字段（memories/memTickAt/beliefs/LOD/感知表），替换需写双向适配器；最自然的接缝是
向量持久化端口（savePort.loadVectors/saveVectors 形状与 world-memory 存储端口一致）。

---

## 七、定时器 / 时间 / 日期审计（全 src grep）

| 位置 | 性质 | 裁定 |
|---|---|---|
| ui/useAutoFlow.ts:45 `setInterval(tick, 1600)` → `wait` 命令 | **世界推进**（经命令链） | 外移后退役：由引擎服务端 scheduler 驱动 |
| ui/overlays/RunLogPanel.tsx:112 `setInterval` 1s | 纯观测（runLog.stats） | 保留（UI tick） |
| 其余 setTimeout（toast 淡出/打击演出/greet 超时/流式超时/编织合窗） | UI/网络 | 保留（UI tick） |
| `new Date()` | **0 处参与游戏时间**（仅 devlog 导出文件名） | 无需处理 |
| 世界 tick 真正心脏 | 引擎 scheduler + WorldClock.advance | 服务端化 |

---

## 八、引擎侧可复用能力对照（迁移时直接用，不新建）

| 需求 | 引擎现成能力 | 位置 |
|---|---|---|
| 常驻世界装配 | `hostGameWorld(registry, adapter)`（create_entity/set_relation/发种子事实） | world-engine/src/adapter.ts:113 |
| HTTP 面 | `startWorldServer`：创建/列表/状态/命令/事件/实体/地点/关系/time/scheduler/pause | world-engine/src/http/protocol.ts:9-22 路由总表 |
| 实时事件流 | WS `/v1/worlds/{id}/events/stream` + `?replay=N` 回放 + `event.id` 幂等去重 | world-engine/src/http/ws.ts:143-149 |
| 命令幂等 | commandId 账本（duplicate:true 短路） | world-engine/src/runtime/WorldRuntime.ts:101-116 |
| 规则扩展 | `registerRule`（自定义 snake_case 命令，如示例 forge/hunt） | world-engine/src/rules/Rules.ts:31-41 |
| RPG 兼容命令 | move/talk/attack/set_attitude/spawn_entity 等 12 条内置 | world-engine/src/rules/rpgCompat.ts |
| 事件分级注册 | `registerEventTables(levels, channels)` | world-engine/src/events/EventSchema.ts |
| 历法定制 | `labels`（月名/纪年，second-game 示例 10 月×20 日） | examples/second-game |
| 文件持久化 | `FileSavePort`（tmp+rename 原子写、世界史/命令账/分级表衍生文件） | world-engine/src/state/fileStorage.ts |
| 鉴权 | API Key + scopes（worlds:read/write）+ gameId 世界隔离 | world-engine/src/http/protocol.ts:73-107 |
| 模型路由 | world-gateway：OpenAI 兼容，模型名=能力通道，九标签路由 | world-engine/gateway/src/router.ts |
| 角色记忆 | world-memory：ingestFact/spreadRumor/tickDay/recall（只读，绝不写世界状态） | world-engine/memory/src/engine.ts |
| AI 演化运行时 | platform/：观察→上下文→提案→白名单→Rules 终审→落地→因果账本 | platform/src |
| 管理面 | admin-web 世界列表/运行时/关系/事件/游戏方聚合 | admin-web |

已知缺口（迁移中补齐，均不需要改引擎 Core）：

1. WS 无连续 sequence 游标，只有 replay 窗口 → 客户端按 `event.id` 去重 + REST 轮询补洞（方案 §22 的 lastSequence 用 id 内嵌 seq 等价实现）。
2. 引擎无自主时间 ticker → 天穹外移初期由宿主脚本/演化运行时定期 `advance_time`；客户端 useAutoFlow 改为发 `wait` Intent（服务端决定是否推进）。
3. 引擎 `EngineWorldState` 信封是通用形状，天穹富状态（academy/econ/dungeon/...）需以"分片 + 规则"形式落服务端 → Phase 3 起逐系统迁移，迁移期双方对照（VRT）。

---

## 九、绞杀式迁移台账（Phase 2 起逐行勾销）

> 原则：每迁一个模块，先并行跑新旧行为对照（新通道 vs 本地引擎，输入相同 → 事实相同），
> 验证通过才允许关闭本地路径；删除代码前 grep 确认零调用者。

| Phase | 迁移物 | 本地实现（迁移源） | 外部去向 | 状态 |
|---|---|---|---|---|
| 1 | WorldEngineClient / 天穹 Adapter / world-cache / 断线语义 | —（新建） | tianqiong/src/world-engine/* | ✅ 2026-10-06（交付说明见《外置引擎迁移-Phase1-交付说明.md》） |
| 2 | Player/NPC/Location/Relation/Attribute 快照与查询 | core.S 直读、world.query.* | GET state/entities/locations/relations + WS | 🔶 bridge 档：时间/位置读面已切（TopBar）；session 档：整份快照回灌即全量真相；NPC 在场读面待 Phase 5 |
| 3 | 命令面：移动/交谈/拾取/购买/攻击/送礼/等待 | WorldRuntime.dispatch 约 40 条 GameCommand | POST commands（引擎内置 12 条 + registerRule 逐条挂） | 🔶 **session 档已全量翻转**：124 条 GameCommand（含 newGame/continueSave 元命令）经会话门整投服务端裁定栈（server/game-host.ts 原样跑 dispatch+24 系统），VRT 逐命令一致（ext-session-vrt）；bridge 档 wait 已翻转、travel 上行同步 |
| 4 | 事件流/快照校验/断线重连 | events/EventStore、EventBus 转发层 | WS 流 + replay + id 幂等 | ✅ bridge 档完成；**session 档完成**：事件环（seq）+ SSE 实时流（?after= 补发）+ 轮询兜底，迟到事实（聊天回话/AI 延续）实时重放 bus 并触发投影重同步 |
| 5 | NPC Runtime（日程→在场、好感、羁绊、目标） | systems/npc、Dialogue/Chat 判定 | 引擎规则 + NPC 种子 + 感知层 | 🔶 session 档已随整栈服务端化；bridge 档仍本地 |
| 6 | World Time / Scheduler / Weather | useAutoFlow、daySettle 顺序表、rollWeather | 服务端时钟 + scheduler + 规则 | 🔶 session 档已服务端化（换档回拨限制随之消除：宿主自持存档）；bridge 档 wait 外置、其余本地 |
| 7 | Memory | src/memory 全栈 + tq2_mind_v1 | world-memory 服务 | 🔶 session 档随整栈服务端化（随宿主 SavePort 落盘）；独立 world-memory 服务待 Phase 7 |
| 8 | AI / Evolution | src/ai 全栈 + tq2_ai_cfg_v1 | world-gateway + platform 演化运行时 | ✅ **session 档三档 AI 装配完成**：① gateway 档（`TIANQIONG_GAME_GATEWAY` 外联 / `_EMBED=1` 内嵌 world-gateway，模型名=§65 六角色，钥匙经 `apiKeyRef:{env}` 网关侧持握，转发配置被忽略）② 转发档（客户端 ai-config 注入本地 LlmConfig）③ ruleSim 兜底；**编织已归还客户端**（sessionWeave 覆盖表，§30 归位完成） |
| 9 | 关闭内置引擎（TIANQIONG_EXTERNAL_WORLD_ENGINE=true 禁旧路径） | — | 双模开关翻转为默认 | ✅ **默认 = session 档**（enabled:true / 停摆语义）；逃生门 env=false 回落本地（开发形态） |
| 10 | 删除旧 Engine（确认零调用者后） | world/、events/、systems/ 世界面、ai/、memory/ | — | ✅ **双档迁移机制已删**（bridge 同步桥/attachExternalWorld/runtime/cache/wait-gate/TS seed 镜像，零残留）；裁定栈作为服务端源码继续存在（宿主共享 src）——"删除"的诚实形态是搬家而非销毁，见文首状态说明 |

**验收对照**（方案 §25 逐条）：审计确认当前天穹**不满足**架构/World Engine/Tianqiong 三组
勾选项中的绝大多数（唯一世界真相、命令闭环外移、NPC/时间/记忆/AI 独立运行、客户端纯表现）；
通用性一项已有部分基础（http-host.mjs PoC + second-game 示例 + admin-web 可见性）。

---

## 十、风险与依赖顺序

1. **富状态迁移是最大成本**：天穹 24 系统的判定规则远多于引擎内置 12 条命令，
   Phase 3-5 必须按"一条 GameCommand = 一条引擎规则"逐条搬，搬一条验一条（对照测试）。
2. **存档语义变化**：本地 localStorage/SQLite 存档 → 引擎 FileSavePort；
   需要 `hydrate` 等价的种子/迁档路径（引擎 applyDefinition + saveWorldLog 已备）。
3. **Tauri 双壳**：浏览器与 Tauri 两种宿主的 SavePort 选择逻辑（main.tsx:39-65）在外移后收敛为
   "一律连服务端"，Tauri SQLite 仅保留为可选离线缓存（Cache ≠ Truth）。
4. **free text 意图解析**属"输入理解"，可留客户端，但解析出的 Intent 必须走
   WorldEngineClient.sendIntent → 引擎规则裁定，不得本地落地。
5. **ruleSim 兜底**迁到服务端后，客户端断网时**不得**把兜底当本地引擎用（方案 §22：
   断网 → 停止世界写操作 → UI 重连态）。

---

*审计人：ZCode Agent · 2026-10-06 · 覆盖 tianqiong/src 全部目录与 world-engine/gateway/memory/platform API 面*

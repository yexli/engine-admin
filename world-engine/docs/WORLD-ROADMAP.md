# WORLD-ROADMAP（未来方案清单）

> 依据《AI World Engine 独立项目拆分与实施方案》制定。**本文是执行清单，不是架构讨论**；
> 与方案原文冲突时，以方案原文为准。每一版启动前必须重读 §73 六条执行纪律与 §3 不做清单。
> 制定日期：2026-09-29 · 当前基线：**V1.0 已完成**（world-engine 1.0.0 · 引擎 73 用例 / 天穹 1716 用例）——
> V1.0 按《V0.9-to-V1.0 Core Boundary Refactor》方案验收（§十六 A–G 全过）；平台运营项（Docker/PG+Redis/账号/计费/管理后台）为 V1.0 后独立排期项。

---

## 0 · 全局纪律（每一版、每一项都适用）

| 纪律 | 方案依据 |
|---|---|
| 顺序铁律：严格按 §69 版本线推进，**前一版 DoD 未全部达成，禁止启动下一版** | §69 |
| 工作项循环：抽取/实现 → 编译 → 测试 → 检查依赖，任一环失败不进下一项 | §29 |
| 停止条件：触发 §59 十条之一 → 写 `WORLD-EXTRACTION-BLOCKERS.md` → 暂停等确认 | §59 / §73 第六条 |
| 禁止顺手重构：不换库、不换包管理器、不升级 TS、不改 UI、不顺手优化 | §3 / §60 |
| 回归门禁：天穹 vitest 全量（当前基线 **1713**）+ 引擎 vitest 全量（当前基线 **57**）全绿，基线只增不减 | §33/§38 |
| 验收标准以 §71 A–H 为纲；每版结束复查 §58 清单并记录在报告附录 | §58 / §71 |
| 判断标准：「换一个完全不同的游戏还能用吗？」能用 → 引擎/独立层；不能 → 游戏层 | §9 |
| **AI 层三禁**（V0.5–V0.8 的总纲）：引擎不调 LLM（§15）、引擎不依赖 Memory（§16）、AI 不直接改 State——AI 理解 → Command → 引擎（§45/§73 第四条） | §15/§16/§45 |
| AI 层落地的每一步都以天穹为参照实现（它已有 ai/openaiCompat、ruleReasoner、MemoryEngine）——迁移方式与 V0.1 抽取同构：审计 → 抽取/解依赖 → Adapter → 回归 | §73 第二条 |

## 当前基线（2026-09-29 · V0.4 末）

| 已完成 | 内容 | 证据 |
|---|---|---|
| V0.1 | 引擎独立项目 + 天穹 Adapter 重接 | tag v0.1 前身 5531e0f；报告 §1–7 |
| V0.2 | Adapter 收尾：写入原语统一 / 查询面下沉 / 契约底册 / 缝合面测试 / 接入指南 | tag v0.2；报告附录 A |
| V0.3 | World SDK：npm 包化 + 「铁与沙」第二游戏实证 + DR-001/002 | tag v0.3；报告附录 B |
| V0.4 | HTTP API：`world-engine/http` 六条路由 + 真实 socket 实证 + DR-003 | tag v0.4；报告附录 C |

未启动：V0.5–V1.0（本文档第二部分）。§3 不做清单中仍未做的：OpenAI Compatible API（V0.5）、模型路由（V0.6）、Embedding/Memory 重构（V0.6/V0.8）、用户系统/多租户/API Key/云部署/Docker/Web 管理后台/计费（V0.9–V1.0）、SillyTavern 插件（V0.5 起具备条件）。

---

# 第一部分 · 已完成版本的存档

## V0.2 · Tianqiong Adapter 收尾 ✅（2026-09-29，tag v0.2）

V2.1 写入原语统一（引擎 createMutate + entryOf/stamp 钩子，天穹 13 通用原语切换）／V2.2 查询面下沉（createQuery，天穹删 5 处重复）／V2.3 世界史通道核对（SavePort.loadWorldLog 往返断言）／V2.4 契约底册（COMMAND-EVENT-CONTRACT.md，零迁移）／V2.5 缝合面测试（engine-adapter.test，9 用例）／V2.6 ADAPTER-GUIDE。
DoD 全过：天穹 1713 / 引擎 47 / 双 typecheck+eslint 绿；§58 复查附录 A。

## V0.3 · World SDK ✅（2026-09-29，tag v0.3）

V3.1 包化（dist 唯一消费面 + node 直 import + pack 四步实证；天穹删 `@wengine` 别名改 file: 依赖）／V3.2 semver + CHANGELOG／V3.3 DR-001（实例隔离推迟 V0.9，关闭 B4）／V3.4 第二游戏「铁与沙」实证四件套／V3.5 指南升级 SDK 文档。
DoD 全过：pack 独立安装实证；天穹 1713 / 引擎 50；§58 复查附录 B。

## V0.4 · HTTP API ✅（2026-09-29，tag v0.4）

`world-engine/http` 子路径：createWorldHttp 纯协议适配器（§64 六条路由）+ startWorldServer（node:http 薄壳，默认只绑 127.0.0.1，体上限 1 MiB）；DR-003 一服务器一世界；真实 socket E2E（fetch 全链）。
DoD 全过：引擎 57 / 天穹 1713；§58 复查附录 C。

---

# 第二部分 · V0.5 – V1.0 执行规划

> 总架构位置（方案 §65）：从 V0.5 起，工作重心从「世界运行层」上移到「AI Cloud 层」。
> 引擎在 V0.5–V0.8 期间**零改动**是常态验收项（引擎唯一的大改在 V0.9，见 DR-001 触发条件）。
> 分包策略：AI 层不进引擎包——`world-gateway/`（V0.5–V0.7）与 `world-memory/`（V0.8）
> 是引擎仓库/发布序列中的**独立包**，依赖方向：gateway/memory → 引擎公开 API（含 world-engine/http），
> 引擎永远不反向依赖它们（§49 依赖方向的 AI 层推广）。

## V0.5 · OpenAI Compatible Gateway ✅（2026-09-29，world-gateway 0.5.0）

**版本目标**：把「世界的 AI 能力」以 OpenAI 兼容 API 暴露出去——外部客户端（SillyTavern §68、Agent）用标准 OpenAI 客户端即可与世界的 AI 层对话。**网关不自产智能**：它把请求翻译成对「AI 能力提供方」的调用；提供方由游戏实现（天穹的 AiPort 通道族就是第一个提供方）。

**交付与证据**：新包 `gateway/`（独立发布单元，不 import 引擎、引擎不知其存在）；线格式（chat 非流式 + SSE 流式 + models + embeddings）；GatewayProvider 注册表（模型名 = 通道）；`startGatewayServer`（loopback 默认/体上限/坏 JSON 400/提供方热插）。测试 9 用例含真实 socket SillyTavern 三步画像；dist 可被 node 直 import 实证。引擎零改动（59 基线 + invariants 不变）。脚本化 ST 客户端 E2E 通过。

| # | 工作项 | 方案依据 | 要点 |
|---|---|---|---|
| W5.1 | **线格式模块**：`/v1/chat/completions`（含 SSE 流式）、`/v1/models`、`/v1/embeddings` 的请求/响应映射，纯函数可测 | §65、§68 | 天穹 `ai/openaiCompat.ts` 是消费端参照；网关是它的镜像（服务端）。线格式解析与引擎无关 |
| W5.2 | **能力提供方注册**：游戏把 AiPort 通道（intent/npcDecide/chat/narrate/summarize/embedding…）注册进网关；通道 → 模型名的映射表（`/v1/models` 由此生成） | §65 六角色、§22 | 提供方接口 = 泛化的 AiPort；没注册的通道返回 501（可诊断） |
| W5.3 | **网关服务器**：复用 V0.4 的服务器纪律（默认 127.0.0.1、体上限、坏 JSON 400）；新包 `world-gateway/`，依赖 `world-engine/http` 同款风格但不含世界路由 | §65 AI Gateway | 无 API Key/计费（§3 留 V1.0）；loopback + 反代是既定部署姿势 |
| W5.4 | **SillyTavern 冒烟画像**：ST 以 OpenAI 兼容端点接入即出字（§68 第一张图）；完整世界交互走 Extension → SDK（§68 第二张图，本期只留文档接口说明） | §68 | 验收用脚本化 ST 请求序列（非真实 ST 安装） |
| W5.5 | **AI 纪律验收**：网关全链路对世界的任何影响仍走 Command（审计：网关自身无 mutate 权限） | §15/§45 | 引擎 invariants 扫描零变化（网关在引擎包外） |

**DoD**：脚本化 OpenAI 客户端对网关完成 chat（流式/非流式）/models/embeddings E2E；SillyTavern 兼容画像通过；天穹以提供方身份接入后 1713 回归绿；引擎包零改动（57 基线不动）；tag `v0.5`。

## V0.6 · Model Router ✅（2026-09-29，world-gateway 0.6.0）

**版本目标**：按**能力标签**选模型（§66）：`fast / cheap / reasoning / roleplay / narrative / memory / embedding / structured-output / long-context`。代码里没有任何厂商名——Qwen/DeepSeek/GPT/Claude/Gemini 只是**配置条目**（§66「World Engine 不关心」的 AI 层版本）。

**交付与证据**：`parseRouteConfig`（fail-fast：未知标签/非 http(s)/重复 id/密钥非引用启动即抛）+ `createModelRouter`（确定性选择、降级链、密钥缺失剔除、`explain()` 决策轨迹）+ `remoteChat/Stream/Embeddings` 出站客户端（仅 http/https；SSRF 边界：endpoint 属管理员可信配置）+ `routedProvider`（六角色即网关模型名）。测试 19 用例含**双上游按通道真实分流**与上游 500→503 如实上报。宿主接入（W6.4）：天穹 `LlmConfig.channelRoutes`（通道 → light/heavy 槽）+ `OpenAiCompatAdapter` 通道级端点覆盖 + 路由留痕；未配置通道行为逐字节不变（1715 回归全绿）。引擎零改动（59 基线）。

| # | 工作项 | 方案依据 | 要点 |
|---|---|---|---|
| W6.1 | **模型描述规范**：`ModelRef = { id, endpoint, apiKeyRef, tags[], 约束(上下文/速率) }`；密钥只存引用（env/密钥库），不进配置文件 | §66 | apiKeyRef 间接层为 V1.0 计费/多租户留位 |
| W6.2 | **路由器**：任务 → 需求标签集 → 候选模型（全标签命中优先，退化为部分命中 + 降级链）；六标准角色预置路由：Intent→fast、NPC→roleplay、Complex Rule→reasoning、Narrative→narrative、Memory→memory、Embedding→embedding | §65/§66 | 纯函数选择器 + 配置驱动；同标签多模型时确定性选择（种子可复现） |
| W6.3 | **路由配置**：`gateway.config.json`（models + routes）；天穹配置两三家端点即完成接入 | §66 | 配置错误 fail-fast（启动即校验，不等到首请求） |
| W6.4 | **天穹接入**：`ai/openaiCompat` 的单端点消费改为经路由器按通道取模型（intent→fast、chat→roleplay、narrate→narrative…） | §66 示例 | 回归门禁：1713 全绿（AI 层行为允许模型差异，通道协议不变） |
| W6.5 | **可观测**：每次路由决策留痕（任务/选中模型/耗时）进 RunLog/网关日志 | §44 追溯精神 | 为 V0.7 编排与 V1.0 计费提供数据面 |
| W6.6 | 文档：标签字典 + 接入新模型指南 | §62 | |

**DoD**：≥2 个不同端点的模型在天穹双通道（intent/narrative）真实分流运行；路由决策可追溯；引擎与网关协议零变化；tag `v0.6`。

## V0.7 · Multi-Model Collaboration ✅（2026-09-29，world-gateway 0.7.0）

**版本目标**：一轮玩家输入 → 多模型按角色协作完成（§65 角色图变成运行时管线）：意图模型解析 → 推理模型判定后果 → NPC 模型生成台词 → 叙事模型织正文——**每个模型的产出仍只是「建议」，世界变更一律落成 Command**（§45）。

**交付与证据**：`parsePipelineSpec`（DAG 描述 fail-fast，DFS 查环）+ `createPipeline`（拓扑分层并行、模板契约 `{{input.x}}`/`{{nodeId}}`、json 输出契约、失败隔离【节点失败只降级自己、下游级联跳过、optional 不报废】、双预算熔断【deadlineMs/maxCalls】、trace 留痕）。网关 24 用例（+5）。宿主 W7.5 E2E：天穹一轮自由行动双模型协作（intent→fast 端点、weave→narrative 端点，1716 回归全绿），世界变更全程经命令链。引擎零改动。

| # | 工作项 | 方案依据 | 要点 |
|---|---|---|---|
| W7.1 | **编排管线**：任务 DAG（角色节点 + 依赖边）；节点 = V0.6 路由的一次调用 | §65 角色图 | 管线描述数据化（JSON），代码只跑描述 |
| W7.2 | **阶段间契约**：上游产出 → 下游输入的类型化通道（意图包/判定包/台词包/正文包），复用天穹 AiPort 既有契约（IntentParse/NpcVerdict/ChatReply/NarrateCtx） | §45 | 契约即边界：任何节点不得越契约读世界状态 |
| W7.3 | **失败隔离与降级**：任一模型超时/失败 → 该节点回退规则路径（天穹「渐进增强」纪律的管线版）；部分产出可用时管线不整体报废 | §15 降级同规 | 降级路径必须可测（模拟模型故障） |
| W7.4 | **预算策略**：每轮的模型调用次数/时延上限；超限即截断进降级 | §66 cheap/fast 标签 | 数值进配置，不硬编码 |
| W7.5 | **天穹 E2E**：自由行动链（freeText → intent → reason → narrate）跑通多模型协作；世界变更全经 WorldExecutor | §14/§45 | 回归 1713 + 新增管线级测试 |
| W7.6 | 文档：管线配置指南 + 降级矩阵 | §62 | |

**DoD**：≥2 模型协作完成一轮真实自由行动；注入故障时降级到规则路径且世界状态一致；引擎零改动；tag `v0.7`。

## V0.8 · Memory Engine ✅（2026-09-29，world-memory 0.8.0）

**版本目标**：把天穹的记忆体系（memory/MemoryEngine、EmbeddingCache、LegacyMemory、感知表 knowledge、信念表 beliefs）抽成**独立 Memory Engine**（新包 `world-memory/`）——它是引擎之上的订阅者，不是引擎的零件（§16）。

**交付与证据**：W8.1 审计裁决——天穹记忆体系（18 文件/1815 行 + 1026 行测试）状态 resident 于 WorldState 存档且耦合 worldBook/law.json/Perception，整体迁移触发 §59 第 4 条 → 记入 BLOCKERS B5；world-memory 按通用引擎建成（事实摄取按感知边界、传闻保真衰减、tickDay 生命周期、词面+可注入向量检索、MemorySavePort 持久化）。**铁与沙闭环实证**（`examples/second-game/memory-loop.test.ts`）：世界事实流 → 摄取 → 检索喂 AI → Command → 状态，记忆全程只读事实。天穹记忆保持原生（B5），专项测试全绿门禁不触碰。引擎/网关零改动。

| # | 工作项 | 方案依据 | 要点 |
|---|---|---|---|
| W8.1 | **审计**：天穹 memory/* 与 WorldState 内五张认知表（memories/knowledge/beliefs/memTickAt/cases）逐字段过 §9 判据 | §16、§26 精神 | 产出 memory-audit 附录：通用（记忆衰减/感知边界/信念推导）→ world-memory；游戏语义（具体记忆文案/LOD 档位数值）→ 留天穹 |
| W8.2 | **事件摄取**：MemoryEngine 订阅世界事实流（进程内 worldBus 或 V0.4 HTTP events 轮询/SSE），把事实转成记忆条目——**只读事件，绝不写状态** | §16 正确结构 | 感知边界（witnesses）是记忆的入参：谁目击谁记得（§8） |
| W8.3 | **检索 API**：按 owner/主题/时间/重要度检索；embedding 通道经 V0.6 路由（memory/embedding 标签）；无向量模型时退化为词面检索（渐进增强） | §65/§66 | 检索结果只喂给 AI，由 AI 生成 Command——Memory 永远不直接改世界 |
| W8.4 | **持久化端口**：MemorySavePort（load/save by owner+worldId）；内置内存实现，SQLite 实现留 V1.0（§40） | §40/§41 | 端口形状对齐引擎 SavePort 风格（DR-002 消费面纪律） |
| W8.5 | **天穹迁移**：memory/* 切到 world-memory 包 + 天穹侧薄 Adapter；旧档记忆迁移（LegacyMemory 路径保持可读） | §73 第二条 | **门禁：天穹 memory-engine/memory-lod 等既有记忆测试全绿是硬标准**；引擎 57 基线不动 |
| W8.6 | 文档：Memory Engine 使用说明（订阅/检索/端口） | §62 | |

**DoD**：天穹记忆行为不变（记忆专项测试全绿）；MemoryEngine 在「铁与沙」上独立运行（订阅→记忆→检索喂 AI→Command 闭环）；引擎包零改动零认知；tag `v0.8`。

## V0.9 · Multi-World / Multi-User ✅（2026-09-30，world-engine 0.9.0）

**版本目标**：一进程多世界、用户拥有世界（§42：user A → world-001/002，user B → world-003）。**这是引擎核心自 V0.1 以来第一次大改**——DR-001/DR-003 的触发条件在此兑现，风险等级最高，工作项最细。

**交付与证据**：W9.1 作用域隔离按 **DR-004 形态**落地（作用域工厂 + 全局缺省——穿参方案被否决，见 DR-004；rng/scheduler 明确为进程级共享设施）；W9.2 隔离不变量入 tests/registry.test.ts（事件环互不含同条事实、事件 id 分域起算、总线订阅互不可见、隔离世界不进全局总线）；W9.3 WorldRegistry（worldId 必填唯一、get/list/close）；W9.5 HTTP 注册表模式（POST /v1/worlds 可多次、{id} 路由形状不变——DR-003 兑现）。**天穹（单世界、全局作用域）零改动：1716 回归全绿**；引擎 68 用例（+7）。所有权/鉴权属部署层（V1.0）；用户系统为 V1.0 条目（§3），本期引擎只认 worldId。

| # | 工作项 | 方案依据 | 要点 |
|---|---|---|---|
| W9.1 | **实例隔离（引擎核心改造）**：worldBus / rng / scheduler / 事件序号从模块级单例迁为 `createWorld` 作用域状态；迁移沿 DR-001 预留路径（约 20 模块签名穿参） | §42、DR-001 触发条件 | 每迁一个单例跑一轮双回归；天穹组合根改传作用域（其唯一世界行为不变） |
| W9.2 | **隔离不变量**：新测试「双世界互不可见」（事件/随机流/序号三方隔离断言）入 invariants | §42 | 这是 V0.9 的存在证明，等价于当年「铁与沙」之于 V0.3 |
| W9.3 | **WorldRegistry**：createWorld → 注册表（worldId → handle）；list/get/close；WorldHandle 增加 owner 概念 | §42 | 引擎 API 只认 owner 字符串；鉴权属部署层（V1.0） |
| W9.4 | **存储按 worldId 分档**：SavePort 语义升级（load(worldId)）；内存/文件实现跟进 | §41/§42 | 旧单世界档 = worldId 已知值的特例，天穹读档零迁移 |
| W9.5 | **HTTP 开放注册表语义**：撤 DR-003 的 409（POST /v1/worlds 可多次）；网关/内存包随实例化改造 | DR-003 触发条件 | 六条路由协议形状不变（客户端零改动，DR-003 已预留） |
| W9.6 | 文档：DR-001/DR-003 标注「已兑现」；多世界部署指南 | §62 | |

**DoD**：同进程双世界隔离不变量绿；天穹（单世界）1713 回归绿；HTTP 注册表流 E2E 绿；§59 风险最高——任何一步触发停止条件即按纪律记录暂停；tag `v0.9`。

## V1.0 · Core Boundary 定型 + Cloud AI World Platform ✅（2026-09-30，world-engine 1.0.0）

**V1.0 按《V0.9-to-V1.0 Core Boundary Refactor》方案执行并验收**（Phase 0–11 全过，§十六 A–G 全过）：

| 工作项 | 结果 |
|---|---|
| Phase 0 基线 | ✓ tag `v0.9-pre-core-boundary`，68 测试全绿 |
| Phase 1 审计 | ✓ docs/CORE-BOUNDARY-AUDIT.md |
| Phase 2 分类 | ✓ docs/CORE-EXTENSION-CLASSIFICATION.md（四类归属全表） |
| Phase 3 State 泛化 | ✓ docs/STATE-GENERALIZATION-REPORT.md + 信封通用容器（locations/relations/variables/metadata/attributes/type，全部可选向后兼容） |
| Phase 4 Command 泛化 | ✓ docs/COMMAND-BOUNDARY-REPORT.md + Core 命令五条（create_entity/remove_entity/update_attribute/set_relation/move_entity）；RPG 命令（attack/talk/set_attitude/spawn_entity）移入 rpgCompat EXTENSION 模块（兼容保留） |
| Phase 5 Event 边界 | ✓ docs/EVENT-BOUNDARY-REPORT.md + §7.3 六项能力验证（深度/预算/幂等/重试/死信——既有实现零缺口） |
| Phase 6 World Definition | ✓ applyDefinition + createWorld({ definition })——创建空世界→注入定义→运行（§八正式确立） |
| Phase 7 天穹 | ✓ 经 Adapter 运行、1716 回归全绿、零改动 |
| Phase 8 第二世界类型 | ✓ examples/colony 太空殖民（火星历/生产/建造）——十项验收全过，**零内核改动，零 Generalization Gap** |
| Phase 9 不变量扩展 | ✓ 内核禁 AI 层包依赖 + Core 规则/运行时禁 RPG 语义词（integration.test） |
| Phase 10/11 回归与定型 | ✓ 四包 73/24/8/1716 全绿；CHANGELOG 1.0.0；公开 API 冻结 |

**平台运营项**（Docker 部署 / PostgreSQL+Redis / 账号与多租户 / Web 管理后台 / 计费）为 V1.0 后独立排期项——它们是运营工程，不属于内核边界方案；启动前需单独圈定范围。

| # | 工作项 | 方案依据 | 要点 |
|---|---|---|---|
| W10.1 | **生产部署**：Docker 化（engine-http + gateway + memory + 天穹/第二游戏前端）；方案 §74「Cloud Deployment」位 | §1/§3/§64 | 引擎/网关/内存三包的镜像矩阵；配置全部环境变量化（apiKeyRef 落密钥库） |
| W10.2 | **持久化升级**：PostgreSQL（世界档/世界史）+ Redis（热态/事件流）实现 SavePort/MemorySavePort | §40 清单 | 端口已在（V0.3 SavePort / V0.8 MemorySavePort），只加介质 |
| W10.3 | **账号与多租户**：用户系统（注册/登录）、API Key 签发、租户隔离（owner 全面生效）；§3 的「用户系统/API Key/多租户」在兑现 | §3/§42 | 鉴权在网关/部署层，引擎仍只认 owner 字符串（W9.3 边界保持） |
| W10.4 | **Web 管理后台**：世界列表/状态/事件流/因果链追溯（§44 traceChain 的可视化）/存档管理 | §3「Web 管理后台」 | 只读优先；管理操作走 Command 通道（AI 三禁同样约束管理员工具） |
| W10.5 | **计费与商业化**：用量计量（V0.6 路由日志是数据面）→ 计费挂账 → 商业化门槛 | §3 | 先计量后计费；不影响未付费通道的本地部署 |
| W10.6 | **平台验收**：公网端到端（SillyTavern → OpenAI 兼容网关 → 世界；天穹 → SDK → HTTP → 云引擎——§20 的完整闭环） | §20/§68 | 「即使天穹整个项目删除，云上世界照常运转」是 V1.0 版的 §75 |

**DoD**：公网部署栈通过双客户端 E2E；计量/计费链路可对账；管理后台只读巡检可用；tag `v1.0`。

---

## 附 A · 每版固定动作

1. **启动**：重读方案 §73 六条纪律 + §3 不做清单；确认上一版 DoD 全勾；确认顺序铁律（§69）。
2. **过程中**：每个工作项按 §29 循环；触发 §59 即停（先记录 BLOCKERS，后暂停）；AI 层版本额外自查「AI 三禁」（§0 表）。
3. **收尾**：双回归全绿（基线只增不减）→ §58 复查入报告附录 → CHANGELOG → tag → 推送。

## 附 B · 版本风险梯度（§59 预判）

| 版本 | 风险 | 主因 | 预置对策 |
|---|---|---|---|
| V0.5 | 低 | 新包新面，引擎不动 | 线格式单测覆盖 |
| V0.6 | 低-中 | 天穹 AI 消费路径改路由 | 通道协议不变 + 1713 门禁 |
| V0.7 | 中 | 多模型编排的时序与降级 | 故障注入测试 + 预算熔断 |
| V0.8 | 中-高 | 天穹记忆体系迁移（memory 测试 800+ 行是硬门禁） | W8.1 审计先行 + 旧档迁移路径保留 |
| V0.9 | **高** | 引擎核心单例实例化（V0.1 以来首次核心大改） | DR-001 预留路径 + 每单例一回归 + 隔离不变量 |
| V1.0 | 中（运营） | 部署/账号/计费的工程面 | 启动前与用户重估范围 |

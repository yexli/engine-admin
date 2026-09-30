# Changelog · world-gateway

## [0.7.0] - 2026-09-29 · Multi-Model 编排管线（V0.7，方案 §65 角色图运行时化）

一轮任务多模型协作：管线 JSON 描述 + 确定性路由执行。

### Added
- `parsePipelineSpec` / `PipelineSpecError`：DAG 描述 fail-fast（id 唯一合法、依赖存在、DFS 查环、规模封顶、模板契约校验）。
- `createPipeline(spec, router)`：拓扑分层并行执行；模板 `{{input.x}}` / `{{nodeId}}` 注入；`output:'json'` 契约；**失败隔离**（节点失败只降级自己、下游级联跳过、`optional` 不报废管线）；**预算熔断**（deadlineMs 时延 + maxCalls 次数，超限按预算降级、已产出照常交付）；`trace` 逐节点留痕（模型/耗时/原因）。
- 测试 +5：三节点 DAG 双模型协作 / 失败隔离（兄弟照常） / optional 与 json 契约 / 双预算熔断 / 描述 fail-fast。

### 验收
- 网关 24 用例全绿；dist 可被 node 直 import。宿主 W7.5 E2E：天穹一轮自由行动完成双模型协作（intent 走 fast 端点、weave 走 narrative 端点），世界变更全程经命令链。

## [0.6.0] - 2026-09-29 · Model Router（V0.6，方案 §65/§66）

按能力标签选模型：任务 → 需求标签集 → 候选模型；厂商只进配置，代码只认标签。

### Added
- `parseRouteConfig` / `RouteConfigError`：ModelRef（endpoint + apiKeyRef{env} + tags + wireModel/maxContextK）与角色覆盖的 **fail-fast** 校验（未知标签/非 http(s) 端点/重复 id/密钥非引用一律启动即抛）。
- `createModelRouter`：确定性选择（匹配数 → prefer → 配置序）；**降级链**（全命中优先、部分命中放行、零命中 null 回退宿主缺省）；密钥缺失模型选型时剔除；`explain()` 全轨迹（W6.5 可观测）。
- `CAPABILITY_TAGS`（§66 固定九标签）+ `STANDARD_ROUTES`（§65 六角色预置：Intent→fast、NPC→roleplay、Reasoning→reasoning、Narrative→narrative、Memory→memory、Embedding→embedding）。
- `remoteChat / remoteChatStream / remoteEmbeddings`：OpenAI 兼容出站客户端（全局 fetch，零依赖；SSE 解析；仅 http/https；endpoint 属管理员可信配置，用户输入不影响 URL）。
- `routedProvider(router)`：把路由结果包装成网关提供方——六角色即 `/v1/models` 的六个「模型名」；与 V0.5 服务器组合即完成「OpenAI 客户端 → 网关 → 按标签分流到多上游」。
- 测试 19 用例（+10）：配置 fail-fast / 确定性与降级链 / 密钥剔除 / **双上游按通道真实分流** / 上游 500→503 如实上报 / 流式透传 E2E。

### 宿主接入参照
- 天穹 W6.4：`LlmConfig.channelRoutes`（通道 → light/heavy 槽）+ `OpenAiCompatAdapter` 通道级端点覆盖 + 路由决策留痕；未配置通道行为逐字节不变。

## [0.5.0] - 2026-09-29 · OpenAI Compatible Gateway（V0.5，方案 §65/§68）

- OpenAI 兼容线格式：`/v1/chat/completions`（非流式 + SSE 流式：delta → stop → `[DONE]`）、
  `/v1/models`、`/v1/embeddings` 的纯映射模块（零厂商 SDK——「OpenAI 兼容」是协议形状不是依赖，§66）。
- 能力提供方注册表：模型名 = AI 能力通道（§65 六角色）；宿主注册 GatewayProvider
  （天穹 AiPort 通道族的桥接点）；未注册通道 /v1/models 不出现、调用 404。
- `startGatewayServer`：node:http 薄壳（默认只绑 127.0.0.1、体上限 1 MiB→413、坏 JSON→400）；
  提供方可热插（注册即出现在 /v1/models）。
- 测试 9 用例：线格式 / 注册表 / 协议（含流式帧与错误帧收流）/ 真实 socket 端到端
  （SillyTavern 三步画像：拉模型 → 非流式 → 流式）。
- 引擎零改动（本版验收项）：`world-engine` 保持在 0.4.1 / 59 用例。

# world-gateway

OpenAI 兼容 API 网关（方案 §65 **AI Cloud Layer**）：让标准 OpenAI 客户端（SillyTavern、任意 Agent）
直接与「世界的 AI 能力」对话。**网关不自产智能**——每个模型名是一个 AI 能力通道
（§65 六角色：intent / npc / reasoning / narrative / memory / embedding），
通道背后是游戏注册的提供方；对世界的任何影响都发生在宿主实现里且必须经 Command（§45）。

零运行时依赖；协议形状是「OpenAI 兼容」，不是对任何厂商的依赖（§66）。

```bash
npm install   # 或作为独立包发布
npm test && npm run build
```

## 60 秒上手

```ts
import { startGatewayServer } from 'world-gateway';

const server = await startGatewayServer({
  port: 8788,            // 缺省 8788
  host: '127.0.0.1',     // 缺省仅本机——无鉴权端口不默认外露
  providers: [
    {
      owner: 'my-game',
      models: ['narrative', 'intent'],           // 通道 = 客户端看到的「模型名」
      complete: async (model, messages) => {
        // 把 OpenAI 消息翻译成你游戏的 AI 调用（天穹的 AiPort 通道族在这里桥接）
        return '他推开门，风沙灌了进来。';
      },
      completeStream: async (model, messages, onDelta) => {
        onDelta('他推开门');
        onDelta('，风沙灌了进来。');
      },
      embed: async (model, input) => input.map((s) => [s.length, 1]),  // 可选
    },
  ],
});
```

```bash
curl http://127.0.0.1:8788/v1/models
curl http://127.0.0.1:8788/v1/chat/completions -d '{"model":"narrative","messages":[{"role":"user","content":"继续"}]}'
```

## 路由

| 路由 | 说明 |
|---|---|
| `GET /v1/models` | 已注册通道清单（OpenAI list 形状） |
| `POST /v1/chat/completions` | 补全；`stream:true` 走 SSE（delta 帧 → stop 帧 → `[DONE]`） |
| `POST /v1/embeddings` | 嵌入（提供方未实现回 501） |

错误语义：未注册模型 404（`model_not_found`）、坏载荷 400、提供方失败/返回空 503（如实上报，不假装修好）、
嵌入未实现 501。安全基线同引擎 http 层：体上限 1 MiB→413、坏 JSON→400、默认 loopback（DR-003 精神）。

## Multi-Model 编排管线（V0.7 · §65 角色图运行时化）

一轮任务多模型协作：管线用 **JSON 描述**（数据化 DAG），代码只跑描述。

```ts
import { parsePipelineSpec, createPipeline } from 'world-gateway';

const spec = parsePipelineSpec({
  id: 'free-turn',
  nodes: [
    { id: 'intent', role: 'intent', user: '解析：{{input.text}}', output: 'json' },
    { id: 'judge', role: 'reasoning', user: '意图是 {{intent}}，判定后果', dependsOn: ['intent'] },
    { id: 'tale', role: 'narrative', user: '基于「{{judge}}」写正文', dependsOn: ['judge'] },
  ],
  deadlineMs: 8000,
});
const result = await createPipeline(spec, router).run({ text: '我看看四周' });
// result.ok / outputs / json / degraded / trace / timedOut
```

- 模板契约：`{{input.x}}` 引用入参、`{{nodeId}}` 引用上游文本；`output:'json'` 节点必须可解析。
- 失败隔离：节点失败只降级自己，下游级联跳过，兄弟分支照常；`optional` 节点失败不判管线失败。
- 预算熔断：`deadlineMs` 时延上限 + `maxCalls` 次数上限，超限剩余节点按『预算』降级，已产出照常交付。
- 产出只是**建议**：对世界的影响由宿主转成 Command 落引擎（§15/§45）。

## 与引擎的关系

架构上属于 AI Cloud 层（§65），物理上是独立包：`world-gateway` 不 import `world-engine`，
引擎也不知道网关存在。宿主负责桥接（游戏 AiPort → GatewayProvider），并保证提供方对世界的
一切影响走 Command 通道（§15/§45）。密钥不在网关——提供方自己管（V0.6 Model Router 接管按标签选模型）。

## Model Router（V0.6 · §66 按能力标签选模型）

厂商名（Qwen/DeepSeek/GPT/Claude/Gemini）只出现在**配置条目**里，代码只认标签：

```ts
import { parseRouteConfig, createModelRouter, routedProvider, startGatewayServer } from 'world-gateway';

const router = createModelRouter(
  parseRouteConfig({
    models: [
      { id: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1', apiKeyRef: { env: 'DEEPSEEK_KEY' }, tags: ['fast', 'cheap'] },
      { id: 'local-tale', endpoint: 'http://127.0.0.1:11434/v1', apiKeyRef: { env: 'LOCAL_KEY' }, tags: ['narrative', 'roleplay', 'long-context'] },
    ],
    routes: { intent: { tags: ['fast'], prefer: ['deepseek-chat'] } }, // 缺省走 §65 标准六角色
  }),
);

const server = await startGatewayServer({ port: 8788, providers: [routedProvider(router)] });
// 客户端选 model='intent' → 路由器命中带 fast 标签的端点；model='narrative' → narrative 端点
```

- **标签字典（固定九个）**：`fast / cheap / reasoning / roleplay / narrative / memory / embedding / structured-output / long-context`；未知标签配置即报错（fail-fast）。
- **六标准角色预置**：Intent→fast、NPC→roleplay、Reasoning→reasoning、Narrative→narrative、Memory→memory、Embedding→embedding；`routes` 可覆盖。
- **确定性**：同配置同任务必选同一模型（匹配数 → prefer → 配置序）。
- **降级链**：全标签命中优先、部分命中放行、零命中返回 null（调用方回退宿主缺省端点）。
- **密钥只存引用**：`apiKeyRef: { env: 'VAR' }` 在调用时解析；缺失的模型在选型时剔除并留痕（`explain()` 全轨迹）。
- **SSRF 边界**：endpoint 是管理员配置（fail-fast 校验 http/https），用户请求永不影响 URL——本地推理端点（环回/内网 llama.cpp、vLLM）是合法场景。
- `routedProvider(router)` 把路由结果包装成 V0.5 网关提供方，六角色即 `/v1/models` 里的六个「模型名」。

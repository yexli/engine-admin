# Embedding 配置双源现状审计（Step 1 · 只读）

> 时间：2026-10-04　方式：三路并行只读审计（memory 包 / platform+gateway 链路 / admin-web+脚本）
> 结论按【证据 文件:行号】给出；本审计未修改任何代码。

## 一、双配置源确认

### 路径 A：Memory 独立 Embedding 配置（待拆除）

```
admin-web 记忆库→向量嵌入页（views/memory/embedding/index.vue:25-30 表单
  enabled/endpoint/model/apiKey）
  │ GET/PUT/POST /control-api/v1/admin/memory/embedding-config[/test]
  ▼
平台鉴权代理（platform/src/admin/http.ts:1164-1188；PUT/test 需 system:manage）
  ▼
memory 服务 8789 → 协议层校验（world-engine/memory/src/http/protocol.ts:304-348）
  ▼
宿主回调（scripts/run-demo-memory.mjs:202-220,267-294）
  ├─ 持久化 platform/data/memory/embedding-config.json（apiKey 明文，:195-200）
  └─ 逐 store engine.setEmbed(directHook)（:211-215 → engine.ts:153-155）
  ▼
Provider 直连旁路（run-demo-memory.mjs:120-142 → gateway/src/remote.ts:186-190，
  POST {endpoint}/embeddings，Bearer 明文 apiKey）
```

**旁路本质**：最后两跳绕开受管网关的路由 / SecretStore 加密 / 出站校验 / usage 记账；
配置面与模型路由互不同步。

### 路径 B：Model Router embedding 能力（唯一真相源，已在用）

```
admin-web AI 网关→模型路由（views/gateway/router/index.vue，capability=embedding 行）
  │ PUT /control-api/v1/admin/model-config（If-Match revision，整体热替换）
  ▼
ModelConfigStore（校验 + SecretStore 加密凭证 + 原子落盘）→ swapTo 双侧热替换
  ├─ gateway.replaceProviders(buildManagedProvider)（managed-runtime.ts:158-207，
  │    embed = resolveModelTarget + 出站校验 + remoteEmbeddings）
  └─ router.replaceRoutes(routes.embedding={primary,fallback}）（managed-runtime.ts:321-327）
  ▼
run-managed embedHook（run-managed.mjs:139-153）
  router.select('embedding') → embeddings.embed(model, texts) → 网关 /v1/embeddings
  ▼
Memory engine.recallScored：向量分 cosine×0.2 并入；失败/null → 纯词面（engine.ts:172-190）
```

### 哪套真正生效？——运行时铁证

- **受管模式（run-managed.mjs，即 dev-stack 平台进程）只消费路径 B**：不读
  `embedding-config.json`，对 `PLATFORM_MEMORY_WORLDS` 世界注入 Router 钩子。
  管理台在路径 A 页面写下的配置对平台内记忆召回**零影响**。
- **独立 memory 服务（run-demo-memory.mjs，8789，供管理台检索调试）只消费路径 A**。
- 两个进程各自 setEmbed，跨进程互不知晓——路径 B 已是事实标准，路径 A 是
  仅存于 demo 宿主 + 一张管理页面的历史遗留。

## 二、关键代码事实

1. **memory 包内核零旁路**：`MemoryConfig` 无任何 embedding 字段（types.ts:78-89）；
   唯一机制是注入式 `EmbedHook { embed(texts): Promise<number[][] | null> }`
   （types.ts:67-69，engine.ts:29/153-155）。**审计结论：不需要改引擎，只需要拆配置面。**
2. **配置仅存在于**：memory HTTP 适配层的 4 个端点（GET/PUT embedding-config、
   /test、GET /v1/memory/embedding 观测）+ demo 宿主的 JSON 文件 + env 引导。
   `embeddingModel/endpoint/apiKey` 等命名全仓零命中（双源实际键名是
   `embedding-config.json` 的 `{enabled,endpoint,model,apiKey}` 与 `routes.embedding`）。
3. **引擎只在检索时向量化**（recallScored 现场计算，条目不持久化向量）——
   换模型不产生持久向量混维问题；但维度信息无处记录、无变化告警。
4. **路径 B 三块缺口**：
   - `POST /v1/admin/routes/embedding/test` 实际发 **chat ping**（managed-runtime.ts:352
     remoteChat('ping')）——embedding 模型通常无 chat 语义，这是假测试；
   - 维度不贯通：embeddings 客户端只回 number[][]（无 dimensions）、网关响应无
     dimensions、ProbeResult 无维度；
   - **fallback 死代码**：embedHook 不调 markFailed/markHealthy（全仓调用点仅
     worldagent/pipeline.ts:138,143 chat 路径）→ embedding 失败不冷却、fallback 槽永不接管。
5. **附带缺口**：网关 remoteEmbeddings 无超时（remote.ts:186-190；remoteChat 有 60s）；
   `DEFAULT_ROUTES.embedding.primary='embedding'` 字面通道名（modelrouter.ts:29，
   独立 run-platform 下产生注定 404 的调用）；usage 无 embeddings 种类（recorder.ts:26）。
6. **引用清单**（拆除影响面，全部确认）：
   - memory 包：http/protocol.ts:60-79,82-88,304-348（配置端点契约+handler）、
     server.ts 透传、http.test.ts:165-208；
   - 脚本：run-demo-memory.mjs:89-142,191-223,267-294（配置文件/env/直连钩子/回调装配）；
   - 平台：admin/http.ts:1159-1188（代理）、admin-http.test.ts:~1020-1099、
     config.ts memoryBaseUrl（需确认其他消费点）；
   - 前端：api/memoryConfig.ts 全文件、views/memory/embedding/index.vue 表单区、
     router/modules/memory.ts:47-56（仅 meta 改名）；
   - 数据：platform/data/memory/embedding-config.json（迁移后改名封存）；
   - 文档：DEPLOY.md:112-114（EMBEDDINGS_* env）、ADMIN-API-MAPPING.md:142,163。
7. **tianqiong2 自带一套 embedding**（embeddingCompat.ts 等）——独立应用内部实现，
   不经平台、不属于本治理范围（方案边界：平台侧双源）。

## 三、唯一真相源判定（Step 2 结论）

**Model Router（ModelConfigStore.routes.embedding）为唯一 Embedding 模型配置源。**

Memory 侧只保留：
- 注入式 `EmbeddingService`（现有 `EmbedHook`，别名导出以对齐方案 §6 命名）；
- `setEmbed(hook|null)` 热替换；
- 维度记录与变化告警（Memory 职责表中的"向量维度检查"）；
- `GET /v1/memory/embedding` 纯观测端点。

Memory 侧删除：Provider / Endpoint / API Key / 模型 ID / 配置读写端点 / 测试端点。

## 四、实施映射（Step 3-9）

| Step | 动作 |
|---|---|
| 3 打通 Memory→Router | 平台新增 `createRoutedEmbeddingService`（router+embeddings 客户端组合，含 markFailed/Healthy 与 fallback 接管）+ 公共 `POST /v1/embeddings`（跨进程 Memory 的 EmbeddingService 传输层）；demo 宿主改经平台调用 |
| 4 迁移旧配置 | `platform/scripts/migrate-memory-embedding.mjs`：读 embedding-config.json → 建/匹配 provider+model(tags 含 embedding) → 设 routes.embedding.primary → 旧文件改名封存 |
| 5 删运行时旁路 | 删 memory 配置端点、平台代理、demo 直连钩子；run-managed 改用 routed service |
| 6 Admin UI | 记忆库→向量嵌入 改状态/诊断页（Router 实况 + 维度 + 测试按钮走真实 Router + 跳转路由页），删除全部可写表单 |
| 7 旧 API | 引用清单已确认（§二.6），三阶段合并执行：停止写入（删表单）→ 迁移（脚本）→ 删除（端点/代理/存储） |
| 8 测试 | Primary/Fallback/模型切换/维度变化告警/旧端点 404/公共端点鉴权与降级 |
| 9 验收 | 改 Router 路由 → Memory 检索自动用新模型（实测）；全量回归 |

## 五、维度保护的诚实口径（方案 §9 的落地）

本引擎**不持久化向量**（检索时现场计算），故"切模型污染已有 Vector Store"的
场景在此实现中不存在。落地的保护为：
1. 检测：引擎记录最近一次成功 embed 的维度，维度变化时打上 `dimensionChanged`
   告警（不静默）；2. 观测：`GET /v1/memory/embedding` 与诊断页展示当前/最近维度；
3. 测试按钮返回实测 dimensions；4. 文档明示：向量实时计算，无需重建索引，
   但语义分将按新模型重算（近因权重不变）。

---

## 六、执行结果（Step 3-9 全部完成，2026-10-04）

| Step | 结果 |
|---|---|
| 2-3 唯一真相源 + 打通 | `createRoutedEmbeddingService`/`routedEmbeddingHook`（platform 0.25.0）：Router.select → 网关 /v1/embeddings，**primary 失败 → markFailed 冷却 → fallback 自动接管**（修复死代码）；公共 `POST /v1/embeddings`（权限码 `embeddings`）= 跨进程 Memory 的传输层，拒绝客户端指定 model；run-managed 记忆钩子与公共端点共享同一 Router（冷却互通）；run-demo-memory 宿主改经 `EMBEDDING_SERVICE_URL/KEY` 接入 |
| 4 迁移 | `platform/scripts/migrate-memory-embedding.mjs` 已执行：prov-siliconflow + mdl-BAAI-bge-m3 启用、凭证入 SecretStore（AES-256-GCM）、`routes.embedding.primary = mdl-BAAI-bge-m3`（revision → 40）；旧 `embedding-config.json` 封存为 `*.migrated-2026-10-04T09-57-00Z` |
| 5 删旁路 | memory 配置端点删除（410 Gone 指路，world-memory 0.9.0）；平台 `/v1/admin/memory/embedding-config[/test]` 代理与 `PLATFORM_MEMORY_URL` 删除；`remoteEmbeddings` 直连钩子删除；`DEFAULT_ROUTES.embedding.primary='embedding'` 字面缺省修正为 null |
| 6 Admin UI | 「记忆库 → 向量嵌入」改为状态/诊断页：路由实况（主/备模型、Provider、当前生效、冷却）+ `[测试 Embedding]`（走真实 Router embed 语义，返回维度）+ `[前往模型路由]` + Memory 运行时实况（引擎实测维度/维度变化告警/检索统计）；全部可写表单删除 |
| 7 旧 API | Phase A/B/C 三阶段一次完成（引用清单 §二.6 全部确认：代码/测试/数据/文档同步） |
| 8 测试 | platform **313/313**（新增 embedding-unification：primary/fallback/模型切换/端点鉴权与降级；admin-http：代理删除断言 + 路由实况 + embed 语义实测）、world-memory **19/19**（410 契约 + 维度变化告警）；四包合计 **502 项全绿**；admin-web vite build 通过 |
| 9 验收（实测） | ① `POST /v1/embeddings` → 真实 1024 维向量（mdl-BAAI-bge-m3 @ 硅基流动，模型由路由决定）；② `GET /v1/admin/routes/embedding` 实况正确；③ `POST routes/embedding/test` → ok + dimension 1024（356ms）；④ Memory 检索端到端（engineDimension 1024 = 上游真实维度）；⑤ **改路由 → Memory 零改动自动跟随**：primary 切空 → 503 no_model_configured（词面照常），恢复 → 200 + 1024 维（revision 40→42 热替换，无重启） |

### DoD 核对（方案 §16）
全部满足：唯一配置源 = Model Router ✓；Memory 不保存 Provider/Endpoint/Key/模型 ✓；
经 embedding capability 获取模型 ✓；Primary/Fallback 正常（含故障接管）✓；Adapter/Gateway
正常 ✓；页面不再提供独立配置、能显示实际生效模型 ✓；测试按钮走真实 Router ✓；维度变化
受保护（检测 + 告警 + 诚实口径）✓；旧配置完成迁移 ✓；旧配置 API 不参与运行时（410/404）✓；
无 Memory→Provider 旁路 ✓；全量测试通过 ✓；Admin UI 构建通过 ✓；Tianqiong 记忆实际调用
通过（tianqiong-village 由平台内嵌服务经 Router 语义召回）✓；World Engine Core 零污染
（Core 未引入任何 Memory/Provider 逻辑）✓。

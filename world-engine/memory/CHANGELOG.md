# Changelog · world-memory

## [0.8.3] - 2026-10-03 · V2.4-07：MemoryEntry.sourceEventId 落档

### Fixed
- `ingestFact` / `spreadRumor` 摄取时已携带 `sourceEventId`，但 `remember`
  落档时**未写入条目**——溯源字段在类型上存在、数据上丢失。现如实落档
  （V2.4-07 Provenance：记忆可回溯到 Source Event）。


## [0.8.1] - 2026-09-30 · M1.1 HTTP 适配层（G7，只读 + 检索面）

- **`world-memory/http` 子路径导出**：`createMemoryHttp`（纯路由协议，模式同
  world-engine/http）+ `startMemoryServer`（node 薄壳，默认 127.0.0.1:8789，
  请求体上限 256 KiB）。路由：`GET /v1/memory/stores`、
  `GET /v1/memory/records`（store/entity/kind/q 分页筛选）、
  `POST /v1/memory/retrieval`（真实评分；无 entity 时聚合 store 内全部 owner）、
  `GET /v1/memory/embedding`（向量通道声明 + 经本服务的检索统计，诚实口径）。
  store = 一个 MemoryEngine 实例（worldId 维度归宿主）；**只读 + 检索面，
  无任何写世界/删记录的口子**（§16 纪律不变）。
- **`recallScored(owner, query, options)`**：召回的带评分版（返回
  `{entry, score}[]`）；`recall` 改为其条目投影，公开形状不变。
- **`MemoryEntry.createdAt?`**：新条目摄取时刻（ISO 8601）；旧快照缺省，
  HTTP 层投影为 null 不编造。

## [0.8.0] - 2026-09-29 · 独立角色记忆引擎（V0.8，方案 §16）

- **事实摄取（W8.2）**：`ingestFact` 按感知边界（witnesses）建目击者记忆（置信 1）；
  `spreadRumor` 传闻写入（置信衰减，宿主可改写文案）；`remember` 自记。
- **生命周期**：`tickDay` 线性衰减（重要度加权：衰量 × (1 − importance/2)）、
  遗忘线、容量上限淘汰；同日重复 tick 不叠加（水位语义）。
- **检索（W8.3）**：置信/重要度/新近度/词面加权；`EmbedHook` 可注入向量
  （经宿主接 V0.6 路由的 embedding 通道），失败静默回词面；召回强化计数。
- **持久化（W8.4）**：`MemorySavePort` + `InMemoryMemoryStorage`；快照序号续接。
- **零引擎依赖**（§16 数据流：宿主桥接事实流与 Command 落地）；闭环实证：
  `examples/second-game/memory-loop.test.ts`（事实流 → 摄取 → 检索喂 AI → Command → 状态）。
- 测试 8 用例全绿；dist 可被 node 直 import。

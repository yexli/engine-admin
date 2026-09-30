# Changelog · world-memory

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

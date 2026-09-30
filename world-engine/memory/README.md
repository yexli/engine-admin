# world-memory

独立角色记忆引擎（方案 §16 **Memory 是引擎之上的独立层**）：事实摄取（感知边界）→
衰减遗忘 → 检索（词面 + 可注入向量）→ 持久化端口。**只读世界事实，绝不直接写世界状态**——
检索结果喂给宿主的 AI，AI 的意图经宿主 Command 通道落地。零运行时依赖。

```bash
npm install && npm test && npm run build
```

## 60 秒上手

```ts
import { MemoryEngine, InMemoryMemoryStorage } from 'world-memory';

const memory = new MemoryEngine({ save: new InMemoryMemoryStorage() });

/* 宿主把世界事实流喂进来（worldBus.on('*') 或 HTTP events 轮询）；
   引擎的 WorldEvent 结构化满足 WorldFact */
worldBus.on('*', (e) => memory.ingestFact(e));   // 感知边界：只有目击者记得

/* 宿主 AI 检索记忆 → 组织建议 → 落成 Command */
const recalls = await memory.recall('guard', 'theft 被偷', { day: currentDay });
// → 建议经 world.executeCommand(...) 落地；本包没有写世界的口子

memory.tickDay(currentDay);  // 衰减 + 遗忘（重要度越高衰得越慢）
memory.spreadRumor(fact, ['barfly'], '听说市场有人被偷了');  // 传闻：置信衰减
```

## 语义要点

- **感知边界（§8）**：`ingestFact` 按 `witnesses` 建目击者记忆（置信 1）；无目击者时 actor 自记。
- **传闻**：`spreadRumor` 以 `rumorConfidence`（缺省 0.6）写入，宿主可给改写文本（细节失真含在文本里）。
- **生命周期**：`tickDay(day)` 线性衰减（重要度越高越慢）、低于 `forgetBelow` 遗忘（保留标记可审计）、
  单 owner 容量上限淘汰。首个 tick 只记水位不衰减。
- **检索加权**：置信 0.4 + 重要度 0.3 + 新近度 0.2（一年窗口）+ 词面命中 0.15/词 + 向量余弦 0.2；
  向量钩子（`embed`）失败静默回词面——渐进增强。
- **持久化**：`MemorySavePort`（load/save/clear）+ `InMemoryMemoryStorage`；快照含序号，
  重启后续接不撞号。

## 与引擎的关系（§16）

独立包、零引擎依赖：引擎不知道 memory 存在。宿主桥接数据流：
`worldBus → ingestFact`（只读）与 `recall → AI → world.executeCommand`（写入只走命令链）。
参照闭环：`examples/second-game/memory-loop.test.ts`（铁与沙）。

天穹（参照宿主）当前使用其原生记忆体系（耦合面审计见 `docs/WORLD-EXTRACTION-BLOCKERS.md` B5）；
通用子系统（lifecycle/propagation/retrieval）的迁入是独立的一刀，不在 0.8 范围。

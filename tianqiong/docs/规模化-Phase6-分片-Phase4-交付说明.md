# 规模化 Phase 6 / 存档分片 / Phase 4 · 交付说明

> 承接 `docs/剩余工作实施方案.md`。三次提交：`576a81d`（Phase 6 + 分片）、`12a0b4a`（Phase 4）、
> `7be905f` / `f64cba2`（真机脚本与收尾）。方案原文的实施顺序按实测成本重排为 **6 → 分片 → 4 → 7**，
> 本文记录落地时的设计与**与原文的逐条偏差**。

## 0. 门禁与证据

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 错 |
| `npm run lint` | 0 错 |
| `npm test` | **892 例 / 58 文件**全绿（改造前 865） |
| `npm run build` | 成功 |

| 附加证据 | 命令 | 结果 |
|---|---|---|
| 分片体积与落盘量 | `node scripts/bench-shards.mjs` | 见 §2.4 |
| 浏览器真机 | `node scripts/verify-shards.mjs <url>`（需 dev 常驻） | **13/13 PASS** |

---

## 1. Phase 6 · 记忆关注度分级

### 1.1 设计

| 层 | 判据 | 周期 | 内容 |
|---|---|---|---|
| L0 相关 | 好感≠0 / 正式见过 / 当天聊过或收过礼 | 每天 | 归并 + 逐条衰减 + 信念 |
| L1 接触过 | 有条目但以上都不成立 | 3 天 | 同上 |
| L2 未接触 | 世界书有名有姓，但本局从未被投影 | 7 天 | **只归并**，不逐条衰减 |

非 NPC 的 owner（势力 / 玩家 / 用例占位）一律 L0：分级只该省「随 NPC 增长的那部分」成本。

「有没有 `NpcDynamic` 条目」就是现成的关联度信号——条目由 `npcDyn()` 惰性建出，
不是世界书预置的，所以「没有条目」精确等于「玩家从未触及」。

### 1.2 与方案原文的偏差（**重要**）

原文 §2.3 写的是「按 owner 的层决定 `day % period === 0` 才处理」。实现改用
**「距上次 ≥ period」+ 随档记账 `WorldState.memTickAt`**，理由：

1. 相位式会让「读档当天」的 owner 白等一整轮（相位落在周期之后）；
2. 刚出现的 owner 要等到下一个整除日才第一次归并——刚结的仇、刚写的记忆会推迟 3～7 天才入账；
3. 周期一改，全体 owner 的处理日集体跳变。

验收数字与原文 §2.4 完全吻合：连续 7 天，L0/L1/L2 分别处理 **7 / 3 / 1** 次。

**代价（照实写）**：L2 不逐条衰减 ⇒ 从未被触及的 NPC 的细碎传闻不会进 `forgotten`，
而是被压缩成摘要。容量仍受 `MEMORY_CAP` 约束（`pruneMemories` 按强度排序，与 status 无关）。

### 1.3 既有用例的处置

两条既有用例（`memory-engine`「日边界 tick 同时做衰减与压缩」、`devlog`「记忆写入与日边界生命周期进 memory 通道」）
的 owner 是世界书 NPC 但本局没被投影 → 落 L2 → 不再衰减。

处置方式是**用规则手段构造场景**（`npcDyn(id, s).met = true` 把 owner 提成 L0）并加前置断言
（`expect(memoryLodOf('lita', s)).not.toBe('L2')`），**没有放宽断言**——按方案 §6 坑 1 的纪律。

---

## 2. 存档分片

### 2.1 通道

`SavePort` 新增可选的两个方法（与 `loadVectors/saveVectors` 同形状）：

```ts
loadShards?(): PortShards | null;
saveShards?(shards: PortShards): void;
```

介质不实现 → `WorldState.save()` 静默退化为整档（内存介质 / 测试桩就走这条，既有 865 例零改动）。

### 2.2 键的划分

| 键 | 内容 |
|---|---|
| `tq2_main_v1` | 主档：player / rep / econ / log / dungeon / … |
| `tq2_npcs_v1` | npcs（含 goal / bag / gold） |
| `tq2_mind_v1` | memories + beliefs |
| `tq2_know_v1` | knowledge + cases |
| `tq2_world_v1` | **旧整档**（迁移前的格式）：留着当回落源，四片全部写成功之后才删 |

主档**刻意不复用 `SAVE_KEY`**：那份旧整档是「介质写了一半（配额写满 / 进程被杀）」时
唯一能回落的完整档，把新主档写回同一个键会在第一次保存时就把它覆盖掉。
「主档里没有 `npcs`」本身就是分片格式的标记（`world/Shards.ts` 的 `isShardedMain`），
不必再加版本位；识别错会把旧档的表清空，所以这个判据有正反两组用例钉住。
`TitleScreen` 的介质切换提示同时认两个键（`tq2_world_v1` / `tq2_main_v1`）。

### 2.3 四条不变量

1. **只写变化过的分片**：脏标记用「上次成功写入的原文」而不是对象引用——
   `mutate` 系列是就地改字段，引用永远不变，拿引用当脏标记会静默漏写。
   判定要算三层：待写队列里的最新值 > **在途批次里的值** > 已落库的值；
   少算「在途」那一层，`await` 窗口里的那次 `saveShards` 会被判成「内容没变」而丢掉。
2. **分片档的完整性判据 = 四个键齐全**：写入方每次都写全四个（空表也写 `'{}'`），
   所以「缺键」精确等于「上一批没写完」。缺片时**回落**到旧整档，
   而不是把缺的那张表 merge 成空表——那不是降级，那是丢数据。
3. **读时兼容旧整档、写时一律新格式**：`loadShards()` 在主档里发现 `npcs` 就返回 null，回落到整档路径。
4. **单分片损坏只归零该表**（hydrate 会再兜一遍），合并后的完整档仍走 `validateState` **唯一闸门**。
   「缺片」与「坏片」是两回事：缺片没有完整档可还原 → 回落；坏片只丢那一张表 → 归零继续。

### 2.4 量化（200 NPC 合成档）

`node scripts/bench-shards.mjs`：

```
整档 JSON            : 8.16 MB
  main（每次必写）   : 0.02 MB
  npcs               : 0.11 MB
  mind（记忆+信念）  : 7.58 MB
  know（感知+案件）  : 0.45 MB

只改主档 : 8.16 MB → 0.02 MB  省 99.8%
只改 npcs: 8.16 MB → 0.11 MB  省 98.6%
只改 mind: 8.16 MB → 7.58 MB  省  7.1%   ← 最坏情况，记忆本身就是那块大头
20 次落盘的操作链（main×12/npcs×5/mind×2/know×1）：163 MB → 16 MB，省 90%
序列化耗时：整档 32.6 ms / 分片 32.0 ms（分片省的是 IO 字节，不是 CPU）
```

操作链的 12/5/2/1 是**假设**（按交互类型估的分布），不是实测统计——请按它读结论。

### 2.5 顺带修掉的真缺陷

`SqliteRepository.flush()` 原先只排空整档队列，分片脏数据会一直留到下一次 `saveShards`——
**退出前最后一次改动等于没落盘**。新用例逮到的。

---

## 3. Phase 4

### 3.1 判据单一源

`systems/npc/Lod.ts` 的 `lodOfNpc` 是「谁算相关」的唯一实现；`MemoryLifecycle` 消费它
（`memoryLodOf` 只是记忆领域的别名）。判据再也不会两处漂移。

### 3.2 为什么其余候选**不做**分频（实测判定）

| 候选 | 结论 | 理由 |
|---|---|---|
| `bondDailyTick` | 不做 | 它遍历 `WB.npcs` 但 `if (!dy) continue`，**本来就只对有条目的 NPC 生效**，分频零收益；且会改 `rng.chance(0.1)` 的调用次数 → 随机流漂移（方案 §6 坑 2 点名的雷），回赠概率与既有用例全都要跟着动 |
| `decayStatusEffects` | 不做 | 「48 刻 = 1 日」是精确语义，分频等于把「中毒三天」变成九天 |
| NPC goal / 钱物 | 不做 | 全仓没有它们的日 tick（grep 确认） |

### 3.3 位置去物化

- 删 `NpcDynamic.curLoc` 与整个 `systems/npc/Autonomy.ts`（`syncOne` / `npcTick`）；
  `npcCurLoc(id, s) = npcAt(id, s)` 挪进 `Npcs.ts`（保留领域语义名）。
- `daySettle` 的顺序表 **14 格 → 13 格**；`subscriptions` 的 npc × `hour_advanced` 订阅撤掉。
- **这不是严格等价重构**：原先 AI 上下文读的是「上一次 tick 时他还在哪」，缓存过期就拿到旧地点；
  现在读到的是此刻。对一个会静默出错的缓存来说，去掉它就是修好它。
- `hour_advanced` 从此**没有订阅者**，但发射端刻意保留：发布端不该因为此刻没人听就停止广播，
  否则下一个消费者又要回来改时钟（`WorldClock` 注释已写明）。

---

## 4. 已知限制 / 未做

1. **Phase 7（L2 聚合）未做，且前提不存在**：全仓没有「批量生成的背景人口」——
   `passerby()` 刻意不建档、`batchGenerate` 只产名字、`people.json` 只有 15 个具名 NPC。
   没有聚合对象就没有消费者，先建 `WorldState.aggregates` 骨架等于幽灵字段。
   需要先做「谁需要个体身份」的产品决策（方案 §5.2 的建议规则可作起点）。
2. **mind 分片的绝对体积未解**：200 × 80 条 → 7.58 MB，仍超 localStorage 单源配额。
   分片解决的是「每次写多少」，不是「单表多大」；解法是记忆分页或裁剪。
3. **Tauri 真壳未手测**：`SqliteRepository` 的分片路径只有单测覆盖（fakeDb），
   真壳写入未验证（承上轮的遗留项）。
4. **Phase 6 对存量档的收益低于目标态**：Phase 4.2 之前每次 `npcTick` 都会给所有 `tier≥1`
   的 NPC 建档，而世界书 15 个 NPC 全部 `tier≥1` → 老档实测分布是 `{L0:0, L1:15, L2:0}`，
   **L2 不会出现**，收益来自 L1 的 3 天周期（约 2/3）而不是 L2 的 7 天。
   新开的档（4.2 之后）没有那次全量建档，L2 才真实存在。`bench-shards.mjs` 的
   `L0=20/L1=30/L2=150` 是**规模化目标态的假设**，不是实测数字。
5. **两个介质对「分片档校验失败」的兜底深度不同**：localStorage 只有分片档一份，
   校验失败即「没有可用存档」；SQLite 在读分片之前还会回落到 `saves` 表的旧整档行
   （过渡期保护）。这是介质能力差异，不是契约冲突，但排查时要知道。
6. `decayTick`（全量衰减）目前只有用例在调；保留它是作为「一次到底」的入口，
   若长期无人使用应删除。`SqliteRepository.save()/drain()` 生产不可达，
   但它正是「分片介质不可用」时的退化目标，**不是**幽灵代码。

## 5. 独立审查与两批修复

用独立审查者（对抗式 prompt：不许复述自评结论、每条 finding 必须附命令输出或行号）
跑了一轮，它自建 vitest 探针打了 8 个边界场景（P1–P8），跑完即删。

**判定为真问题并已修（8 条）**：P1 在途写窗口吞更新、P4 重置世界与失败回填交错、
P5 分片表建不起来时不降级、P7 分频记账残留、I1 分片档完整性 + 回落源被提前删除、
I3 prefetch 失败留脏基准、I4 存量档 LOD 分布与 bench 假设方向相反、M1 `PortShards.main` 类型谎言。
另处置 M2/M3/M4/M5/M6 与测试质量瑕疵（`mutate.npcMet` 原语）。

**判定为「看着可疑但实际安全」**：P3（旧档带 `curLoc` 仍过校验——`checkNpcs` 本就不做未知键检查）、
P8（`LocalSaveRepository` 混用 `save()/saveShards()`——localStorage 同步写，没有 await 窗口）。

**审查者未验证 / 本轮仍未验证**：Tauri 真壳的 sqlite 分片写入；崩溃窗口的实际丢数据；
`memoryDue` 时钟回退的可达性（防御已加）。

## 6. 复跑

```bash
cd tianqiong
npm run typecheck && npm run lint && npm test && npm run build
node scripts/bench-shards.mjs
npm run dev   # 另开一个终端
node scripts/verify-shards.mjs http://127.0.0.1:5273/
```

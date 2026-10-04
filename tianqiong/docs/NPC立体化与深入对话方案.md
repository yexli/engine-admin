# NPC 立体化与深入对话方案

> 目标：124 个 NPC，**每一个**都立得起来、**每一个**都谈得进去。
> 本文只做设计，不含实现。文中所有数字、字段与代码位置均为实测，可直接复核。

---

## 0. 结论先行

**素材已经够了，问题是素材没进对话。**

| 缺口 | 一句话 | 现状代价 |
|---|---|---|
| **G1 人设不进 prompt** | `personaBlock` 只输出 9 个字段，`lore` 七项（身份/外貌/性格/能力/过往/弱点/持有物）**一个字都没进对话 prompt** | NPC 不知道自己的过去与软肋，只能靠头衔与"说话习惯"演 |
| **G2 话题是空壳** | `topics` 只有标签 `{ l, tier }`，玩家点 chip = 把标签当台词发出去 | 327 条话题背后零内容，NPC 无从"对这个话题说点什么" |
| **G3 没有"深"的机制** | 无信任门、无话题层级、无深挖产出；每轮产出只有 `{line, attDelta, mem, rumor}` | 聊十轮与聊一轮的结构完全相同，谈不进第二层 |

**四期落地**：P1 注入（改动最小、收益最大）→ P2 话题卡 → P3 信任门与深挖产出 → P4 124 人全覆盖的数据生产。

---

## 1. 现状实测

### 1.1 名册与数据底盘

| 类别 | 人数 | 位置 | 关键字段 |
|---|---|---|---|
| 街头 NPC | 15 | `src/data/world/people.json` | 有 topics/voice/schedule，**无 `lore`** |
| 档案人物 | 109 | `src/data/npc/<板块>/<id>/npc.json` | `lore` 七项 **109/109 全填**，topics 均 3 条，voice/refuseStyle/goal/rels 全填 |
| 合计 | **124** | `worldBook.npcs`（街头在前、档案在后） | — |

实测填充率（脚本核对，非估计）：

- `lore.identity / appearance / personality / abilities / past / flaw / belongings`：**109 / 109**
- `lore` 七项合计正文：**28.4k 字**（人均约 260 字）
- `topics`：档案侧共 **327 条**，人均 3 条，**全部只有 3–7 字标签**
- `schedule`：**63 / 109 缺失**（另 46 人有）→ 这 63 人在日程外不出现，"立体"缺少出场机会
- `docs/设定源/天穹纪-人物.md`：**145 KB** 原始档案，每人 10 字段（含《现状与目标》《弱点与把柄》完整原文）
- `src/data/lore/lore-person.json`：109 张人物 canon 卡，**每条被截断到 300 字**（min 286 / max 301），懒加载

### 1.2 一次对话实际喂进去的东西（逐行核对）

链路：`dialogue/openDlg` → `Chat.openChat` → `Chat.sendChat` → `Chat.buildCtx` → `AI.chatAsync` → `Chat.applyChat`

```
openaiCompat.ts:291-311  chatAsync 组装的全部内容

system = 你扮演《天穹纪元》中的 NPC：{name}（{title}·{race}）
       + 当前态度 + 台词规范（口语化/60字内/不得编造）
       + personaBlock(npcId)                  ← 见下
       + JSON 输出契约 {line, attDelta, mem, rumor}

user   = 场景{location}(+act) · 对方{玩家名}{职业}
       + 立场{stance} + 人际{rels 前3条} + 记忆{mem 检索 topK 条}
       + 最近交谈{history 6 条} + 玩家本句{input}
```

而 `personaBlock`（`src/ai/persona.ts:22-35`）实际只拼这些：

> 姓名（头衔·种族）· 志向 goal · 关切 interest · 底线 bottomLine · 说话习惯 voice · 优先序 priority · 拒绝方式 refuseStyle

**结论：`identity / appearance / personality / abilities / past / flaw / belongings` 七项，全库 0 条进入对话。**
人物志面板能看到它们，AI 看不到——这就是"每个人都是一个头衔加一句口头禅"的根因。

同时注意 `narrative` 通道**有** canon 注入，但预算只有 **240 字符**、且查询词不含玩家输入：

```
openaiCompat.ts:185
narrative 通道 → loreCanonBlock(matchLore({ area, locName, npcNames }, { max: 5 }), 240)
```

### 1.3 对话的预算天花板（决定了方案的形状）

| 项 | 值 | 出处 |
|---|---|---|
| 场景上限 `npc_dialogue` | **900 token** | `src/data/world/context.json` sceneTokens |
| Profile 上限 | minimal 300 / low 500 / medium 700 / high 900 / maximum 1200 | 同上 profiles |
| 档位矩阵 | worldImportance(0–4) × LOD(L0/L1/L2) | 同上 matrix |
| 字/token | 1.6 | `src/data/world/memory.json` caps |
| 记忆检索 | `npc_dialogue` topK 8；记忆容量 80 条/人 | 同上 retrieval.profiles |

**900 token ≈ 1440 字**。这不是"能不能塞进去"的问题，是"塞什么"的问题——任何注入方案都必须先做预算账本，否则新人设会把记忆检索挤没。

### 1.4 已有的、可以直接接线的资产

| 资产 | 位置 | 对本方案的用途 |
|---|---|---|
| 上下文档位 `resolveBudget(importance, lod, scene)` | `systems/npc/ContextProfile.ts` | 人设分档注入的**唯一预算源**，不另立一套 |
| LOD 分层 | `systems/npc/Lod.ts` | 决定"此刻这个人值多少笔墨" |
| 记忆引擎（检索/信念/传播） | `src/memory/**` | 谈过什么、说到第几层，落进记忆 |
| `matchLore` + PERSON_LORE | `ai/retriever.ts`、`data/lore/*` | 现成的关键词取词器（**但只对地点/NPC名，不带输入文本**） |
| `deepTalkUnlock(npcId)` | `systems/codex/Codex.ts:120` | 深谈解锁图鉴，**已有事件 `lore_unlocked` 通路** |
| 羁绊/亲密度门 `intimacyGate` | `systems/relationship/Bond.ts` | 深度门的现成判据（att + 任务/flag/赠礼/聊天累计） |
| 事件总线分级/幂等 | `events/**` | 深度产出走事件，不新增跨系统 import 边 |

---

## 2. 什么叫"立体"、什么叫"能深入"（可验收定义）

**立体 = 五要素同时成立**，缺一条就打回"路人"：

1. **谁**：身份 + 归属（`lore.identity` / `owner`）— 已有数据 ✅
2. **从哪来**：过往 + 现状与目标（`lore.past` / `goal`）— 已有数据 ✅
3. **裂口**：弱点与把柄（`lore.flaw`）— 已有数据 ✅
4. **怎么说**：voice / priority / refuseStyle / 三档 greet — 已有数据 ✅
5. **此刻**：日程 act + 对玩家态度 + 对他人关系 + 记得什么 — 已有机制 ✅

> 也就是说：**立体的料齐了，链子断了**（1.2 节）。P1 就是把链子接上。

**能深入 = 四问全答"是"**：

| 问 | 当前答案 | 目标答案 |
|---|---|---|
| 能连着问几层？ | 1 层（问什么都是同一池子的话） | **≥3 层**（表层 / 内层 / 深水区） |
| 每层有增量吗？ | 无 | 每层给新事实，不是换措辞 |
| 深处有代价与产出吗？ | 无 | 有：图鉴条目 / 情报 / 关系推进 / 风险 |
| 他知道自己的边界吗？ | 不知道（模型自由发挥） | 明确"不知道 / 不肯说 / 会说假" |

---

## 3. 三条路线对比

| | A 纯数据对话树 | B 纯 LLM 加强 prompt | **C 数据骨架 + AI 措辞（推荐）** |
|---|---|---|---|
| 做法 | 给每人写死问答树 | 把 lore 全塞 prompt，让模型自由发挥 | 数据定"能说什么、什么时候说"，AI 只负责这一轮的措辞 |
| 内容量 | 124 人 × 树，人力爆炸 | 近乎零 | 每人 4–6 张话题卡 |
| 无模型可用 | ✅ | ❌（凭规则池就哑了） | ✅ 规则路径直出 `say` |
| 漂移/编造 | 无 | 高（会编身世、编关系） | 低（素材+边界双重约束） |
| 可复现 | ✅ | ❌ | ✅ 判定在 core |
| 与项目铁律 | 违反"讲述归 AI" | 违反"恒定归引擎 / 降级可用" | **一致** |

推荐 C。理由不是平衡，而是项目的既有铁律已经把答案钉死了：

> 恒定归引擎，讲述归 AI。不配任何模型也能完整通关。
> AI 只出文本与判断，落地过白名单。降级可用。

---

## 4. 设计

### 4.1 P1 · 注入层：让人设真正进入对话

**改动**：`ai/persona.ts` + `ai/openaiCompat.ts` + `data/world/context.json`（+测试）。

**(a) `personaBlock` 分档**

```ts
// 现在：personaBlock(npcId) —— 9 个字段，固定长度
// 改为：personaBlock(npcId, chars?) —— 按字段优先级填充到字数上限
```

字段优先级（先给的先说话，后面的先被裁）：

```
1 identity    身份        —— 判断的立足点，最高优先
2 personality 性格        —— 决定语气与选择
3 flaw        弱点与把柄   —— 能挖的钩子，NPC 自己心里有数
4 past        过往        —— 追问时的增量来源
5 goal/interest/bottomLine/voice/priority/refuseStyle（现状已注入，保留）
6 abilities   能力
7 belongings  持有物
8 appearance  外貌        —— 文字 RPG 里影响最小，排最后
```

额度写进配置（不改代码就能调）：

```jsonc
// src/data/world/context.json 新增
"personaChars": { "minimal": 120, "low": 180, "medium": 240, "high": 320, "maximum": 400 }
```

300 token 的背景路人拿 120 字，maximum 档拿 400 字——**同一个人，LOD 不同，笔墨不同**，与既有分级语言完全一致。

**(b) user 块补两块检索内容**

1. **本场景 canon**：`matchLore` 的查询词**加入玩家本句**（现在只有 area/locName/npcNames）——玩家问"星枢塔"，就该想起星枢塔的设定。
2. **被提及者的公开档案**：输入里出现别的人名时，注入那人的 **seed 一行**（不是 canon）——"你知道赛瑞斯是神殿派首领"，但**不给他完整档案**。这既补了"NPC 眼里的世界"，又天然构成认知边界。

**(c) 预算账本（必须做，否则一定翻车）**

```
npc_dialogue 场景 900 token（≈1440 字）的分配：
  人设锚（personaBlock 分档）      35%    ~500 字
  记忆检索（现 topK 8）            25%    ~360 字
  场景/人物 canon 片段             15%    ~215 字
  立场 + 关系 + 历史 6 轮          20%    ~290 字
  预留（玩家输入 + 契约开销）       5%
```

实现形态：一个纯函数 `chatBudget(profile)` 返回各块字数上限，`buildCtx` 与 `chatAsync` 共用。**超出即截断，不静默丢弃整块**（沿用 `persistentCanon` 的"放不下也硬塞第一条"兜底哲学）。

**P1 验收**：无模型与有模型两条路下，问凯尔"你为什么要扶皇权派"，回答必须能引用他的`past`（三段棋局与提前站队）而不是泛泛而谈。

---

### 4.2 P2 · 话题层：把标签变成内容

**数据结构**（`src/types/world.ts` 扩 `NpcDef`）：

```ts
export interface NpcTopic {
  l: string;                               // 标签（沿用，chip 兼容）
  tier?: 'safe' | 'warm' | 'deep';         // 由两档扩到三档
  /** 表层应答：1–2 句，NPC 口吻；无模型时直出，有模型时作素材 */
  say: string;
  /** 他知道的事实要点（3–5 条短句）。AI 只能在此范围内展开 */
  facts?: string[];
  /** 边界：谈到哪为止、怎么推、撒什么谎 */
  edge?: string;
  /** 追问钩子：玩家可以接着问什么（2–3 条，写成玩家口吻） */
  next?: string[];
  /** 深水区门槛（tier='deep' 时生效） */
  gate?: { att?: number; intimacy?: number; quest?: string; flag?: string; item?: string };
  /** 说透之后的产出 */
  gain?: { mem?: string; loreId?: string; att?: number; rumor?: string; flag?: string };
}
```

**存放位置**：独立文件 `<板块>/<id>/talk.json`，与 `lore-person.json` 同策略**懒加载**。

> 理由（重要）：`npc.json` 走 `import.meta.glob(..., { eager: true })` 打进主包，109 人已约 300 KB；talk 卡按人均 1.5–2 KB 计会再加 **约 200 KB 进首包**。talk 卡只在开对话时用得到，懒加载零代价。

**命中规则（确定性，不掷随机）**：

```
玩家发言 → ① 与 chip 标签精确匹配 → 命中该话题
          ② 否则对 l / facts 关键词做包含匹配（最长优先，同长度按 idx 升序）
          ③ 都不中 → 落现有三档池（行为不变，不报错）
```

**(a) 规则降级同构（这是本期的技术核心）**

`ruleSim.chat` 现在只会吐三档池 + interest/goal 模板。改为：**命中话题 → 出 `say` 或按 depth 出更深的应答；未命中 → 保留现有三档池**。这样"不配模型也能深入"这条铁律在话题层同样成立。

**(b) 追问链：复用 chips，不改冻结的 uispec**

`chips` 已经是 `string[]`，`SheetHost.tsx:158-166` 点击即 `send(text)`。所以：

```
chatChips(id) 的输出从「静态话题标签」升级为「本次可问的下一步」：
  未谈过的话题标签（现状保留）+ 已谈话题的 next 钩子（新增）
```

零 UI 改动就长出"追问链"。深水区未解锁的**不显示**（避免需要给 chip 加锁图标 → 避免动 uispec）。

**(c) 输出契约扩展**（`PluginInterface.ts` `ChatReply`）：

```ts
export interface ChatReply {
  line: string;
  attDelta?: number; mem?: string; rumor?: string;
  /** 新增：本次命中/推进的话题标签（必须命中该 NPC 已有话题，否则 core 丢弃） */
  topic?: string;
  /** 新增：本轮是否把该话题推进了一层 */
  advance?: boolean;
}
```

core 侧 `chatApply` 白名单校验：`topic` 必须命中名册，`advance` 只在"该话题当前层 < 可解锁层"时为真——**AI 不能凭空解锁**。

---

### 4.3 P3 · 深度层：门、层、产出

**(a) 信任门（纯函数，规则层判定，AI 不参与）**

```ts
// systems/npc/Talk.ts（新增，纯判据模块，可进 KERNEL 白名单）
topicGate(npcId, topic, s): 0 | 1 | 2 | 3   // 0=不可谈 1=表层 2=内层 3=深水区
```

| 档 | 条件 | 素材 |
|---|---|---|
| safe | 常在 | `say` |
| warm | att ≥ 45 或 intimacy ≥ 1（沿用现状） | `say` + `facts` |
| deep | att ≥ 70 + `intimacyGate` 满足（任务/flag/赠礼/聊天累计，现成字段） | `facts` + 秘密层 |

**(b) 进展落档**：`NpcDynamic.talkProg?: Record<string, number>`（话题标签 → 已到层数，可选字段 + 老档兜底读 0）。

**约束**：每 NPC 键数 ≤ 8（只记谈过的话题），避免存档膨胀。

**(c) 深挖产出**——全部走**已有通路**，不新增依赖边：

| 产出 | 通路 |
|---|---|
| 图鉴条目 | 既有的 `lore_unlocked` 事件 → `Codex.deepTalkUnlock`（`Chat.ts` 已在发，改成"谈透才发"） |
| 情报/传闻 | 既有 `rumor_spread` 事件 |
| 记忆 | 既有 `memoryEngine.propose`（过验证闸） |
| 关系 | 既有 `adjAtt` + 日封顶（+2/日，全局 +4/日，不动） |

**(d) 代价**：把 `flaw` 级的秘密问出来，应当有反作用——`gain.rumor` 触发扩散、或对当事人 `grudge` 风险上升。**"深"必须伴随代价，否则没有游戏意义**（这是本方案里唯一需要有意识加"痛感"的地方）。

---

### 4.4 P4 · 数据生产：124 人全覆盖

109 人 × (4–6 话题 × say/facts/edge/next) ≈ **1800–2600 条文本**。必须分层生产，不能一刀切。

| 层 | 人数 | 规格 | 生产方式 |
|---|---|---|---|
| 街头 15 人 | 15 | 每人 5–6 话题、2 层深、**并补 `lore` 七项** | 手写（玩家最先遇到，最值钱） |
| wi = 4 / 3 | ~30 | 每人 5–6 话题、3 层深（含秘密层） | AI 起草 + **人工逐条审校** |
| wi = 2 | ~45 | 每人 4 话题、2 层深 | AI 起草 + 抽检 50% |
| wi 0–1 | ~34 | 每人 3 话题（身份/近况/一件私事）、1 层 | 模板 + AI 起草 + 抽检 20% |

**素材来源（不需要从零创作）**：

```
docs/设定源/天穹纪-人物.md   →  10 字段原文（含《现状与目标》《弱点与把柄》）
    ↓ 已有脚本：scripts/gen-npcs-from-md.mjs（生成 npc.json）
    ↓ 新增脚本：scripts/gen-npc-talk.mjs（生成 talk.json 草稿）
talk.json = { 话题标签 ← 从字段蒸馏；say ← 用 voice 风格改写身份/近况；facts ← 过往/能力/持有物；
              edge ← 弱点与把柄的"不愿说"部分；next ← 现状与目标里可被追问的线头 }
```

**关键工程决策**：**AI 起草的产物必须过 schema 测试**（见 §6），并且**只作为草稿落进对话草案目录**，审校后才进 `src/data/npc/`——不能让未经审校的模型文本直接进世界书。

**顺带**：63 人缺 `schedule` 一并补齐（按 `owner` 与 `loc` 推导出"在哪里、什么时候在"，人工确认），否则这 63 人在日程空档里根本不出场，谈不进去。

---

### 4.5 P5（可选）· 可见性

- 人物志面板增加"知情度"：我跟他谈到哪一层、还差什么条件。
- 对话窗口显示"他刚想起了什么"（记忆被命中的那一刻）。
- **注意**：这期要动 `src/types/uispec.ts`（SheetHost 注释称其为冻结类型层），成本另计，故列为可选。

---

## 5. 分期总表

| 期 | 内容 | 主要改动面 | 工作量级 |
|---|---|---|---|
| **P1** | personaBlock 分档 + lore 入 prompt + canon 检索带输入 + 预算账本 | `ai/persona.ts`、`ai/openaiCompat.ts`、`ai/retriever.ts`、`data/world/context.json`、测试 | **S**（半天级，收益最大） |
| **P2** | NpcTopic 契约 + talk.json 懒加载 + 话题命中 + 规则降级 + 追问链 chips + ChatReply 扩展 | `types/world.ts`、`systems/npc/Chat.ts`、`ai/ruleSim.ts`、`ai/openaiCompat.ts`、`data/npc/**` | **M** |
| **P3** | 信任门 + talkProg 落档 + 深挖产出与代价 + 图鉴联动 | `systems/npc/Talk.ts`(新)、`systems/npc/Chat.ts`、`types/world.ts`、`systems/codex/Codex.ts`(接线) | **M** |
| **P4** | 124 人 talk 卡生产 + 生成脚本 + 校验测试 + 街头补 lore + 补 63 人 schedule | `data/npc/**`、`scripts/gen-npc-talk.mjs`(新)、`tests/**` | **L**（数据工程为主） |
| P5 | 可见性（人物志知情度 / uispec 解冻） | `types/uispec.ts`、`ui/panels/*`、`ui/overlays/SheetHost.tsx` | M（可选） |

顺序不可颠倒：**P1 单独就能让对话质量抬一个台阶**，且不依赖任何新数据结构——建议先做 P1 并实测对话效果，再决定 P2/P3 的细节尺度。

---

## 6. 验收与测试

| 层 | 用例 | 断言 |
|---|---|---|
| 数据 schema | `npcArchive.test.ts` 扩展 | 每人 ≥3 话题；`say` 长度 ≤ 80 字；`tier` 合法；`next` ≤3 条；**无遗留 `{槽位}`**；`gate.loreId` 必须能在图鉴里查到 |
| 预算 | 新增 `chatBudget.test.ts` | 各块之和 ≤ 场景上限；三档 profile 下均不超；**放不下时截断而非整块丢弃** |
| 注入 | 新增 `personaInject.test.ts` | `personaBlock` 分档输出符合字数上限；lore 字段按优先级出现；缺字段不崩 |
| 规则降级 | `chat.test.ts` 扩展 | 无 LLM：命中话题 → 出 `say`；连续 3 轮不重句；未命中 → 落三档池 |
| 深度 | 新增 `talk.test.ts` | `topicGate` 边界（att 44/45、intimacy 0/1）；deep 未解锁时不产出；谈透才发 `lore_unlocked` |
| AI 边界 | `chat.test.ts` 扩展 | 越界 `topic` 被 core 丢弃；`attDelta` 仍钳制；失败降级不破窗（F-17 用例保留） |
| 回归 | 既有 ~80 个测试文件 | 全绿 |
| 架构 | `arch-deps.test.ts` | **不新增任何跨系统 import 边**（深度产出走事件总线） |
| 存档 | 新增迁移用例 | 老档无 `talkProg` → 读 0，不报错；`chats` 20 轮封顶不变 |

**量化验收**（P4 完成时）：

- 124/124 人有话题卡，人均 ≥3 话题。
- 每位 wi ≥ 3 的 NPC 至少 1 条可谈到第 3 层的话题。
- 无模型状态下，随便挑 10 个 NPC 各聊 5 轮：不重句、能就自己的话题给出 ≥2 条不同内容。
- 对话 prompt 的实际字数在 900 token 预算内（打点记录，超预算即算失败）。

---

## 7. 风险与红线

| 风险 | 触发条件 | 对策 |
|---|---|---|
| **预算挤压记忆** | 人设塞满 1440 字，记忆检索被挤没 | §4.1(c) 预算账本，记忆占比硬性保留 25% |
| **模型编造身世/关系** | prompt 给了素材但没给边界 | `facts` 白名单 + `edge` 边界声明 + `topic` 越界丢弃；system 明确"没有依据就说不知道" |
| **主包膨胀** | talk 卡内联进 `npc.json`（eager glob） | 独立 `talk.json` **懒加载**（已有 `lore-person` 先例） |
| **存档膨胀** | `talkProg` 无上限 | 每人 ≤8 键；只记谈过的话题；可选字段，老档兜底 |
| **确定性破坏** | 话题命中引入 `rng` | 命中规则纯字符串匹配，**零 rng 消耗**（项目曾因"每事件每人抽一次"导致数值随人数漂移） |
| **架构门禁** | 想直接在 `Chat` 里 import `Codex` | 不新增边：继续走 `worldBus` 的 `lore_unlocked`；`Talk.ts` 若被多方消费再考虑进 KERNEL 白名单 |
| **uispec 冻结** | 想给 chip 加锁定图标 | P2 只显示"当前可问"的；解锁条件靠内容暗示，P5 再解冻类型层 |
| **内容质量失控** | AI 批量起草直接入世界书 | 草稿与正式数据目录分离；schema 测试 + 人工抽检后才合并 |
| **降级路径失配** | 只改 `chatAsync` 忘了 `ruleSim.chat` | P2 明确要求两条路同构；测试对两条路分别断言 |

---

## 8. 需要裁决的四件事

1. **talk 卡放哪**：独立 `talk.json` 懒加载（推荐）／内联 `npc.json`（简单但首包 +200 KB）。
2. **街头 15 人是否补 `lore`**：他们没档案字段，需要手写。玩家最先接触的是他们（酒馆老板娘、报童、铁匠），收益高但纯手写。
3. **深水区要不要带代价**：问出 `flaw` 级秘密 → 触发传闻扩散/关系风险（有痛感，更像人）／纯粹奖励（更友好）。
4. **生产顺序**：先精写 30 个高重要度 NPC 验证手感（推荐）／先给 124 人铺 3 话题骨架再逐层加深。

---

## 附录 · 代码位置对照表

| 内容 | 位置 |
|---|---|
| 人设锚组装（P1 主改动） | `src/ai/persona.ts:22-35` |
| 对话 prompt 组装（P1/P2 主改动） | `src/ai/openaiCompat.ts:291-331` |
| 规则降级对话池（P2 主改动） | `src/ai/ruleSim.ts:81-93` |
| canon 检索层 | `src/ai/retriever.ts`（`matchLore` / `loreCanonBlock`） |
| 会话引擎（话题/门禁/后果收敛） | `src/systems/npc/Chat.ts`（`chatChips` / `buildCtx` / `sendChat` / `applyChat`） |
| 上下文档位与预算 | `src/systems/npc/ContextProfile.ts` + `src/data/world/context.json` |
| LOD 判据 | `src/systems/npc/Lod.ts` |
| 记忆配置与容量 | `src/data/world/memory.json` |
| NPC 类型定义 | `src/types/world.ts`（`NpcLore` / `NpcDef` / `NpcDynamic`） |
| 对话端口契约 | `src/plugins/PluginInterface.ts:65-93` |
| 档案数据（109） | `src/data/npc/<板块>/<id>/npc.json` |
| 街头数据（15） | `src/data/world/people.json` |
| 人物志 canon（截断 300 字 · 懒加载） | `src/data/lore/lore-person.json` + `src/data/lore.ts` |
| 原始档案（10 字段全文 · 145 KB） | `docs/设定源/天穹纪-人物.md` |
| 深谈解锁图鉴 | `src/systems/codex/Codex.ts:120`（`deepTalkUnlock`） |
| 羁绊与亲密度门 | `src/systems/relationship/Bond.ts` |
| 聊天窗口 UI（chips / 输入） | `src/ui/overlays/SheetHost.tsx:106-183` |
| UI 描述符（冻结类型层） | `src/types/uispec.ts`（`ChatSheet` / `chatSend`） |
| 依赖冻结门禁 | `src/tests/arch-deps.test.ts` |

---

*本文为设计稿：P1 可直接开工；P2–P4 待 §8 四件事裁决后细化到卡片级。*

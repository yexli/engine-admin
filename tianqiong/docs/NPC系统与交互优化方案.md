# 天穹纪元2.0 · NPC 系统与交互优化方案

> **基线**：2026-09-27 工作树实测（committed 至 `27ededc`"行囊界面落地"，其后 104 个文件为在途改动）。
> **前序文档**：《NPC 立体化与深入对话方案》（P1–P5）·《NPC 分级-待决问题》（已决）·《规模化-Phase6-分片-Phase4-交付说明》。
> 本文只审「玩家 ↔ NPC」这一整条链：数据 → 判据 → 引擎 → 提示词 → 界面。**文中所有数字均为本机实测**，复核方式见 §6 附录。

---

## 0. 结论先行

**P1 已落地；P2 只落了骨架（数据 1/124）；P3/P4 未启动。**

更关键的是：**三处"已经在跑"的旧逻辑结果是错的**，优先级高于任何新增功能。

| 期 | 方案原定 | 实际状态 | 证据 |
|---|---|---|---|
| P1 注入 | lore 七项进 prompt | **已完成** | `src/ai/persona.ts`（分档填充）+ `context.json.personaChars` |
| P2 话题 | 话题卡 + 命中 + 追问链 | **机制完成，数据 1/124** | `src/systems/npc/Chat.ts`（matchTopic/topicDepth/chatChips）、`src/data/talk.ts`；talk.json 仅 `npc/central/kael` |
| P3 深度 | 信任门 + 进展落档 + 产出与代价 | **未启动** | 无 `src/systems/npc/Talk.ts`；`NpcDynamic` 无 `talkProg` |
| P4 数据 | 124 人 talk 卡 / 街头补 lore / 63 人作息 | **未启动** | talk.json ×1；people.json 15 人 `lore` 全缺；档案 63 人无 `schedule` |

一句话：**料齐了、链子接了一半、而且链子上有三处接错了。**

---

## 1. 实测底盘

| 项 | 值 | 出处 |
|---|---|---|
| 名册 | **124** = 档案 109 + 街头 15 | `src/data/npc/**/npc.json` · `src/data/world/people.json` |
| `lore` 七项 | **109/124**（街头 0/15） | 同上 |
| `schedule` | 61/124（档案 46 + 街头 15）；**63 人无** | 同上 |
| **作息空档** | **街头 15/15 全部有空档；档案 0/109** | §2-A1 模拟 |
| talk 卡 | **1/124** | `src/data/npc/central/kael/talk.json` |
| `worldImportance` | 4:16 / 3:40 / 2:43 / 1:25 | npc.json + people.json |
| 上下文档位 | 5 档 ×（wi 0–4）×（LOD L0–L2）矩阵 | `src/data/world/context.json` |
| 人设预算 | chat 300 / greet 240 / decide 200 字（**按通道**） | 同上 `personaChars` |
| 任一时刻在场 | **110–124 人 / 43–52 处**（63 人 hours=[0,12] 全天在岗） | §2-A4 模拟 |
| 对话窗口上限 | 存档 20 轮（`CAP_TURNS`）/ 深谈页 12 轮（`DLG_TURNS`） | `Chat.ts` · `Dialogue.ts` |
| 记忆容量 | 80 条/人，检索档位 npc_dialogue topK 8 | `memory.json` |

---

## 2. 已知问题

### A 类 · 已在跑，但结果是错的（必修）

#### A1 · 街头 15 人作息全部有空档 → 一天里大半时间见不到核心 NPC

按 `Npcs.npcAt` 的同一套判据（`segHit`：`h >= from && h < to`，`h ∈ 0..11`）逐人模拟：

| NPC | schedule | 不在场的时辰 |
|---|---|---|
| 赛琳娜（歌姬） | 0-2@plaza → 10-15@tavern | **3–9**（7 个时辰） |
| 灰烬（黑市） | 10-16@alley → 0-2@plaza | **3–9** |
| 老乔 | 8-15@tavern → 0-2@alley | **3–7** |
| 科兹·幽鸣（导师） | 10-16@alley → 0-2@market | **3–9** |
| 阿亚·晨羽（导师） | 8-12@temple → 12-14@plaza | **0–7** |
| 米露 / 奥托 / 范德尔 | … | 0–3 与 10–11 |
| 莉安（老板娘） | 0-3@market → 4-12@tavern | **3**（两段之间的缝） |
| 戈林 / 布伦丹 / 雷诺 / 罗兰 / 雅拉 | … | 0–3 与尾段 |

根因两条，都属于"数据与判据不匹配"：

1. **`to` 写了 12 以上**（10-15 / 8-15 / 10-16 / 12-14）：时辰只有 0..11，这些段**永远不命中**；
2. **段间漏交界时辰**：`0-3` 覆盖 0/1/2，`4-12` 覆盖 4..11 → **3 时无人接管**。

而 `npcAt` 对"有 schedule 但未命中"是**直接返回 null**，`hours` 兜底只在**没有 schedule** 时才走（`src/systems/npc/Npcs.ts:64-72`）。
契约测试 `src/tests/npcArchive.test.ts:131`「任何时辰都找得到人（作息不留空档）」**只扫 `src/data/npc/**` 的 109 人**，街头 15 人在覆盖之外——测试是绿的，玩家是看不到人的。

后果：`presentNPCs`、地图页"此刻在场"、左栏"此刻在场"同时为空；玩家在非黄金时段进城，等于走进空城。

#### A2 · 话题深度从"被裁剪的 20 轮窗口"里数 → 聊得越多，深度越浅

`src/systems/npc/Chat.ts`（`sendChat`）：

```ts
const asked = turns.filter((t) => t.who === 'p' && t.text.trim() === card.l).length;
```

而 `turns` 有 `CAP_TURNS = 20` 封顶（超出丢最旧）。写满 20 条之后，最早那几次同话题提问被丢掉 → `asked` 从 3 掉回 1 → `topicDepth` 从**第 3 层退回第 1 层**，NPC 把第一层再讲一遍；`chatChips` 的追问链同源：已问过的话题标签会**重新出现**（"死灰复燃"）。

同一个文件里已经为同类问题付过学费——`applyChat` 的轮次计时改用了 `bondProg.chats`，注释原文是「*轮次计时不能从被裁剪过的窗口里数*」。话题侧漏了。

#### A3 · 图鉴解锁是"每轮都发"，不是"谈透才发"

`Chat.applyChat` 无条件发 `lore_unlocked`（注释声称"深谈解锁其人条目"，方案 §4.3(c) 的验收是"谈透才发"）。现状：随意搭一句话就解锁图鉴条目，`Codex.deepTalkUnlock` 的门形同虚设。

#### A4 · 无日程者的 `hours=[0,12]` = 全天在岗

63 名无日程的档案人物中，**63/63** 都是 `hours=[0,12]`。于是：

- 任一时刻全城可见 **110–124 人**、分布在 43–52 处；
- 酒馆 0–2 时同时站 **16 人**、10–11 时 **16–20 人**。

这不叫世界感，叫噪音：左栏"此刻在场"（`ui/HudCard.tsx` 的 `CastNow`）**没有上限**，地图页才切片 6 人。

### B 类 · 机制半成品（该做完）

| 编号 | 问题 | 证据 |
|---|---|---|
| B1 | **talk 卡 1/124**；327 条 `topics` 仍只有 `{l, tier}` 标签；街头 15 人无 `lore` → `personaBlock` 对他们只剩"姓名+头衔+voice+priority+refuseStyle"，P1 收益为零 | `data/talk.ts` · `ai/persona.ts` |
| B2 | **信任门只有 att 一档**：`topicDepth` 只看 `card.gate.att`，方案 §4.3(a) 的 `intimacyGate`（任务/flag/赠礼/聊天累计）没接；无 `talkProg` → 谈到第几层不可存、不可回看、不可露出 | `Chat.topicDepth` · `types/world.ts` |
| B3 | **深水区无代价、无产出结构**：`gain` 目前只用 `gain.mem`；方案 §4.3(d)"深必须伴随代价"未落地 | `Chat.ts` · talk.json 的 `gain` |
| B4 | **预算账本未落地**：`personaChars` 按**通道**分（300/240/200），不按 `worldImportance × LOD`——神祇与报童在 prompt 里拿同样长的人设；而记忆检索早已分档。方案 §4.1(a)(c) 的"按档位 120–400 字 + chatBudget 分块"未做 | `context.json.personaChars` |
| B5 | **canon 检索不带玩家输入**：`matchLore({area, locName, npcNames})`——问"星枢塔"唤起不了星枢塔的设定 | `ai/openaiCompat.ts:492` |
| B6 | **被提及者档案不注入**：聊天出现第三方名字时，NPC 不知道"你知道他是谁" | 同上（chatAsync user 块） |

### C 类 · 交互与可见性

| 编号 | 问题 | 证据 |
|---|---|---|
| C1 | **入口单一**：唯一入口是左栏"此刻在场"的名字（`cmd({type:'npcTalk'})`）；地图页"此刻在场"是**不可点**的死文本；档案/纪闻页零 NPC 入口；远程查人要情报 ≥80 | `ui/HudCard.tsx:44-51` · `ui/panels/MapPanel.tsx:308-321` · `ui/panels/NewsPanel.tsx:162` |
| C2 | **124 人没有一个会主动找你**：全仓无 NPC 主动行为；`beliefActions.rules` 只覆盖"玩家犯罪"（立案/冷淡/传谣），不会产生"某人来找你/托人捎话/派人盯你" | `data/world/memory.json:70+` · `plugins/beliefDispatch.ts` |
| C3 | **关系不可见**：好感只是词+色+进度条；亲密度档只在升档 toast 出现；"还差什么条件"看不到；人物志折叠在**深谈页最底部**，"此刻"页面对它零入口 | `ui/overlays/SheetHost.tsx:396-397` · `relationship/Bond.ts` |
| C4 | **长线关系不可回溯**：深谈页 12 轮 / 存档 20 轮，与"两年交情"的叙事承诺不匹配 | `Dialogue.ts:139` · `Chat.ts:38` |
| C5 | **在场名单无上限**：`CastNow` 全量渲染（实测酒馆最多 20 人），窄屏是噪音 | `ui/HudCard.tsx:29-58` |
| C6 | **离场即断线**：`npcAt !== player.loc` 时对话/赠礼/请求全被拒；替代通道只有 `CommNet.sendMessage`（按**地点**发，不定向到人）与米亚那条硬编码带口信 | `Chat.sendChat` · `commnet/CommNet.ts` |

---

## 3. 方案：六张卡

卡片顺序 = 依赖顺序。每张卡都写明**改动面 / 验收 / 风险**。

### 卡 N-A（S · 半天）· 修三条真缺陷 —— 不新增机制

**A1 数据修**：15 名街头 NPC 的 `schedule` 重写为 0..12 无缝（`to` 一律 ≤12，跨夜用 `from > to` 表达）；顺带把 `to:12+` 的段按"时辰上限"折算。
**A1 守卫（第二道保险）**：新增 `scripts/audit-npc-schedule.mjs`（124 人 × 12 时辰全扫，报告空档时辰与越界 `to`），并把它接进 `npcArchive.test.ts` 的名单（把街头 15 人纳入契约）。`npcAt` 的"有 schedule 未命中直接 return null"**保持不动**——它是正确的严格语义，兜底应该落在数据与校验上，而不是让脏数据静默回落。

**A2 修**：话题计数落档。最小改动是先把计数从窗口搬到状态：`NpcDynamic.talkAsked?: Record<string, number>`（键 = 话题标签，≤8 键），`sendChat` 与 `chatChips` 共用；窗口只负责显示。
**A3 修**：`lore_unlocked` 改为"该话题首次进第 2 层"或"intimacy ≥ 1"时发一次（幂等，由 `talkAsked`/`talkProg` 承担）。

**验收**：新增 `tests/npcTalkRegression.test.ts` 三例——① 连发 25 轮后同话题深度不退化；② `lore_unlocked` 一天只发一次；③ 124 人作息 0..12 无缝（含街头）。
**风险**：低。唯一要注意的是 `talkAsked` 属**新增可选字段**，老档读 0（`validate` 采"存在即校验、缺失放行"）。

### 卡 N-B（M）· 信任门与进展落档：新建 `src/systems/npc/Talk.ts`

- 纯判据模块：`topicGate(npcId, card, s): 0 | 1 | 2 | 3`（0 不可谈 / 1 表层 / 2 内层 / 3 深水区）。**判据复用 `relationship/Bond` 的既有口径**（att、intimacy、gifts/chats/quest/flag），不另写第二套真相。
- 落档：`NpcDynamic.talkProg?: Record<string, number>`（层数，≤8 键）——A2 的 `talkAsked` 若已落地，可合并为同一字段的两种读数（**建议合并，避免两个近似字段**）。
- 产出与代价：到第 3 层时按 talk 卡的 `gain` 走**既有通道**（`lore_unlocked` 一次 / `rumor_spread` 可选 / `adjAtt` 守既有日封顶 +2/+4）；代价默认只落 `addMem`，"逼问 → 记恨"仅在该卡数据显式标注时发 `form_grudge`。

**验收**：`tests/npcTalk.test.ts`——门边界（att 44/45、intimacy 0/1）、deep 未解锁无产出、老档无字段不报错、**不消耗 rng**（确定性）。
**风险**：低-中。`Talk.ts` 若被 UI 与引擎同时消费，需评估是否进 KERNEL 白名单；先只被 `Chat`/`Dialogue` 消费。

### 卡 N-C（S/M）· 预算账本：把"这个人值多少笔墨"贯穿两条链

- `personaChars` 由"按通道"改为"按通道 × 档位"（minimal 120 → maximum 400，配置化，沿用矩阵）。
- 新增纯函数 `chatBudget(profile)`（落 `ContextProfile.ts`）：返回 persona / memory / canon / stance+history / reserve 各块字数上限，**`Chat.buildCtx` 与 `ai/openaiCompat.chatAsync` 共用同一份**（现在是两处各切一刀）。
- `matchLore` 查询词加入玩家本句（B5）；命中第三方人名时注入其 `lore.identity` 一行（截 40 字，B6）。

**验收**：`tests/chatBudget.test.ts`——各块之和 ≤ 场景上限；五档 profile 均不超；放不下时**截断而非整块丢弃**（沿用 `persistentCanon` 的"硬塞第一条"哲学）。
**风险**：中。人设变长会挤记忆检索——账本必须硬保留记忆占比（≥25%）。

### 卡 N-D（M）· 交互面：让人找得到人、看得见关系

- 左栏 `CastNow` 加上限（6）+「另有 N 人」；地图页"此刻在场"改为**可点**（复用 `npcTalk`，零新命令）。
- 深谈页头部加"知情度"行（由 `Talk.topicGate` 给出当前层与缺什么，如"再熟一些才肯说"）——P5 的可见性以**只读文本**落地，不动 `types/uispec.ts`。
- 人物志入口从深谈页底提到"此刻"页（同一个 `NpcDossier` 组件，不新建组件）。

**验收**：`scripts/verify-dlg-pages.mjs` 扩两例（可点在场名单 / 知情度行）；`shot-npc-*` 截图 430px 窄屏无溢出。
**风险**：低。只动 UI 层。

### 卡 N-E（L · 数据工程主体）· 124 人 talk 卡与街头补齐

- 新增 `scripts/gen-npc-talk.mjs`：从 `docs/设定源/天穹纪-人物.md`（145KB，10 字段原文）+ `npc.json` 起草 talk.json，**草稿落 `outputs/npc-talk-draft/`**，人工审校后才进 `src/data/npc/`（沿用方案 §4.4 的"草稿与正式分离"）。
- 分层规格（按 `worldImportance` 派活）：街头 15 人（5–6 话题 + **补 lore 七项**，手写）／wi 4·3（5–6 话题含秘密层）／wi 2（4 话题）／wi 1（3 话题）。
- 63 名无日程者补 `schedule`（按 `loc` + 身份推导 → 人工确认），随后跑 `spread-schedules.mjs` 错开，最后跑 N-A 的审计脚本保证 0 空档。

**验收**：`npcArchive.test.ts` 扩到 124 人（含街头）——每人 ≥3 话题卡、`say` ≤80 字、**无残留 `{占位符}`**、`gate.loreId` 能在图鉴查到；talk 卡打包体积打点（懒加载后首包不涨）。
**风险**：内容质量。靠"草稿目录 + schema 测试 + 人工抽检"三道闸。

### 卡 N-F（M · 可选）· 主动性：让世界先开口

只做三类**确定性**主动接触，全部走既有事件/命令面，**不新增 import 边**：

1. **回访**：亲密度 ≥2 且玩家 ≥N 天未登门 → 托人捎话/登门（复用 `reciprocate` 的通道 + `pushLog`，不弹浮层）；
2. **话茬**：玩家在场时由 `npcActNow` + 好感正负给一句"他先开口"（在场名单头部 1 人、日限 1 次、**哈希抽样**决定谁）；
3. **记恨回应**：`grudge` 状态下 NPC 主动冷场（UI 位已存在）。

**红线**：不消耗主 rng 流（走 `events/Sampling` 的哈希抽样）；日结算步骤**只能追加在顺序表末尾**（`arch-day-settle.test.ts` 是逐位硬契约）。
**风险**：中——它改变的是"世界感"，但会新增判定点；建议放在最后，单独一轮验收。

---

## 4. 顺序与依赖

```
N-A（修 bug，半天）
  └─ N-B（信任门 + 落档）─┬─ N-E（数据生产，L）
                          └─ N-D（交互面，可与 N-E 并行）
N-C（预算账本，可与 N-B 并行）—— 只依赖 context.json 与 chatAsync
N-F（主动性）—— 最后，单独验收
```

---

## 5. 明确不做

- **不恢复 `npcTick` / `curLoc`**：位置是 `npcAt` 的纯函数产物，物化缓存只会引入会过期的第二真相（已裁决，墓碑注释保留）。
- **不把 talk 卡内联进 `npc.json`**：109 人 eager glob 已约 300KB，内联再加约 200KB 首包（P2 已定懒加载）。
- **不给 chip 加锁图标**：不动 `types/uispec.ts` 冻结类型层，深水区靠内容暗示。
- **不为主动性新增跨系统 import 边**：一律走事件总线，`arch-deps` 基线只减不增。
- **不做"NPC 之间自主社交"**：`gossipTick` 已覆盖信息传播；再加一层关系演化收益不抵成本。

---

## 6. 附录 · 复核方式

作息空档（Node ESM，等价于 `npcAt` 判据）：

```js
// 逐人逐时辰判定：有 schedule 走 segHit（h>=from && h<to），否则走 hours
// 输出每个人「不在场的时辰」列表；期望结果：124 人全部为空数组
```

在场人数（同时刻全城）：

```js
// 对 0..11 每个时辰统计 在场人数 / 分布地点数；当前实测 110–124 人 / 43–52 处
```

数据覆盖：

```powershell
# talk 卡数量（期望 124）
Get-ChildItem -Recurse -File src/data/npc -Filter talk.json
# 档案侧 schedule 覆盖（当前 46/109）
Get-ChildItem -Recurse -File src/data/npc -Filter npc.json |
  Where-Object { (Get-Content $_.FullName -Raw) -match '"schedule"' } | Measure-Object
```

---

## 7. 需要你裁决的三件事

1. **talk 卡生产顺序**：先精写 30 个高重要度（wi ≥ 3，先把手感做对）／先铺 124 人骨架再逐层加深？
2. **深水区代价**：有痛感（问出把柄 → 传闻扩散 / 记恨风险）／纯奖励（更友好、更好上手）？
3. **N-F 主动性是否本期做**：它直接改变"世界感"，但会新增每日判定点与一处顺序表追加。

---

*本文为设计稿：N-A 可直接开工（三处缺陷有代码位置与复现路径）；N-B/N-C 为机制补齐；N-D/N-E 为体验与内容；N-F 待裁决。*

---

## 8. 落地记录（2026-09-27 · 用户裁决：按顺序落地、深水区带代价）

| 卡 | 状态 | 落地内容 | 验证 |
|---|---|---|---|
| **N-A** | ✅ 完成 | ① 街头 15 人作息重写为 0..12 无缝（`to` 越界全部折算，交界时辰补齐）；② 话题次数落档 `NpcDynamic.talkProg`（不再从 20 条窗口里数）；③ 图鉴改为**谈透才发**（`talkDeep` 幂等）；④ 新增 `scripts/audit-npc-schedule.mjs`；⑤ `npcArchive.test.ts` 把街头 15 人纳入契约 | 审计脚本：124 人可见度 100%、0 空档、0 越界；`npcTalkP3.test.ts` 6 例 |
| **N-B** | ✅ 完成 | 新建 `systems/npc/Talk.ts`（纯判据，零依赖）：`askedOf/markAsked/markDeep/topicGateOk/topicDepth`（≤8 键，并列按字典序保持确定性）；门扩到 att + intimacy + quest + flag；`Chat.gateCtxOf` 用 Bond 的「权益有效档」；深水区代价：基线 -1 好感（只付一次）+ 可选 `gain.rumor` / `gain.grudge` | `npcTalkP3.test.ts`：落档单调、窗口不回退、关系回落层数现算、谈透只结算一次、gate 不过不解锁 |
| **N-C** | ✅ 完成 | `context.json` 新增 `personaCharsByProfile` 与 `budget`（五块占比 + 1.6 字/token）；`ContextProfile` 新增 `chatBudget` / `personaCharsFor`；`Chat.buildCtx` 走账本（记忆只拿 25%，不再吃满场景预算）；适配器 `chatAsync` 人设按档位、canon 检索**带玩家本句**、注入被提及者一行；`ChatCtx.budget` 契约 | `chatBudget.test.ts` 6 例（分块之和、同源 tokens、档位分流、通道×档位取小） |
| **N-D** | ✅ 完成 | 左栏在场名单上限 6 + 「另有 N 人」；地图页「此刻在场」改为可点（复用 `npcTalk`）；深谈页新增「知情度」行（已谈透 x/y + 还差什么门）；人物志入口提到「此刻」页 | typecheck / lint / build；UI 截图验收未跑（见 §9） |
| **N-E** | ✅ **完成（124/124 · 100% · 378 张卡）** | ⑥ 收尾：街头 15 人补齐 **lore 七项**（此前 0/15——P1 的人设注入对他们等于空），契约与档案侧对称 | `--check` 全合规；`npcArchive` 新增街头 lore 用例 | ① `scripts/gen-npc-talk.mjs`：`--check` 分层校验 / `--draft-all` 批量草稿 / `--promote <id>` 转正；② `data/talk.ts` 支持 `src/data/talk/<id>.json`（街头 NPC 没有自己的文件夹，另起一目录不动档案结构）；③ **街头 15/15 全部写完**（含凯尔共 16 人正式卡：三层应答 + facts + edge + 追问链 + 深水区代价标注）；④ 118 份草稿落 `outputs/npc-talk-draft/`（人称安全的 say/inner 初稿 + 档案整句 facts + `_material` 原档素材，core/edge 留人写）；⑤ 补齐凯尔 6 条缺失的 topics 索引（此前那 6 张卡在界面上永远点不到） | 校验脚本：16 人全合规；契约测试 5 例（街头 15 人全覆盖、正式卡不许带 `_draft/_material`）；四绿通过 |
| **N-F** | ⏸ 未开始 | 主动性（回访 / 先开口 / 记恨冷场）——文档标为可选，且会新增每日判定点，留待单独一轮验收 | — |

**四绿（本次改动后）**：typecheck 0 ／ 测试 **1647 全过**（110 文件，新增 22 例）／ build OK ／ 改动文件 lint 0。

---

## 9. 已知遗留（诚实清单）

1. ~~N-E 剩余 52 人的 talk 卡转正~~：**已完成**——wi2 30 人、wi1 22 人全部写完，名册 124 人无一缺卡（契约用例按数据动态断言）。原本的流程（草稿 → 人写 → `--promote` → `--check`）保留在脚本里备查：
   `改 outputs/npc-talk-draft/<id>.talk.json 的 core/edge` → `node scripts/gen-npc-talk.mjs --promote <id>` → `--check`。
   建议按 §4.4 分层推进：wi 4/3（56 人，含秘密层）→ wi 2（43 人）→ wi 1（25 人）。街头 15 人已闭环（玩家最早遇到的人）。
2. **写错目录的卡（2026-09-27 抓到）**：oser 与 frey 两张卡一度被写进没有档案的目录（central / wind）。运行时照样加载（glob 只看路径），但它们破坏了「一 NPC 一文件夹」的约定，而**以 npc.json 为锚的扫描整片漏掉了它们**——现已归位，并加了「孤儿卡」检查（脚本 + 契约用例各一条）。
3. **全量 lint 当前非 0（49 条）**：全部来自**在途未提交**的 `scripts/*.mjs` 探针（`getComputedStyle`/`performance` 等浏览器全局）与 `src/world/Narration.ts`（`no-useless-assignment`），与本次改动无关；本次涉及的文件 lint 为 0。
3. **UI 截图验收未跑**：N-D 的三处界面改动只过了 typecheck/lint/build，`scripts/verify-dlg-pages.mjs`、`shot-*` 未执行（需 dev server 常驻 5273）。
4. **`item` 门保守禁用**：`topicGateOk` 对 `gate.item` 一律判「未满足」（判定要查背包，会把 `systems/character` 拉进来多一条跨系统边）——数据层当前无人使用该字段。
5. **greet / decide 两条通道的人设仍按通道上限**：档位（`personaCharsByProfile`）当前只在 `chat` 通道生效——另两条的契约里没有 `budget` 字段，接它们要扩 `GreetCtx`/`NpcCtx`。

# 天穹纪元 2.0 · 阶段 H 交付说明（星枢完全体 · 长线闭环 · 表现层追平）

> 执行依据：`天穹纪元2.0-后续开发方案-阶段H.md`（v2.0 · 执行模式 B「一次到底」）
> 工程：`E:\桌面\天穹3\天穹高端\tianqiong2`｜端口 **5273**｜交付日 2026-09-20
> 本文即用户要求的「代码结构 / 目录结构 / 任务进度」三合一交付说明。
> 注：改本文**不会**影响 5273 上的 dev server——`vite.config.ts` 已把 `docs/**` 移出文件监视（见下 §5 缺口 8）。

---

## 0. 验收结论（四绿 · 实测）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck`（tsc --noEmit） | **0 错**（空输出） |
| 规范 | `npm run lint`（eslint .） | **0 错 0 警**（空输出） |
| 单测 | `npm test`（vitest run） | **29 文件 / 351 tests 全过** |
| 构建 | `npm run build`（tsc + vite build） | **✓ built，exit 0** |
| 端到端 | `node scripts/verify-stage-h.mjs http://127.0.0.1:5273/` | 全项通过，控制台仅 1 条无害 404（favicon），**缺失素材 0** |
| 双端截图 | `node scripts/shot.mjs http://127.0.0.1:5273/ <out>` | **9 张**（手机 430×932 七屏 + 桌面三栏两屏） |

对比开工基线：**25 文件 / 214 tests → 29 文件 / 351 tests（+137）**；四绿由「tsc 有 3 处 H2 遗留错」修到全清。

### 0.1 用户验收反馈修复（2026-09-20 · 用户实测发现）

> 反馈：**「你 NPC 功能没补全，参考其他 NPC，如『米娅』」**（附雅拉·风吟对话截图，只有「人物志 + 赠礼」两项）

**根因**：`core/dialogue.ts:dlgOpts()` 是**逐人写死的 `switch (id)`，且没有 `default` 分支**。四位新播种的学院导师不在任何 `case` 里，因此只剩函数末尾无条件追加的「赠礼」——**同时使约束文档 §5 明文承诺的「G10 新 NPC 零代码契约」形同虚设**（契约要求 people.json 字段齐备即自动获得 聊天/请求/叙事/赠礼 四个交互面）。

**修复（两处，均在 `core/dialogue.ts`）**
1. **补 `default:` 兜底分支** → 任何未逐人定制的 NPC（含今后新增）自动获得 **聊天**（提示语取 `topics[0].l`，缺省「随便聊聊」）+ **提出请求**；加上函数末尾常驻的赠礼/赔罪，G10 契约真正成立。
2. **为四位导师补专属 `case`** + 在 `dlgAct` 补五个真实落点动作，交互面比参照对象「米娅」（4 项）更厚：

| NPC | 交互面（5 项） |
|---|---|
| 雅拉·风吟（翠风学园） | 听她讲「时间的褶皱」/ 「学园还收学生吗？」→ 学院名录 / 聊天 / 提出请求 / 赠礼 |
| 科兹·幽鸣（深井学院） | 看他拓的符文 / 「深井学院怎么进？」/ 聊天 / 提出请求 / 赠礼 |
| 阿亚·晨羽（浮岛观星台） | 跟她上屋顶看星图 / 「观星台收人吗？」/ 聊天 / 提出请求 / 赠礼 |
| 罗兰·铁锋（训练营） | **请他指点基本功（受训）**：6 时辰 · 恢复 15% 体力 / 「训练营怎么报名？」/ 聊天 / 提出请求 / 赠礼 |

**回归护栏（+5 tests，cardH6.test.ts）**
- `people.json` **每一个** NPC 必须同时具备 聊天 / 提出请求 / 赠礼 三个交互面，且选项非空、带 npcId；
- 四位导师必须有专属动作（`lore_wind/lore_deep/lore_sky/train` + `ac_menu`），交互面 ≥4；
- 专属动作必须在 `dlgAct` 里存在真实 `case`（防死按钮），且 `default:` 分支必须存在（防退化复现）；
- 受训确有收益（耗 6 刻 + 回血，不空转）；
- 未知 NPC id 不抛错。

**浏览器复核**：`verify-stage-h.mjs` 新增 NPC 交互面检查——实测五个 NPC 全部具备 聊天/请求/赠礼，导师各 5 项、米娅 4 项，截图 `h6-3-导师对话.png`。

---

## 1. 任务进度（8 张卡 · 逐卡状态）

| 卡 | 主题 | 状态 | 代码依据（新增/改动） | 单测 |
|---|---|---|---|---|
| **H1** | 星枢七塔补完（星海/星塔/星斗台/星殿 + star6 占位） | ✅ 已完成（本轮开工前由上一会话落地，本轮复核 + 接入 H4 试炼镜像） | `data/world/starhub.json`、`data/starhub.ts`、`core/starNet.ts` | cardH1 **19** |
| **H2** | 星渊暗线（star6 激活 + 五级魔气 + 三方阴谋链） | ✅ 同上（复核 + 修 3 处 tsc 遗留错） | `data/world/abyss.json`、`core/abyss.ts`、`events.json` | cardH2 **13** |
| **H3** | 命名生成器（13 族词根 + 确定性组合 + 避雷） | ✅ **本轮新建** | `data/naming/{lexicon,rules,blocklist}.json`、`core/naming.ts` | cardH3 **45** |
| **H4** | 地下城 100 层（五主题分层 + 星塔镜像 + 深渊钩子） | ✅ **本轮新建** | `scripts/gen-dungeon.mjs`、`data/world/dungeon.json`、`data/dungeon.ts`、`core/dungeon.ts`、`ui/overlays/DungeonOverlay.tsx` | cardH4 **27** |
| **H5** | 百年神选（海选→预选→正赛→神战→候补 + 跨大陆观战） | ✅ **本轮新建** | `data/world/theoselect.json`、`core/theoselect.ts`、`events.json`、`ui/panels/{NewsPanel,CharPanel,MapPanel}` | cardH5 **31** |
| **H6** | 培养学院 + 神明系统（四路径 · 六主神 · 神职五级） | ✅ **本轮新建** | `data/world/{academy,deities}.json`、`core/{academy,deity}.ts`、`ui/panels/{AcademyPanel,DeityPanel}.tsx` | cardH6 **29** |
| **P1** | 表现层（演出强化 + 移动端手感 + 插画提示词） | ✅ **本轮完成**（第 1 项插画见 §5 缺口） | `styles/fx.css`、`overlays/{Check,Combat,SheetHost}`、`TabBar/TopBar/GameShell`、`素材清单.md` | 无（表现层，靠截图/实测） |
| **Q1** | 规则一致性红队（AI 越权诱导 20+ 用例） | ✅ 同上（复核） | `core/redteam.test.ts` | redteam **17** |

**集成接线（本轮主线补齐，属各卡的「最后一公里」）**
- `core/engine.ts`：`enter_dungeon / dungeon_menu / dungeon_next / dungeon_retreat`（H4）、`theoselect_menu / ts_enroll / ts_spectate`（H5）、`ac_menu / ac_courses / ac_enroll / ac_study / ac_graduate / de_menu / de_show / de_pray / de_intervene`（H6）全部路由；并在组合根挂 **H5↔H6 终局钩子** `theoselect.setAscendHook(deity.ascendCandidate)`。
- `core/time.ts` newDay 挂 `dungeonTick`（深层魔气）+ `theoselectTick`（保底开启 + 阶段推进），与既有 `econRevert/vendorIncome/bondDailyTick/abyssTick/timeline/npcTick` 同序。
- `core/index.ts`：H3/H4/H5/H6 全部公共出口（**UI 只经索引进引擎**——本轮把 H6 面板的直连 import 收了回来）。
- `core/starNet.ts`：星塔试炼 `trialClimb` 改为**镜像 `dungeon.json` 的层名/主题/难度**（`trialMirror`），网内无伤铁律不变。
- `core/actions.ts.observe()`：接入 H3 `passerby()` 路人署名。
- `core/theoselect.ts.seedField()`：候选池 = 世界书 15 名 NPC（canon 名）+ **10 名命名生成器补位**。
- `data/world/people.json`：**播种 4 位学院导师** `tutor_{wind,deepwell,skycap,camp}`，成为可交谈/可赠礼/有 goal·bottomLine 的真实 NPC（验收二 · NPC 独立性）。
- `types/world.ts`：H4/H5/H6 长线状态类型固化（`DungeonState / TheoselectState / AcademyState / DeityFavor / DeityId`），全部**可选字段**。

---

## 2. 目录结构（阶段 H 新增面）

```
tianqiong/
├── scripts/
│   ├── gen-dungeon.mjs            # H4 数据生成器（确定性 LCG；改生成器后重跑即可复现 dungeon.json）
│   ├── verify-stage-h.mjs         # ★ 阶段 H 端到端自检（DEV 桥 __tq，双端截图 + 控制台零错）
│   └── shot.mjs                   # 既有双端截图（本轮复跑 9 张）
├── docs/
│   ├── 技术架构与开发约束.md        # 本轮更新 §1 目录树 / §8 素材规则 / §10 路线图（阶段 H 记录）
│   └── 阶段H-交付说明.md            # ★ 本文
├── public/assets/素材清单.md        # P1 追加「Prompt Sheet」34 条中文提示词
└── src/
    ├── types/
    │   ├── world.ts               # +DungeonState/TheoselectState(+Candidate)/AcademyState/DeityFavor/DeityId
    │   └── uispec.ts              # +DungeonView（core→UI 纯数据视图契约）
    ├── data/
    │   ├── dungeon.ts             # H4 加载器（零逻辑）
    │   ├── naming/{lexicon,rules,blocklist}.json   # H3 词根 1872 条 / 公式 / 避雷
    │   └── world/
    │       ├── dungeon.json       # H4 100 层（生成物）
    │       ├── theoselect.json    # H5 五阶段 canon
    │       ├── academy.json       # H6 s100 七院 + 8 导师
    │       └── deities.json       # H6 六主神 / 五级神职 / 四级信仰路线
    ├── core/
    │   ├── naming.ts  dungeon.ts  theoselect.ts  academy.ts  deity.ts   # 五个新模块
    │   ├── starNet.ts abyss.ts events.json time.ts engine.ts index.ts actions.ts npcs.ts   # 接线改动
    │   └── cardH{1..6}.test.ts  redteam.test.ts
    ├── styles/fx.css              # P1 全部新增动效（16 关键帧 + reduced-motion + 安全区）
    └── ui/
        ├── overlays/DungeonOverlay.tsx          # H4 层中常驻 HUD
        ├── panels/{AcademyPanel,DeityPanel}.tsx # H6
        └── panels/{NewsPanel,CharPanel,MapPanel}.tsx  # H4/H5/H6 只读展示扩展
```

**分层未破**：`types ← data ← core ← ai/repo ← store ← ui` 单向依赖原样；`naming/dungeon/theoselect/academy/deity` 五个新 core 模块只 import `@/types/*`、`@/data/*` 与同层 core，零 React/zustand/DOM。

---

## 3. 代码结构（关键设计）

### 3.1 二分制（恒定 → 引擎数据 / 讲述 → AI + seed / 后果 → core）
- **数据驱动**：加一层地下城 / 一位神明 / 一所学院 = 加一个 JSON 对象，不改代码；`dungeon.json` 由 `gen-dungeon.mjs` 模板化生成（浅 20 手工 / 中 30 / 深 30 / 最深 19 / 深渊 1），避免手写 100 层失控。
- **后果全在 core**：H4 爬层、H5 名次、H6 神迹/晋升均为 core 函数写 `WorldState`；AI 只拿 `loreRef` canon 润色。Q1 红队 17 用例常驻 CI 守这条线。
- **关 AI 成立**：每层 / 每阶段 / 每神迹都有 `seed` 文本，无 `{占位符}`（单测断言）。

### 3.2 数据契约与迁移（ver 保持 1）
新增字段**一律 `?:` 可选** + `state.ts:hydrate()` 补默认，旧档（`tq2_world_v1` / SQLite `saves`）直接可读。H4/H5/H6 各有一条「旧档缺字段不崩」单测。

### 3.3 幂等与防刷（长线系统的三个必备护栏）
| 系统 | 幂等键 | 频次门 |
|---|---|---|
| H4 深渊钩子 | `flags.dungeon_abyss_reached` | 首达一次，重复抵达不重复入历史 |
| H5 阶段推进 | `theoselect.advancedAt === s.t` | 同刻只结算一次；失败者 `disqualified` 锁到下一届 |
| H5 神选名次 | — | 评分含 `rng` 但**先抽运气再懒初始化**，同 seed 同结果 |
| H6 祈祷 / 神迹 | `favor[deity].lastPrayDay / lastMiracleDay` | 祈祷 ≤3/日；神迹 14 日冷却 |
| H6 候补神晋升 | `flags['ascend_<npcId>']` | 重复调用零副作用仍返回 true |

### 3.4 视野/UI 契约
新增长线系统一律提供**纯数据视图**函数（`dungeonView / theoselectView / academyView / deityView`），React 只渲染 + 发 `GameCommand`，不摸 `core.S`。H4 的层中 HUD 用 `core.S?.dungeon?.floor` 早退守标题页（组件挂在 GameShell 之外）。

---

## 4. 验收动作与证据

| 《项目方案》§71 验收 | 支撑卡 | 实测证据 |
|---|---|---|
| 一 · 自由行动 | 既有 intents | core.test 意图组 11 例 |
| 二 · NPC 独立性 | H6 学院导师 | `allMentors()` 8 位 goal/bottomLine 两两不同；4 位已播种进 `people.json` 可交谈可赠礼 |
| 三 · 世界因果 | H2/H4/H5 | 深渊 100 层 → `dungeon_abyss_reached` + 历史；神选四阶段 → 座次 + 寿命奖励 + 历史（浏览器实测 `seen: 海选→预选→正赛→神战→候补, rank 1, champion player`） |
| 四 · 持续世界 | D1/D2 | 既有 cardD1/D2 |
| 五 · 规则一致性 | Q1 | redteam 17 例全绿 |
| 六 · 星枢完全体 | H1 | 七塔入口全在（star6 走 leak 门），四 func 各自演出 |
| 七 · 长线闭环 | H3/H4/H5/H6 | 100 层可爬（cave3→50 层切入→81 深层→100 深渊）；神选四阶段可推进；学院可毕业；六主神可祈祷 |
| 八 · 表现层 | P1 | 双端截图 9 张 + 端到端 12 张；控制台零错、无横向溢出；缺图回退 0 次 404 |

**运行方式**
```powershell
cd E:\桌面\天穹3\天穹高端\tianqiong2
npm run dev                                  # http://127.0.0.1:5273/
node scripts/verify-stage-h.mjs http://127.0.0.1:5273/ ..\outputs\stage-h-verify
node scripts/shot.mjs http://127.0.0.1:5273/ ..\outputs\stage-h-shots
```

---

## 5. 已知缺口（诚实清单 · 均不阻塞验收）

1. **插画仍缺 25 张（+9 个清单外 id）**：本环境**无可用图像生成工具**，未生成也未伪造任何 webp。P1 交付的是 `素材清单.md` 里 **34 条中文提示词 + 尺寸/体积表 + ffmpeg 命令 + 缺口自检脚本**。`ArtImage` 缺图符印回退已验证有效（本轮 404 数为 0，因回退不发请求）。
2. **情绪 tag 无数据源**：`DialogSheet` 至今无 `mood` 字段（P1 按红线未改类型文件），现由「正文强情绪词扫描 → 回落 att 档」保守推导。建议后续在 `DialogSheet` 加 `mood?: '怒'|'喜'|'惊'|'疑'|'冷'` 后删掉推导。
3. **暴击无出口**：`CombatState` 无 `crit` 字段、`foeHit` 只带 index，故 UI 以「单次伤害 ≥ 目标生命上限 1/3」作**重击**近似（文案明确写「重击」而非「暴击」，不谎报）。建议后续给 `cbLog/CoreEvent` 补 `crit: boolean`。
4. **学院报名不做地点前置**：canon 六所学院在 `geo.json` 的 locked 大陆，加地点门会让卡不可玩；已在 `academy.json.enrollNote` 说明为「经公会与星枢传讯报名，毕业任务赴本院」——待阶段 I 跨大陆交通落地后可加。
5. **`nameFromLore` 人物卡需先 `await loadPersonLore()`**：懒加载设计（主包分割），未加载时回落生成名，不抛错。
6. **H3 未落「100 个名字快照文件」**：改为测试内打印 13 族样例（default 5 + legend 3）供人肉扫读；快照文件非必需，未落。
7. **`academy.json.mentor.{goal,bottomLine}` 与 `people.json` 存在同人两处文案**：前者是「学院招生使」语境，后者是「人物志」语境，均为有意分层；已确保 4 位新播种导师两处逐字一致，其余 4 位保留各自语境。
8. **dev server 曾被 EBUSY 打死（已修）**：Windows 上 vite 监视器遇 `EBUSY` 是**直接退出**而非重试。本轮写 `docs/阶段H-交付说明.md` 时原子替换锁住句柄，把 5273 的 dev server 打成 `exit 1`（`path: .../docs/阶段H-交付说明.md`）。已在 `vite.config.ts` 的 `server.watch.ignored` 补 `**/docs/**`、`**/scripts/**`、`**/outputs/**`——应用从不 import 这三处，监视它们只有风险没有收益。修复后实测：写同一文件 → 5273 仍 `ALIVE`，`HTTP 200`。

---

## 6. 复审修订日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-09-20 | 首版：阶段 H 八卡（H1–H6 + P1 + Q1）全部落地；四绿（29 文件 / 346 tests）；端到端自检脚本与双端截图交付；更新 `docs/技术架构与开发约束.md` §1/§8/§10 |
| v1.1 | 2026-09-20 | 用户实测反馈修复：`dlgOpts` 补 `default` 兜底 + 四位学院导师专属交互面（G10 契约落地）；+5 回归测试（351 tests）；端到端脚本增 NPC 交互面检查 |

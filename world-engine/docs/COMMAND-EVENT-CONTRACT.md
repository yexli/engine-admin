# COMMAND-EVENT-CONTRACT（命令—事件契约底册）

> V0.2 · 工作项 V2.4 产出（方案 §13/§14/§45/§47）。**本文是底册，不是规范**：
> 整理自 `tianqiong2/src/world/WorldRuntime.ts`（dispatch / uiAction / sceneAction）
> 与 `src/events/EventSchema.ts`（分级表）在 V0.1 抽取后（引擎 `5531e0f`）的实际接线。
> 代码以实现为准；发现漂移请先改代码，再同步本册。
>
> 用途：这是后续把 dispatch 逐条规则化（§47 registerRule）时的**迁移底册**——
> 每迁一条命令成引擎 Rule，在此行打勾；迁移前后必须有同VRT回归证据。

## 1 · 铁律（方案 §13/§45）

- Command =「我要让世界做什么」（意图，可被拒绝）；Event =「世界发生了什么」（事实，只发布）。
- 任何来路（UI / 脚本 / AI）都只能经 `world.command(cmd)` → `dispatch` 提交命令；
  AI **不得**直接写 WorldState（§45：AI 建议 AttackCommand，不能 `npc.hp -= 30`）。
- 每条命令 = 一个 tick（入口 `worldBus.beginTick()` 重置事件配额）；
  出口统一 `sync()`（changed 立即 + 尾节流落盘）+ 叙事编织水位（F-12/F-19）。

## 2 · dispatch 层命令（GameCommand.type）

| 命令 | 入口 | 典型世界事件 | 典型 mutate 原语 |
|---|---|---|---|
| `newGame` | WorldRuntime.newGame → newState（世界书创角） | —（开局广播走 bus.screen） | 初始化整档；log(开场白) |
| `continueSave` | continueSave → hydrate（旧档迁移） | — | 档内字段自愈（hydrate） |
| `importState` | importState → validateState → hydrate | — | 同上 |
| `resetWorld` | resetWorld | —（清总线/死信/世界史/向量缓存） | core.S = null（生命周期口） |
| `travel` | actions.go | `travel_arrived`(L1)、时辰/日节律、遇袭（combat 开战） | playerLoc；gold(旅费 payGold)；att(npc 遭遇) |
| `sceneAction.k` | 行动坞子路由（见 §4） | 按子项（observe → `lore_unlocked` 等） | 各系统 |
| `wait` | **WorldClock.advance（引擎时钟）** | `hour_advanced`(L0)/`new_day`(L2)/`time_advanced`、due 计划事件 | 时钟内衰减 effects |
| `npcTalk` | dialogue.openDlg | `dialogue_completed`(L1)、`relationship_changed`(L2) | npcMet；npcAtt；pushLog(say) |
| `dialogChoice` | dialogue.dlgAct | 同上 + `quest_completed/failed`(L2)、`crime_committed`(L2) | playerGold；rep；playerFlag |
| `dialogReq` | dialogue.runReq | `npc_attitude_shift`(L2)、`rumor_spread`(L1) | npcAtt；addHistory |
| `shopBuy` | shop.buy | `item_gained`(L1)、`gold_changed`(L1)、`large_trade`(L2) | payGold；playerBag；econ |
| `shopSell` | shop.sell | `item_lost`(L1)、`gold_changed`(L1)、`large_trade`(L2) | playerGold；playerBag；vendorCoin(econ) |
| `combat.k` | combat.playerAct / flee / combatUseItem | `combat_round`(L1)、`damage_applied`(L0)、`character_died`(L2)、`item_consumed`(L0) | playerHp/playerMp；npcBag(战利品)；killed |
| `freeText` | freeActSmart（意图解析→计划执行） | 视意图（与面板命令同源事件） | 经 WorldExecutor 同一验证通道（§18） |
| `chatOpen` | chat.openChat | `dialogue_completed`(L1) | npcMet |
| `chatSend` | chat.sendChat | `npc_attitude_shift`(L2)、`rumor_spread`(L1)、`grudge_formed`(L2) | npcAtt；chats |
| `useItem` | combat.useItem | `item_consumed`(L0)、`heal_applied`(L0) | playerBag(-1)；playerHp/Mp |
| `equipItem` | combat.equipItem | —（装备态在 player.equip） | equip 字段（战斗系统内受控写） |
| `ui.a` | uiAction 子路由（见 §3） | 按子项 | 各系统 |

## 3 · uiAction 子路由分组（`ui` 命令的 `a` 参数）

| 分组 | 代表 case | 入口 | 典型事件 |
|---|---|---|---|
| 星枢网 | sn_enter/exit/duel/buy/council… | starNet.* | `large_trade`(L2)、`faction_relation_changed`(L2) |
| 星渊 | abyss_menu/probe/seal | abyss.* | `abyss_breach`(L3，已通电) |
| 神选/神明 | ts_enroll / de_pray / de_intervene | theoselect.* / deity.* | `title_granted`(L2)、favor 变化 |
| 学院/成长 | ac_enroll/study/graduate、growth_* | academy.* / growth.* | `xp_gained`(L0)、`quest_completed`(L2) |
| 地下城 | dungeon_enter/next/retreat | dungeon.* | `combat_round`(L1)、`character_died`(L2) |
| 工坊/图鉴 | craft_menu/do、codex_open | craft.* / codex.* | `item_crafted`(L1)、`lore_unlocked`(L1) |
| 婚丧 | rt_marry | rites.marry | `relationship_changed`(L2)、`reputation_changed`(L2) |
| 通讯 | cm_compose/send | commNet.* | `travel_arrived`(L1，信件抵达) |
| 法律 | payfine_ok | law.payFine | `crime_committed`(L2)、`reputation_changed`(L2) |
| 商队支线 | cbt_caravan / caravan_good/bad | combat / 内联 | `faction_relation_changed`(L2)、`npc_attitude_shift`(L2) |
| 浮层 | close/reset/reset_ok/dlgPage | sheet / 纯渲染 | —（不碰 WorldState） |

## 4 · sceneAction 子路由（行动坞）

observe / gather_intel / search / rest_inn / drink / shop_grocer / steal / pray / heal_svc /
explore_wild / explore_cave / enter_dungeon / theoselect_menu / academy_menu / deity_menu /
gather / craft / codex_open / starnet / rest_wild / exchange_go / payfine_go。
入口分别：actions.*、shop.openShop、dungeon / theoselect / academy / deity / craft / codex /
starNet / exchange 菜单；事件与 mutate 同 §2/§3 对应行。检定类动作（observe/search/gather_intel）
经 CheckResolver 异步收束后写回——事件发布在收束回调里（叙事编织窗口依赖此时序，F-19）。

## 5 · 世界事件分级速查（§12，注册表唯一来源：`src/events/EventSchema.ts`）

- **L0 internal**：hour_advanced、damage_applied、heal_applied、mp_spent、cooldown_ticked、item_consumed、xp_gained
- **L1 local**：lore_unlocked、rumor_spread、npc_moved、gold_changed、item_gained/lost、dialogue_completed、combat_round、item_crafted、travel_arrived、weather_changed、time_advanced
- **L2 cross-system**：character_died、npc_missing、crime_committed、quest_completed/failed、faction_relation_changed、reputation_changed、relationship_changed、large_trade、new_day、item_stolen、npc_attitude_shift、title_granted
- **L3 reasoner**：ruler_died、npc_assassinated、city_at_war、faction_conflict、player_betrayed_faction、city_disaster、major_political_event、abyss_breach（唯一已通电：abyss_breach）
- **critical 通道**：hour_advanced、new_day（不计普通配额，独立熔断）
- 引擎侧缺省分级：未注册类型 = L1 / ambient（引擎独立世界用）

## 6 · 规则化迁移台账（§47）

> 每把一条 dispatch 分支迁成引擎 `world.registerRule`，在此登记；迁移前后必须有同样的回归证据并链接到报告附录。
> V0.2 阶段**不迁移任何一条**（方案 §59：重写命令层 = 停止条件；本册只为后续迁移备料）。

| # | 命令 | 状态 | 迁移提交 | 回归证据 |
|---|---|---|---|---|
| — | （空） | — | — | — |

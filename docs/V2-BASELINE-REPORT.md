# V2.x 基线报告（P0–P6 全链路回归验收）

> 生成时间：2026-10-03
> 结论：**V2.x 基线成立**——P0 至 P6 六个阶段的全部验收标准在干净的全栈环境下复核通过，钉为进入 P7（Memory 联动）前的稳定基线。

## 一、基线范围与版本

| 阶段 | 内容 | 版本锚点 |
|---|---|---|
| P0 | 实现审计 | docs/CURRENT_IMPLEMENTATION_AUDIT.md（§一–八） |
| P1 | Evolution Runtime 封口（并发互斥/running 留痕/幂等账重建） | platform 0.11.0 |
| P2 | 天穹最小真实链路（地点表/三人组/注意力/商店购买/反应呈现） | world-engine 1.2.1 + 宿主 |
| P3 | Trigger Engine（逐实体唤醒 + 双重成本闸门 + 平台内触发循环） | platform 0.12.0 |
| P4 | Context Engine（五项预算 + 预算报告 + 触发段 + 记忆/目标通路） | platform 0.13.0 |
| P5 | NPC Runtime MVP（个体决策 + 焦点作用域 + 金币禁令 + NpcProfile） | platform 0.14.0 |
| P6 | World Time / Schedule（历法统一 + 日程注册持久化 + 调度循环零 AI） | platform 0.15.0 |

## 二、自动化测试基线（全绿）

| 包 | 版本 | 测试 | 类型检查 |
|---|---|---|---|
| world-engine | 1.2.1 | **108/108** | ✅（基线复核修复 2 处测试文件既有类型瑕疵：file-storage 空值断言、ws-stream 作用域类型） |
| platform | 0.15.0 | **232/232** | ✅ |
| gateway | 0.7.1 | **30/30** | — |
| memory | 0.8.2 | **20/20** | — |
| **合计** | | **390 项** | |

## 三、全栈 live 验收（dev-stack 六服务）

启动：`node platform/scripts/dev-stack.mjs`（引擎 8787 / 记忆 8789 / 平台 8790·8791 / 天穹宿主 8795 / 管理台 8848）。六服务全部存活（平台公开 API 与管理面的根路径 401 为鉴权闸门正常工作）。

### 真人走查（`scripts/run-v21-walkthrough.mjs`，35 项检查）
- **第一轮（干净起栈）：35/35 通过**。
- **第二轮（全栈重启后）：35/35 通过**——可重复性成立。

### 逐阶段证据复核（live，真模型 DeepSeek）

| 阶段 | 证据（本轮采集） |
|---|---|
| P1 封口 | 演化账本磁盘落盘（tianqiong-village.jsonl，54 行）；**全栈重启后幂等账重建生效**：第二轮中 evt_1_24 / evt_1_32 的触发键命中第一轮账本，直接返回原 run（未重复执行 AI、未重复 Mutation）；全新事件 evt_1_33 得到真实新 run；因果 trace 端点反向还原 Event → run → proposalId → changeId 全链 |
| P2 真实链路 | 引擎地点表落库（shop=杂货商店 / tavern=米露的酒馆 / village=村庄，unknown 空）；三人组齐备；走查 [06][09] 无硬编码触发；[15]-[17] 商店经济一致（-3 钱/干粮+1） |
| P3 Trigger | 触发日志如实记录每次裁决：「无人值得唤醒（3 实体中 1 个 low/medium）——零 AI 调用」×N；「唤醒 milu（其余 2 实体未唤醒）→ 个体演化 tick」；wakePlan（milu:high / keeper:none / trader:none）入账 |
| P4 Context | run.context 带触发段（primaryEventId + woken）、goal 段（来自引擎 NPC 属性「把酒馆经营好，弄清常客们的来历」）、预算报告（estimated=537 / max=6000，各段携带量如实） |
| P5 个体决策 | 幂等键 `auto:tianqiong-village:evt_1_32:milu`（事件+实体分键）；模型以米露视角判断；金币禁令由 suite 测试钉住（AI 提改 NPC money → policy 拒） |
| P6 Schedule | 日程经管理面注册（PUT 200）并持久化（data/schedules.json）；平台重启自动恢复守护；时间推进零 AI；错位 NPC 自动归位（此前 live 验证） |

### 跨阶段组合边界（本轮实测确认，行为符合设计）
**确定性事件 id vs 持久幂等账**：引擎重启后世界重建，事件 id 从 evt_1_1 重新计——第二轮中与第一轮同 id 的事件被 P1 幂等账判重（返回原 run，不重复执行）。这既是「宁阻塞不重复」纪律的正确表现（防重放重复执行），也意味着新世界的同 id 事件不会获得新的 AI 判断。**处置**：dev 循环重启引擎时一并重启平台（本基线的第二轮即为全栈重启，幂等判重按预期工作）；多代世界 id 语义（世界实例指纹）登记为 P9 Admin Runtime 议题。

## 四、基线纪律检查

- **Core 架构**：六阶段对引擎的唯一改动是 additive（locations）；Core/Extension 边界源码扫描断言持续通过；演化 causation 以 Journal 为权威（Event 不携带演化专属字段）。
- **AI 边界**：全程无状态写入口（结构保证）；三层围栏（策略→白名单→Rules）；金币禁令补齐方案 §八合规。
- **失败可见**：running 中间态落账、预算报告、写失败计数、唤醒裁决日志、触发状态计数——各环节「失败/裁剪/未唤醒」均可观测。
- **成本纪律**：分级 gate + 唤醒 gate 双闸门；个体 tick 按事件+实体分键；调度循环零 AI。

## 五、遗留（不阻塞基线，按优先级）

1. 引擎事件持久化未闭环（loadWorldLog 零调用，重启丢事件史）——P7 前或 P9 收口。
2. 宿主与平台各持日程数据副本（走查断言钉住一致性）——P9 单一数据源。
3. tianqiong 真实游戏本体未接网络闭环（双状态）——独立工作项。
4. Memory 包零接线——**P7 议题（下一步）**。
5. 多代世界 id 语义——P9。
6. advance_time 无上限等内核边界——云部署前处理。

## 六、签字

P0–P6 全链路在自动化（390 项）与 live（六服务、双轮走查、真模型全链）两个层面复核通过，**V2.x 基线成立**。下一阶段按方案进入 P7（Memory 与 NPC Runtime 联动）。

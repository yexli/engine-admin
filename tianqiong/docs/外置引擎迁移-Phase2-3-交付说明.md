# 外置引擎迁移 · Phase 2/3（同步桥）交付说明

> 前置：Phase 1 连接层（[外置引擎迁移-Phase1-交付说明.md](./外置引擎迁移-Phase1-交付说明.md)）
> 本交付：**时间/位置读面切换（Phase 2 首批）+ wait 裁定翻转（Phase 3 第一条）+ 双向同步桥**
> 日期：2026-10-06

---

## 一、这次交付了什么

开关打开（`TIANQIONG_EXTERNAL_WORLD_ENGINE=true`）后，游戏进入「双引擎过渡态」：
外部 World Engine 与本地引擎通过同步桥保持单一收敛事实，第一批裁定权完成翻转。

```text
            ┌─────────────── 同步桥（单队列串行）───────────────┐
            │ 上行：本地领先量（位置/刻数增量）→ 引擎             │
本地引擎 ──┤                                                    ├── 外部引擎
（大多数    │ 下行：引擎裁定的 time_advanced 事实 → 回灌本地时钟  │ （wait 的
 系统仍    └────────────────────────────────────────────────────┘   裁定者）
 在本地）
```

### 核心机制

| 机制 | 说明 |
|---|---|
| **wait 裁定翻转** | `dispatch('wait')` 经新端口 `world/extGate.ts` 转投引擎（`advance_time`），不再走本地时钟；引擎的 `time_advanced` 事实流回后，桥把本地时钟**补差追平**——时辰边界钩子（directorTick / daySettle）照常在本地触发，未迁移系统无感 |
| **上行同步（增量制）** | 本地每次 `changed`（travel 耗时/战斗/上学等一切本地裁定的时间与位置变化），桥把领先**增量**经单队列 FIFO 提交引擎。增量制 + 串行化保证交替领先时贡献相加、不互相吞并（曾发现 max-wins 绝对值制会吞掉并发推进，已修复并有测试钉住） |
| **收敛律** | 时间只有一个人在写：桥是引擎的**唯一**时间/位置写者。`pendingT` 投影 = 引擎现值 + 已排队增量；事实水位高于投影才采纳。数学上无双推进（混合序列 VRT 断言逐刻相等） |
| **重连对账** | 断线重连的对象可能是新引擎实例——online 时以观测镜像为新基线，再把本地领先量补推上去（断线期间本地继续裁定的部分不丢失） |
| **迁移期断线契约** | 断线 → gate 失效 → wait 回落本地裁定（游戏可玩）；重连后上行收敛。这不是"偷偷切本地引擎"：本地引擎在 Phase 9 之前本来就是未迁移完的裁定者。Phase 9 删除本地路径后切 §22 停摆语义 |
| **TopBar 读面切换** | 开关打开、连接在线且水位就绪时，「几点/在哪」读引擎镜像（数值引擎裁定）；时辰名/地名文案仍是天穹资产（方案 §12 边界：数值归引擎，显示归客户端）。水位未就绪 = 与现状逐字节相同 |

### 已知边界（诚实声明）

1. **换档/重置不回拨引擎时间**：引擎时间不可倒流，本地 newGame 后刻数小于引擎水位时，桥只告警一次并暂停时间同步，直到本地再次领先。引擎侧接管世界生命周期后消除（Phase 6+）。
2. **NPC 在场读面未切**：引擎侧还没有日程规则（NPC 位置是静态种子），切了会显示错人——等 Phase 5。
3. **引擎世界重启后档案继续**：宿主 FileSavePort 已持久化，但本地存档与引擎存档仍是两份（Phase 6 收敛）。

---

## 二、改动清单

| 文件 | 改动 |
|---|---|
| `src/world/extGate.ts` | **新**：外部裁定端口槽（模式同 setSavePort/setAiPort；依赖方向：本地引擎不依赖具体通道） |
| `src/world/WorldRuntime.ts` | `case 'wait'`：gate 激活时转投引擎；未注入端口 = 行为与现状完全一致 |
| `src/plugins/extWorldSync.ts` | **新**：同步桥（单队列串行、增量上行、事实下行收敛、重连对账、gate 装配） |
| `src/plugins/extWorldSync.test.ts` | **新**：5 个收敛律单元测试（假 runtime，无网络） |
| `src/tests/ext-world-sync.test.ts` | **新**：真引擎进程 VRT——混合裁定序列逐刻一致 + 断线/重连收敛 |
| `src/world-engine/cache/worldCache.ts` | 镜像增加 `timeView`（引擎历法视图） |
| `src/world-engine/runtime/attachExternalWorld.ts` | `ExtWorldReport` 携带 timeView |
| `src/store/useGame.ts` | `extWorld` 初始值补 timeView |
| `src/ui/TopBar.tsx` | 读面切换（引擎水位就绪时读镜像） |
| `src/devlog/RunLog.ts` | 新观测通道 `extsync`（外擎同步） |
| `eslint.config.js` | scripts 全局补 URL/URLSearchParams |
| `src/main.tsx` | 装配 `attachWorldSync` + HMR 卸载 |

---

## 三、测试证据（本轮新增 7 个，全量 124 文件 / 1758 用例全绿）

| 用例 | 断言 |
|---|---|
| ① 本地领先 → 上行补差 | travel 类本地耗时后引擎逐刻追平 |
| ② 引擎领先（wait 翻转） | 本地时钟被回灌到 t+4，且**不是** t+8（无双推进） |
| ③ 交替领先 +3 → wait4 → +2 | 终值 25/25——增量制修复了 max-wins 并发吞并（回归钉死） |
| ④ 位置单向上行 | 本地 travel 后引擎位置跟随 |
| ⑤ 本地回退 | 引擎不被回拨（换档限制有告警） |
| VRT 混合序列（真引擎进程） | travel(本地) → wait(引擎) → travel → wait 终态：本地 t === 引擎 t、位置一致、TopBar 读面（镜像）=== core.S |
| VRT 断线重连 | 断线 wait 走本地（可玩）；重连后引擎以新基线追平本地领先量 |

`tsc --noEmit` 零错误；`eslint .` 零错误；`vite build` 成功（chunk 体积警告为世界书既有体量，非本次引入）。

---

## 四、怎么体验

```bash
# 终端 A：外部引擎（存档落盘 .world-data/）
cd tianqiong && npm run host:world

# 终端 B：开开关起游戏
# PowerShell: $env:VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE='true'; npm run dev
```

游戏内可见：
- 右上角「外擎」徽标 + 引擎时间水位（`外擎 D1·16刻`）；
- 顶栏时间/地名在水位就绪后来自引擎镜像；
- 点「休息/等待」→ 引擎推进时间，徽标水位与顶栏同步跳字（这一刻时间是**引擎裁定的**）；
- 移动/旅行 → 引擎世界跟随（管理后台 `GET /v1/worlds/tianqiong-main` 可见玩家位置与刻数实时一致）；
- 杀掉终端 A → 徽标「重连中…」，游戏照常可玩；重启宿主 → 自动恢复并补账。

---

## 五、下一步（按台账）

1. **Phase 3 继续**：逐条把低风险 GameCommand（go/rest/sceneAction 等）经 registerRule 挂到引擎，每条一次 VRT（extGate 端口模式已铺好，逐条翻转即可）。
2. **Phase 5**：NPC 日程/在场规则服务端化 → SceneView 在场读面切换。
3. **Phase 6**：引擎侧 scheduler 接管世界生命周期（newGame/重置回拨问题在此消除）。

# 外置引擎迁移 · Phase 3（会话托管）交付说明

> 前置：Phase 1 连接层、Phase 2/3 同步桥（[Phase2-3 交付说明](./外置引擎迁移-Phase2-3-交付说明.md)）
> 本交付：**会话档（session mode）——服务端宿主完整裁定栈，客户端纯指令 + 快照回灌**
> 日期：2026-10-06

---

## 一、这次交付了什么

方案 §9 的终局形态第一次完整可跑：

```text
Tianqiong 客户端                       游戏会话宿主（独立 Node 进程）
┌──────────────────────┐   GameCommand  ┌────────────────────────────┐
│ UI / 输入 / 动画 / 资源 │ ────────────→ │ dispatch + 24 系统 + 规则推演 │
│ core = 快照投影        │ ←──────────── │ （原样复用，一行未改）        │
│ （Cache = Truth 的投影）│  事实流+快照    │ FileSavePort 落盘           │
└──────────────────────┘                └────────────────────────────┘
```

**为什么是"整体搬迁"而不是"逐条翻转"**：本地规则的裁定消耗同一个 rng
流与数据表（travel 的遭遇掷骰、combat 的 d20、econ 回归……），逐条把规则
重写成引擎侧副本必然与本地漂移（VRT 会失败）。忠实的做法是让服务端原样
运行 dispatch + 全部系统——客户端命令整投、响应整体回灌。这正是方案 §9
"客户端只产生 Intent"的实现，且 124 条命令（含 newGame/continueSave 等
元命令）一次全部受益。

### 客户端零改动的关键：三个槽位 + 事件重放

- `core.S` ← `hydrate(snapshot)` 整体回灌（WorldState 快照）；
- `core.CB` / `core.curShop` ← 响应随行（战斗/商店瞬态槽不在 WorldState 里，漏了战斗浮层就会瞎）；
- 服务端事实流原样重放到本地 bus（`sheet/check/toast/combat/screen` 形状同构），最后补一发 `changed` 驱动重渲染。
- UI 全部面板/浮层照旧读 core、听 bus——**一行 UI 代码没改**（审计确认 UI 对系统的直调全是只读纯函数）。

### 服务端（`server/game-host.ts`，vite SSR 构建）

| 端点 | 说明 |
|---|---|
| `GET /game/health` | 探活（t/loc） |
| `GET /game/state` | 全量快照 |
| `POST /game/new` | 开局（元命令在无世界时也受理） |
| `POST /game/command` | 裁定 + 事实 + 快照 + CB/curShop |

- 命令处理是同步的：响应里的事件就是本次命令的完整因果；
- 存档：FileSavePort 同款 tmp+rename 原子写（`TIANQIONG_GAME_SAVE`），重启接续；
- **编织（Narration）不在服务端**：按方案 §30 文本表现层归客户端——服务端注册的 AiPort 摘掉 `narrateAsync`（core 全部 ai() 消费方都有无端口/规则兜底），避免异步编织事件落到哪条命令边界由传输决定；
- `TIANQIONG_GAME_SEED`：rng 播种与本地组合根同序（seed → bootstrap → newGame），VRT 对照的基础。

### 客户端装配（`src/plugins/extSession.ts` + `world/extGate.ts` 会话命令端口）

- 配置：`TIANQIONG_EXTERNAL_WORLD_ENGINE=true` + `VITE_WORLD_ENGINE_MODE=session`（缺省 bridge，行为不变）；
- session 档**不装配本地裁定订阅栈**（bootstrapWorld）：推演/记忆/感知都由服务端做，本地 core 只是被快照刷新的投影——否则会对重放事实双触发；
- 断线回落（迁移期契约）：探活失败/命令失败 → 端口失效 → dispatch 回落本地裁定（可玩），健康检查循环拉回后继续会话。

---

## 二、怎么跑

```bash
# 终端 A：构建 + 托管（存档落盘 .world-data/game-session.json）
cd tianqiong && npm run host:game

# 终端 B：session 档起游戏
# PowerShell:
#   $env:VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE='true'
#   $env:VITE_WORLD_ENGINE_MODE='session'
#   npm run dev
```

此刻：全部按钮的动作都在服务端裁定；杀掉终端 A → 游戏回落本地继续可玩（徽标「重连中…」）；重启宿主 → 自动拉回。

---

## 三、测试证据（本轮新增 2 个 VRT 用例，全量 125 文件 / 1761 用例全绿）

| 用例 | 断言 |
|---|---|
| **同种子同序列：服务端裁定 ≡ 本地裁定** | newGame → travel → wait → travel → wait → travel 逐命令对照：t / loc / gold / hp 与事件类型序列完全一致（真实宿主进程 + 真实会话通道 + 快照回灌路径） |
| 宿主被杀回落 | 在线命令回灌成功 → SIGKILL → 命令回落本地裁定继续推进（迁移期契约） |

VRT 过程中钉死的三个真问题（这就是对照测试的价值）：
1. **AUTONEW 吃 rng**：宿主自动开局会消耗随机流，使后续裁定与参照组错位——改为开局本身是被测命令（`newGame` 也走会话）；
2. **播种顺序**：宿主在 bootstrapWorld 之后播种与本地组合根（之前播种）不同序——对齐后消除；
3. **异步编织跨命令边界**：编织窗口的 setTimeout 事件落在哪条命令由传输决定——按 §30 把编织归还客户端表现层（服务端摘 narrateAsync），两端口径一致。

`tsc --noEmit` 零错误；`eslint .` 零错误（`.server-build/` 构建产物加入忽略）；P3 类型债守卫保持 15（会话通道改泛型签名消化掉了新增断言）。

---

## 四、已知边界（诚实声明）

1. **AI 暂为规则兜底**：session 档的服务端用 ruleReasoner/ruleSim（模型网关是 Phase 8）——对话/叙事质量等同"未配 Key"形态；客户端已配的 Key 在 session 档不参与世界裁定。
2. **编织暂缺**：服务端不织（§30 归客户端）、客户端 session 档未实现本地编织——见闻录显示规则文本（渐进增强的"没配模型"形态）。客户端本地编织是后续表现层任务。
3. **单进程单世界**：宿主一次托管一个存档；多存档/多世界待接 world-engine Registry。
4. **bridge 档与 session 档并存**：bridge（wait 翻转 + 同步桥）保留为缺省档，session 是显式 opt-in 的终局档；两者断线契约一致（回落本地、可玩）。

---

## 五、下一步（按台账）

1. **Phase 8 前置**：world-gateway 接入宿主（模型名=通道），session 档 AI 升级为真模型 + 客户端 Key 迁移到网关；
2. **编织归还客户端**：session 档在客户端监听新见闻（快照 logSeq 差分）本地编织（表现层）；
3. **Phase 5/6 收尾**：bridge 档 NPC 在场/日结算服务端化（session 档已含）；
4. **Phase 9**：session 档稳定后翻默认档，随后按 §22 把断线语义切"停摆等重连"，进 Phase 10 删除本地裁定栈。

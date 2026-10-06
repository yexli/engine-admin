# 外置引擎迁移 · Phase 9/10（终局）交付说明

> 前置：Phase 1-8（连接层 → 会话托管 → 事件流 → 网关接入 → 编织归位）
> 本交付：**Phase 9 翻默认档 + §22 停摆语义；Phase 10 删除双档迁移机制**
> 日期：2026-10-06
>
> **方案收官**：Tianqiong 已从"自带世界引擎的游戏"彻底变成
> **World Engine 会话宿主的纯外部游戏客户端**。

---

## 一、终局形态

```text
                    ┌─────────────────────────────┐
                    │   游戏会话宿主（独立进程）        │
                    │   npm run host:game           │
                    │   dispatch + 24 系统 + 规则推演  │
                    │   + world-gateway（可选内嵌）    │
                    │   + FileSavePort 存档           │
                    └──────────────┬──────────────┘
                            GameCommand │ 事实流+快照+SSE
                                   ┌────┴────┐
                                   │ Tianqiong │
                                   │ UI / 输入 / 动画 / 资源    │
                                   │ core = 快照投影（含编织覆盖）│
                                   └─────────┘
```

- **世界发生什么**：只由宿主裁定（124 条命令整投，含开局/续档元命令）。
- **玩家看到什么**：客户端渲染快照投影 + SSE 实时事实 + 本地编织覆盖表。
- **AI**：gateway 档（内嵌/外联，网关侧持钥）> 转发档 > ruleSim 兜底；编织在客户端（§30）。
- **断线**：§22 停摆——命令拒收（toast + 时间不动）、UI 保留、探活自动重连，绝不本地兜底。

### Phase 9（翻默认档 + 停摆）

- `readExternalEngineConfig`：默认 `enabled: true`（外部会话形态即默认）；
  **逃生门**：env `VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE=false`（或 localStorage
  `{"enabled":false}`）回落本地引擎——迁移期开发形态，非空 env 值一律视为显式指定
  （逃生门必须比默认值好按）。
- extSession 停摆：会话端口 `isActive` 恒 true；断线命令就地拒收
  （toast「与世界的连接已断开——正在自动重连」），删除本地回落路径。

### Phase 10（删除双档迁移机制，grep 确认零残留）

删除：bridge 同步桥（extWorldSync + 同步 VRT）、attachExternalWorld / externalWorldRuntime /
worldCache（+测试）、TS 侧种子镜像（+parity 测试；宿主侧 mjs 镜像保留供 world-host）、
wait 裁定门（extGate 收敛为纯会话端口）、main.tsx 多档分支。
保留：WorldEngineClient（世界事实通用客户端，SDK/管理面基础设施）、gameSession、
config、sessionWeave、extSession。

**关于"删除旧引擎"的诚实说明**：本仓库的终局架构里，裁定栈（world/systems/events…）
是宿主与客户端**共享的同一份源码**——它没有从世界上消失，而是整体搬到了服务端进程；
客户端进程里它只剩逃生门形态。裁定代码的"删除"以搬家形式完成，双档并存机制
（即真正的"旧引擎运行方式"）已删除干净。

---

## 二、怎么跑（新形态）

```bash
# 终端 A：世界（必须先起）
cd tianqiong && npm run host:game
# 可选 AI：内嵌网关 + 真上游
#   $env:TIANQIONG_GAME_GATEWAY_EMBED='1'; $env:TIANQIONG_GAME_AI_UPSTREAM='https://api.deepseek.com/v1'
#   $env:TIANQIONG_GAME_AI_KEY_ENV='DEEPSEEK_KEY'; $env:TIANQIONG_GAME_AI_WIRE='deepseek-chat'

# 终端 B：游戏客户端
npm run dev          # 默认即 session 档；杀掉终端 A → 徽标重连、命令拒收；重启自动恢复

# 逃生门（本地开发形态，不需要宿主）：
#   $env:VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE='false'; npm run dev
```

---

## 三、验收对照（方案 §25 全表）

| 组 | 项 | 状态 |
|---|---|---|
| 架构 | 不再拥有 World Truth / 状态主副本 / NPC Runtime / World Time / Memory Runtime / 直调 AI Provider / 直执 Mutation / 自 Tick 世界 | ✅（客户端 core 为快照投影；裁定全在宿主；编织为渲染覆盖不改状态） |
| World Engine | 唯一 Truth / Command-Rules-Mutation 闭环 / Event 输出 / NPC·Time·Memory 独立运行 / Persistence | ✅（宿主进程内闭环；网关/向量可选） |
| Tianqiong | 只负责 UI/表现 / 输入经会话门 / 状态经快照+事件 / 断开不停本地引擎 / 无第二真相 | ✅（逃生门为显式开发形态） |
| 通用性 | Game A 接入 / Game B 可复用 / Core 无天穹专属代码 / 游戏逻辑只在 Adapter·客户端 | ✅（会话协议 + world-engine 通用面；second-game 示例与 SDK-GUIDE 既有） |

全量回归：**122 文件 / 1746 用例全绿**（bridge 机制 6 文件删除后无残留）；`tsc --noEmit`
零错误；`eslint .` 零错误；客户端与服务端构建均通过。

---

## 四、遗留与后续（不在迁移方案范围内）

1. **SysPanel 网关指向**：面板 Key 输入目前只影响客户端表现层 AI（编织/场景叙事）；
   世界裁定 AI 的配置在宿主环境变量/转发——面板改为网关指向属产品 UI 迭代。
2. **多存档/多世界**：宿主一次托管一个存档；接 world-engine Registry 可扩展。
3. **离线模式**（可选产品化）：§22 停挡之外，若要"断线可玩、重提交互"，需要服务端
   出站队列 + 冲突仲裁——明确超出本方案，列为后续提案。

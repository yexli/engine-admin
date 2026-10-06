# 外置引擎迁移 · Phase 1 交付说明

> 方案：《World-Engine-Tianqiong完全脱离内置引擎实施方案》
> 前置交付：Phase 0 全量审计（[ENGINE-DEPENDENCY-AUDIT.md](./ENGINE-DEPENDENCY-AUDIT.md)）
> 本交付：**Phase 1（外部连接层）+ Phase 2 接入缝 + travel/wait 切片的 VRT 对照**
> 日期：2026-10-06

---

## 一、这次交付了什么

```text
Tianqiong
    ↓                        ← Phase 1 新建（唯一通道，全部收口）
WorldEngineClient (HTTP + WS)
    ↓
Game Adapter（scripts/world-host.mjs 宿主真实世界书）
    ↓
World Engine（独立进程，唯一 World Truth）
```

### 新增：外部连接层 `src/world-engine/`（方案 §七的目录落地）

| 文件 | 职责 |
|---|---|
| `client/WorldEngineClient.ts` | 连接层核心：connect / getWorld / getState / getEntity / getEvents / sendCommand（自动幂等键）/ sendIntent / subscribeEvents；连接状态机（idle/connecting/online/reconnecting/offline/closed）；断线自动重连（指数退避）；**断线补齐 = REST 事件史 + WS `?replay=N` 双窗口 + eventId 幂等去重**；断线期写操作抛 `WorldEngineOfflineError`——**绝不回落本地引擎**（方案 §22） |
| `client/types.ts` | wire 协议类型（与引擎 HTTP/WS 面同构；刻意不 import 引擎包——连接层只认协议） |
| `cache/worldCache.ts` | 客户端镜像：快照（权威）+ 事件增量 reducer（对齐引擎 emit 载荷）。**Cache ≠ Truth** 写在文件头 |
| `adapter/tianqiongSeed.ts` | 世界书（geo.json + people.json）→ `GameWorldSeed` 映射（TS 侧唯一实现） |
| `runtime/externalWorldRuntime.ts` | client+cache 组合：cmd()/getMirror()/onMirror()/onStatus()；重连成功自动做快照校验（方案 §22「定期 Snapshot 校验」） |
| `runtime/attachExternalWorld.ts` | 组合根装配：读开关 → 后台连引擎 → 状态汇报回调；首连失败自动重试 |
| `config.ts` | **`TIANQIONG_EXTERNAL_WORLD_ENGINE` 开关**（env `VITE_` 前缀 + localStorage `tq2_ext_engine_v1` 覆盖），端点缺省 `http://127.0.0.1:8798` / `tianqiong-main` |
| `index.ts` | 桶出口：游戏各层只允许从这里 import 外部引擎能力 |

### 新增：宿主与脚本

| 文件 | 说明 |
|---|---|
| `scripts/world-host.mjs` | **生产形态宿主**：真实世界书 → `hostGameWorld` → `startWorldServer`；FileSavePort 落盘 `.world-data/`（重启接续）；可选 API Key（`TIANQIONG_WORLD_KEY`）。`npm run host:world` |
| `scripts/lib/tianqiong-seed.mjs` | 种子映射的宿主侧镜像（Node 宿主不能 import src 的 TS）；与 TS 侧由 parity 测试钉死一致 |

### 接线：现有文件的增量（全部向后兼容）

| 文件 | 改动 |
|---|---|
| `src/main.tsx` | 组合根加一行 `attachExternalWorld()`（开关关闭 = no-op）+ HMR 卸载 |
| `src/store/useGame.ts` | 新增 `extWorld` 字段（连接态 + 引擎镜像水位，只喂显示） |
| `src/ui/overlays/ExtWorldBadge.tsx` | 新组件：连接指示徽标（online）／醒目重连提示（offline）；开关关闭时不渲染 |
| `src/App.tsx` | 挂载 `<ExtWorldBadge />` |
| `eslint.config.js` | 新增 `arch-external-client` 分层守卫：连接层禁 React/Zustand/UI/store/**本地引擎层** |
| `package.json` | `host:world` / `host:http` 脚本 |

---

## 二、怎么跑（验收路径）

```bash
# 1) 起外部引擎（终端 A）——宿主 63 地点 / 15 NPC / 10 关系
cd tianqiong && npm run host:world
#    → http://127.0.0.1:8798/v1/worlds/tianqiong-main（管理后台指向 /world-api 亦可看）

# 2) 开开关起游戏（终端 B）
#    PowerShell:  $env:VITE_TIANQIONG_EXTERNAL_WORLD_ENGINE='true'; npm run dev
#    浏览器右上角出现「外擎 D1·16刻」徽标 = 已连上引擎并镜像水位；
#    杀掉宿主进程 → 徽标变「重连中…」；重启宿主 → 自动恢复 online。

# 3) 测试（无需起服务，测试自管子进程）
npm test          # 全量（当前 1751 通过）
npx vitest run src/world-engine          # 连接层 25 用例
npx vitest run src/tests/ext-world-parity.test.ts   # VRT 对照
```

---

## 三、测试证据（新增 32 个用例，全绿）

| 测试文件 | 覆盖 |
|---|---|
| `src/world-engine/client/WorldEngineClient.test.ts`（8） | 对着**独立引擎进程**（生产拓扑）：connect 快照、travel/wait 意图→事实流回、commandId 幂等、断线写拒绝、**SIGKILL 杀进程→自动重连→双窗口补齐不重不漏**、close 停机、意图映射 |
| `src/world-engine/cache/worldCache.test.ts`（8） | 快照权威替换；对齐引擎 emit 载荷的事件增量（player_moved/entity_moved/npc_attitude_shift/weather_changed）；未知事实至少推进时间水位 |
| `src/world-engine/adapter/tianqiongSeed.test.ts`（5） | 种子契约（NPC 落点必须在地点表）、真实世界书规模 63/15、**TS 侧与宿主 mjs 侧 deep-equal**（两份实现不漂移） |
| `src/world-engine/config.test.ts`（5） | 开关 env/localStorage 解析、坏 JSON 容错 |
| `src/world-engine/runtime/attachExternalWorld.test.ts`（4） | no-op / 在线连上 / **引擎后出现→重试循环接回** / dispose 停机 |
| `src/tests/ext-world-parity.test.ts`（2） | **VRT 对照**（方案 §27 纪律）：同一 travel/wait 意图喂本地引擎与外部引擎（宿主同一份世界书），事实结果一致（落点相同、刻数增量相同） |

全量回归：**122 文件 / 1751 用例全部通过**（含既有 1719 个），`tsc --noEmit` 零错误，eslint（含新分层守卫）零告警。
宿主实机冒烟：`world-host.mjs` 起服 → REST `move` → state 落点 market → 存档文件落盘 ✓。

---

## 四、本次修复的存量问题

- `src/tests/world-engine-integration-verify.test.ts:49`：未用参数 `ms` 导致 `npm run build`（tsc --noEmit）失败——改为 `_ms`。

---

## 五、边界与诚实声明（哪些还没做）

1. **开关打开 ≠ 世界已外移**。当前开关只建立"外部连接 + 镜像 + 可见性"；游戏玩法（24 系统、NPC、时间驱动）仍跑在本地引擎上——这是绞杀式迁移的中间态（方案 §18 允许，台账见审计文档 §九）。
2. **Phase 2 的 UI 读面未切**：TopBar/SceneView 仍读 `core.S`；`extWorld` 镜像目前只喂徽标显示。切读面是下一步（每切一个面板做一次 VRT）。
3. **Phase 3 的命令面未切**：仅 travel/wait 双通道打通并有对照；其余 ~38 条 GameCommand 需逐条 registerRule 挂到引擎再对照。
4. **WS 无 sequence 游标**（引擎面限制，见审计 §八缺口 1）：补齐依赖 eventId 幂等 + 窗口，超过窗口的历史缺口靠快照校验收敛。
5. 测试在 Windows 上偶发端口占用时 ⑤ 号用例会红（随机 18798-18897 段）；重跑即恢复。

---

## 六、下一步（按台账顺序）

1. **Phase 2 读面切换**：TopBar 时间/位置、SceneView 在场列表改读 `extWorld` 镜像（引擎权威），逐面板 VRT。
2. **Phase 3 命令面**：把 `go/travel/rest` 等低风险 GameCommand 以 `registerRule` 挂到引擎（宿主侧规则包），客户端 dispatch 改发 Intent；每条命令一次对照。
3. **Phase 6 时间驱动**：引擎侧 scheduler 定时 `advance_time`，退役 `useAutoFlow` 的 setInterval。
4. Phase 5/7/8（NPC/Memory/AI）依台账。

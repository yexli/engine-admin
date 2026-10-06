# 外置引擎迁移 · Phase 8（world-gateway 接入）交付说明

> 前置：Phase 3 会话托管、Phase 4/8 前置 事件流与 AI 注入
> 本交付：**world-gateway 接入会话宿主——AI Cloud Layer（方案 §65）在 session 档落地**
> 日期：2026-10-06

---

## 一、这次交付了什么

session 档的 AI 装配升级为三档优先级，方案 §65 的「模型名 = 能力通道」第一次在
天穹的世界裁定栈上完整落地：

```text
客户端命令 → 会话门 → 服务端 AiPort（openai-compat 适配器）
    → world-gateway（模型名 = §65 六角色：intent/npc/reasoning/narrative/memory/embedding）
        → 路由器（角色 → 能力标签 → 模型）→ 上游提供方（apiKeyRef:{env} 网关侧持钥）
```

### 三档优先级（`server/game-host.ts` buildAiPort）

| 档 | 触发 | 钥匙位置 |
|---|---|---|
| ① **gateway 外联** | `TIANQIONG_GAME_GATEWAY=http://…`（已有网关服务） | 网关侧 |
| ① **gateway 内嵌** | `TIANQIONG_GAME_GATEWAY_EMBED=1`（宿主自起网关，`_PORT` 可调） | 网关侧（`apiKeyRef:{env}`，调用时从环境解析，配置文件里只有变量名） |
| ② 转发档 | 客户端 `POST /game/ai-config` 注入本地 LlmConfig（Phase 4/8 前置通道，沿用） | 客户端转发（迁移过渡形态） |
| ③ ruleSim 兜底 | 以上皆无 | —（世界照常转） |

gateway 档激活时转发配置被**显式忽略**（响应带 `gateway:true`）——钥匙不再经手客户端。
内嵌上游两种来源：远端 OpenAI 兼容端点（`TIANQIONG_GAME_AI_UPSTREAM` + `TIANQIONG_GAME_AI_KEY_ENV`
+ `TIANQIONG_GAME_AI_WIRE`，经 `createModelRouter + routedProvider`）或
`TIANQIONG_GAME_AI_FAKE=1` 假上游（确定性回包 + 调用清单 `/game/__aicalls`，测试钩子）。

### 通道映射

宿主 LlmConfig 指向网关：`tiers.light → 网关模型 'intent'`（快通道）、
`tiers.heavy → 'npc'`（角演通道）、主模型 `intent` 兜底、向量走 `'memory'` 角色——
全部经既有 `channelRoutes`/`tiers` 机制，**适配器一行未改**。

### 进程韧性（顺手加固）

宿主补了 `unhandledRejection` / `uncaughtException` 观测（`fs.writeSync` 直写
stderr——SIGKILL 会丢用户态缓冲，同步写是崩溃现场留得下来的唯一方式）。
游戏服务器不该被一次坏延续打死；异步延续里的异常就地留痕、进程不死。

---

## 二、怎么跑

```bash
# 内嵌网关 + 真上游（DeepSeek 示例）：
# PowerShell:
#   $env:TIANQIONG_GAME_GATEWAY_EMBED='1'
#   $env:TIANQIONG_GAME_AI_UPSTREAM='https://api.deepseek.com/v1'
#   $env:TIANQIONG_GAME_AI_KEY_ENV='DEEPSEEK_KEY'      # 钥匙放系统环境变量
#   $env:TIANQIONG_GAME_AI_WIRE='deepseek-chat'
#   npm run host:game
# 或外联已有网关：$env:TIANQIONG_GAME_GATEWAY='http://127.0.0.1:8788'
```

---

## 三、测试证据（新增 1 用例，全量 127 文件 / 1766 用例全绿）

`src/tests/ext-session-gateway.test.ts`（内嵌网关 + 假上游，真实进程 + 真实 HTTP）：

| 断言 | 结果 |
|---|---|
| ① health 如实回报 `ai: openai-compat · intent @ 网关` | ✅ |
| ② 网关 `/v1/models` 暴露 §65 六角色 | ✅ |
| ③ freeText 命令触发 intent 通道调用（`__aicalls` 观测到 `【fake:intent】…` 回包；解析失败自动落正则兜底——断言的是调用发生） | ✅ |
| ④ 网关档优先：转发配置被忽略（`gateway:true`） | ✅ |

`tsc --noEmit` 零错误；`eslint .` 零错误。

---

## 四、已知边界

1. **客户端 Key 面板未改**：session 档 + gateway 档下，系统面板的 Key 输入只影响
   客户端表现层（场景叙事等），世界裁定的 AI 走网关——面板指向网关的 UI 改造留待
   Phase 9 一并做（默认档翻转时的配套）。
2. **编织仍缺**（同前）：§30 归客户端表现层，session 档本地编织待实现。
3. **内嵌网关暂无鉴权**（world-gateway 缺省 loopback 无鉴权）——与引擎 http 层
   同一安全基线：本机使用形态；对外部署时接平台层。

---

## 五、下一步（按台账）

1. **编织归还客户端**：session 档按快照 logSeq 差分做本地编织（表现层）。
2. **Phase 9**：session 档翻默认档（含 SysPanel 网关指向改造）→ 断线语义切 §22 停摆 → **Phase 10** 删除本地裁定栈。

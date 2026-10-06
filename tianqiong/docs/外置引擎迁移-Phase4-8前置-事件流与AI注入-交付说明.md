# 外置引擎迁移 · 会话事件流 + AI 注入（Phase 4/8 前置）交付说明

> 前置：Phase 3 会话托管（[Phase3 交付说明](./外置引擎迁移-Phase3-会话托管-交付说明.md)）
> 本交付：**SSE 事件流 + 迟到事实收敛 + 服务端 AI 配置注入（真模型可用）**
> 日期：2026-10-06

---

## 一、这次解决了什么

Phase 3 的会话托管有一个结构性缺口：**裁定是同步的，但世界不全是同步的**。
聊天回话（chatAsync）、意图解析后的多步行动、AI 后续落地……这些异步延续在
服务端落地后，客户端只能等"下一条命令"才能从快照里间接看到——聊天窗会
明显迟滞。本次补齐三件事：

1. **事件环 + SSE 实时流**（宿主）：每条事实盖单调 `_seq`，进环（1000 条）
   并实时推给 `GET /game/events/stream?after=N`（SSE，含补发 + 15s 心跳；
   纯 node:http 零依赖）；另备 `GET /game/events?after=N` 轮询兜底。
2. **客户端迟到事实收敛**（extSession）：订阅 SSE，按 `_seq` 去重后原样
   重放到 bus；凡迟到事实意味着服务端状态变了 → 250ms 合并窗口后拉一次
   `/game/state` 重灌投影（Cache 追平 Truth）。
3. **AI 配置注入**（Phase 8 前置）：`POST /game/ai-config` 把客户端本地
   已配的 LlmConfig（localStorage `tq2_ai_cfg_v1`，含 Key/分档路由/向量）
   转发给宿主；宿主用**同一个** `OpenAiCompatAdapter` 装配服务端 AiPort
   （chat/intent/decide/greet/narrative + 向量通道，`applyEmbeddingProvider`
   接记忆检索），`narrateAsync` 恒摘（§30 编织归客户端表现层）。
   无头部署走环境变量 `TIANQIONG_GAME_AI`（JSON）。都没配 = ruleSim 兜底。
   玩家改配置（系统面板保存）→ `onLlmConfig` 触发自动重转发。

> 迁移期说明：客户端把 Key 发给本机会话宿主是过渡形态；Phase 8 收尾时
> 换 world-gateway 统一持钥（`apiKeyRef:{env}`），客户端不再经手 Key。

---

## 二、改动清单

| 文件 | 改动 |
|---|---|
| `server/game-host.ts` | 事件环 + `_seq` 盖戳；SSE 流端点；`/game/events` 轮询；`/game/ai-config`；测试钩子 `/game/__emit`（env 守卫）；health 增 `ai`/`lastSeq`；`buildAiPort()`（ruleSim ↔ openai-compat 热切换 + 向量接线） |
| `src/world-engine/client/gameSession.ts` | `readSse`（协议层，fetch 流式读，浏览器/Node 通用）；`streamEvents` / `eventsSince` / `setAiConfig`；`SessionEvent._seq` |
| `src/plugins/extSession.ts` | `_seq` 水位去重；SSE 订阅（上线即启）；迟到事件重放 + 合并重同步；AI 配置转发 + `onLlmConfig` 跟随 |
| `src/tests/ext-session-stream.test.ts` | **新**：4 用例（见下） |

---

## 三、测试证据（新增 4 用例，全量 126 文件 / 1765 用例全绿）

| 用例 | 断言 |
|---|---|
| readSse 协议层 | 帧切分、跨块多帧、心跳注释忽略、结束返回、abort 静默 |
| 命令事实 tee | 命令响应与 SSE 流同达（宿主把同一事件既回响应又推流） |
| **迟到事实全链路** | `__emit` 合成事实 → SSE 推送 → 客户端 bus 重放 → 250ms 合并 → 投影重同步（report 可观测）；`?after=last` 补发为空（不重放） |
| AI 配置注入 | 缺省 rule；缺 Key 配置仍 rule；字段齐全（假端点）切 openai-compat（health 如实回报）；清配置回落 rule |

`tsc --noEmit` 零错误；`eslint .` 零错误。

---

## 四、已知边界

1. **编织仍缺**：服务端恒摘 narrateAsync（§30），客户端 session 档的本地编织未实现——见闻录为规则文本。
2. **Key 过渡形态**：客户端转发 Key 到本机宿主（localhost 单用户）；world-gateway 统一持钥后移除。
3. **场景叙事双轨**：SceneView 的 `narrativeAsync` 仍是客户端直连（UI 表现层），世界裁定内嵌 AI（chat/intent/decide）在服务端——Phase 8 收尾统一进网关。

---

## 五、下一步（按台账）

1. **Phase 8 收尾**：宿主接 world-gateway（模型名=通道 + 能力路由），Key 迁到网关侧；客户端 Key 输入面板改为指向网关。
2. **编织归还客户端**：session 档在客户端按快照 logSeq 差分做本地编织（表现层）。
3. **Phase 9**：session 档翻默认档 → 断线语义切 §22 停摆 → Phase 10 删本地裁定栈。

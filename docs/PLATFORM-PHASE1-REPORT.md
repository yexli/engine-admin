# World Platform Phase 1 验收报告（平台 API 标准化）

> 日期：2026-09-30 · 依据：《下一阶段平台化规划》§6（Phase 1）、§37（执行原则）、§38（第一优先级：最小商业闭环）
> 被测：`platform/`（world-platform 0.1.0，新增包）× World Engine（真实）× AI Gateway（真实/脚本化）

## 一、本阶段做了什么（严格一个阶段）

**目标（方案 §6）：把现有内部 HTTP API 整理成稳定的 Public API，区分 Public / Admin / Internal 三层。**

新增 `platform/` 包（零运行时依赖，与 engine/gateway 同构：纯协议适配器 + node:http 薄壳），
**未修改 World Engine / Gateway / Memory / admin-web 任何一行**：

```text
platform/src/
├── types.ts                 # 密钥/路由/管线契约
├── keys/keystore.ts         # API Key：SHA-256 落盘、明文仅创建时返回、撤销/过期
├── auth.ts                  # Bearer 鉴权 + 权限检查（401/403 语义）
├── tasks.ts                 # 任务分析：显式 capability > 关键词规则 > 缺省（可解释）
├── router/modelrouter.ts    # Capability → 主/备模型；30s 失败冷却自动回切
├── upstream/engine.ts       # 引擎客户端：worlds 透传 + state/events 读取
├── upstream/gateway.ts      # 网关客户端：world-agent 非流式调用 + 保真流式代理
├── worldagent/context.ts    # 世界事实 → system 上下文（World Truth 注入）
├── worldagent/pipeline.ts   # world-agent 管线 + OpenAI 兼容响应组装
├── http/protocol.ts         # 纯路由协议：三层边界 + 鉴权 + 透传/管线
├── http/server.ts           # node:http 壳：2MiB 上限、request-id、CORS、访问日志
└── config.ts                # 环境变量 → 运行配置（全部有安全缺省）
```

## 二、Public API（v1，稳定形状）

鉴权：除 `/healthz` 外全部要求 `Authorization: Bearer sk-world-...`；
权限码：`chat:completions` / `worlds:read` / `worlds:write`（与 Admin 权限模型同族）。

| 端点 | 层 | 说明 |
|---|---|---|
| `GET /healthz` | 公共免鉴权 | 探活 |
| `GET /v1/models` | Public | 只暴露 `world-agent`（底层通道/厂商不外露，方案 §2.1） |
| `POST /v1/chat/completions` | Public | `model=world-agent` → 平台管线；其他模型 → 鉴权后保真代理（含 SSE） |
| `POST /v1/worlds` | Public | 透传引擎（worlds:write） |
| `GET /v1/worlds` / `{id}` / `{id}/state` / `{id}/events` | Public | 透传引擎（worlds:read） |
| `POST /v1/worlds/{id}/commands` / `time` | Public | 透传引擎（worlds:write） |
| `/v1/admin/*` | Admin | **501 占位**：形状已定，真实化在 Phase 4/9（Admin Web 的 Mock 不受影响） |
| Internal | — | 不在公共端口暴露任何内部端点 |

**world-agent 响应**：标准 OpenAI `chat.completion` + 附加 `platform` 元数据
（capability / task_reason / model_used / fallback_used / world_id）——
OpenAI SDK 兼容（附加字段），调试信息不破坏协议。

错误统一 OpenAI 形状：`{ error: { message, type, code } }`；
`401 invalid_api_key`、`403 insufficient_permission`、`404 world_not_found`、
`503 no_model_configured`（能力未配模型，提示检查 router.json）、`502 upstream_error`。
失败诚实可见——不假装修好。

## 三、最小商业闭环实测（方案 §38）

```text
用户 → 获得 API Key（keyctl 签发）→ 配置 Base URL → model=world-agent
     → 本地游戏发送 OpenAI 格式请求
     → World Platform：鉴权 ✓ → 任务分析 ✓ → 能力路由 ✓
     → World Engine：世界事实注入上下文 ✓
     → AI Gateway：模型调用 ✓ → 结果整合（OpenAI 响应）✓
     → 游戏继续运行（同 Key 执行 world command）✓
```

演示脚本（自含引擎/网关/平台，可重复执行）输出：

```text
[4] POST /v1/chat/completions  model=world-agent  world=w-demo
    HTTP 200  model: world-agent
    content: （npc 通道回应）我知道你在酒馆，莉安对你态度不错。你说：「莉安还在酒馆吗？…」
    capability: roleplay（携带世界上下文，缺省 roleplay）  model_used: npc
[5] POST /v1/worlds/w-demo/commands → ok=true events=["evt_1_4"]
[6] 无 Key 访问 → HTTP 401
```

真实部署模式实测（平台 :8790 + 真实引擎 :8787）：
`/healthz` ✓、`/v1/models` 只含 world-agent ✓、`/v1/worlds` 返回真实引擎数据 ✓、
无 Key 401 ✓、网关离线时 world-agent 返回诚实 502（含主备模型诊断）✓。

## 四、测试

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | ✅ 0 错误 |
| `vitest run`（4 文件 36 用例） | ✅ 全部通过 |
| keystore 单测 | 创建/验证/撤销/过期/持久化/bootstrap 不落盘 |
| 任务分析/路由单测 | 规则分类、冷却回切、未配置 503 语义、seed 幂等 |
| 协议单测（注入假上游） | 三层边界、401/403/404/501/502/503、管线全分支（世界缺失/主备切换/全挂/流式拒绝/参数校验） |
| **闭环集成测试** | 真实引擎服务 + 真实网关服务 + 平台服务（port 0）：`world-agent` 全链路（断言上游确实收到世界上下文）、worlds 透传真实数据、权限隔离 403 |
| 演示脚本 | `demo-minimal-loop.mjs` 端到端 ✓ |

## 五、安全基线（Phase 1 范围内）

- 密钥明文只在创建响应出现一次；落盘仅 SHA-256 哈希 + 展示前缀；文件损坏拒绝静默重建。
- 撤销/过期立即失效；无 Key 统一 401（不泄露密钥存在性）。
- 默认只绑 127.0.0.1；CORS 默认 `*`（Bearer 鉴权无 CSRF 面）但可配置收紧；请求体 2 MiB 上限。
- 每请求 `x-request-id`（响应头 + 访问日志），为 Phase 9/12 可观测性播种。
- 已知边界：Phase 1 无速率限制/配额/审计（Phase 9/10）；无 HTTPS（公共部署自备反代）。

## 六、验收对照（方案 §38 清单 → 本阶段覆盖）

| §38 环节 | 状态 |
|---|---|
| 获得API Key | ✅ keyctl（Phase 2 由 Admin API/租户体系承接） |
| 配置 Base URL + world-agent | ✅ 单一公共入口 |
| 本地游戏发送请求 | ✅ OpenAI 兼容（SDK/SillyTavern 形状一致；正式兼容性验证在 Phase 7） |
| World Platform（鉴权/路由） | ✅ |
| World Engine / Memory | ✅ 引擎真实接入；Memory 服务化在 Phase 5（管线已预留世界上下文注入点） |
| 返回结果、游戏继续运行 | ✅ 同一 Key 执行 world commands |

## 七、按方案边界未做（后续阶段）

- Phase 2：Tenant/User/Membership/配额（密钥已带 `tenantId` 前向字段）
- Phase 3：World 生命周期平台化（CREATE/PAUSED/…，需引擎侧设计）
- Phase 4：Provider Registry 产品化（当前路由表文件配置，模型=网关通道名）
- Phase 5：Memory Service 产品化（管线已留注入点）
- Phase 6-7：天穹/SillyTavern 正式接入与兼容性验证
- Phase 8-10：PostgreSQL/Redis、限流/配额/审计、Trace 体系

## 八、运行状态与复现

```bash
# 当前本机已验证的服务
node scripts/run-demo-engine.mjs      # 引擎 :8787
cd platform && pnpm build && node scripts/run-platform.mjs   # 平台 :8790
cd platform && node scripts/keyctl.mjs create --name <名称>   # 签发密钥
cd platform && node scripts/demo-minimal-loop.mjs             # 一键闭环演示
```

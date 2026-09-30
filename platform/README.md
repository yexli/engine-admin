# World Platform（Phase 1 · 平台 API 标准化）

> 把「引擎 + 网关 + 记忆」组合成可被外部应用调用的公共 API 入口。
> 方案：`docs/World-Driving-Engine-Admin完成后-下一阶段平台化规划(1).md` §6（Phase 1）、§38（最小闭环）。

## 这是什么

```text
本地游戏 / Agent / SillyTavern / 第三方应用
        │  只需三个配置：Base URL + API Key + model
        ↓
World Platform（本包，公共入口，默认 127.0.0.1:8790）
        │  鉴权 → 分层 → 任务分析 → 能力路由
        ├──── /v1/worlds*   ──→ World Engine（8787，权威实现，透传）
        └──── /v1/chat/*    ──→ AI Gateway（8788，模型能力通道）
```

- **world-agent** 是平台级虚拟模型：世界上下文注入 + 任务分析 + 能力路由，
  客户端永远不需要知道底层是哪个厂商的模型。
- **非 world-agent 模型**：平台是「加了鉴权的保真代理」，请求/响应（含 SSE 流）原样转发。
- **分层**：Public（`/v1/*`）现在可用；Admin（`/v1/admin/*`）本阶段 501 占位；
  Internal 完全不暴露。

## 快速开始

```bash
# 0) 前置：引擎与网关在跑（或用演示脚本自起）
node scripts/run-demo-engine.mjs          # 工作区根目录，引擎 :8787

# 1) 构建
cd platform && pnpm install && pnpm build

# 2) 签发 API Key（明文只显示一次）
node scripts/keyctl.mjs create --name my-game
node scripts/keyctl.mjs list
node scripts/keyctl.mjs revoke <key-id>

# 3) 启动平台（默认 :8790；可用环境变量覆盖，见 src/config.ts）
node scripts/run-platform.mjs

# 4) 像任何 OpenAI 兼容客户端一样调用
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer sk-world-..." \
  -H "content-type: application/json" \
  -d '{"model":"world-agent","world":"w-main","messages":[{"role":"user","content":"周围有什么？"}]}'
```

一条命令跑通 §38 最小商业闭环（自含引擎/网关/平台，无需预置服务）：

```bash
node scripts/demo-minimal-loop.mjs
```

## 配置（环境变量）

| 变量 | 缺省 | 说明 |
|---|---|---|
| `PLATFORM_PORT` / `PLATFORM_HOST` | 8790 / 127.0.0.1 | 监听；公共部署必须显式 host + 反代/TLS |
| `ENGINE_BASE_URL` | http://127.0.0.1:8787 | World Engine |
| `GATEWAY_BASE_URL` | http://127.0.0.1:8788 | AI Gateway |
| `PLATFORM_DATA_DIR` | `./data` | 密钥与路由文件目录（已 gitignore） |
| `PLATFORM_KEYS_FILE` / `PLATFORM_ROUTER_FILE` | data 目录内 | 显式指定文件路径 |
| `PLATFORM_BOOTSTRAP_KEY` | 无 | 运维主密钥（不落盘；仅应急用） |
| `PLATFORM_CORS_ORIGIN` | `*` | 浏览器客户端来源；公共部署建议收紧 |
| `PLATFORM_ACCESS_LOG` | 1 | 访问日志（每请求一行，含 request-id） |

## 开发

```bash
pnpm test        # vitest：36 个用例（含真实引擎+网关的全链路闭环）
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc → dist/
```

阶段报告与验收记录：`../docs/PLATFORM-PHASE1-REPORT.md`

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

## 受管模式（Model Control Plane · 推荐）

一个进程组合 受管 Gateway + 受管 Platform + 私有管理监听：在 Admin Web
录入 OpenAI 兼容供应商与凭证、注册真实模型、给六能力指派主/备模型，
**保存即时生效，无需重启**。

```bash
# 前置：先构建 world-engine/gateway（平台以 link 依赖其 dist）
cd world-engine/gateway && pnpm build

cd platform && pnpm install && pnpm build

# 启动（缺任一变量直接拒绝启动——fail closed）
PLATFORM_ADMIN_TOKEN=$(openssl rand -hex 24) \
PLATFORM_SECRET_MASTER_KEY=$(openssl rand -hex 32) \
node scripts/run-managed.mjs
#   public  : 127.0.0.1:8790  公开 API（客户端只见 world-agent）
#   admin   : 127.0.0.1:8791  私有管理监听（仅回环）
```

| 变量 | 缺省 | 说明 |
|---|---|---|
| `PLATFORM_ADMIN_TOKEN` | **必填** | 管理面令牌：由服务端反代注入 `x-admin-token`，**绝不**进浏览器 JS / `VITE_*` / 日志 |
| `PLATFORM_SECRET_MASTER_KEY` | **必填** | 上游凭证 AES-256-GCM 加密主密钥（丢失 = 凭证不可解密，需回滚密钥文件） |
| `PLATFORM_ADMIN_PORT` / `PLATFORM_ADMIN_HOST` | 8791 / 127.0.0.1 | 管理监听（host 仅允许回环地址） |
| `PLATFORM_MODEL_CONFIG_FILE` / `PLATFORM_SECRETS_FILE` | data 目录内 | 版本化模型配置 / 加密凭证库 |
| `PLATFORM_UPSTREAM_HOST_ALLOWLIST` | 空（不限） | 出站上游主机名允许列表（逗号分隔，支持 `*.suffix`） |
| `PLATFORM_UPSTREAM_ALLOW_LOOPBACK` | 0 | 是否允许环回/私有网段上游（本地推理服务器设 1） |
| `PLATFORM_UPSTREAM_TIMEOUT_MS` | 60000 | 出站上游调用超时 |
| `MANAGED_GATEWAY_PORT` | 自动 | 受管 Gateway 内部回环端口 |

安全姿态：

- 管理面独立监听、仅回环；令牌常量时间比较；`authorization` 头一律忽略
  （浏览器持有的公共 API Key 借道不了管理面）；写请求拒绝非回环 Origin；
- 上游凭证 AES-256-GCM 加密落盘，配置/响应/日志只有 `secretId` 引用；
  每次替换生成新版本，旧版本保留用于回滚；
- 出站上游是特权输入：URL 策略（仅 http/https、拒绝内嵌凭据/fragment、
  可选主机允许列表）+ DNS 解析策略（防 rebinding 到内网）；
- 上游拒绝凭证（401/403）显式上报 `upstream_credential_rejected`，
  **不进冷却**——配置错误要可见，修复后立即可用；
- 未配置模型的能力对 world-agent 诚实返回 `503 no_model_configured`。

### Admin Web 接入

开发态：`admin-web` 目录 `PLATFORM_ADMIN_TOKEN=<同上> PLATFORM_ADMIN_TARGET=http://127.0.0.1:8791 npx vite`
——Vite 把同源 `/control-api/*` 改写到管理监听并在服务端注入令牌
（见 `admin-web/vite.config.ts`，开发服务器仅绑 127.0.0.1）。

生产态：`admin-web/nginx.conf.template` 提供同源 `/control-api` 路由 +
令牌注入 + 独立公共 API 路由；**TLS 在入口层终结**（或自配 `listen 443 ssl`）。
在入口保护配置好之前，把管理面暴露到真实网络属于不受支持的部署。

### 旧配置迁移（显式操作）

旧 `data/router.json` 的路由值是 Gateway 通道名（npc/narrative…），不是物理
模型——迁移必须显式映射，工具只生成候选文件、从不覆盖现有配置：

```bash
node scripts/migrate-router.mjs \
  --from data/router.json \
  --model mdl-ds=deepseek-chat --model mdl-ds-r=deepseek-reasoner \
  --map npc=mdl-ds --map narrative=mdl-ds --map reasoning=mdl-ds-r \
       --map memory=mdl-ds --map fast=mdl-ds --map cheap=mdl-ds
# 人工审阅 data/model-config.candidate.json → 补端点/凭证/tags → Admin Web 激活
```

### 回滚

每次配置提交保留上一版本（`model-config.json.bak`），密钥库追加式保留全部
历史版本。`POST /v1/admin/model-config/rollback`（带 If-Match）恢复上一版本
并热替换运行时快照；旧凭证引用仍可解析。独立旧入口
`scripts/run-platform.mjs` 继续可用，作为应急通道——它不是第二配置写入口。

## 开发

```bash
pnpm test        # vitest：含真实引擎+网关闭环、配置/密钥、管理 API、受管模式 E2E
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc → dist/
```

阶段报告与验收记录：`../docs/PLATFORM-PHASE1-REPORT.md`

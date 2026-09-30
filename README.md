# 世界驱动引擎全套带管理端

#### 介绍
世界驱动引擎，引擎+管理端

---

## 软件架构

四个部分构成「引擎内核 → 平台 API → 管理后台 → 演示宿主」的完整链路：

```text
.
├── world-engine/              ① 世界引擎核心（world-engine 1.0.0）
│   ├── gateway/               子包 world-gateway 0.7.0 —— AI 网关，默认 :8788
│   ├── memory/                子包 world-memory 0.8.0 —— 记忆引擎
│   ├── src/                   runtime / command / rules / mutate / state / events / time / http / api
│   └── package.json           build / test / typecheck
│
├── platform/                  ② 平台公共 API 入口（world-platform 0.1.0）
│   └── src/                   auth · keys · router · tasks · upstream · worldagent · http
│
├── admin-web/                 ③ 管理后台前端（6.2.0，基于 vue-pure-admin thin 6.2.0 定制）
│
└── scripts/
    └── run-demo-engine.mjs    ④ 引擎宿主启动脚本（暂代正式宿主）
```

### 数据流

```text
第三方应用 / 本地游戏 / Agent
        │  Base URL + API Key + model
        ▼
platform  :8790     鉴权 → 分层 → 任务分析 → 能力路由
        ├── /v1/worlds*  ──→ world-engine  :8787   权威世界状态（透传）
        └── /v1/chat/*   ──→ world-gateway :8788   模型能力通道
                                   │
                            world-memory        记忆引擎

admin-web :8848     管理后台，直连 world-engine :8787 / gateway :8788
```

### 各模块职责

- **world-engine** —— 与具体应用无关的世界模拟内核。`Command → Runtime → Rules → Mutation → State → Event`。可独立运行、独立测试，经 Adapter 被多个游戏与 AI 应用复用。
- **world-gateway**（`world-engine/gateway/`）—— 多模型编排管线，对上层提供统一的模型能力通道。
- **world-memory**（`world-engine/memory/`）—— 独立记忆引擎，负责世界记忆的写入、检索与召回。
- **platform** —— 把「引擎 + 网关 + 记忆」组合成可被外部应用调用的公共 API 入口；`world-agent` 是平台级虚拟模型（世界上下文注入 + 任务分析 + 能力路由）。
- **admin-web** —— 管理后台前端，用于世界 / NPC / 事件 / 密钥 / 路由的运维操作。
- **scripts/run-demo-engine.mjs** —— 演示用宿主：注册表模式（多世界）监听 `127.0.0.1:8787`，预建演示世界便于后台联调。不修改 engine 任何代码，仅作宿主集成示例。

## 安装教程

前置：Node.js ≥ 20。

```bash
# ① 引擎核心（npm）
cd world-engine
npm install
npm run build            # tsc → dist/
npm test                 # vitest

# ② 平台 API（pnpm）
cd ../platform
pnpm install
pnpm build
node scripts/run-platform.mjs        # 默认 127.0.0.1:8790

# ③ 管理后台（pnpm）
cd ../admin-web
pnpm install
pnpm dev                 # 默认 http://localhost:8848
```

## 使用说明

```bash
# 演示宿主：注册表模式（多世界）+ 两个演示世界，监听 127.0.0.1:8787
node scripts/run-demo-engine.mjs
```

管理后台代理目标见 `admin-web/.env`：

| 变量 | 缺省 | 说明 |
|---|---|---|
| `VITE_WORLD_API_URL` | `http://127.0.0.1:8787` | World Engine HTTP API |
| `VITE_GATEWAY_API_URL` | `http://127.0.0.1:8788` | AI Gateway HTTP API |
| `VITE_PORT` | `8848` | 管理后台本地端口 |

平台侧环境变量（`PLATFORM_PORT` / `ENGINE_BASE_URL` / `GATEWAY_BASE_URL` / `PLATFORM_DATA_DIR` 等）见 `platform/README.md`。

## 仓库约定

- `node_modules/`、`dist/`、`.mimosa/` 为可再生产物，不入库。
- `platform/data/` 存放 API Key 与路由表（运行时数据），不入库。
- `scripts/run-demo-engine.mjs` 依赖 `world-engine/dist/`，运行前需先 `npm run build`。
- 各包的完整文档在各自目录的 `README.md`。

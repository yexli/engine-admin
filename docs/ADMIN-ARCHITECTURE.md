# Admin Web 架构（ADMIN-ARCHITECTURE）

> World Driving Engine V1.0 管理后台 · 基于 vue-pure-admin 官方精简版（pure-admin-thin 6.2.0）
>
> 核心原则：**只建设 Admin Web，不修改 World Engine V1.0 核心架构。**

## 1. 总体架构

```text
Admin Web（admin-web，Vue 3 + TS + Vite + Element Plus + Pinia + Tailwind）
        ↓  HTTP（同源 + vite 代理）
   ┌────┴──────────────────────┐
   │ /world-api → 127.0.0.1:8787 │  World Engine HTTP API（真实）
   │ /gateway-api → 127.0.0.1:8788 │  AI Gateway（OpenAI 兼容代理，真实）
   │ /admin-api → vite mock      │  管理面聚合 API（第一版 Mock，见 API-GAP）
   └───────────────────────────┘
```

## 2. 严格边界（已遵守）

```text
允许：Admin Web → HTTP API → World Platform
禁止：Admin Web → 直接数据库
禁止：Admin Web → import World Engine 内部模块
```

- 未修改 `world-engine/` 任何源码；`scripts/run-demo-engine.mjs` 仅通过引擎公开 API
  （`createWorldRegistry` / `startWorldServer`）做宿主集成演示。
- 未修改 pure-admin 基础架构（layout / store / http / 路由机制未动），
  全部业务通过 `src/views`、`src/api`、`src/router/modules`、`src/store/modules` 扩展。
- 唯一的基础设施改动（均为缺陷修复或既有扩展点）：
  - `build/plugins.ts`：停用 `vite-plugin-remove-console`（Windows/中文路径下 external
    白名单失效，会把 iconfont.js 破坏成非法语法导致构建失败）。
  - `src/components/ReIcon/src/offlineIcon.ts`：按 pure-admin 官方机制注册离线菜单图标。
  - `vite.config.ts`：新增 `/world-api`、`/gateway-api` 代理（模板预留的 proxy 配置位）。

## 3. 目录结构

```text
admin-web/
├── mock/                        # vite-plugin-fake-server mock
│   ├── login.ts                 # 三角色登录（admin / operator / viewer）
│   ├── asyncRoutes.ts           # 动态路由预留（当前返回空）
│   └── admin/                   # 管理面 Mock 数据
│       ├── dashboard.ts  extensions.ts  gateway.ts
│       ├── memory.ts     observability.ts  system.ts
│       └── _utils.ts
├── src/
│   ├── api/                     # 统一 API Client（页面禁止散落 fetch/axios）
│   │   ├── types.ts             # 引擎契约镜像类型
│   │   ├── world.ts             # 真实：/world-api/v1/*
│   │   ├── entity.ts / location.ts / relation.ts / runtime.ts
│   │   │                        #   从 GET /state 派生（引擎无独立端点）
│   │   ├── event.ts / command.ts # 真实：events / commands（含真实命令目录）
│   │   ├── extension.ts / rule.ts / provider.ts / model.ts / router.ts
│   │   ├── pipeline.ts / apiKey.ts / usage.ts / memory.ts / logs.ts
│   │   ├── system.ts / dashboard.ts   # Mock：/admin-api/*
│   ├── composables/             # useAsyncData（Loading/Empty/Error 三态）、usePolling
│   ├── store/modules/world.ts   # 跨页共享：世界清单 + 当前世界上下文
│   ├── components/
│   │   ├── WorldSelect/         # 全局世界选择器
│   │   └── JsonView/            # JSON 展示 + 复制
│   ├── router/modules/          # 8 个业务路由模块（自动 glob）
│   └── views/                   # 27 个业务页面（见 §4）
└── ...
```

## 4. 菜单与页面（27 页）

| 模块 | 页面 | 数据来源 |
|---|---|---|
| Dashboard | 总览（指标卡/活动图/Recent Errors/World Runtime 表） | 引擎直读 + Mock 聚合 |
| 世界管理 | 世界列表、世界详情（8 Tab） | **真实** /world-api |
| 世界运行 | State / Entities / Locations / Relations / Events / 命令调试台 / Scheduler / Runtime Monitor | 真实（state/events/commands 派生）；Scheduler 为 API Gap 占位 |
| 扩展管理 | Extensions / Rules / 扩展命令 | Mock |
| AI Gateway | Providers / Models / Model Router / Pipelines / API Keys / Usage | Mock（Providers 页含真实网关联通测试） |
| Memory | Stores / Memories / Retrieval 调试 / Embedding | Mock |
| 运行监控 | Logs / 事件流 / AI Calls / Errors | Mock |
| 系统 | 用户 / 权限 / 设置 / System Status | Mock（Status 页含真实引擎直探） |

世界详情 Tabs 与独立 Runtime 页面**复用同一组组件**
（`src/views/runtime/components/*Panel.vue`），传入 `worldId` 即可。

## 5. 关键设计

- **API 纪律**：所有请求经 `src/api/*`（pure-http 实例），页面零散落 fetch/axios。
- **三态原则**：所有页面 Loading / Empty / Error 处理（`useAsyncData` 统一封装，
  错误给出可读原因 + 重试按钮；引擎不可达在 Dashboard/世界列表有全局提示条）。
- **真实/Mock 分层**：页面上的 Mock 数据均有显式提示条标注「Mock + 见
  ADMIN-API-GAP.md」；真实数据（Worlds/State/Events/Commands/Runtime 直探）无此标注。
- **命令执行安全**：命令调试台执行前强制 `ElMessageBox.confirm` 警示「会修改 World
  State」；执行后展示 CommandResult（ok/reason/Generated Events）。
- **实时**：第一版全部 Polling（Dashboard 30s / Monitor 5s / 事件流 10s / 列表 15s），
  组件卸载自动停止（`usePolling`）。
- **Key 脱敏**：API Key 全程脱敏展示，明文仅在创建/重新生成响应中出现一次。

## 6. 本地运行

```bash
# 1) 启动 World Engine（可选，用于真实数据；端口 8787）
node scripts/run-demo-engine.mjs

# 2) 启动管理后台（端口 8848）
cd admin-web && pnpm install && pnpm dev

# 3) 登录（Mock 账号）
admin/admin123        # 管理员（全部权限）
operator/operator123  # 世界运营
viewer/viewer123      # 只读观察员
```

后端地址可在 `.env` 调整：`VITE_WORLD_API_URL`、`VITE_GATEWAY_API_URL`。

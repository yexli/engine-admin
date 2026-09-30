<h1>World Driving Engine · 管理后台</h1>

基于 [vue-pure-admin 官方精简版](https://github.com/pure-admin/pure-admin-thin)（thin 6.2.0）
建设的 World Driving Engine V1.0 管理后台。**只做 Admin Web，不修改 World Engine 核心。**

## 功能总览

| 模块 | 内容 | 数据 |
| --- | --- | --- |
| Dashboard | 平台运维总览：指标卡 / 事件活动图 / Recent Errors / World Runtime | 引擎直读 + 聚合(Mock) |
| 世界管理 | 世界列表、创建世界、世界详情（State/Entities/Locations/Relations/Events/Commands/Scheduler/Runtime 八 Tab） | **真实引擎 API** |
| 世界运行 | State、Entities、Locations、Relations、Events、命令调试台、Scheduler、Runtime Monitor | 真实（Scheduler 为 Gap 占位） |
| 扩展管理 | Extensions / Rules / 扩展命令（查看 + 启停） | Mock |
| AI Gateway | Providers / Models / Model Router / Pipelines / API Keys / Usage | Mock（含真实网关联通测试） |
| Memory | Stores / Memories / Retrieval 调试 / Embedding | Mock |
| 运行监控 | Logs / 事件流 / AI Calls / Errors | Mock |
| 系统 | 用户 / 权限 / 设置 / System Status（含引擎直探） | Mock |

所有依赖后端缺口的数据均以 Mock 呈现并在界面标注；缺口清单见
`../docs/ADMIN-API-GAP.md`，架构与映射见 `../docs/ADMIN-ARCHITECTURE.md`、
`../docs/ADMIN-API-MAPPING.md`。

## 快速开始

```bash
# 1) 安装依赖
pnpm install

# 2)（可选）启动演示用 World Engine，端口 8787，供真实数据联调
node ../scripts/run-demo-engine.mjs

# 3) 启动管理后台，端口 8848
pnpm dev
```

内置账号（Mock 登录，角色详见 `../docs/ADMIN-PERMISSION.md`）：

```text
admin / admin123            管理员（全量权限）
operator / operator123      世界运营
viewer / viewer123          只读观察员
```

后端地址可在 `.env` 调整：`VITE_WORLD_API_URL`（默认 127.0.0.1:8787）、
`VITE_GATEWAY_API_URL`（默认 127.0.0.1:8788）。

## 命令

```bash
pnpm dev          # 开发（8848）
pnpm build        # 生产构建
pnpm typecheck    # tsc + vue-tsc 类型检查
pnpm lint         # eslint + prettier + stylelint
```

## 目录导览

```text
src/api/          统一 API Client（真实 / 派生 / Mock 三类，页面禁止散落请求）
src/views/        27 个业务页面；runtime/components 为世界详情与运行页共享面板
src/router/modules/  8 个业务路由模块（菜单即路由）
mock/             vite-plugin-fake-server Mock（登录 + /admin-api/*）
```

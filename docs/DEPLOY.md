# 部署指南（M5.3 · 一台新机器从零拉起全栈）

> 目标形态：Docker Compose 四容器 —— engine(8787) / memory(8789) /
> platform(8790 公共 + 8791 管理，受管模式内嵌 gateway) / admin-web(80，Nginx
> 同源反代全部 API 与管理界面)。对外只需暴露 admin-web 的 80/443。
>
> 诚实说明：本部署文件在无 Docker 的开发机上编写，**镜像构建未实测**；首次在
> 有 Docker 的主机执行时如遇小问题（依赖锁文件、alpine 兼容），按报错微调即可，
> 文件结构与流程是权威的。

## 1. 前置

- Docker ≥ 24 + Docker Compose v2（`docker compose version` 可用）；
- 仓库根包含 `world-engine/`、`platform/`、`admin-web/`、`scripts/`、`deploy/`。

## 2. 生成密钥与令牌（deploy/.env）

```bash
cd deploy
cat > .env <<EOF
PLATFORM_SECRET_MASTER_KEY=$(openssl rand -hex 24)
PLATFORM_ADMIN_TOKEN=$(openssl rand -hex 16)
PLATFORM_BOOTSTRAP_KEY=sk-world-$(openssl rand -hex 12)
EOF
```

- `PLATFORM_SECRET_MASTER_KEY`：上游凭证加密主密钥——**一旦凭证入库不可更换**，
  请离线备份；丢失 = 全部供应商凭证重新上传；
- `PLATFORM_ADMIN_TOKEN`：管理面令牌，由 Nginx 在服务端注入，浏览器永不持有；
- `PLATFORM_BOOTSTRAP_KEY`：公共 API 运维主密钥（可选，缺省仅用管理台签发的 Key）。

## 3. 构建与启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f platform   # 首次启动会播种内置用户并大声告警
```

启动后拓扑：

| 服务 | 容器内 | 宿主（仅回环） | 说明 |
|---|---|---|---|
| engine | 8787 | 127.0.0.1:8787 | 演示宿主（预置 w-main / w-test 两个世界） |
| memory | 8789 | 127.0.0.1:8789 | 演示宿主（每世界一个 store，轮询引擎摄取事实；快照落盘 `platform/data/memory/`，重启恢复） |
| platform | 8790 / 8791 | 127.0.0.1:8790 / 8791 | 受管模式：公共 API + 管理监听（内嵌 gateway） |
| admin-web | 80 | **8080（对外）** | Nginx 托管前端 + 同源反代全部 API |

## 4. 首次上线清单（必做）

1. 打开 `http://<主机>:8080`，用内置账号登录（`admin / admin123`）；
2. **立即修改内置账号口令**（系统管理 → 用户）：三个内置账号的默认口令是公开
   文档值，任何非本机部署都必须改；
3. AI 网关 → 提供方：建档真实上游供应商 → 上传凭证（AES-256-GCM 加密落盘）→
   启用并指派能力路由（P8 起支持方案 §十一 全部 13 项能力；未配置的能力如实 503）→
   用「测试」按钮做有界实测；
4. 世界列表 → 创建（或使用演示世界）；
5. 按需在「AI 网关 → API 密钥」为调用方签发公共 API Key（明文仅显示一次）。

## 4.5 平台运行时能力开关（P3–P7，按需配置到 platform 容器）

| 环境变量 | 作用 | 缺省 |
|---|---|---|
| `PLATFORM_TRIGGER_WORLDS` | 平台内触发引擎守护的世界（逗号分隔）——High 事实 + 逐实体唤醒评估，无人值得唤醒零 AI 调用 | 空=关闭 |
| `PLATFORM_MEMORY_WORLDS` | 记忆摄取与个体决策召回的世界 | 空=关闭 |
| `PLATFORM_SCHEDULES_FILE` | NPC 日程存储文件（游戏方经 `PUT /v1/npc/worlds/:id/schedules` 注册，平台确定性对齐，零 AI） | data/schedules.json |
| `PLATFORM_TRIGGER_INTERVAL_MS` / `PLATFORM_MEMORY_INTERVAL_MS` / `PLATFORM_SCHEDULE_INTERVAL_MS` | 三循环轮询间隔 | 3000 |
| `PLATFORM_EVOLUTION_CAPABILITY` | 演化提案走的能力通道 | reasoning |

观测：`GET :8791/v1/admin/runtime`（World Runtime / Evolution / Trigger / Schedule / Memory 单点数据面）；
因果链：`GET :8791/v1/evolution/worlds/:id/events/:eventId/trace`（八环）。
引擎重启后世界重建，平台自动检测（seed 指纹）并重置消费集，无需重启平台。

## 5. 数据与升级

- 平台数据（模型配置 / 加密凭证 / API Key / 用户 / 会话 / 用量记录）全部落在
  `platform-data` 卷（容器内 `/stack/platform/data`）；升级镜像：
  `docker compose pull && docker compose up -d`，数据不丢；
- **备份**该卷即备份全部平台状态；`PLATFORM_SECRET_MASTER_KEY` 丢失 = 凭证不可解密；
- 引擎世界数据是演示宿主的进程内存态（重启即重置种子）——持久化世界属 SavePort
  范畴（平台 Phase 8），不在本部署形态内。

## 6. TLS

Admin Web 必须经 TLS 暴露。二选一：

- **入口层终结**（推荐）：负载均衡 / 反向代理（如宿主 Nginx、Caddy、云 LB）终结
  TLS 后转发到 8080；
- **容器内终结**：把 `admin-web/nginx.conf.template` 的 `listen 80` 改为
  `listen 443 ssl` 并挂载证书卷，修改 deploy/docker-compose.yml 对应挂载。

## 7. 验证（冒烟）

- UI 冒烟（生产构建，本机开发环境跑）：`cd admin-web && pnpm test:e2e`
  ——登录 → 世界详情 → 执行命令 → 修改路由 → 回滚 全流程自动断言；
- 全链冒烟（本机 dev-stack）：`node platform/scripts/dev-stack.mjs` 起栈后
  `node scripts/run-v21-walkthrough.mjs`（35 项）；
- **全链验收**：`PLATFORM_ADMIN_TOKEN=… node scripts/run-p10-acceptance.mjs`
  ——真人全流程 30 项（世界一致性 / AI 稳定性 / 因果性八问），自动重置世界，产出 docs/P10-ACCEPTANCE.md；
- 部署后手测：登录 → 任意页轮询有数据 → 世界列表「暂停/恢复」生效 →
  AI 网关「测试」通过 → `GET :8791/v1/admin/runtime` 各分区有数据。

## 8. 可选：记忆库接入向量通道

记忆检索缺省为纯词面 + 新近度 + 重要度 + 置信度四因子打分。接入向量模型
（语义相似度 ×0.2 并入总分，失败静默回词面）只需给 memory 容器加环境变量：

```yaml
  memory:
    environment:
      WORLD_API_URL: http://engine:8787
      # Embedding 统一治理（2026-10）：向量能力经平台模型路由，Memory 不再持有
      # Provider/Endpoint/Key——embedding 模型在「AI 网关 → 模型路由」配置；
      # 本服务只连平台公共 API（EmbeddingService 传输层）：
      EMBEDDING_SERVICE_URL: http://platform:8790
      EMBEDDING_SERVICE_KEY: sk-world-...               # 需 embeddings 权限
```

接通后管理台「记忆库 → 向量嵌入」诊断页显示路由实况（主/备模型、当前生效、
实测维度）；embedding 模型本身在「AI 网关 → 模型路由」配置（唯一真相源）。
未配置时该页如实显示「未接入向量通道」。注意：向量在**检索时现场计算**
（查询 + 全部候选逐条 embed），条目量大后费用/延迟线性增长，向量化入库与
索引属 SavePort/Phase 8 范畴。

## 9. 已知边界

- 引擎 / Memory 演示宿主为**演示种子**（进程内存态）；生产化世界宿主与
  SavePort 持久化另行排期；
- 引擎公共面（/world-api）无鉴权：容器端口只绑宿主回环，跨容器流量在 compose
  内网——对外绝不暴露 8787/8789/8790/8791；
- 管理监听跨容器可达依赖 `PLATFORM_ADMIN_ALLOW_NON_LOOPBACK=1`（platform 启动时
  大声告警）：隔离责任由 compose 内网 + 端口绑定策略承担。

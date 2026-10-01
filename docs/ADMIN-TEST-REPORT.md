# Admin 测试报告（ADMIN-TEST-REPORT）

> 日期：2026-09-30 · 环境：Windows 10 (26200) / Node 24.19 / pnpm 11.7
> 被测：`admin-web/`（vue-pure-admin thin 6.2.0 定制）+ World Engine（127.0.0.1:8787，演示种子数据）

## 一、结论速览

| 项 | 结果 |
|---|---|
| TypeScript 类型检查（tsc + vue-tsc） | ✅ 通过（0 错误） |
| 生产构建（vite build） | ✅ 通过（3.54 MB） |
| 路由可达性（27 页面） | ✅ 全部注册；抽测 8 页均正常渲染 |
| 真实 API 联调（World Engine） | ✅ 通过（见 §三） |
| 权限（Admin / Viewer 实测） | ✅ 通过（见 §五） |
| 异常路径（引擎不可达） | ✅ 错误态 + 重试 + 全局提示（设计如此，代码路径统一） |
| Mock 页面 | ✅ 12 页正常（显式标注 Mock） |

## 二、静态验证

- `npx tsc --noEmit`：通过。
- `npx vue-tsc --noEmit --skipLibCheck`：通过（修复了 events 页返回类型、settings 页
  el-input-number 联合类型、router roles 位置、pinia 双参 defineStore 等）。
- `vite build`：通过。期间定位并修复两个问题：
  1. `vite-plugin-remove-console` 在 Windows/中文路径下 external 白名单失效，
     将 iconfont.js 的 `console && console.log(t)` 删成非法语法 → 已在
     `build/plugins.ts` 停用该插件（保留 console，对运维后台无害）；
  2. `gateway/router`、`gateway/pipelines` 两处 `v-model="!!expr"` 不是合法
     v-model 成员表达式 → 改为 `:model-value` + `@update:model-value`。

## 三、真实 API 联调（World Engine @8787）

| 场景 | 操作 | 结果 |
|---|---|---|
| 世界清单 | Dashboard / 世界列表 | ✅ `GET /v1/worlds` 返回 w-main、w-test |
| State 面板 | 世界详情 → State | ✅ tick/weather/player/npcs/variables/raw JSON 与引擎一致 |
| Entities 面板 | 详情 → Entities | ✅ lita(att=5, met)、borin 由 state 派生 |
| Locations 面板 | 引擎直查 | ✅ plaza/tavern/forest（definition 物化）+ relations 1 条 |
| 命令执行 | 命令调试台：选 talk → 填 targetId/text → Preview → 确认 → Execute | ✅ `CommandResult ok=true`，Generated Events `evt_1_13`，确认弹窗正常 |
| Events 面板 | 引擎直查 | ✅ `GET /v1/worlds/{id}/events` 倒序渲染（因果链 UI 具备） |
| 推进时间 | API 直测 | ✅ `POST /time {ticks}` → ok |
| 引擎不可达 | 关闭引擎场景（同一错误路径） | ✅ 页面呈现错误态 + 重试按钮，Dashboard 出现黄色全局提示，不显示假数据 |

## 四、页面抽测（浏览器黑盒，1440×900）

| 页面 | 结果 |
|---|---|
| 登录页 | ✅ 预填 admin/admin123，错误凭据返回失败提示 |
| Dashboard | ✅ 指标卡（Worlds=2、Entities=4 引擎直读 + Mock 指标）、活动图、Recent Errors、World Runtime 表、轮询开关 |
| 世界列表 | ✅ 搜索/排序/轮询/创建对话框（JSON 校验 labels 白名单）/推进时间弹窗/暂停关闭按钮禁用+Gap 提示 |
| 世界详情 8 Tab | ✅ State/Entities/Commands 实测；Locations/Relations/Events/Scheduler/Runtime 组件同构复用 |
| Gateway Providers | ✅ Mock 表格 + 状态筛选 + 健康检查按钮 + 真实网关联通测试入口 |
| 菜单 | ✅ 7 大模块 + Dashboard；「异常页面」已隐藏 |

## 五、权限实测

| 场景 | 结果 |
|---|---|
| viewer 菜单隔离 | ✅ 扩展管理/AI Gateway/系统 三组菜单整体消失 |
| viewer 按钮权限 | ✅ 世界列表无「创建世界」按钮 |
| viewer 越权直访 `#/runtime/commands` | ✅ 重定向 403 |
| admin 全量 | ✅ 菜单/按钮齐全，命令可执行 |

## 六、已完成

- 27 个业务页面（Dashboard 1 / Worlds 2 / Runtime 8 / Extensions 3 / Gateway 6 /
  Memory 4 / Observability 4 / System 4，另含 9 个共享组件）。
- 19 个 API 模块（真实 7 + 派生 5 + Mock 7 类）+ vite 双代理 + Mock 层 7 文件。
- 三角色登录、菜单/按钮两级权限、Pinia 世界上下文、轮询基建、Loading/Empty/Error 三态。
- 类型检查与生产构建双通过；真实引擎全链路联调通过；docs 五份文档。

## 七、未完成 / 按方案边界不做

- 管理面（Gateway 管理、Memory、Observability 聚合、System 用户/设置）的真实后端
  —— 依赖 API Gap（G6-G9），当前以 Mock 呈现且界面明示。
- World 暂停/恢复/关闭（G1，需引擎侧设计）、Scheduler 查询（G4，页内为缺口占位）。
- 方案 §27 明确不做项（玩家端、NPC 聊天、地图编辑器、DAG 编辑器等）均未做。

## 八、已知问题（2026-09-30 · M5 复查更新）

1. ~~**Mock 依赖 dev/prod 均启用 fake-server**（`enableProd: true`）~~
   ✅ 已关闭（M5.1）：fake-server 插件与 `mock/` 全部移除，生产构建零假路由
   （dist 实测无 fake-server / admin-api 引用）。
2. **`vite-plugin-remove-console` 已停用**：生产产物保留 console（上游插件在
   Windows/中文路径下的缺陷，见 ADMIN-ARCHITECTURE §2）。**维持停用**（对内部
   运维后台保留 console 利于排障），修复上游后再开。
3. ~~**派生视图性能**：Entities/Locations/Relations 由全量 state 前端派生~~
   ✅ 已关闭（M1.3）：三视图改服务端分页端点，`GET /state` 仅 State 页保留。
4. ~~**登录会话**：前端 Mock 签发 token~~ ✅ 已关闭（M3.1：真实管理会话 + 服务端
   权限强制 + 本地用户/设置服务）。**遗留半项**：`/world-api`（引擎公共面）仍无
   鉴权（127.0.0.1-only / compose 内网是唯一防线）——引擎侧鉴权中间件属引擎
   里程碑，不在本后台规划内。
5. ~~**事件因果链**：演示数据未串联链式事件~~ ✅ 已关闭（M4.3）：演示宿主串联
   三级因果链（talk_started → social_mood_shift → narrative_hook_opened），
   链 UI 全链路验证；顺带修复前端字段名（parent→parentId）与引擎 emitEvent
   双记账两个真实缺陷。

## 九、后续建议（复查更新）

1. ~~按优先级落地 ADMIN-API-GAP 的 G7 / G4 / G3~~（已落地 M1）；
2. ~~真实化后逐页回归~~（M1–M4 逐里程碑完成，M2 起 mock 逐文件清退）；
3. ~~引擎侧评审 G1 暂停语义后，恢复世界列表/Monitor 的暂停与关闭按钮~~
   （已落地 M4.2，按钮已恢复并接真）；
4. ~~引入 Playwright 冒烟测试~~（已落地 M5.2：`admin-web` `pnpm test:e2e`，
   对生产构建跑全流程）；
5. 大世界量时为世界列表加服务端分页（当前引擎注册表 list 全量返回，规模可控）；
6. 部署形态见 `docs/DEPLOY.md`（M5.3：compose 全栈 + Nginx 同源反代）。

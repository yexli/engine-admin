# Admin 权限模型（ADMIN-PERMISSION）

> 第一版角色-权限模型。**M3 起全部真实**：登录走管理监听 `/v1/admin/session/login`
> （本地三档用户，scrypt 存储 `data/users.json`，会话 12h/刷新轮换 7d）；菜单权限走
> pure-admin 路由 `meta.roles`，按钮权限走登录返回的 `permissions` + `hasPerms`/`<Perms>`
> 组件；**服务端按同一权限码目录强制**（`gateway:manage` / `system:manage` 写闸，
> viewer 只读会话直访写端点 403 实测通过）。前端权限仅是 UX，服务端强制才是安全边界；
> 引擎 `/world-api` 仍无鉴权（127.0.0.1-only 是唯一防线，见 ADMIN-API-GAP.md G9 注意）。

## 1. 角色

| 角色 | 账号（Mock） | 定位 | permissions |
|---|---|---|---|
| Admin | `admin / admin123` | 平台管理员，全量权限 | `["*:*:*"]`（超权） |
| Operator | `operator / operator123` | 世界运营：操作世界、执行命令、读写记忆、查看监控 | `world:read` `world:write` `command:execute` `memory:read` `memory:write` `observability:read` |
| Viewer | `viewer / viewer123` | 只读观察员 | `world:read` `memory:read` `observability:read` |

## 2. 权限码目录

| 权限码 | 名称 | 控制内容 |
|---|---|---|
| `world:read` | World 读取 | 世界/状态/实体/事件等一切查看 |
| `world:write` | World 写入 | 创建世界、推进时间、（未来）暂停/恢复/关闭 |
| `command:execute` | 命令执行 | 命令调试台 Execute 按钮（影响 World State） |
| `gateway:manage` | Gateway 管理 | AI Gateway 六页的全部写操作 |
| `memory:read` | Memory 读取 | Memory 四页查看 + Retrieval 调试 |
| `memory:write` | Memory 写入 | 删除记忆记录 |
| `observability:read` | 监控读取 | Logs / AI Calls / Errors / 事件流 |
| `system:manage` | 系统管理 | 用户/角色/设置管理；扩展与规则的启停 |

## 3. 菜单可见性（路由 `meta.roles`）

| 菜单 | admin | operator | viewer |
|---|---|---|---|
| Dashboard | ✓ | ✓ | ✓ |
| 世界管理（列表/详情） | ✓ | ✓ | ✓ |
| 世界运行 State/Entities/Locations/Relations/Events/Scheduler/Monitor | ✓ | ✓ | ✓ |
| 世界运行 命令调试台 | ✓ | ✓ | ✗（直访 403，已实测） |
| 扩展管理（三页） | ✓ | ✓ | ✗ |
| AI Gateway（六页） | ✓ | ✗ | ✗ |
| Memory Stores/Memories/Embedding | ✓ | ✓ | ✓ |
| Memory Retrieval 调试 | ✓ | ✓ | ✗ |
| 运行监控（四页） | ✓ | ✓ | ✓ |
| 系统（四页） | ✓ | ✗ | ✗ |

## 4. 按钮级控制（`<Perms value="...">` / `hasPerms`）

| 按钮/操作 | 权限码 | Viewer 效果 |
|---|---|---|
| 创建世界 | `world:write` | 隐藏 |
| 推进时间（列表/Monitor） | `world:write` | 隐藏 |
| 暂停/恢复/关闭世界 | `world:write` | M4.2 起真实（引擎 1.0.3 G1 软暂停）；前端权限门是 UX——引擎公共面无鉴权（已知问题 #4） |
| 命令调试台 Execute | `command:execute` | 隐藏（页面本身 403） |
| Extensions/Rules 启停 | `system:manage` | 禁用 + tooltip |
| Gateway 全部写操作 | `gateway:manage` | 隐藏/禁用 + tooltip |
| 删除记忆 | `memory:write` | 显示「只读」 |
| 用户/设置编辑保存 | `system:manage` | 隐藏/禁用 |

## 5. 已实测（浏览器黑盒）

- `admin` 登录：8 个菜单全量；命令台可执行真实命令。
- `viewer` 登录：菜单仅剩 Dashboard/世界管理/世界运行(除命令台)/Memory(除 Retrieval)/运行监控；
  世界列表无「创建世界」按钮；直访 `#/runtime/commands` 重定向 403。

## 6. 真实化路径 —— ✅ 已落地（M3）

1. ~~落地 G9（ADMIN-API-GAP.md）：用户/角色/设置服务 + 登录签发 token~~
   （M3.1/M3.3/M3.4：`/v1/admin/session/*` + `/v1/admin/system/{users,permissions,settings}`）
2. ~~`mock/login.ts` 替换为真实 `/login`（返回 roles + permissions 结构不变，前端零改动）~~
   （M3.1：`/control-api/v1/admin/session/login`，形状与 Mock 完全一致；`mock/login.ts`、
   `mock/refreshToken.ts`、`mock/admin/system.ts` 已删除；登出会真实吊销会话）
3. **World/Gateway HTTP 层增加鉴权中间件（当前 127.0.0.1-only）**——仍待做（引擎侧工作项）。
   管理面自身已在 M3.2 完成服务端强制；引擎公共面的鉴权属于后续引擎里程碑。

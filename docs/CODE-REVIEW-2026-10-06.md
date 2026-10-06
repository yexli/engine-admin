# 代码审查报告（Code Review · 2026-10-06）

> 审查方式：四路并行深度走读（world-engine 内核 / platform 平台面 / admin-web 前端 / 跨包一致性）
> 审查范围：全部 src/ 源码（~52 文件 platform + ~28 文件 engine + ~30 页面 admin-web）、测试、配置、文档
> 基线版本：world-engine 1.4.1 / platform 0.25.2 / admin-web 6.x / gateway 0.7.2 / memory 0.9.0
> 纪律：**只读审查，不修改任何源码**；发现分级报告，修复由用户决策

---

## 总览

| 等级 | 数量 | 说明 |
|---|---|---|
| **CRITICAL** | 2 | 远程可利用的安全漏洞（引擎） |
| **HIGH** | 12 | 远程崩溃/数据泄漏/数据丢失/功能不可用 |
| **MEDIUM** | 24 | 正确性/性能/资源/UX 缺陷 |
| **LOW** | 27 | 边界情况/文档/代码卫生 |
| **INFO** | 12 | 设计观察/正面确认 |

**总体评价**：架构纪律优秀（AI 边界结构性保证、Core/Extension 分离、append-only 事件史、三层围栏），但存在两个**远程可利用的 CRITICAL 安全漏洞**（引擎鉴权绕过 + 原型链污染）和多个 HIGH 级问题需要优先处理。

---

## CRITICAL（立即修复）

### C1. 引擎鉴权完全绕过：Object.prototype 继承键作为 API Key

- **位置**：`world-engine/src/http/protocol.ts:478`、`src/http/ws.ts:188`
- **类别**：安全（远程，无需认证）
- **问题**：鉴权查找使用 `init.auth.keys[key]` 无 own-property 检查。发送 `x-api-key: __proto__`（或 `toString`、`constructor`、`valueOf`）返回继承的 truthy 值 → 通过 `if (!rec) 401` 闸门；`rec.gameId`/`rec.scopes` 为 `undefined` → 身份默认为 **admin**（全量读写权限，所有世界可见）。WS 升级路径同样受影响（`?key=__proto__`）。
- **实证**：审查中已验证——auth 启用时，`x-api-key: toString` 成功执行写命令（`change_weather → ok:true`），`Bearer constructor` 列出所有世界。
- **修复**：`if (!Object.hasOwn(init.auth.keys, key)) return 401;`——或将 keys 存入 `Map` / `Object.create(null)` 对象。

### C2. 全局 Object.prototype 污染：`__proto__` 作为实体 ID（远程，无需认证）

- **位置**：`world-engine/src/mutate/WorldMutate.ts:83-88`（entryOf）；`src/rules/coreRules.ts:90`、`rpgCompat.ts:49,72`（存在性检查）
- **类别**：安全（远程原型链污染）
- **问题**：`entryOf` 执行 `let dy = s.npcs[id]`；当 `id === '__proto__'` 时返回 `Object.prototype`（truthy），然后 `touch()` 将 `_ver` **写入 Object.prototype**，后续调用者写入 `met`、`att`、`effects`、`attributes`。规则存在性检查使用同样的 truthy `npcs[id]` 测试，`__proto__` 一路通过。`sanitizeCommand`（protocol.ts:141）只做长度检查。
- **实证**：已验证——HTTP 端到端：
  - `POST /v1/worlds/w1/commands {"type":"talk","targetId":"__proto__"}` → `Object.prototype.met = true` 进程级污染
  - `{"type":"update_attribute","targetId":"__proto__","payload":{"key":"role","value":"admin"}}` → `({}).attributes === {"role":"admin"}`
- **修复**：在 mutate + rules 边界拒绝/规范化保留 id（`__proto__`、`constructor`、`prototype`）；存在性检查使用 `Object.hasOwn(npcs, id)`；或用 `Object.create(null)` 构建 `npcs`/`rels`/`locations`/`rep`。

---

## HIGH（优先修复）

### H1. 远程进程崩溃：WS 升级路径未防护的 decodeURIComponent

- **位置**：`world-engine/src/http/ws.ts:200`（及 `:161` URL 解析）
- **问题**：`GET /v1/worlds/%/events/stream` 升级 → `decodeURIComponent('%')` 抛出 `URIError`，在同步 `'upgrade'` 监听器内无 try/catch → 未捕获异常 → 进程退出。发生在 auth 检查**之前**。
- **修复**：try/catch 整个 upgrade handler → 回复 400/404 并 destroy socket。

### H2. 远程进程崩溃：new URL 使用攻击者控制的 Host 头

- **位置**：`world-engine/src/http/server.ts:58`
- **问题**：``new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)`` 在 try 块**之前**执行。`Host: a b`（合法头值）使 `new URL` 抛出 `TypeError: Invalid URL` → 未捕获 → 进程退出。
- **修复**：wrap in try/catch，回退到 `http://localhost`。

### H3. FileSavePort 在仅 world-log 脏时删除主存档文件

- **位置**：`world-engine/src/state/fileStorage.ts:95-101`
- **问题**：`flushSync()` 将 `pending === null` 视为"已清除"并执行 `rmSync(this.filePath)`。但 `saveWorldLog()`/`saveCommandLedger()` 设置 `dirty = true` 而不触碰 `pending`。真实序列：重启后首条命令 → `saveWorldLog` → 500ms 防抖触发**先于** container 的 1000ms 节流 → flush 时 `pending === null` → **已加载的主存档被删除**。
- **修复**：仅在显式 `clear()` 路径删除主文件（独立标志）；`flushSync` 中当 `pending === null && !clearRequested` 时跳过主文件分支。

### H4. 无界 WebSocket 接收累加器（内存 DoS）

- **位置**：`world-engine/src/http/ws.ts:252-270`
- **问题**：`acc = Buffer.concat([acc, chunk])` 无上限。`decodeFrame` 拒绝声明长度 > 16 MiB 但**不关闭连接**——客户端可以用虚假 127-length 头逐字节增长 `acc`，每连接无限制。
- **修复**：限制 `acc`（如 1 MiB）；溢出或超限声明长度时 `socket.destroy()`。

### H5. 世界事件史：无界内存 + 每事件 O(H) 同步深拷贝

- **位置**：`world-engine/src/api/WorldAPI.ts:192-244`
- **问题**：`worldLog`/`worldLogIds` 永远增长；**每个**发射的事件调用 `savePort.saveWorldLog(worldLog)`（全数组），`FileSavePort.saveWorldLog` 同步执行 `JSON.parse(JSON.stringify(rows))`——每事件 O(H)，世界生命周期 O(H²)，阻塞事件循环。
- **修复**：在 port 的 write-behind 阶段防抖/序列化而非每次调用；增加增量追加通道；`queryEvents` 按 day/type 索引而非全扫描。

### H6. 跨租户世界数据泄漏：world-agent chat 路径

- **位置**：`platform/src/http/protocol.ts:352-360`（+ `src/worldagent/pipeline.ts:46-59`）
- **问题**：`/v1/worlds*` 路由严格执行 gameId 隔离，但 `handleChat` 对 `model=world-agent` 调用 `runWorldAgent` 时**从未检查 `key.gameId` 与世界的 `ownerGame`**。任何持有 `chat:completions` 的游戏方 Key 可传入其他租户的 worldId，获取该世界状态（玩家/NPC/属性/最近事件）。
- **修复**：在 `handleChat` 中，当 `key.gameId` 非空且 `extractWorldId(body)` 非空时，调用 `worldOwnedByGame(worldId, key.gameId)`，不匹配返回 404。

### H7. 众所周知的默认管理员凭证

- **位置**：`platform/src/admin/users.ts:109-118`
- **问题**：`admin/admin123`、`operator/operator123`、`viewer/viewer123` 在 `users.json` 缺失时播种。`run-managed.mjs` 支持非回环绑定（`PLATFORM_ADMIN_ALLOW_NON_LOOPBACK=1`），此时任何可达端口的人用文档化默认密码获得完整 `*:*:*` 管理权限。
- **修复**：内置账户仍为播种密码时拒绝启动（或拒绝非回环绑定）；或首次登录强制改密。

### H8. Admin-Web 模型控制面角色执行绕过

- **位置**：`admin-web/src/api/modelControl.ts:225-247`（+ `vite.config.ts:56-72`、`nginx.conf.template:23-26,47`）
- **问题**：`modelControl.request()` 使用原始 `fetch`，**从不发送 `x-admin-session`**。代理在 session 头缺失时注入**主管理令牌** → 后端对所有 gateway 页面调用短路 `requirePerm()` → `viewer` 角色可触发模型实测、修改路由配置。
- **修复**：在 `modelControl.request()` 中附加 session token；用 `Perms` 组件包裹测试/运行按钮。

### H9. 全局 10s axios 超时 vs 长时间后端操作

- **位置**：`admin-web/src/utils/http/index.ts:19`；`src/api/evolution.ts:138-147`
- **问题**：演化 tick 是同步 LLM 闭环（上游允许 60s，nginx 允许 75s），但前端全局超时 10s → 任何真实模型调用被客户端中止，功能不可用。
- **修复**：为 tick/pipeline test 传入 per-request timeout（90s/45s）。

### H10. Token 刷新失败永久挂起所有排队请求

- **位置**：`admin-web/src/utils/http/index.ts:84-98`；`src/store/modules/user.ts:92-105`
- **问题**：(a) `handRefreshToken` reject 时排队回调永不调用 → 所有 in-flight promise 永远 pending。(b) 后端对无效 refresh token 返回 HTTP 200 + `{success:false}`，前端只检查 `if (data)` → 始终 truthy → 将垃圾 token 持久化。
- **修复**：验证 `data.success`；interceptor 增加 `.catch` 排空队列并强制登出。

### H11. 登录失败完全静默

- **位置**：`admin-web/src/views/login/index.vue:49-73`
- **问题**：`loginByUsername(...).then(...).finally(...)` 无 `.catch`。网络错误、500、429 节流 → unhandled rejection，spinner 停止，零用户反馈。
- **修复**：增加 `.catch(e => message(...))`。

### H12. Platform 测试套件当前 RED（flaky test）

- **位置**：`platform/tests/managed-runtime.test.ts`
- **问题**：全量运行 → 1 failed | 332 passed。失败用例：「上游拒绝凭证：显式上报 upstream_credential_rejected，且不进冷却」——仅在全套件并行负载下失败（时序敏感）。
- **修复**：使断言确定性（fake timers / await 显式状态）。

---

## MEDIUM（计划修复）

### 引擎（world-engine）

| # | 位置 | 问题 | 修复方向 |
|---|---|---|---|
| M1 | `events/WorldEventBus.ts:19` | isolated 世界的 bus 使用全局 `channelOf`，自有通道表不参与投递判定 | 传入 EventSchemaInstance |
| M2 | `api/WorldAPI.ts:236-279` | 非 isolated 世界 dispose 后全局 bus 订阅泄漏（僵尸写） | 保留 unsub 句柄，dispose 时调用 |
| M3 | `api/WorldAPI.ts:140-146` | createWorld monkey-patch 共享 defaultEventSchema.registerEventTables，累积包装链 | 不修改共享单例 |
| M4 | `http/server.ts:109-111` | 单世界模式 WS 流看不到 POST /v1/worlds 创建的世界 | 共享 handle getter |
| M5 | `http/ws.ts:150-155` | WS relay 缺世界归属过滤（非 isolated 世界事件跨世界泄漏） | 增加 belongTo 过滤 |
| M6 | `events/WorldEventBus.ts:96,103-107` | deadLetters 数组无界增长 | 改为环形（500） |
| M7 | `http/protocol.ts:539-544` | Registry 模式所有世界共享一个 savePort（同文件互相覆盖） | savePortFactory(worldId) |
| M8 | `state/WorldDefinition.ts:82-94` | applyDefinition 对 relations 不幂等（重复 apply 产生重复边） | upsert on (source,target,type) |
| M9 | `state/WorldState.ts:67` | evtSeq 从全局 schema 持久化（isolated 世界存无关计数器），且从未被读回 | 注入实例 schema |

### 平台（platform）

| # | 位置 | 问题 | 修复方向 |
|---|---|---|---|
| M10 | `evolution/context.ts:260-265` | token 预算裁剪可丢弃主触发事件（pop 取尾部=最旧=可能是 primary） | splice 非 primary 的末位 |
| M11 | `memory/runtime.ts:103-111` | 记忆运行时先标记消费后摄取——getState 失败时事件永久丢失 | markSeen 移到 ingest 成功后 |
| M12 | `evolution/ledger.ts:55-70` + `journal.ts` | 幂等账从 200 条环重建——超窗历史丢失，重启后旧幂等键可重复执行 | 从 JSONL 文件直接重建 |
| M13 | `evolution/driver.ts:93-108` | 演化驱动从不向 router 报告失败——冷却机制对演化路径无效，死主模型每次 tick 都先超时 | markFailed/markHealthy |
| M14 | 多文件 | 长生命周期进程无界内存增长（ledger maps / born set / sessions / secrets） | LRU/eviction/cap |
| M15 | `evolution/journal.ts:101-111` | JSONL 无界增长 + tick 热路径同步 I/O（appendFileSync 含完整 context+proposal） | 轮转/异步追加/索引 |
| M16 | `keys/keystore.ts:83-102` | KeyStore SIGINT/SIGTERM handler 先于 run-managed 的 shutdown 执行并 process.exit → usage flush/runtime stop 永不执行 | 库级不调 process.exit |
| M17 | `npc/scheduler.ts:71,103-131` | 动态注册的世界在 status() 不可见；已删除的世界永远被轮询 | 从 states 派生 status；prune |
| M18 | `usage/recorder.ts:83-134` | 每次 admin 请求同步重读重解析全量 JSONL（最大 64 MiB）；每次公共请求同步追加 | 内存尾索引/异步批量追加 |

### 前端（admin-web）

| # | 位置 | 问题 | 修复方向 |
|---|---|---|---|
| M19 | `store/modules/user.ts:81-90` | 登出不等待服务端吊销 → 请求无 session 头发出 → 400 → 会话 12h 内仍有效 | await logoutSession() |
| M20 | `views/evolution/index.vue:52-124` | 演化控制台 tick/intent 失败静默（无 catch）+ partially_applied 误报为失败 + 按钮无权限门 | catch + 状态分支 + Perms |
| M21 | `views/gateway/keys/index.vue:58-81` | API Key 创建失败静默（无 catch） | 增加 catch |
| M22 | `composables/usePolling.ts:16-30` | keep-alive deactivate 后 polling 永不恢复 | wasPolling 标志 |
| M23 | 多页面 | 轮询错误 toast 风暴（引擎下线时每 5-15s 弹一次）+ 隐藏 tab 不停轮询 | silent + visibilitychange |
| M24 | `composables/useAsyncData.ts` | 无请求排序/取消——慢响应覆盖快响应（竞态） | sequence token / AbortController |

### 跨包

| # | 位置 | 问题 | 修复方向 |
|---|---|---|---|
| M25 | 根 README + world-engine README + platform README + admin-web README | 版本号/测试数/功能描述全面漂移（README 写 0.25.0/315，实际 0.25.2/333；admin-web README 仍描述 Mock 时代） | 文档刷新 |
| M26 | `admin-web/src/api/apiKey.ts:28-33` | 前端权限词表缺 `embeddings`（后端已有）→ UI 创建的 Key 永远无法调用 /v1/embeddings | 补齐 |
| M27 | `admin-web/vite.config.ts:45-48` | /gateway-api 代理指向 8788（dev-stack 从不监听）→ 系统状态页 ai-gateway 探针永久失败 | 指向 8790 或 dev-stack 起 gateway |

---

## LOW（择机处理）

<details>
<summary>展开 27 项 LOW 级发现</summary>

### 引擎

| # | 位置 | 问题 |
|---|---|---|
| L1 | `runtime/WorldRuntime.ts:191`、`api/WorldAPI.ts:300` | `slice(-0)` 返回全部（n=0 时契约意外） |
| L2 | `runtime/WorldRuntime.ts:196-205` | 命令历史快照丢弃 commandId（无法关联幂等键） |
| L3 | `runtime/WorldRuntime.ts:104` | 幂等命中结果共享 events 数组引用（调用方可污染账本） |
| L4 | `rules/coreRules.ts:222-228` | advance_time amount=NaN → ok:true 但无操作（库路径无 HTTP 过滤） |
| L5 | `mutate/WorldMutate.ts:157` | rep() 使用 `in` 操作符（继承键通过） |
| L6 | `mutate/WorldMutate.ts:99-146` | playerBag/npcBag 接受非有限 qty（Infinity 堆叠） |
| L7 | `time/WorldClock.ts:44,140` | 默认 period 表对大部分时辰错误（3 条 vs 12 时辰索引） |
| L8 | `http/ws.ts:64-91,251-269` | WS 帧卫生：未拒绝非掩码客户端帧/控制帧长度未校验/无版本检查 |
| L9 | `http/ws.ts:103-106` | WS relay 忽略背压（慢消费者无界缓冲） |
| L10 | `http/server.ts:63-73` | 413 handler 无重入守卫（headers already sent） |
| L11 | `state/fileStorage.ts:118-138` | load() 损坏文件时忽略内存中更新的 pending |
| L12 | `http/server.ts:121-127` | server.close() 可因 idle keep-alive 连接挂起 |

### 平台

| # | 位置 | 问题 |
|---|---|---|
| L13 | `evolution/perspective.ts:72` | buildPerspective 丢弃 npcLocations 参数（actor-location 可见性规则死代码） |
| L14 | `evolution/commands.ts:56` | translateChange 缺省 FULL_CORE_POLICY（公开导出，新调用点忘传=无限制） |
| L15 | `evolution/commands.ts:66` | 玩家守卫只匹配字面 'player'（多玩家/自定义 id 无保护） |
| L16 | `evolution/policy.ts:42-48` | gradeOf 使用原始对象索引（prototype 键误分级） |
| L17 | `evolution/driver.ts:258` | proposalKey 的 JSON.stringify replacer 在嵌套层剥键（假阳性去重） |
| L18 | `evolution/driver.ts:157` | 驱动静默截断超限 changes（runtime 的"逐条拒绝不静默丢弃"永不触发） |
| L19 | `upstream/gateway.ts:73-99` | SSE 代理无 idle/total 超时 + 忽略背压 |
| L20 | `admin/managed-runtime.ts:65-87` | DNS-rebinding TOCTOU（验证与实际请求之间） |
| L21 | `keys/keystore.ts:208-211` | KeyStore 文件写非原子（无 tmp+rename，崩溃损坏 → 启动抛错） |
| L22 | `admin/http.ts:1148` | 冷却检测用 message.includes 而非 instanceof |
| L23 | `memory/runtime.ts:39,182` | duplicatesTotal 永远为 0（从未递增） |
| L24 | `npc/state.ts:115` vs `npc/schedule.ts:50-54` | slot 边界处理不一致（floor/ceil vs 原始比较） |
| L25 | `evolution/journal.ts:171-174` | 文件名 sanitize 可碰撞（a/b 与 a_b 同文件） |

### 前端

| # | 位置 | 问题 |
|---|---|---|
| L26 | 多页面 | ElMessageBox.confirm 取消时 unhandled rejection（缺 catch） |
| L27 | `views/gateway/keys/index.vue:83-86` | 非安全上下文 clipboard.copy 静默失败（一次性明文 Key 丢失） |

</details>

---

## INFO（设计观察 / 正面确认）

| # | 观察 |
|---|---|
| I1 | **AI 边界结构性完整**：未发现任何模型输出绕过 translateChange → policy → Rules 到达世界状态的路径。runtime 只持有 EngineClient（无状态写方法）；dispatchIntent 执行调用方命令而非 AI 输出；OOC/narrative 隔离是结构性的。 |
| I2 | **sanitizeCommand 是正确的白名单重建**（protocol.ts:128-225）——形状正确，只缺保留键语义（C2）。 |
| I3 | **FileSavePort 原子写 + 损坏备份**纪律优秀（tmp+rename、corrupt-ts 备份、exit 钩子、unref 定时器）。 |
| I4 | **事件总线配额/延后/死信/processedBy 幂等**纪律工程化良好（除 M6 无界死信）。 |
| I5 | **提示注入面**：玩家可控字符串（实体属性/事件数据/记忆摘要）原样流入驱动提示词。三层围栏限定了爆炸半径（白名单+策略+Rules），记忆段携带"主观非权威"声明——当前是不做输出侧异常检测下的最佳实践。建议：记录被拒提案尖峰作为注入信号。 |
| I6 | **工具链对齐优秀**：四后端包共享相同 devDeps（TS 6.0.3 / vitest 5.0.2 / @types/node 26.6.3）；admin-web 为 TS 5.9.3 + strict:false（Vue 模板遗产）。 |
| I7 | **依赖接线一致**：platform → gateway/memory 用 link:；platform 不依赖 world-engine（HTTP 通信）——已验证零 `from 'world-engine'` 导入。 |
| I8 | **共享常量当前一致**：MANAGED_CAPABILITIES 13 项双端匹配；权限码 gateway:manage/system:manage 一致；usage kind 枚举一致。 |
| I9 | **端口一致**：README/config/vite proxy/dev-stack 对齐（唯一例外 8788，见 M27）。 |
| I10 | **无 v-html XSS 暴露**：唯一的 v-html（JsonView）转义 &<> 后只注入自有 span——已验证安全。 |
| I11 | **前端游戏方经济键未禁**：默认策略只禁 money/gold，游戏专属经济键（spice_stock、item_silk）不在禁止列表——有经济系统的宿主应经 policyFor 扩展 forbiddenAttributeKeys。 |
| I12 | **gateway/memory 无 lockfile**：不可重复安装（world-engine/platform/admin-web 各有 pnpm-lock.yaml）。 |

---

## 修复优先级建议

### 第一批（安全 / 数据丢失 / 远程崩溃）

| 序 | Finding | 预估 | 说明 |
|---|---|---|---|
| 1 | C1 鉴权绕过 | 0.5h | 一行 Object.hasOwn 或改 Map |
| 2 | C2 原型链污染 | 1h | 保留键拒绝 + Object.hasOwn 存在性检查 |
| 3 | H1 WS decodeURIComponent 崩溃 | 0.5h | try/catch |
| 4 | H2 Host 头 URL 崩溃 | 0.5h | try/catch + fallback |
| 5 | H3 FileSavePort 误删主档 | 1h | 分离 clear 标志 |
| 6 | H6 跨租户泄漏 | 0.5h | 一个 worldOwnedByGame 检查 |
| 7 | H8 模型控制面角色绕过 | 0.5h | 附加 session header |

### 第二批（功能不可用 / 数据完整性）

| 序 | Finding | 预估 |
|---|---|---|
| 8 | H9 10s 超时 vs LLM 调用 | 0.5h |
| 9 | H10 token 刷新挂起 | 1h |
| 10 | H11 登录静默失败 | 0.5h |
| 11 | H7 默认凭证 | 1h |
| 12 | M11 记忆先消费后摄取 | 0.5h |
| 13 | M12 幂等账环截断 | 1.5h |
| 14 | M10 触发事件可被裁剪 | 0.5h |
| 15 | H4 WS 无界累加器 | 0.5h |

### 第三批（性能 / 资源 / 可维护性）

H5、M13-M18、M19-M24、M25-M27 及 LOW 项按模块批量处理。

---

## 审查结论

**架构层面**：设计纪律执行到位——AI 边界、Core/Extension 分离、append-only 事件史、三层围栏、零依赖引擎均为结构性保证而非约定。未发现架构级设计缺陷。

**实现层面**：两个 CRITICAL 安全漏洞（C1/C2）是**必须立即修复**的——它们允许远程未认证攻击者绕过鉴权并污染进程全局原型链。HIGH 级问题集中在三个方向：① 引擎 HTTP/WS 层的输入验证不足（H1/H2/H4）；② 持久化层的边界条件（H3/H5）；③ 前端认证生命周期与错误处理（H8-H11）。

**测试层面**：覆盖率优秀（500+ 测试），但存在一个 flaky test（H12）和 platform/node_modules/.bin 为空的环境问题。测试主要覆盖正常路径和已知的边界条件，但对**恶意输入**（原型链键、畸形 URL、超大值）的覆盖不足——C1/C2 正是这个盲区的产物。

**建议**：第一批 7 项（~4.5h）修复后，系统安全性从"本机开发可用"提升到"可对外部署"水平。

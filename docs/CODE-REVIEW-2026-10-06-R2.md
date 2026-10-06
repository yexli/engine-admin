# 代码审查报告 · 全仓第二轮（Code Review R2 · 2026-10-06）

> 触发方式：用户指令「调用相关 skill，对当前项目做一遍代码审查」→ 加载 `dev-expert`（`code-review` 子技能 + `karpathy-coding-guidelines`）。
> 审查范围：`world-engine/`（内核 + gateway + memory）、`platform/`、`tianqiong/`、`admin-web/`、`deploy/`、`scripts/`、发布链路。
> 方式：四路并行只读深度走读（子代理）+ 主审复核 + **运行时可复现验证**（自建探针，非仅静态阅读）。
> 纪律：**只读审查，未修改任何源码**。本轮新增文件仅本报告与项目记忆。修复与否由你决策。
> 与上一轮关系：`docs/CODE-REVIEW-2026-10-06.md` 的 C1（原型链键鉴权绕过）**在本轮运行时复现中依然成立**——文档记录过 ≠ 已修复。

---

## 总览

| 等级 | 数量 | 说明 |
|---|---|---|
| **致命（Critical）** | 5 | 鉴权绕过 / 进程可被打死 / 跨租户数据泄漏 / 全站请求挂死 |
| **严重（Major）** | 18 | 数据丢失、竞态、无限流、静默失败、构建门禁红 |
| **警告（Warning）** | 16 | 性能反模式、权限覆盖缺口、凭据与仓库卫生 |
| **正面确认** | 10 | 架构纪律、安全实践、测试规模 |

**一句话结论**：架构纪律（AI 只建议不改世界、Core/Extension 分离、append-only 事件史、三层围栏）确实是硬约束；但 **运行时边界（Node 传输层、异步落地、队列与限流）有系统性缺陷**——五个致命项全部落在"信任外部输入 / 信任异步回调"这一层，且其中两个可用一条 curl 复现。

---

## 致命（立即修复）

### C1 · 原型链继承键当作 API Key：引擎鉴权与租户隔离整体失效
- **位置**：`world-engine/src/http/protocol.ts:478`、`world-engine/src/http/ws.ts:188`
- **原文**：
```ts
const key = apiKeyOf(req);
const rec = key !== undefined ? init.auth.keys[key] : undefined;
if (!rec) return { status: 401, ... };
```
- **问题**：`init.auth.keys` 是普通对象，`keys['__proto__' | 'constructor' | 'toString' | 'valueOf']` 命中**原型链**，返回值恒为真值 → 通过 401 闸门；此时 `rec.gameId === undefined` → 身份被判为「管理钥匙」，可见域 `!gameId || ...` 全部放行，`canWrite` 取缺省 `['worlds:read','worlds:write']` → **读写全权**。
- **运行时证据（本轮自建探针，单世界 ownerGame=gameB，引擎开启 auth）**：
```
GET /v1/worlds/victim-world  x-api-key=__proto__    -> 200 {...victim-world...}
GET /v1/worlds/victim-world  x-api-key=constructor  -> 200
GET /v1/worlds/victim-world  x-api-key=toString     -> 200
GET /v1/worlds/victim-world  x-api-key=valueOf      -> 200
GET /v1/worlds/victim-world  x-api-key=sk-game-a    -> 404（隔离正确）
GET /v1/worlds/victim-world  （无 key）              -> 401（闸门正确）
POST /v1/worlds/victim-world/commands x-api-key=__proto__ -> 200 {"ok":true,"events":["evt_1_2"],"appliedRules":["AdvanceTimeRule"]}
WS  GET .../events/stream?key=__proto__  -> HTTP/1.1 101 Switching Protocols
WS  ?key=bogus -> 401 ；?key=sk-game-a -> 404
```
- **影响**：开启鉴权的引擎实例 = 未鉴权实例。任意持 HTTP/WS 可达性者可读全部世界事实与事件流、创建/推进/暂停/删除任意游戏方的世界。多租户隔离（G2）在此路径上等于不存在。
- **修复**：`Object.hasOwn(init.auth.keys, key) ? init.auth.keys[key] : undefined`（或把钥匙表换成 `Map`）。WS 与 HTTP 两条路径同源修一处抽公共函数，避免再次漏挂。**修复后必须回归**：`__proto__/constructor/toString/valueOf` 全部 401。

### C2 · 畸形 Host 头使请求处理器同步抛错，进程整体退出（远程 DoS）
- **位置**：`world-engine/src/http/server.ts:58`（实测）、`platform/src/http/server.ts:100`、`platform/src/admin/http.ts:1220`（同型代码，已逐行核对无 try/catch）
- **原文**：
```ts
const server: Server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
```
- **问题**：`new URL('/', 'http://[')` 抛 `TypeError: Invalid URL`；该语句在 request 监听器首行、任何 try/catch 之外，Node 不隔离 EventEmitter 监听器异常 → 未捕获异常 → 进程退出。`Host: [` 是合法 HTTP 头值，Node 照收。全仓 `*.ts` 无 `process.on('uncaughtException'/'unhandledRejection')` 兜底（仅 keystore 注册 exit/SIGINT/SIGTERM）。
- **运行时证据（自建探针，向引擎发送 `Host: [`）**：
```
response bytes: ""
uncaughtException escaped request handler: TypeError: Invalid URL
```
- **影响**：一条请求打死进程；平台公共口（:8790）与管理口（:8791）同型，对外部署即可被远程反复打停（世界全部掉线 + 会话丢失）。
- **修复**：URL 解析包 try/catch（失败回 400 `malformed_host`）；request 处理器整体加兜底；进程入口注册 `uncaughtException/unhandledRejection` 记录并保活（长驻服务不该因单请求异常退出）。

### C3 · WS 升级握手内 decodeURIComponent 未捕获：畸形百分号编码打死进程
- **位置**：`world-engine/src/http/ws.ts:200`（`server.on('upgrade')` 处理器内，无 try/catch）
- **原文**：`const id = decodeURIComponent(segments[2]!);`
- **运行时证据（自建探针，`GET /v1/worlds/%E0%A4%A/events/stream` + 合法 WS 升级头）**：
```
socket closed; bytes received: ""
uncaughtException escaped upgrade listener: URIError: URI malformed
```
- **影响**：与 C2 同一个进程退出后果，且触发面更宽（任何能发 WS 升级请求的客户端）。HTTP 面同类解码在 `protocol.ts:573` 被 `server.ts:97-102` 的 try/catch 兜住（返回 500），WS 面没有——两边不对称正是根因。
- **修复**：解码包 try/catch → 400 并 destroy；整个 upgrade 处理器外层再兜一层；同时下线"以异常文本回包"的 500 语义（见 M8）。

### C4 · world-agent 通道绕过 gameId 租户隔离（跨游戏方读世界事实）
- **位置**：`platform/src/http/protocol.ts:202-209`（chat 分支）与 `212-290`（worlds 分支的隔离实现）；`platform/src/worldagent/pipeline.ts:22-30, 46-57`
- **原文**：
```ts
// protocol.ts chat 分支：只校验能力，不校验世界归属
if (path === '/v1/chat/completions' && method === 'POST') {
  if (!hasPermission(key, 'chat:completions')) { ... }
  return handleChat(req, key, meter);
}
// pipeline.ts：worldId 完全来自请求体
for (const v of [b['world'], b['world_id'], meta?.['world_id']]) { ... }
const ctx = await buildWorldContext(deps.engine, worldId);   // GET /state + /events
```
- **问题**：`ownerGame` 核验只写在 `/v1/worlds*` 分支内；`/v1/chat/completions` 在拿 `world_id` 去读世界状态与事件时不做归属校验。钥匙模型的 `gameId` 与 `chat:completions` 可并存（`KeyStore.create` 两者独立），于是"同一份数据在 /v1/worlds 上受隔离、在 chat 上不受"。
- **影响**：gameId=A 的钥匙指定 `world_id`=B 方世界即可把 B 方实体名册/玩家位置/最近事实拼进 system prompt 由模型复述；并可用 `world_not_found` 与 `upstream_error` 差异枚举世界存在性。
- **修复**：抽出 `worldOwnedByGame(worldId, key.gameId)` 并在 chat 分支（或 `runWorldAgent` 之前）强制调用，不匹配一律 404（与 worlds 面同语义）。

### C5 · 部署链路 `/world-api/` 无鉴权直通引擎（匿名可写世界）
- **位置**：`admin-web/nginx.conf.template:66-70`、`deploy/docker-compose.yml:76-77`、`platform/scripts/dev-stack.mjs`（无引擎 auth 装配）
- **原文**：
```nginx
location /world-api/ {
    proxy_pass http://${WORLD_API_UPSTREAM}/;
    proxy_set_header Host $host;
    client_max_body_size 1m;
}
```
- **问题**：该 location 不注入任何凭证，上游在编排里被指向引擎本体（`WORLD_API_UPSTREAM=engine:8787`），而栈内引擎未装配鉴权表；`/control-api` 的 `requirePerm` 只覆盖管理面。前端 worlds 全部调用走 `/world-api`（`admin-web/src/api/world.ts` 9 处）。
- **影响**：能访问管理台端口者无需登录即可创建/推进/暂停/删除世界、读取全部世界事实与实时流；operator/viewer 分级在该链路上失效。
- **修复**：worlds 调用改走 `/control-api` 由后端 `requirePerm('world:write')` 强制；或给引擎装配钥匙表并仅在 nginx 校验会话后注入（二选一，别两头都漏）。
- **需你确认**：其它部署形态（`PLATFORM_UPSTREAM_ALLOW_LOOPBACK` 等）是否已额外加固该路径。

---

## 严重（建议尽快修复）

### 引擎内核（world-engine）

- **M1 · FileSavePort 落盘失败后 `dirty` 悬空 → 挂起存档永久丢失**。`state/fileStorage.ts:91-116`：仅成功路径 `this.dirty = false`，catch 只报一次错且不重排程；`schedule()` 在 timer 存在时直接 return。磁盘满/EPERM/快照序列化失败后，宿主不再有新 save 时这份快照永不落盘，重启回退旧档。修复：catch 保留 dirty 并退避重排程，或升级为 fatal。**[走读复核]**
- **M2 · WS 入站缓冲 `acc` 无界增长**。`http/ws.ts:74-77`：声明长度 >16MiB 时 `decodeFrame` 返回 `[null,0,buf]` 永不消费，`data` 处理器 `if (!payload) break` 后每 chunk 全量 `Buffer.concat` 重解析。单连接 10 字节帧头即可让内存持续增长 + 收包退化为 O(n)。修复：非法帧一律 1002 关闭 + acc 硬上限（256KiB）。**[走读复核]**
- **M3 · FileSavePort 固定 `.tmp` 名 + 无串行化**。`state/fileStorage.ts:45-47, 97-98`：同档双实例（进程内共用路径或双进程）写 tmp 与 rename 可交错，异常被吞 → 档停在中间版本。修复：tmp 名加 pid+序号，按 filePath 串行化。**[走读复核]**
- **M4 · 事件总线同步派发无异常隔离**。`events/WorldEventBus.ts:145-151` 裸调 `s.fn(...)`：一个订阅者抛错会跳过同事件后续订阅者（世界史落盘、记忆摄取、审计），并冒泡进 `WorldClock.tick` / `WorldRuntime.execute` / `WorldAPI.emitEvent`，时钟推进半途中断。修复：逐订阅者 try/catch + 记账继续。**[走读复核]**
- **M5 · 规则异常分支不落盘**。`runtime/WorldRuntime.ts:168-181`：`ok === false` 分支调 `container.sync()`，异常分支不调——内存已变（前序规则改过状态并 emit 过事件）、磁盘未变 → UI 与存档不一致，重启出现幽灵回滚。修复：异常分支同样 sync()。**[走读复核]**
- **M6 · 网关流式路径不感知客户端断开**。`gateway/src/server.ts:75-103`：无 `req/res close` 钩子，未把断链接到上游 AbortController（`remote.ts:122-123` 仅超时触发）→ 客户端断开后继续读上游、按 token 计费跑到自然结束/120s 超时。修复：close → `reader.cancel()/abort()`。**[走读复核]**
- **M7 · 世界史无上限 + 每事件全量深拷贝（O(n²) 落盘）**。`api/WorldAPI.ts:241-245` 每事件推入无界 `worldLog`，`state/fileStorage.ts:175-179` 每次 `JSON.parse(JSON.stringify(rows))` 全量深拷贝并写全档；`queryEvents` 全量 filter。修复：滚动/分片上限 + 增量追加 + 索引。**[走读复核]**
- **M8 · 500 响应回显内部异常文本（信息泄漏）**。`http/server.ts:99-101`（memory `http/server.ts:72-74` 同型）。**实测**：`GET /v1/worlds/%E0%A4%A -> 500 {"error":"URI malformed"}`；落盘失败还会透出存档路径。修复：对外固定错误码 + 通用文案，原文只进服务端日志。**[实测+走读]**
- **M9 · MemoryEngine 裁剪只标 `forgotten`、从不物理删除**。`memory/src/engine.ts:140-145`：条目永久驻留，每次 remember 全表 filter、persist 全量深拷贝 → 长期 O(N²)。修复：阈值后物理移除 + ownerId 索引。**[走读复核]**
- **M10 · 检索按 owner 扇出：单请求 N 次 embedding + N 次全量快照**。`memory/src/http/protocol.ts:215-220` 对每个 owner 各调一次 `recallScored`（内部各提交一次 embed 并 persist）。管理台轮询即成本放大器。修复：按 store 聚合一次 embedding + 候选池预筛上限。**[走读复核]**

### platform 平台面

- **M11 · Trigger Runtime 有界并发失效**。`evolution/triggerRuntime.ts:232-236`：
```ts
executing.push(p.then(() => { const i = executing.indexOf(p); if (i >= 0) executing.splice(i, 1); }));
if (executing.length >= TICK_CONCURRENCY) await Promise.race(executing);
```
压入的是包装后的新 Promise，却用原始 `p` 查索引 → 恒为 -1，数组只增不减；一旦含已 settle 元素，`race` 立即返回，`TICK_CONCURRENCY=3` 限流形同虚设。一次 High 事实唤醒 N 个 NPC = N 路模型调用并发打出。修复：保存包装 promise 再按其索引删除，或改计数信号量；race 抛错路径用 `allSettled` 收尾。**[走读复核]**
- **M12 · 管理面观测端点每次全量读入+解析整个用量 JSONL**。`usage/recorder.ts:113-133` 同步读当前文件与轮转副本并逐行 `JSON.parse`（默认轮转 32MiB，两代 ~64MiB），`usage/query.ts` 随后全量 filter+sort；`/v1/admin/usage`、`/v1/obs/{logs,errors,overview}` 四端点每次都走这条路，同进程还承载会话与账本写入 → 事件循环被整段占用。修复：mtime/size 解析缓存或迁 SQLite；"最近 N 条"改尾读；排序只作用于分页窗口。**[走读复核]**
- **M13 · 幂等键"检查-登记"窗口 + 锁按 focus 分域**。`evolution/runtime.ts:128`（锁键 `worldId|focus`）、`138-143`（run 开头检查）、`235`（提案幂等检查后才 recordKey）：同 key 不同 focus 的并发 tick 双方都查空、都执行 → 同一幂等键两次真实 Mutation，API 重放保护不可靠。修复：进入 runTick 后原子 `tryAcquireKey` 预占。**[走读复核]**
- **M14 · `keys.json`/`users.json` 写盘非原子 + 每次鉴权命中触发全表重写**。`keys/keystore.ts:208-211` 直接 `writeFileSync` 覆盖（同仓 `admin/secrets.ts:134-139` 已有 `atomicWrite` 却未复用）；`verify()` 命中即改 `lastUsedAt` 并 `scheduleFlush()` → 高 QPS 下退化为"每 2s 重写全量钥匙表"，写坏即 `load()` 抛错拒绝启动。修复：复用 atomicWrite；lastUsedAt 改低频落盘。**[走读复核]**
- **M15 · NPC 日程循环"先吃后看"**。`npc/scheduler.ts:177-186`：读到事实立即 `markSeen` 消费，随后才 `await align()`；align 失败只 `errors++`，被消费的时间事实不重试（Trigger Runtime 专门做过"先看后吃"修正，本模块未对齐）。玩家可见后果：NPC 停在错误地点直到下一个时间事实。**[走读复核]**
- **M16 · 流式透传无背压、无断连取消**。`http/server.ts:157-172`：`res.write` 不看返回值、无 `close` → `reader.cancel()`；`upstream/gateway.ts:96-98` 在 finally 清掉超时后整条流再无空闲超时。慢客户端/半开连接下缓冲无界增长。**[走读复核]**
- **M17 · 管理面只读端点缺权限码**。`admin/http.ts:351-353`（`GET /v1/admin/keys` 全量钥匙元数据）、`234-236`（model-config）、`769-772`（settings）只校验"已认证"；权限目录把 API Key 管理归 `gateway:manage`，viewer 无该码。只读会话即可拉全平台钥匙元数据（id/name/prefix/tenantId/gameId/过期/lastUsedAt/permissions）用于租户枚举。**[走读复核]**

### tianqiong 游戏

- **M18 · SQLite 写穿队列被拒后永久失效，后续落盘静默丢弃**。`repo/sqlite.ts:430-434`：
```ts
this.queue = this.queue.then(() => this.db.execute('DELETE FROM save_shards')).catch(() => undefined);
this.queue = this.queue.then(() => this.db.execute('DELETE FROM world_log WHERE id = $1', [ROW_ID])).catch(() => undefined);
this.queue = this.queue
  .then(() => this.db.execute('DELETE FROM saves WHERE id = $1', [ROW_ID]))
  .then(() => this.db.execute('DELETE FROM vector_index'));   // ← 无 catch
```
同一条尾巴上只有前两条挂了 `.catch`。而 `ensureVectorTable()`（111-118）**明确容忍建表失败继续跑**，`clear()` 却无条件 `DELETE FROM vector_index` —— 表不存在时该语句必抛，队列当场毒化：Promise 一旦 rejected，其后所有 `.then(fn)` 的 fn 永不执行，`save()` 只改内存镜像，`lastError` 不会被置位、`onError` 永不响。后果：重置世界后新一局进度**不再落盘且不报错**；`flush()`（438-439 `await this.queue`）抛错会跳过 Tauri 关窗路径的 `win.destroy()`（关不掉窗口）。修复：统一 `enqueue()`（从 `this.queue.catch(() => undefined)` 接尾巴）；`fail()` 内调用 `onError` 处包 try/catch。**[走读复核]**
- **M19 · 多步自由行动中途抛错 → `freeBusy` 与在飞锁永不释放，输入框永久锁死**。`actions/ActionParser.ts:301-315`：第 2..n 步在 `scheduler.after` 的裸 setTimeout 回调里执行，回调体无 try/catch；`executeIntent` 抛错则 `onDone()` 永不执行 → `freeInFlight` 残留、`freeBusy:false` 永不发 → `Composer` 永久 disabled、`useAutoFlow` 永久不推进。修复：run() 整段 try/catch/finally 保证 `onDone`。**[走读复核]**
- **M20 · 对话异步落地无世代守卫**。`systems/npc/Chat.ts:340-342`：`chatAsync().then(applyChat)` 落地时直接 `need()` 并写状态（好感、bondProg、会话流、日封顶、记忆、流言）；同仓 `Narration` 有 `epoch`、`WorldRuntime` 有 `cancelAll()`，只有这条裸着。读档/重置后旧局台词会写进新档；`core.S === null` 时 catch 分支二次抛错产生 unhandled rejection。**[走读复核]**
- **M21 · 分层模型槽跨端点复用主 Key**。`ai/llmConfig.ts:308-314`：`{ baseURL: slot.baseURL || c.baseURL, model: slot.model, apiKey: slot.apiKey || c.apiKey }` —— 槽位只填端点/模型、Key 留空时，主服务 Key 会以 `Authorization: Bearer` 发给第三方端点（文件注释自己承认该风险，却当使用说明而非拦截条件）。修复：`slot.baseURL !== c.baseURL && !slot.apiKey` 时回落主模型或要求补 Key。**[走读复核]**
- **M22 · 构建门禁红（一条未用变量 + 一条 lint error）**。`pnpm build` = `tsc --noEmit && vite build`：
```
src/tests/world-engine-integration-verify.test.ts(49,27): error TS6133: 'ms' is declared but its value is never read.
scripts/http-host.mjs  26:31  error  'URL' is not defined  no-undef
```
`tsconfig.json` 的 `include: ["src"]` 含测试文件而 `noUnusedLocals: true` → 单条未用变量卡死整包构建。**[实测]**
- **M23 · 导入存档后世界史错配**。`world/WorldRuntime.ts:117` `restoreWorldLog(savePort()?.loadWorldLog?.() ?? [])`：导入的 JSON 只含 `WorldState`，却从当前介质取世界史；`newGame`/`resetWorld` 都显式 `clear()`，导入路径不清 → 因果链回溯指向新档不存在的实体。**[走读复核]**
- **M24 · 向量行缺 `model` 字段时跨模型复用**。`memory/embedding/EmbeddingCache.ts:51-55` `if (cur && it.model && it.model !== cur)`：旧介质里无 model 的行放行，两套向量空间算出的余弦照样落在 0..1 参与排序（不报错、结果不可信）。修复：缺失即视为不匹配。**[走读复核]**

---

## 警告（Warning）

| 编号 | 位置 | 问题 | 影响 |
|---|---|---|---|
| W1 | `admin-web/src/utils/http/index.ts:87-98` | 刷新令牌 `.then(...).finally(...)` 无 `.catch`，`PureHttp.requests` 永不清空 | 刷新失败后所有过期请求永久 pending、无登出、无提示（后端 200+`success:false` 不走 401 分支） |
| W2 | `admin-web/src/composables/usePolling.ts:11-13` | `setInterval` 不等上次完成、失败不停、后台标签照跑（间隔 5s × 串行 3 请求） | 后端不可达时请求叠加成百上千 |
| W3 | `admin-web/nginx.conf.template:66-70` | `/world-api/` 无 `proxy_http_version 1.1`、无 Upgrade/Connection | 容器部署下 WS 实时流必失败，静默退回轮询（dev 可用仅因 vite 代理声明 `ws:true`） |
| W4 | `admin-web/src/views/login/index.vue:39-42` | 表单初始值硬编码 `admin/admin123`（与后端种子口令一致） | 未改口令实例 = 公开后门；同时泄露管理员账号名 |
| W5 | `admin-web/src/utils/auth.ts:37-39,53-59` | `authorized-token` 由 js-cookie 写入，无 HttpOnly/SameSite/Secure；refreshToken/roles 明文进 localStorage；nginx 无安全头/CSP | 一处同源 XSS 即全权会话 |
| W6 | `platform/src/keys/keystore.ts:160,174` | 摘要比对用 `===`（同仓 admin 令牌与口令都用了 timingSafeEqual） | 与仓库既有标准不一致；配合 M14 放大写放大 |
| W7 | `platform/src/admin/users.ts:148-151` | 用户名不存在时短路返回、不跑 scrypt；`scryptSync` 阻塞事件循环；首启播种三档默认口令且无强制改密 | 时序信道可枚举用户名；登录期间 admin 进程停顿 |
| W8 | `platform/src/evolution/journal.ts:172-174` vs `106/140/155` | 写盘用 `sanitize(worldId)`，载入却以文件名回推 worldId 并强校验 | worldId 含冒号/中文/超长时整份账本计入 `skippedCorrupt`（幂等重建、因果追溯失效）。**疑似**，最小验证：`world:1` 建世界 → append 一个 run → `load()` 断言 |
| W9 | `platform/src/http/server.ts:106` | CORS 缺省 `*` | 任意源可跨域调用平台 API（仍需持 Key，风险有限；生产建议白名单） |
| W10 | `admin-web/src/utils/print.ts:97-101,149` | textarea 值赋给 `innerHTML` 后 `doc.write` 进同源 iframe（无 sandbox） | 回填内容含 `</textarea><img onerror=...>` 可在同源 iframe 执行（存量工具代码，未见 views 调用点） |
| W11 | `admin-web/.env.staging:11` | `VITE_CDN = true`（staging 打包替换为外部 CDN，无 SRI；production 为 false） | 预发布环境依赖第三方 CDN 完整性与可用性 |
| W12 | `platform/data/memory/embedding-config.json.migrated-2026-10-04T09-57-00-350Z` | **真实上游密钥明文残留**：`"apiKey": "sk-uhuh...bov"`（SiliconFlow/BAAI-bge-m3 迁移残留，非当前生效配置但仍在工作树） | 任何目录压缩/备份/共享都会外泄凭据；建议确认该 key 已吊销并删除残留文件 |
| W13 | `platform/dbg-mem-T434yt/**`、`platform/mc-check.json` | 调试残留已随发布白名单进入公开仓库（`git -C .publish ls-files` 命中） | 仓库卫生；发布脚本红线只覆盖 `.env*` 与 `platform/data` |
| W14 | `tianqiong/src/repo/index.ts:166-180` | 分段注释（① 指纹先行）与实际写入顺序（指纹最后）互相矛盾 | 维护者按注释挪动 `SHARD_META_KEY` 即复现"四片新、指纹旧"同代校验失败 |
| W15 | `admin-web/src/router/index.ts:150-154` + `directives/{auth,perms}` | 路由与按钮权限只读 localStorage/cookie 判定 | 后端覆盖处（`/control-api`）有效；`/world-api`、`/memory-api` 无后端校验时构成实质越权（与 C5 同源） |
| W16 | `world-engine/src/http/ws.ts:272` | `?replay=N` 无上限校验（HTTP 面 `?n=` 已 clamp 到 500） | 单连接可请求整环回放 × 世界数；建议 clamp 与 HTTP 面一致 |

---

## 正面确认（不该被改动的好设计）

1. **AI 边界是结构性保证**：`evolution/commands.ts` 内核白名单 + 策略围栏 + Rules 终审 + run 内去重，每步拒绝都带 `rejectedBy` 归因；AI 无法直接改世界。
2. **并发与幂等有骨架**：`concurrency.ts` 世界级串行锁确实接在 tick 上（`runtime.ts:129`）；`consumer.ts:63` 事件级幂等；账本可从 Journal 惰性重建（M11/M13 是骨架里的洞，不是没骨架）。
3. **AI 输出解析零信任**：`tianqiong/src/ai/ConsequencePlanner.ts:17-60` 只认可配对 JSON，`validatePlan` 全量校验，解析失败即放弃执行（"绝不猜 AI 想做什么"）。
4. **SQL 全参数绑定**：`tianqiong/src/repo/sqlite.ts` 全部 `$n` + args，无字符串拼接；动态部分只有常量 DDL。
5. **恒定时间比较 + 强 KDF 已存在于正确位置**：admin 令牌（`admin/http.ts:142-147`，timingSafeEqual）、口令（`admin/users.ts:55-59`，scrypt+随机盐）、上游凭证（`admin/secrets.ts`，AES-256-GCM + scrypt KDF + 0600 + atomicWrite）。
6. **出站策略与 SSRF 防护**：`admin/model-config.ts:217` 主机允许列表 + `managed-runtime.ts:68-83` 解析后拒绝环回/私有地址（除非显式放行）。
7. **发布链路有红线自检**：`publish-to-gitee.mjs` 白名单 + 复制后 `assertNoRedlines()` 硬中止（`.env*`、`platform/data` 不入库）——W13 说明红线清单可以再补几项。
8. **损坏不静默**：keystore/users/secrets/fileStorage 一律"坏档备份 + 报错"，不用空数据覆盖旧档。
9. **适配层而非重复实现**：`tianqiong/src/world/*` 是对 `world-engine` 的薄适配（`createWorldContainer` 等），不存在第二套内核。
10. **测试规模真实**：world-engine 151 / gateway 30 / memory 19 / platform 333 / tianqiong 1719，全部通过（见下）。

---

## 验证证据（本轮实跑）

| 验证项 | 命令 | 结果 |
|---|---|---|
| world-engine 测试 | `world-engine/node_modules/.bin/vitest run` | **21 files / 151 tests 全通过**（exit 0） |
| world-engine 类型 | `tsc --noEmit` | 通过（exit 0） |
| gateway 测试 | `gateway: vitest run` | **6 files / 30 tests 通过**（exit 0） |
| memory 测试 | `memory: vitest run` | **2 files / 19 tests 通过**（exit 0） |
| platform 测试 | `node node_modules/vitest/vitest.mjs run` | **33 files / 333 tests 通过**（exit 0） |
| platform 类型 | `node platform/node_modules/typescript/bin/tsc -p platform/tsconfig.json` | 通过（exit 0） |
| tianqiong 测试 | `tianqiong: vitest run` | **116 files / 1719 tests 通过**（exit 0） |
| tianqiong 类型 | `tianqiong: tsc --noEmit` | **失败：1 error TS6133（M22）** |
| tianqiong lint | `tianqiong: eslint .` | **失败：1 error `URL is not defined`（M22）** |
| admin-web 类型 | `admin-web: vue-tsc --noEmit --skipLibCheck` | 通过（exit 0） |
| 原型键鉴权绕过 | 自建探针（引擎开启 auth，world ownerGame=gameB） | **`__proto__/constructor/toString/valueOf` → 200 + POST 写命令 200；WS `?key=__proto__` → 101（C1）** |
| 畸形 Host 头 | 自建探针（`Host: [`） | **`uncaughtException escaped request handler: TypeError: Invalid URL`（C2）** |
| WS 畸形百分号编码 | 自建探针（`/v1/worlds/%E0%A4%A/events/stream`） | **`uncaughtException escaped upgrade listener: URIError: URI malformed`（C3）** |
| 错误文本回显 | `GET /v1/worlds/%E0%A4%A` | **500 `{"error":"URI malformed"}`（M8）** |

环境说明：`tianqiong/node_modules` 初始缺失 `vite`/`@types/node`（`vitest` 存在但启动即 `ERR_MODULE_NOT_FOUND`），已用 `pnpm install --frozen-lockfile` 修复后完成上表验证；离线模式失败（`ERR_PNPM_NO_OFFLINE_META`），需联网。`admin-web` 未配置 vitest（`tests/modelControl.test.ts` 无 runner，仅 e2e 冒烟脚本）。

---

## 优先修复顺序（建议）

1. **C1 原型键鉴权绕过**（一条 curl 即全量读写，且上一轮已记录却仍在）→ `Object.hasOwn`/`Map`，HTTP+WS 同修。
2. **C2 + C3 两个进程退出**（`Host: [` / 畸形百分号编码）→ try/catch + 进程级 `uncaughtException` 兜底。
3. **C5 `/world-api` 无鉴权直通** → 统一走管理面权限码，或引擎装钥匙表。
4. **C4 world-agent 租户隔离**，与 C1 同类（隔离必须两条路径同源）。
5. **M18 SQLite 写队列毒化 + M22 构建门禁红**（前者静默丢档、后者一行变量卡死构建）。
6. **M1/M3 FileSavePort（丢失与竞态）**、**M5/M4（内存-磁盘不一致、订阅者连坐）**。
7. **M11/M13 限流与幂等骨架补洞**、**M12 观测面全量读**。
8. **W1/W2 前端会话与轮询**、**W12 明文密钥清理与吊销**。

---

## 已知限制与未覆盖

- **未覆盖**：`tianqiong/src/systems/**`（48 文件，仅精读 Combat/Bond/Chat/Dialogue 局部）、`tianqiong/src/ui/panels/**` 与部分 overlays（只读 effect 区域）、`admin-web/src/views/**` 未逐行读的 30+ 页面、`admin-web/build/**`、`layout/**`、`style/**`、`platform/src/{memory,rpc}` 部分文件、`world-engine/src/{time/WorldClock,events/EventSchema,adapter,mutate}`、`.publish/` 内容对比。
- **上述未覆盖区域不构成"已确认无问题"**。
- **标注为疑似（未运行态复现）**：W8（journal worldId 回推）、M20 的 unhandled rejection 具体触发时机、M11 关于"未消费 rejection 终止进程"的推论（C2/C3 已证明无全局兜底）。
- 本轮**未做**：压测与性能基线（M7/M10/M12 的成本描述基于代码结构，未量化）、Tauri 桌面端实机、浏览器 e2e、依赖供应链审计（建议后续单独出 `threat-modeling` 轮次）。
- 本轮**未修改任何源码**；所有命令均在既有工作树上只读执行（新增文件仅本报告 + `.ai-memory` 记忆）。

**总体评分：72/100**（架构与纪律 90，运行时边界与部署链路 50，构建门禁 60）。

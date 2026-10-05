# P2 遗留缺口修复方案

> 制定日期：2026-10-05
> 基线：world-engine 1.4.1 / platform 0.25.2 / admin-web 6.x / 四包 502+315 测试全绿
> 性质：**P2 级（可维护性 / 可观测性）**——不阻塞运行，但影响长期健壮与可观测
> 纪律：零 Core 破坏性改动；引擎公开 API 只增不改；每项独立可验收、可单独提交

---

## 总览（10 项，按优先级排序）

| # | 缺口 | 影响面 | 改动包 | 预估工作量 |
|---|---|---|---|---|
| 1 | /worlds/detail 状态恒 assumed-running | 前端可观测 | admin-web | 0.5h |
| 2 | KeyStore 防抖窗口崩溃丢数据 | 持久化健壮 | platform | 1h |
| 3 | 权限缺省过宽（空数组→全量） | 安全面 | platform | 1h |
| 4 | Journal 环 200 截断（超窗不可查） | 可观测 | platform | 1.5h |
| 5 | MemoryRuntime 世界集静态 | 运行时弹性 | platform | 1.5h |
| 6 | 双事件列表去重语义差 | 数据一致性 | world-engine | 2h |
| 7 | 命令链无事务性（文档+观测增强） | 可观测/文档 | world-engine | 1h |
| 8 | 并发无版本冲突检测（最小实体版本戳） | 正确性增强 | world-engine + platform | 3h |
| 9 | evolution runtime 膨胀拆分 | 可维护性 | platform | 3h |
| 10 | 记忆同场判定取摄取时刻快照（文档化） | 已知边界 | 文档 | 0.5h |

**合并重启窗口**：#1 纯前端热加载；#2-#5 platform 一次重启；#6-#8 world-engine 一次重启；#9 platform 一次重启（可与 #2-#5 合并）。建议执行顺序：#1 → #2-#5 → #6-#8 → #9 → #10。

---

## 卡片 1：/worlds/detail 状态徽标联动 pause

### 问题

`admin-web/src/views/worlds/detail/index.vue:86-88` 硬编码：
```html
<el-tag v-if="info" type="success" effect="plain">assumed-running</el-tag>
```
引擎 `GET /v1/worlds/{id}` 已返回 `status: 'running' | 'paused'`（protocol.ts:285），前端类型 `WorldInfo.status` 已声明（api/types.ts:28），但 detail 页未消费。

### 锚点

- `admin-web/src/views/worlds/detail/index.vue` L86-88

### 改动指令

将硬编码 tag 替换为动态状态：

```html
<el-tag
  v-if="info"
  :type="info.status === 'paused' ? 'warning' : 'success'"
  effect="plain"
>
  {{ info.status === 'paused' ? '已暂停' : '运行中' }}
</el-tag>
```

### 单测

admin-web 无组件单测框架；验证方式 = `vue-tsc --noEmit` 零错误 + `vite build` 通过。

### 验证命令

```bash
cd admin-web
npx vue-tsc --noEmit
npx vite build
```

手动验证：dev-stack 起栈 → 打开 detail 页 → POST pause → 刷新 → 徽标变「已暂停」→ POST resume → 刷新 → 徽标变「运行中」。

### 提交信息

```
fix(admin-web): world detail 状态徽标联动 pause/resume（QA #8）
```

---

## 卡片 2：KeyStore 防抖窗口崩溃丢数据

### 问题

`platform/src/keys/keystore.ts:18` 防抖 2000ms + `timer.unref()`（L97）——进程在防抖窗口内崩溃/被 kill，最近 2s 内的 create/remove/revoke 操作丢失。当前无 exit 钩子兜底。

### 锚点

- `platform/src/keys/keystore.ts` L89-98（scheduleFlush）、L100-106（flush）

### 改动指令

在 KeyStore 构造函数末尾注册进程退出钩子：

```typescript
constructor(
  private readonly filePath: string,
  bootstrapKey?: string,
  private readonly now: () => number = () => Date.now(),
  private readonly flushFn: (file: string, data: KeyStoreFile) => void = flushSync,
) {
  this.bootstrapKeyHash = bootstrapKey ? hashKey(bootstrapKey) : null;
  this.load();
  /* 崩溃兜底：进程退出前同步落盘（防抖窗口内的变更不丢） */
  const exitFlush = (): void => { this.flush(); };
  process.once('exit', exitFlush);
  process.once('SIGINT', () => { exitFlush(); process.exit(130); });
  process.once('SIGTERM', () => { exitFlush(); process.exit(143); });
  /* 允许测试/调用方显式释放（避免钩子累积） */
  this.dispose = () => {
    process.removeListener('exit', exitFlush);
    exitFlush();
  };
}
```

在类上声明 `dispose` 属性：

```typescript
/** 释放进程钩子并同步落盘（测试/优雅退出用） */
dispose!: () => void;
```

### 单测

在 `platform/tests/` 新增或追加 keystore 测试：

```typescript
it('exit 钩子兜底：防抖窗口内 kill 不丢数据', () => {
  // 构造 KeyStore（flushFn 写临时文件）
  // create 一个 key（触发 scheduleFlush，不落盘）
  // 手动触发 process.emit('exit')
  // 断言临时文件包含新 key
});

it('dispose 释放钩子后 exit 不再触发 flush', () => {
  // create → dispose → 修改 flushFn 为 spy → process.emit('exit') → spy 未调用
});
```

### 验证命令

```bash
cd platform
npx vitest run tests/keystore*.test.ts
npx vitest run   # 全量回归
```

### 提交信息

```
fix(platform): KeyStore 注册 exit/SIGINT/SIGTERM 钩子，防抖窗口内崩溃不丢密钥变更
```

---

## 卡片 3：权限缺省过宽（空数组→全量权限）

### 问题

`platform/src/keys/keystore.ts:42-48` `normalizePermissions`：
```typescript
if (!Array.isArray(input) || input.length === 0) return [...PLATFORM_PERMISSIONS];
```
空数组 = 全量权限（chat:completions + worlds:read + worlds:write + embeddings）。游戏方创建 Key 时若忘传 permissions，默认拿到写权限——违反最小权限原则。

### 锚点

- `platform/src/keys/keystore.ts` L41-48（normalizePermissions）
- `platform/src/types.ts` L24-29（PLATFORM_PERMISSIONS 定义）

### 改动指令

1. 新增最小只读缺省常量：

```typescript
/** 缺省最小权限（只读）：未显式声明 permissions 时的安全回退 */
export const MINIMAL_PERMISSIONS: readonly PlatformPermission[] = [
  'worlds:read',
] as const;
```

2. 修改 normalizePermissions：

```typescript
export function normalizePermissions(input: unknown): PlatformPermission[] {
  if (!Array.isArray(input) || input.length === 0) return [...MINIMAL_PERMISSIONS];
  const out = input.filter(
    (p): p is PlatformPermission =>
      typeof p === 'string' && (PLATFORM_PERMISSIONS as readonly string[]).includes(p),
  );
  return out.length ? out : [...MINIMAL_PERMISSIONS];
}
```

3. **向后兼容**：既有 KeyStore 文件中已落盘的 key 不受影响（permissions 已持久化在 JSON 里）；仅影响**新创建**且未显式传 permissions 的 key。

4. bootstrap 主密钥保持全量权限不变（L131-143 硬编码 `[...PLATFORM_PERMISSIONS]`，运维逃生通道）。

### 单测

```typescript
it('空 permissions → 最小只读（worlds:read）', () => {
  const perms = normalizePermissions([]);
  expect(perms).toEqual(['worlds:read']);
});

it('未传 permissions → 最小只读', () => {
  const perms = normalizePermissions(undefined);
  expect(perms).toEqual(['worlds:read']);
});

it('显式传 worlds:write → 保留', () => {
  const perms = normalizePermissions(['worlds:read', 'worlds:write']);
  expect(perms).toEqual(['worlds:read', 'worlds:write']);
});

it('bootstrap 主密钥仍为全量权限', () => {
  // 构造带 bootstrapKey 的 KeyStore → verify → 断言 permissions 含全部 4 项
});
```

### 验证命令

```bash
cd platform
npx vitest run tests/keystore*.test.ts tests/auth*.test.ts
npx vitest run   # 全量回归（注意：既有测试若依赖空数组→全量需同步修正断言）
```

**注意**：全量回归时搜索 `normalizePermissions` 的既有测试用例，若有断言空数组→全量权限的，需改为断言→最小只读。grep 命令：
```bash
grep -rn "normalizePermissions" platform/tests/
```

### 提交信息

```
fix(platform): 权限缺省从全量收紧为最小只读（worlds:read），遵循最小权限原则
```

---

## 卡片 4：Journal 环 200 截断（超窗 run 不可查）

### 问题

`platform/src/evolution/journal.ts:18` `RING_CAP = 200`——内存环每世界最多 200 条 run。超窗后：
- `recent(worldId, n)` 只能返回环内数据
- `get(worldId, runId)` 对超窗 run 返回 null
- `traceEvent` 依赖 `get`，超窗后因果链断裂

JSONL 磁盘文件有全量数据，但无读取路径。

### 锚点

- `platform/src/evolution/journal.ts` L18（RING_CAP）、L72-78（recent/get）

### 改动指令

1. `get` 增加磁盘回退：环内未命中时，若配置了 `dir`，扫描对应 JSONL 文件查找：

```typescript
get(worldId, runId) {
  // 1. 环内查找（热路径）
  const ring = rings.get(worldId) ?? [];
  const hit = ring.find((r) => r.id === runId);
  if (hit) return hit;
  // 2. 磁盘回退（冷路径：超窗 run）
  if (!dir) return null;
  return loadFromDisk(worldId, runId);
},
```

2. 新增 `loadFromDisk` 内部函数（惰性、带缓存）：

```typescript
/** 磁盘回退：按行扫描 JSONL 查找 runId（冷路径，结果缓存进环外 Map） */
const diskCache = new Map<string, EvolutionRun>(); // `${worldId}|${runId}` -> run

function loadFromDisk(worldId: string, runId: string): EvolutionRun | null {
  const cacheKey = `${worldId}|${runId}`;
  const cached = diskCache.get(cacheKey);
  if (cached) return cached;
  const filePath = `${dir}/${sanitize(worldId)}.jsonl`;
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const run = JSON.parse(t) as EvolutionRun;
        if (run?.id === runId && run.worldId === worldId) {
          diskCache.set(cacheKey, run);
          return run;
        }
      } catch { /* 跳过损坏行 */ }
    }
  } catch { /* 文件不可读 */ }
  return null;
}
```

3. `recent` 增加 `n > cap` 时的磁盘补全（可选，第一版只做 get 回退即可满足 traceEvent 需求）。

4. 磁盘缓存上限：`diskCache` 超过 1000 条时 LRU 淘汰（简单实现：Map 超限时 clear 最旧一半）。

### 单测

```typescript
it('超窗 run 经磁盘回退可查（get 不返回 null）', () => {
  // 构造 ringCap=5 的 journal（带 dir）
  // append 10 条 run（前 5 条被挤出环）
  // get(worldId, 第1条runId) → 非 null（磁盘回退命中）
});

it('磁盘回退缓存命中（第二次 get 不读文件）', () => {
  // 同上，第二次 get 同一 runId → 结果相同
  // （可选：mock readFileSync 断言只调用一次）
});

it('无 dir 配置时超窗 get 仍返回 null（向后兼容）', () => {
  // 构造无 dir 的 journal，ringCap=2
  // append 5 条 → get 第1条 → null
});

it('traceEvent 对超窗 run 仍能还原因果链', () => {
  // 集成级：构造 ringCap=3，跑 5 次 tick
  // traceEvent 指向第1次 run 产生的事件 → 非 null
});
```

### 验证命令

```bash
cd platform
npx vitest run tests/evolution*.test.ts
npx vitest run   # 全量回归
```

### 提交信息

```
feat(platform): Journal get 增加磁盘回退，超窗 run 因果链不断裂
```

---

## 卡片 5：MemoryRuntime 世界集静态（启动后不可动态纳管）

### 问题

`platform/src/memory/runtime.ts:55`：
```typescript
const worlds = [...(opts.worlds ?? opts.service.worlds())];
```
世界列表在构造时固定。运行期间新建的世界（如第二个游戏方接入）不会被记忆摄取守护，需重启平台。

对比：TriggerRuntime 和 ScheduleRuntime 均通过环境变量声明 + 轮询发现，但 Memory 的 `worlds` 是构造参数。

### 锚点

- `platform/src/memory/runtime.ts` L55（worlds 固定）、L63-65（states 初始化）、L86（pollOnce 遍历 states）

### 改动指令

1. 暴露 `addWorld` / `removeWorld` 方法：

```typescript
export interface MemoryRuntime {
  start(): void;
  stop(): void;
  running(): boolean;
  status(): { running: boolean; intervalMs: number; worlds: MemoryWorldStatus[] };
  pollOnce(): Promise<void>;
  /** 动态纳管新世界（运行中即可生效；重复添加幂等） */
  addWorld(worldId: string): void;
  /** 移除守护（停止摄取；已有记忆数据保留） */
  removeWorld(worldId: string): void;
}
```

2. 实现：

```typescript
addWorld(worldId: string) {
  if (states.has(worldId)) return; // 幂等
  states.set(worldId, { worldId, polls: 0, ingestedTotal: 0, duplicatesTotal: 0, dayTicks: 0, errors: 0, seen: new Set(), seenOrder: [], worldResets: 0 });
  log(`[memory] 动态纳管新世界：${worldId}`);
},

removeWorld(worldId: string) {
  if (!states.has(worldId)) return;
  states.delete(worldId);
  log(`[memory] 移除守护：${worldId}`);
},
```

3. 装配侧（`platform/scripts/run-managed.mjs`）：在管理面 `POST /v1/worlds` 成功时调用 `memoryRuntime.addWorld(worldId)`（若 memoryRuntime 已装配）。

4. 管理面端点（可选增强）：`POST /v1/admin/memory/worlds/:id`（纳管）/ `DELETE`（移除），权限码 `gateway:manage`。

### 单测

```typescript
it('addWorld 后新世界被摄取守护', async () => {
  // 构造 runtime（worlds=['w1']）→ start
  // addWorld('w2') → pollOnce → 断言 w2 的 polls > 0
});

it('addWorld 幂等（重复添加不重建状态）', () => {
  // addWorld('w1') × 2 → status().worlds 长度为 1
});

it('removeWorld 后不再摄取', async () => {
  // 构造 runtime（worlds=['w1','w2']）→ removeWorld('w2') → pollOnce
  // 断言 w2 的 polls 不增长
});

it('removeWorld 不影响已有记忆数据', () => {
  // removeWorld('w1') → service.recall('w1', ...) 仍有数据
});
```

### 验证命令

```bash
cd platform
npx vitest run tests/memory*.test.ts
npx vitest run   # 全量回归
```

### 提交信息

```
feat(platform): MemoryRuntime 支持动态纳管/移除世界，无需重启平台
```

---

## 卡片 6：双事件列表去重语义差

### 问题

引擎存在两套事件存储：
- `state.events`（环形窗口 200 条，WorldState 内，随 SavePort 快照持久化）
- `worldLog`（append-only 持久史，V2.4-01 接线，FileSavePort 独立文件）

去重语义不一致：
- worldLog `absorbLog`（WorldAPI.ts:186-188）：同 id **保末次**（后行覆盖前行）
- state.events 环形窗口：同 id **保首次**（bus.emit 的幂等守卫 `processedBy` 拒绝重复投递）

后果：重启恢复时，若 worldLog 中某 id 的末次与 state.events 中该 id 的首次内容不同（理论上不应发生，但损坏/并发场景下可能），两套数据产生分歧。

### 锚点

- `world-engine/src/api/WorldAPI.ts` L174-193（worldLog + absorbLog）
- `world-engine/src/events/WorldEventBus.ts`（emit 幂等守卫 processedBy）
- `world-engine/src/state/WorldState.ts` L134（state.events 初始化为 []）

### 改动指令

**策略：统一为「保首次」（append-only 语义，与事件不可变纪律一致）**

1. 修改 `absorbLog` 的同 id 处理：

```typescript
// WorldAPI.ts absorbLog 内
if (worldLogIds.has(e.id)) {
  // 旧：worldLog[idx] = e; /* 同 id 保末次 */
  // 新：同 id 保首次（append-only 纪律：事件一旦成事实不可变）
  continue; // 跳过重复 id，保留首次入史的版本
}
```

2. 在恢复完成后增加一致性校验（可选，作为诊断日志）：

```typescript
/* 恢复后一致性诊断：worldLog 与 state.events 环的同 id 事件内容比对 */
if (worldLog.length && state.events.length) {
  const logMap = new Map(worldLog.map(e => [e.id, e]));
  for (const ringEvent of state.events) {
    const logEvent = logMap.get(ringEvent.id);
    if (logEvent && JSON.stringify(logEvent) !== JSON.stringify(ringEvent)) {
      opts.log?.warn?.(`事件 ${ringEvent.id} 在 worldLog 与 state.events 中内容不一致（以 worldLog 为准）`);
    }
  }
}
```

3. 文档化：在 `world-engine/CHANGELOG.md` 记录语义统一决定。

### 单测

```typescript
it('absorbLog 同 id 保首次（后行不覆盖前行）', () => {
  // 构造 worldLog 含两条同 id 但 data 不同的事件
  // 恢复 → 断言 worldLog 中该 id 只有首条的 data
});

it('恢复后 worldLog 与 state.events 环一致', () => {
  // 正常恢复流程 → 断言 ring 中每条事件在 worldLog 中内容相同
});
```

### 验证命令

```bash
cd world-engine
npx vitest run tests/world-log*.test.ts tests/v24-hardening*.test.ts
npx vitest run   # 全量回归
```

### 提交信息

```
fix(world-engine): 事件史去重统一为「保首次」append-only 语义，消除双列表分歧
```

---

## 卡片 7：命令链无事务性（文档 + 观测增强）

### 问题

`world-engine/src/runtime/WorldRuntime.ts` 命令执行：规则 A 已改状态后规则 B 拒绝/抛错 → A 的变更保留、已发事实不撤。`ok:false ≠ 零副作用`。

世界模拟语义下可辩护（事实不可撤），但调用方（游戏方/平台）无法从 CommandResult 中知道「哪些规则已经执行了」。

### 锚点

- `world-engine/src/runtime/WorldRuntime.ts` L74-135（execute 循环）
- `world-engine/src/command/Command.ts`（CommandResult 类型）

### 改动指令

**策略：不改执行语义（事实不可撤是设计决定），增强可观测性 + 文档化**

1. CommandResult 增加 `appliedRules` 字段（additive，可选）：

```typescript
export interface CommandResult {
  ok: boolean;
  reason?: string;
  events: WorldEvent[];
  /** 已成功执行的规则名列表（ok:false 时表示「这些规则已产生副作用」） */
  appliedRules?: string[];
}
```

2. WorldRuntime.execute 内收集已执行规则：

```typescript
const appliedRules: string[] = [];
for (const rule of matched) {
  // ... 既有执行逻辑 ...
  appliedRules.push(rule.name);
}
// 返回时附带
return { ok, reason, events, appliedRules };
```

3. HTTP 响应透出（protocol.ts 的 command 端点已有 result 透传，无需额外改动）。

4. 文档：在 `docs/SDK-GUIDE.md` 增加「命令链语义」一节：

```markdown
### 命令链非事务性（设计决定）

引擎命令按注册序逐规则执行。若规则 B 拒绝/抛错，规则 A 已产生的状态变更与事实
**不回滚**——世界模拟中「已发生的事不可撤」是核心纪律。

`CommandResult.appliedRules` 列出已成功执行的规则名：
- `ok: true` → 全部匹配规则执行完毕
- `ok: false` + `appliedRules: ['move']` → move 规则已产生副作用，后续规则拒绝

调用方若需「全有或全无」语义，应在游戏侧做前置校验（发命令前确认条件），
或将多步操作拆为独立命令逐条确认。
```

### 单测

```typescript
it('ok:false 时 appliedRules 列出已执行规则', () => {
  // 注册两条规则：ruleA 成功改状态，ruleB return false 拒绝
  // execute → ok:false, appliedRules:['ruleA']
});

it('ok:true 时 appliedRules 含全部匹配规则', () => {
  // 两条规则都成功 → appliedRules:['ruleA','ruleB']
});

it('appliedRules 为 additive（旧消费者不受影响）', () => {
  // 断言 CommandResult 类型兼容（无 appliedRules 时不报错）
});
```

### 验证命令

```bash
cd world-engine
npx vitest run tests/mutate-runtime*.test.ts tests/http*.test.ts
npx vitest run   # 全量回归
cd ../platform
npx vitest run   # 平台回归（消费 CommandResult 的路径）
```

### 提交信息

```
feat(world-engine): CommandResult 增加 appliedRules 可观测字段 + SDK 文档化命令链语义
```

---

## 卡片 8：并发无版本冲突检测（最小实体版本戳）

### 问题

V2.4-00 Q12：多 Proposal 先后修改同一 Entity 时，后到者基于最新状态评估（串行锁保证），但无法检测「AI 的观察上下文是基于过期状态构建的」。

当前串行锁（P1）已保证同世界 tick 不并发执行，但以下场景仍有风险：
- tick A 观察状态 → AI 思考（耗时 2s）→ 期间游戏方命令改变了同一实体 → tick A 的提案基于过期观察落地

### 锚点

- `world-engine/src/state/WorldState.ts`（EntityDynamic 类型）
- `world-engine/src/mutate/WorldMutate.ts`（写入原语）
- `platform/src/evolution/runtime.ts` L249-264（观察 + 上下文构建）

### 改动指令

**策略：最小侵入——实体级单调版本戳（mutation counter），演化侧观察时记录、落地时比对**

#### 引擎侧（additive）

1. `EntityDynamic` 增加可选字段 `_ver?: number`（内部版本戳，不暴露给游戏语义）：

```typescript
// world-engine/src/types.ts EntityDynamic
/** 内部版本戳：每次 mutation 递增（并发冲突检测用；游戏语义不消费） */
_ver?: number;
```

2. `WorldMutate` 的每个写入原语在修改实体时递增 `_ver`：

```typescript
// WorldMutate.ts 内所有修改 npc 的路径末尾
const entity = need(s.npcs[id]);
entity._ver = (entity._ver ?? 0) + 1;
```

3. HTTP `GET /v1/worlds/{id}/entities/{eid}` 响应已包含完整 EntityDynamic（_ver 自然透出）。

#### 平台侧

4. 演化 runtime 在观察阶段记录焦点实体的 `_ver`：

```typescript
// runtime.ts 观察后
const observedVersions = new Map<string, number>();
if (focusEntity && context.entities) {
  const focused = context.entities.find(e => e.id === focusEntity);
  if (focused?._ver !== undefined) observedVersions.set(focusEntity, focused._ver);
}
```

5. 落地前比对（在 translateChange 之后、executeCommand 之前）：

```typescript
// 版本冲突检测：观察时的 _ver 与当前 _ver 不一致 → 标记 stale（不拒绝，但留痕）
const currentState = await opts.engine.getState(worldId);
for (const [entityId, observedVer] of observedVersions) {
  const currentVer = currentState.state?.npcs?.[entityId]?._ver ?? 0;
  if (currentVer !== observedVer) {
    run.staleObservation = { entityId, observedVer, currentVer };
    // 第一阶段：留痕不拒绝（AI 提案可能仍然合理——由 Rules 终审）
    // V2.5 可选：配置为拒绝（policy.staleReject = true）
  }
}
```

6. `EvolutionRun` 类型增加可选字段：

```typescript
/** 观察过期检测（V2.4 P2）：落地时焦点实体版本与观察时不一致 */
staleObservation?: { entityId: string; observedVer: number; currentVer: number };
```

### 单测

```typescript
// world-engine
it('mutation 递增实体 _ver', () => {
  // create_entity → _ver=0/undefined
  // update_attribute → _ver=1
  // 再次 update_attribute → _ver=2
});

it('_ver 随 SavePort 持久化恢复', () => {
  // 修改 → save → load → _ver 保持
});

// platform
it('观察后实体被外部修改 → staleObservation 留痕', () => {
  // tick 开始（观察 _ver=1）→ 模拟外部命令改实体（_ver=2）→ 提案落地
  // 断言 run.staleObservation = { entityId, observedVer:1, currentVer:2 }
});

it('无外部修改 → staleObservation 不存在', () => {
  // 正常 tick → run.staleObservation === undefined
});
```

### 验证命令

```bash
cd world-engine
npx vitest run
cd ../platform
npx vitest run
```

### 提交信息

```
feat: 实体版本戳（_ver）+ 演化观察过期检测（staleObservation 留痕）

world-engine: EntityDynamic._ver 单调递增（additive， mutation 时自动）
platform: 演化落地前比对焦点实体版本，不一致时 run.staleObservation 留痕
第一阶段留痕不拒绝（Rules 仍为终审）；V2.5 可配置为拒绝
```

---

## 卡片 9：evolution runtime 膨胀拆分

### 问题

`platform/src/evolution/runtime.ts` 445 行，集闭环编排 + 幂等账 + 焦点作用域 + 记忆召回钩子 + 因果 trace + 并发锁于一身。V2.4-00 Q8 判定「中度膨胀」，行为稳定后应拆分。

### 锚点

- `platform/src/evolution/runtime.ts` 全文（445 行）
- 同目录已有：commands.ts / consumer.ts / context.ts / driver.ts / journal.ts / perspective.ts / policy.ts / triggerRuntime.ts / types.ts / wake.ts

### 改动指令

**策略：提取三个内聚子模块，runtime.ts 只保留编排骨架（目标 ≤200 行）**

#### 9.1 提取 `ledger.ts`（幂等账）

将 L125-161（runsByKey / runsByProposal / lastRunAt / ledgerRebuilt / ensureLedger / focusOf）提取为独立模块：

```typescript
// platform/src/evolution/ledger.ts
export interface EvolutionLedger {
  ensureRebuilt(worldId: string): void;
  checkIdempotencyKey(worldId: string, key: string): string | null; // runId | null
  checkProposal(worldId: string, scope: string, proposalKey: string): string | null;
  checkCooldown(scope: string, cooldownMs: number): number; // 剩余 ms（0=可用）
  recordKey(worldId: string, key: string, runId: string): void;
  recordProposal(scope: string, proposalKey: string, runId: string): void;
  recordFinish(scope: string): void;
  focusOf(worldId: string, wakePlan?: WakePlan): string;
}

export function createLedger(journal: { recent(...): EvolutionRun[] }): EvolutionLedger;
```

#### 9.2 提取 `concurrency.ts`（并发锁）

将 L163-186（inFlight Map + tick 串行化逻辑）提取：

```typescript
// platform/src/evolution/concurrency.ts
export interface WorldLock {
  acquire<T>(worldId: string, fn: () => Promise<T>): Promise<T>;
}

export function createWorldLock(): WorldLock;
```

#### 9.3 提取 `observation.ts`（观察 + 记忆召回）

将 L249-283（buildEvolutionContext 调用 + 记忆召回 + triggerGrade 推导）提取：

```typescript
// platform/src/evolution/observation.ts
export interface ObservationResult {
  context: EvolutionContext;
  triggerGrade: 'high' | 'medium' | 'low';
  focusEntity: string;
}

export async function observe(
  engine: EngineClient,
  worldId: string,
  opts: { eventWindow: number; wakePlan?: WakePlan; budget?: ContextBudget; memoryRetriever?: ... },
): Promise<ObservationResult>;
```

#### 9.4 runtime.ts 瘦身

保留：
- `createEvolutionRuntime` 工厂签名与选项
- `runTick` 编排骨架（调用 ledger → lock → observation → driver → translate → execute → finish）
- `dispatchIntent`
- `runs` / `run` / `traceEvent` / `knownWorlds` 代理

目标：runtime.ts ≤ 200 行，每个子模块 ≤ 120 行。

### 单测

**不新增测试**——纯重构，既有 299 项 platform 测试全部通过即为验收。可选：为 ledger.ts / concurrency.ts 各补 2-3 条单元测试（隔离验证）。

### 验证命令

```bash
cd platform
npx vitest run          # 全量 315 测试零回归
npx tsc --noEmit        # 类型检查
```

### 提交信息

```
refactor(platform): evolution runtime 拆分为 ledger/concurrency/observation 三子模块

runtime.ts 445→~180 行（编排骨架）；幂等账/并发锁/观察+记忆各自内聚。
纯重构，零行为变更，315 测试零回归。
```

---

## 卡片 10：记忆同场判定取摄取时刻快照（文档化）

### 问题

`platform/src/memory/runtime.ts:98-128`：感知边界派生（「谁在场看见了这条事实」）使用的是**摄取时刻**的世界状态快照（npcLocations），而非事实发生时刻的位置。

若 NPC 在事实发生后、摄取前移动了位置，记忆的 witnesses 派生可能不准确。

### 判定

**可接受的设计边界**（不修代码）：
- 摄取延迟 = 轮询间隔（缺省 3s），NPC 在 3s 内移动的概率极低
- 事实本身携带 `location` 字段（事件 schema），记忆引擎优先使用事实的 location 而非快照
- 修正需要「事实发生时刻的历史状态」——即事件溯源，属 V2.5 增量追加介质范畴

### 改动指令

在 `platform/src/memory/runtime.ts` 文件头注释增加已知边界声明：

```typescript
/* 已知边界（P2 记录，V2.5 方向）：
   感知边界派生使用摄取时刻的状态快照（npcLocations），而非事实发生时刻。
   轮询间隔（缺省 3s）内 NPC 移动会导致 witnesses 派生偏差。
   缓解：事实自带 location 字段优先；修正需事件溯源（V2.5 增量介质）。 */
```

在 `docs/CURRENT_IMPLEMENTATION_AUDIT.md` 的 P7 遗留节追加一条：

```markdown
- 感知边界派生取摄取时刻快照（非事实发生时刻）：轮询间隔内 NPC 移动可致 witnesses 偏差。
  缓解=事实自带 location 优先；修正需事件溯源（V2.5）。判定=可接受设计边界，不修代码。
```

### 验证命令

```bash
cd platform
npx vitest run tests/memory*.test.ts   # 确认注释不影响测试
```

### 提交信息

```
docs(platform): 记忆同场判定取摄取时刻快照——文档化为已知设计边界
```

---

## 执行纪律

1. **逐卡片提交**：每张卡片独立 commit，不混合（方便 revert）
2. **回归门**：每张卡片完成后跑对应包全量测试 + tsc --noEmit，绿了才进下一张
3. **不触红线**：
   - 引擎公开 API 只增不改（_ver / appliedRules 均为可选新字段）
   - 玩法语义不进引擎
   - AI 无状态写入口
   - 不为前端方便修改 Core
4. **向后兼容**：所有新字段为可选（`?`），旧消费者不受影响
5. **合并重启**：#2-#5 + #9 为 platform 改动，一次重启窗口；#6-#8 为 world-engine 改动，一次重启窗口

---

## 验收清单（全部完成后）

```bash
# 四包全量
cd world-engine && npx vitest run && npx tsc --noEmit
cd ../platform && npx vitest run && npx tsc --noEmit
cd ../world-engine/gateway && npx vitest run
cd ../world-engine/memory && npx vitest run
cd ../../admin-web && npx vue-tsc --noEmit && npx vite build

# dev-stack 冒烟
node platform/scripts/dev-stack.mjs
# → 六服务健康 → 天穹走查 35/35 → 商路验收 20/20
```

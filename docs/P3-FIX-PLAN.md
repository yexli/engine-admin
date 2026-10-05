# P3 遗留缺口修复方案

> 制定日期：2026-10-05
> 基线：world-engine 1.4.1 / platform 0.25.2 / admin-web 6.x / 四包 502+315 测试全绿
> 性质：**P3 级（优化项 / 已知边界 / 云部署前处理）**——不阻塞当前运行，但影响生产健壮性与可维护性
> 纪律：零 Core 破坏性改动；引擎公开 API 只增不改；每项独立可验收、可单独提交
> 前置：P2 修复方案（docs/P2-FIX-PLAN.md）已完成

---

## 总览（18 项，分三类处置）

### A 类：代码修复（8 张卡片）

| # | 缺口 | 影响面 | 改动包 | 预估 |
|---|---|---|---|---|
| 1 | advance_time 无上限（DoS 面） | 引擎健壮 | world-engine | 1h |
| 2 | registry.close() 不做资源收尾 | 资源泄漏 | world-engine | 1.5h |
| 3 | moveRule 不校验地点存在 | 数据完整性 | world-engine | 1h |
| 4 | router 页「清空」无二次确认（QA #9） | 前端 UX | admin-web | 0.5h |
| 5 | useModelControl 保存提示 revision 预计算（QA #13） | 前端文案 | admin-web | 0.5h |
| 6 | 库级缺省策略 FULL_CORE_POLICY 全开 | 安全面 | platform | 1h |
| 7 | NPC 个体 tick 串行→有界并发 | 性能 | platform | 2h |
| 8 | registerEventTables 不随档持久化 | 重启一致性 | world-engine | 2h |

### B 类：文档化 / 部署警示（1 张卡片，合并 7 项）

| # | 缺口 | 处置 |
|---|---|---|
| 9 | /intent 端点白名单旁路 | 部署文档警示 |
| 10 | token 估算保守口径 | SDK 文档化 |
| 11 | 传闻传播（spreadRumor）未接 | 路线记录 |
| 12 | 记忆文本英文 id 拼接 | Adapter 层文档 |
| 13 | 定时事件（bus.schedule/due）未被平台消费 | 路线记录 |
| 14 | 总线投递分级取模块级默认表 | 已知边界文档 |
| 15 | Journal 写失败静默 | 纪律文档（已有计数暴露） |

### C 类：维持现状（设计边界 / 有界自愈，不修）

| # | 缺口 | 判定理由 |
|---|---|---|
| 16 | 调度双源（平台+宿主） | 幂等无害，走查断言钉住；长期收敛属 V2.5 |
| 17 | 指纹检测窗口（每 N 轮） | 有界自愈（最坏 ≤N×interval），P9 已文档化 |
| 18 | 演示栈引擎纯内存 | 设计边界；opt-in 持久化已具备（WORLD_ENGINE_DATA_DIR） |

**合并重启窗口**：#1-#3 + #8 world-engine 一次；#6-#7 platform 一次；#4-#5 前端热加载；#9-#15 纯文档。
建议执行顺序：#1-#3 → #8 → #4-#5 → #6-#7 → #9-#15。

---

## 卡片 1：advance_time 无上限（云部署 DoS 面）

### 问题

`world-engine/src/time/WorldClock.ts:169-184`：
```typescript
function advance(n: number) {
  for (let i = 0; i < n; i++) { /* 逐刻推进：效果衰减 → 日边界 → 时辰边界 */ }
}
```
HTTP 端点（protocol.ts:703-708）校验 `n >= 1` 但**无上界**。`POST /v1/worlds/{id}/time {"ticks": 1e9}` 将同步阻塞事件循环数小时——云部署 DoS 面。

审计原文（§七 #10）：「advance_time 无上限（`{"ticks":1e9}` 同步阻塞——云部署 DoS 面）」。

### 锚点

- `world-engine/src/time/WorldClock.ts` L169（advance 函数）
- `world-engine/src/http/protocol.ts` L703-708（HTTP 校验）
- `world-engine/src/rules/coreRules.ts` L196-206（advanceTimeRule）

### 改动指令

**策略：双层钳制（HTTP 层 + 规则层），缺省上限 = 48×30 = 1440 刻（30 天），可配置**

1. HTTP 层增加上界校验（protocol.ts）：

```typescript
// L703-708 区域
const ticks = (req.body as { ticks?: unknown } | undefined)?.ticks;
const n = typeof ticks === 'number' ? ticks : Number(ticks);
if (!Number.isFinite(n) || Math.floor(n) < 1) {
  return { status: 400, body: { error: 'body must be {"ticks": <positive number>}' } };
}
/* P3：单次推进上限（防 DoS；缺省 1440 刻 = 30 天；装配方可经 init.maxTicksPerAdvance 覆盖） */
const maxTicks = init.maxTicksPerAdvance ?? 1440;
if (Math.floor(n) > maxTicks) {
  return { status: 400, body: { error: `ticks exceeds max (${maxTicks}); split into multiple requests` } };
}
```

2. `CreateWorldServerOptions`（或 protocol 的 init 类型）增加可选字段：

```typescript
/** 单次 advance_time 的最大刻数（缺省 1440 = 30 天；防同步阻塞 DoS） */
maxTicksPerAdvance?: number;
```

3. 规则层兜底（coreRules.ts advanceTimeRule）：

```typescript
apply(ctx) {
  const MAX_SINGLE_ADVANCE = 1440; // 30 天；与 HTTP 层同口径
  const raw = Math.max(1, Math.floor(ctx.command.amount ?? 1));
  const ticks = Math.min(raw, MAX_SINGLE_ADVANCE);
  if (ticks < raw) {
    ctx.emit({ type: 'time_advance_clamped', data: { requested: raw, applied: ticks } });
  }
  ctx.clock.advance(ticks);
  ctx.emit({ type: 'time_advanced', data: { ticks } });
},
```

### 单测

```typescript
it('HTTP ticks > maxTicksPerAdvance → 400', async () => {
  // POST /v1/worlds/{id}/time {"ticks": 99999} → 400 + 可读错误
});

it('HTTP ticks = maxTicksPerAdvance → 200（边界合法）', async () => {
  // POST {"ticks": 1440} → 200
});

it('规则层钳制：command amount=9999 → 实际推进 1440 + clamp 事实', () => {
  // executeCommand({ type:'advance_time', amount:9999 })
  // → state.t 增加 1440（非 9999）
  // → events 含 time_advance_clamped
});

it('正常推进不受影响：ticks=5 → 5', () => {
  // 既有测试零回归
});
```

### 验证命令

```bash
cd world-engine
npx vitest run tests/http*.test.ts tests/world-clock*.test.ts
npx vitest run   # 全量回归
```

### 提交信息

```
fix(world-engine): advance_time 增加单次上限钳制（缺省 1440 刻），防同步阻塞 DoS
```

---

## 卡片 2：registry.close() 不做资源收尾

### 问题

`world-engine/src/api/WorldRegistry.ts:49-51`：
```typescript
close(worldId: string): boolean {
  return worlds.delete(worldId);
}
```
仅从 Map 中移除引用。不做：
- `container.flushSave()`（挂起的脏档丢失）
- `FileSavePort.dispose()`（进程 exit 钩子累积、定时器悬垂）
- `bus.reset()`（isolated 总线的订阅者/死信/定时器悬垂）

后果：关闭的世界仍持有 SavePort 定时器与 exit 钩子；多次 create/close 循环会累积钩子（内存泄漏 + 退出时写已关闭世界的档）。

审计原文（§七 #10）：「registry.close 不收尾（不 flushSave、不 dispose SavePort、不 bus.reset），悬垂句柄仍可执行命令」。

### 锚点

- `world-engine/src/api/WorldRegistry.ts` L49-51（close）
- `world-engine/src/api/WorldAPI.ts` L80-117（WorldHandle 接口）
- `world-engine/src/state/fileStorage.ts` L200-204（FileSavePort.dispose）
- `world-engine/src/state/WorldState.ts` L88-91（container.flushSave）

### 改动指令

**策略：WorldHandle 增加 `dispose()` 方法（additive）；registry.close 调用它**

1. WorldHandle 接口增加：

```typescript
// WorldAPI.ts WorldHandle 接口
/** 释放世界资源：flush 挂起存档 → dispose SavePort → reset 事件总线。
 *  关闭后的句柄一切操作抛错（防悬垂使用）。 */
dispose(): void;
```

2. createWorld 内实现 dispose：

```typescript
// WorldAPI.ts createWorld 返回的 handle 对象内
let disposed = false;

function dispose(): void {
  if (disposed) return;
  disposed = true;
  /* 1. 冲刷挂起的脏档（节流窗口内的变更不丢） */
  container.flushSave();
  /* 2. 世界事件史落盘 */
  if (hasWorldLog() && worldLog.length > 0) savePort?.saveWorldLog?.(worldLog as unknown[]);
  /* 3. 释放 SavePort（移除 exit 钩子、清定时器） */
  if (savePort && typeof (savePort as any).dispose === 'function') {
    (savePort as any).dispose();
  }
  /* 4. 重置事件总线（isolated 世界：清订阅者/死信/定时器） */
  if (isolated) bus.reset();
}
```

3. 所有公开方法入口增加 disposed 守卫：

```typescript
function guardDisposed(): void {
  if (disposed) throw new Error(`world '${opts.worldId ?? 'world'}' has been disposed`);
}
// 在 getState / executeCommand / advanceTime / getEvents / emitEvent / setSavePort 等入口调用
```

4. registry.close 改为：

```typescript
close(worldId: string): boolean {
  const handle = worlds.get(worldId);
  if (!handle) return false;
  handle.dispose();
  worlds.delete(worldId);
  return true;
},
```

### 单测

```typescript
it('close 后 flushSave 被调用（脏档不丢）', () => {
  // create world with SavePort spy → executeCommand → close → 断言 save 被调用
});

it('close 后 FileSavePort.dispose 被调用（exit 钩子释放）', () => {
  // create world with FileSavePort → close → 断言 process listener count 不增
});

it('close 后句柄操作抛错（防悬垂使用）', () => {
  // close → getState() → throws 'disposed'
  // close → executeCommand() → throws 'disposed'
});

it('重复 close 幂等（不抛错）', () => {
  // close × 2 → 第二次返回 false，不抛
});

it('isolated 世界 close 后 bus.reset（订阅者清空）', () => {
  // create isolated → bus.on(...) → close → bus.stats().subscribers === 0
});
```

### 验证命令

```bash
cd world-engine
npx vitest run tests/registry*.test.ts tests/file-storage*.test.ts
npx vitest run   # 全量回归
```

### 提交信息

```
fix(world-engine): registry.close 增加资源收尾（flush/dispose/reset），防悬垂句柄与钩子泄漏
```

---

## 卡片 3：moveRule 不校验地点存在

### 问题

`world-engine/src/rules/coreRules.ts:175-190`（moveRule）与 L149-170（move_entity）：
```typescript
// moveRule
ctx.mutate.playerLoc(target);  // 不检查 target 是否在 state.locations 中
```
玩家/NPC 可以「走进不存在的地点」——世界状态出现悬空位置引用。

审计原文（§七 #10）：「moveRule 不校验地点存在（走进不存在的地点也成功）」。

### 锚点

- `world-engine/src/rules/coreRules.ts` L175-190（moveRule）
- `world-engine/src/rules/coreRules.ts` L149-170（moveEntityRule）
- `world-engine/src/types.ts`（EngineWorldState.locations）

### 改动指令

**策略：有地点表时校验存在性；无地点表时保持既有行为（向后兼容）**

1. moveRule 增加地点校验：

```typescript
export function moveRule<W extends EngineWorldState>(): WorldRule<W> {
  return {
    name: 'MoveRule',
    for: 'move',
    apply(ctx) {
      const target = ctx.command.targetId;
      if (!target) {
        ctx.emit({ type: 'move_failed', cause: '缺少目的地' });
        return false;
      }
      if (ctx.state.player.loc === target) {
        ctx.emit({ type: 'move_failed', cause: '已经在这里', location: target });
        return false;
      }
      /* P3：地点存在性校验——有地点表时拒绝走进不存在的地点；
         无地点表（locations 为空/未定义）时保持既有行为（向后兼容） */
      const locations = ctx.state.locations;
      if (locations && locations.length > 0 && !locations.some((l) => l.id === target)) {
        ctx.emit({ type: 'move_failed', cause: '地点不存在', location: target });
        return false;
      }
      ctx.mutate.playerLoc(target);
      ctx.emit({ type: 'player_moved', actor: ctx.command.actorId ?? 'player', location: target });
    },
  };
}
```

2. moveEntityRule 同理（L149-170 区域）：

```typescript
// 在 move_entity 的 apply 内，mutation 前增加同样的地点校验
const locations = ctx.state.locations;
if (locations && locations.length > 0 && !locations.some((l) => l.id === location)) {
  ctx.emit({ type: 'entity_move_failed', cause: '地点不存在', target: id, location });
  return false;
}
```

### 单测

```typescript
it('有地点表时 move 到不存在地点 → 拒绝 + move_failed 事实', () => {
  // 播种 locations: [{id:'plaza'}] → move target='nowhere' → ok:false
  // events 含 move_failed cause='地点不存在'
});

it('有地点表时 move 到存在地点 → 成功', () => {
  // move target='plaza' → ok:true, player.loc='plaza'
});

it('无地点表时 move 到任意字符串 → 成功（向后兼容）', () => {
  // locations=[] 或 undefined → move target='anywhere' → ok:true
});

it('move_entity 同理：NPC 移入不存在地点 → 拒绝', () => {
  // move_entity targetId=npc1 location='nowhere' → ok:false
});
```

### 验证命令

```bash
cd world-engine
npx vitest run tests/mutate-runtime*.test.ts tests/api*.test.ts tests/adapter*.test.ts
npx vitest run   # 全量回归
cd ../platform
npx vitest run   # 平台回归（演化 move_entity 命令）
```

**注意**：天穹宿主播种了 locations（P2 修复），走查脚本中的移动目标均在地点表内——预期零回归。但需确认 `scripts/run-tianqiong-host.mjs` 的地点表覆盖所有走查路径。

### 提交信息

```
fix(world-engine): moveRule/moveEntityRule 增加地点存在性校验（有表时拒绝悬空位置）
```

---

## 卡片 4：router 页「清空」无二次确认（QA #9）

### 问题

`admin-web/src/views/gateway/router/index.vue:78-83`：
```typescript
function clearRoute(cap: ManagedCapability) {
  if (!mc.config.value) return;
  mc.config.value.routes[cap] = { primary: null, fallback: null };
  mc.markDirty();
}
```
点击「清空」按钮直接清除路由配置（草稿），无确认弹窗。虽然只是草稿语义（需「保存全部」才生效），但误触后用户可能不知道发生了什么。

QA 原文（#9）：「router 页「清空」无二次确认（直接改草稿）」。

### 锚点

- `admin-web/src/views/gateway/router/index.vue` L78-83（clearRoute）、L228（按钮）

### 改动指令

```typescript
import { ElMessageBox } from "element-plus";

async function clearRoute(cap: ManagedCapability) {
  if (!mc.config.value) return;
  const zh = CAPABILITY_META[cap]?.zh ?? cap;
  try {
    await ElMessageBox.confirm(
      `将「${zh}」能力的主/备路由全部清空（保存后该能力返回 503）。`,
      "清空路由确认",
      { type: "warning", confirmButtonText: "清空", cancelButtonText: "取消" }
    );
  } catch {
    return; // 用户取消
  }
  mc.config.value.routes[cap] = { primary: null, fallback: null };
  mc.markDirty();
}
```

模板中按钮无需改动（`@click="clearRoute(...)"` 已绑定）。

### 单测

admin-web 无组件单测；验证 = `vue-tsc --noEmit` + `vite build` 通过。

### 验证命令

```bash
cd admin-web
npx vue-tsc --noEmit
npx vite build
```

手动验证：dev-stack → 模型路由页 → 点「清空」→ 弹窗确认 → 取消=不变 / 确认=草稿清空。

### 提交信息

```
fix(admin-web): router 页「清空」增加二次确认弹窗（QA #9）
```

---

## 卡片 5：useModelControl 保存提示 revision 预计算（QA #13）

### 问题

`admin-web/src/composables/useModelControl.ts:126`：
```typescript
message(`配置已保存并即时生效（revision ${config.value.revision + 1}）`, { type: "success" });
await load();
```
提示中的 revision 是**本地预计算**（当前+1），但服务端实际 revision 可能不同（并发写入、凭证上传推进等）。`await load()` 之后才有真实值。

QA 原文（#13）：「useModelControl 保存成功提示的 revision 为预计算值」。

### 锚点

- `admin-web/src/composables/useModelControl.ts` L111-149（save 函数）、L126（提示文案）

### 改动指令

将提示移到 `load()` 之后，使用服务端返回的真实 revision：

```typescript
async function save(): Promise<boolean> {
  if (!config.value || saving.value) return false;
  const localIssues = clientValidate(config.value);
  if (localIssues.length > 0) {
    message(localIssues[0], { type: "warning" });
    return false;
  }
  saving.value = true;
  try {
    await modelControlApi.putConfig(
      cloneConfig(config.value),
      config.value.revision
    );
    dirty.value = 0;
    conflict.value = false;
    await load(); // 先刷新，拿到服务端真实 revision
    message(`配置已保存并即时生效（revision ${config.value?.revision ?? "?"}）`, {
      type: "success"
    });
    return true;
  } catch (e) {
    // ... 既有错误处理不变 ...
  } finally {
    saving.value = false;
  }
}
```

### 单测

验证 = `vue-tsc --noEmit` + `vite build` 通过。

### 验证命令

```bash
cd admin-web
npx vue-tsc --noEmit
npx vite build
```

手动验证：模型路由页 → 改配置 → 保存 → 提示中 revision 与服务端一致（对比 GET /v1/admin/model-control 响应）。

### 提交信息

```
fix(admin-web): 保存成功提示使用服务端真实 revision（QA #13）
```

---

## 卡片 6：库级缺省策略 FULL_CORE_POLICY 全开

### 问题

`platform/src/evolution/commands.ts:39-45`：
```typescript
export const FULL_CORE_POLICY: EvolutionPolicy = {
  allowedActions: CORE_EVOLUTION_ACTIONS,
  forbiddenActionsOnPlayer: [],
  maxChangesPerProposal: Number.MAX_SAFE_INTEGER,
  maxEntitiesAffected: Number.MAX_SAFE_INTEGER,
  cooldownMs: 0,
};
```
`createEvolutionRuntime` 的 `opts.policy` 缺省回退到 FULL_CORE_POLICY（runtime.ts:110）。若装配方忘传策略，AI 可无限改实体、无冷却——库级缺省无结构性强制。

审计原文（§七 #8）：「库级缺省策略 FULL_CORE_POLICY 全开：run-managed 已显式传 NPC_EVOLUTION_POLICY，但库级缺省无结构性强制」。

### 锚点

- `platform/src/evolution/commands.ts` L39-45（FULL_CORE_POLICY）
- `platform/src/evolution/runtime.ts` L110（`opts.policy ?? FULL_CORE_POLICY`）
- `platform/src/evolution/policy.ts`（NPC_EVOLUTION_POLICY 定义）

### 改动指令

**策略：缺省从 FULL_CORE_POLICY 收紧为 NPC_EVOLUTION_POLICY（安全缺省）；FULL_CORE_POLICY 保留但需显式传入**

1. runtime.ts L110 修改缺省：

```typescript
// 旧：const defaultPolicy = opts.policy ?? FULL_CORE_POLICY;
// 新：安全缺省 = NPC 演化策略（3 动作/3 变化/3 实体/30s 冷却/禁触玩家）
//     FULL_CORE_POLICY 需装配方显式传入（「我知道我在做什么」）
import { NPC_EVOLUTION_POLICY } from './policy.ts';
const defaultPolicy = opts.policy ?? NPC_EVOLUTION_POLICY;
```

2. 在 FULL_CORE_POLICY 定义处增加文档注释：

```typescript
/**
 * 全开策略（无限制）：仅用于测试与受信任的内部装配。
 * **不是 createEvolutionRuntime 的缺省值**——缺省为 NPC_EVOLUTION_POLICY（安全缺省）。
 * 显式传入此策略表示装配方确认：AI 可执行全部白名单动作、无变化数/实体数上限、无冷却。
 */
export const FULL_CORE_POLICY: EvolutionPolicy = { ... };
```

3. **向后兼容检查**：grep 全部 `createEvolutionRuntime` 调用点，确认生产装配（run-managed.mjs）已显式传 `NPC_EVOLUTION_POLICY`；测试中若依赖 FULL_CORE_POLICY 缺省行为的，需显式传入。

```bash
grep -rn "createEvolutionRuntime" platform/tests/ platform/scripts/
```

### 单测

```typescript
it('未传 policy → 缺省为 NPC_EVOLUTION_POLICY（安全缺省）', () => {
  // createEvolutionRuntime({ engine, driver })（不传 policy）
  // → AI 提案改 4 个实体 → 第 4 个被 policy 拒绝（maxEntitiesAffected=3）
});

it('显式传 FULL_CORE_POLICY → 无限制（向后兼容）', () => {
  // createEvolutionRuntime({ engine, driver, policy: FULL_CORE_POLICY })
  // → AI 提案改 10 个实体 → 全部通过
});

it('既有测试零回归（依赖缺省行为的测试需显式传 FULL_CORE_POLICY）', () => {
  // 全量 vitest run
});
```

### 验证命令

```bash
cd platform
grep -rn "createEvolutionRuntime" tests/ scripts/   # 确认调用点
npx vitest run   # 全量回归
```

### 提交信息

```
fix(platform): 演化运行时缺省策略从 FULL_CORE_POLICY 收紧为 NPC_EVOLUTION_POLICY（安全缺省）
```

---

## 卡片 7：NPC 个体 tick 串行→有界并发

### 问题

`platform/src/evolution/triggerRuntime.ts:203-211`：
```typescript
for (const npc of woken) {
  // ...
  const run = await opts.evolution.tick(st.worldId, 'auto', { idempotencyKey: key, wakePlan: npcPlan });
  // ...
}
```
同一事件唤醒多个 NPC 时，逐个 `await`——串行执行。若唤醒 3 个 NPC，每个 AI 调用 2s，总耗时 6s。

审计原文（P5 遗留）：「个体 tick 是串行的（同事件多 NPC 顺序执行）——并发批量属 P11 压测议题」。

P11 压测实测：最坏情况（100 NPC 世界，5 名 HIGH）AI 调用 4 次——串行耗时 ~8s。有界并发可降至 ~2s。

### 锚点

- `platform/src/evolution/triggerRuntime.ts` L203-215（for...of await 循环）
- `platform/src/evolution/runtime.ts` L163-186（inFlight 并发锁——按世界串行）

### 改动指令

**策略：有界并发（concurrency limit = 3），保留世界级串行锁语义**

注意：runtime.ts 的 `inFlight` 锁是**按世界**串行的——同一世界的并发 tick 会排队。因此即使 triggerRuntime 并发发起多个 tick，runtime 内部仍会串行化。

**真正瓶颈**：runtime 的世界级锁让同世界多 NPC 无法并行。改为**按焦点分域**的锁：

1. runtime.ts 并发锁改为 `world|focus` 粒度：

```typescript
// 旧：const inFlight = new Map<string, Promise<EvolutionRun>>();
// 新：按 world|focus 分域（同一 NPC 串行，不同 NPC 可并行）
const inFlight = new Map<string, Promise<EvolutionRun>>();

function tick(worldId, trigger, tickOpts) {
  const focus = focusOf(worldId, tickOpts.wakePlan);
  const lockKey = `${worldId}|${focus}`;  // 焦点分域
  const prev = inFlight.get(lockKey);
  const exec = (async () => {
    if (prev) { try { await prev; } catch {} }
    return runTick(worldId, trigger, tickOpts);
  })();
  inFlight.set(lockKey, exec);
  const cleanup = () => { if (inFlight.get(lockKey) === exec) inFlight.delete(lockKey); };
  exec.then(cleanup, cleanup);
  return exec;
}
```

2. triggerRuntime.ts 改为有界并发：

```typescript
/* P3：有界并发（同事件多 NPC 并行 tick，上限 3；世界级安全由 runtime 焦点锁保证） */
const TICK_CONCURRENCY = 3;

async function runBatch<T>(items: T[], fn: (item: T) => Promise<void>, limit: number): Promise<void> {
  const executing: Promise<void>[] = [];
  for (const item of items) {
    const p = fn(item).then(() => { executing.splice(executing.indexOf(p), 1); });
    executing.push(p);
    if (executing.length >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

// 替换原 for...of 循环：
await runBatch(woken, async (npc) => {
  const npcPlan = { ...plan, wakes: plan.wakes.map(w => w.entityId === npc ? w : { ...w, grade: 'none', reasons: [...w.reasons, 'not_this_focus'] }) };
  const key = `auto:${st.worldId}:${gen}:${eventId}:${npc}`;
  try {
    const run = await opts.evolution.tick(st.worldId, 'auto', { idempotencyKey: key, wakePlan: npcPlan });
    st.ticksFired++;
    for (const id of run.eventIds ?? []) st.born.add(id);
    // ... 既有日志 ...
  } catch (e) {
    // ... 既有错误处理 ...
  }
}, TICK_CONCURRENCY);
```

### 单测

```typescript
it('同事件唤醒 3 NPC → 并行执行（总耗时 < 3×单次）', async () => {
  // mock driver 每次 propose 延迟 100ms
  // 3 NPC 唤醒 → 总耗时 < 250ms（并行）而非 > 300ms（串行）
});

it('同一 NPC 的并发 tick 仍串行（焦点锁）', async () => {
  // 同一 focus 连发 2 次 tick → 第二次等第一次完成
});

it('不同 NPC 的 tick 互不阻塞', async () => {
  // NPC-A tick 进行中 → NPC-B tick 不等待
});

it('既有测试零回归（串行语义测试仍通过）', () => {
  // 全量 vitest run
});
```

### 验证命令

```bash
cd platform
npx vitest run tests/trigger*.test.ts tests/evolution*.test.ts
npx vitest run   # 全量回归
```

### 提交信息

```
perf(platform): NPC 个体 tick 从串行改为有界并发（焦点分域锁，上限 3）
```

---

## 卡片 8：registerEventTables 不随档持久化

### 问题

`world-engine/src/events/EventSchema.ts:78-91`：`LEVEL_TABLE` 和 `CHANNEL_TABLE` 是纯内存对象。宿主通过 `registerEventTables()` 注册的分级/通道表不随 SavePort 持久化——重启后回落 Level 1 / ambient 缺省。

审计原文（复审补丁尾部）：「registerEventTables 分级/通道表不随档持久化（重启后回落 Level 1/ambient）」。

后果：重启后事件分级错误 → 触发器分级判断失准（High 事件被当 ambient）→ 演化不触发。

### 锚点

- `world-engine/src/events/EventSchema.ts` L78-91（createEventSchema / registerEventTables）
- `world-engine/src/api/WorldAPI.ts` L119-139（createWorld，isolated 时创建独立 schema）
- `world-engine/src/state/storage.ts`（SavePort 接口）

### 改动指令

**策略：SavePort 增加可选通道 `loadEventTables/saveEventTables`（additive）；WorldAPI 装配时恢复/变更时落盘**

1. SavePort 接口增加可选方法：

```typescript
// world-engine/src/state/storage.ts SavePort 接口
/** 事件分级/通道表持久化（P3：重启后恢复宿主注册的表） */
loadEventTables?(): { levels: Record<string, number>; channels: Record<string, string> } | null;
saveEventTables?(tables: { levels: Record<string, number>; channels: Record<string, string> }): void;
```

2. EventSchemaInstance 增加导出/导入：

```typescript
// EventSchema.ts EventSchemaInstance 接口
/** 导出当前分级/通道表（持久化用） */
exportTables(): { levels: Record<string, WorldEventLevel>; channels: Record<string, EventChannel> };
/** 导入表（恢复用；幂等覆盖） */
importTables(tables: { levels: Record<string, WorldEventLevel>; channels: Record<string, EventChannel> }): void;
```

实现：
```typescript
exportTables() {
  return { levels: { ...LEVEL_TABLE }, channels: { ...CHANNEL_TABLE } };
},
importTables(tables) {
  api.registerEventTables(tables.levels, tables.channels);
},
```

3. WorldAPI createWorld 内：

```typescript
// 启动恢复：从 SavePort 加载表
const savedTables = savePort?.loadEventTables?.();
if (savedTables) events.importTables(savedTables);

// registerEventTables 包装：注册后落盘
const origRegister = events.registerEventTables;
events.registerEventTables = (levels, channels) => {
  origRegister(levels, channels);
  savePort?.saveEventTables?.(events.exportTables());
};
```

4. FileSavePort 实现（fileStorage.ts）：

```typescript
private tablesPath = this.filePath + '.tables.json';

loadEventTables() {
  if (!existsSync(this.tablesPath)) return null;
  try { return JSON.parse(readFileSync(this.tablesPath, 'utf8')); }
  catch { return null; }
}

saveEventTables(tables) {
  try {
    mkdirSync(dirname(this.tablesPath), { recursive: true });
    writeFileSync(this.tablesPath, JSON.stringify(tables, null, 2), 'utf8');
  } catch { /* 写失败不炸运行时 */ }
}
```

### 单测

```typescript
it('registerEventTables 后重启恢复（分级/通道不丢）', () => {
  // create world A → registerEventTables({combat:3},{combat:'critical'}) → setSavePort(FileSavePort)
  // 模拟重启：create world B（同 SavePort 文件）→ levelOf('combat')===3, channelOf({type:'combat'})==='critical'
});

it('无 SavePort 时行为不变（纯内存）', () => {
  // create world（无 savePort）→ registerEventTables → 重启后回落缺省
});

it('exportTables/importTables 幂等', () => {
  // register → export → import → export → 两次相同
});
```

### 验证命令

```bash
cd world-engine
npx vitest run tests/world-log*.test.ts tests/v24-hardening*.test.ts tests/file-storage*.test.ts
npx vitest run   # 全量回归
```

### 提交信息

```
feat(world-engine): 事件分级/通道表随 SavePort 持久化，重启后恢复宿主注册
```

---

## 卡片 9：文档化批次（7 项合并）

### 9.1 /intent 端点白名单旁路 → 部署文档警示

**问题**：`POST /v1/evolution/worlds/:id/intent`（admin/http.ts:1154-1179）的 `ic_action` 分支接受 `command` 对象直通引擎，闸门只有 `requirePerm('gateway:manage')`。持有管理权限的调用方可绕过演化围栏直接发命令。

**处置**：在 `docs/DEPLOY.md` 安全须知节增加：

```markdown
### /intent 端点（ic_action 命令直通）

`POST /v1/evolution/worlds/:id/intent` 的 `ic_action` 分支接受 `command` 对象，
经权限校验（`gateway:manage`）后**直通引擎命令链**——不经演化围栏/白名单/冷却。

这是设计决定（游戏方需要确定性命令通道），但意味着：
- 持有 `gateway:manage` 权限的 Key 可绕过 AI 围栏直接改世界
- 对外部署时，`gateway:manage` 权限只授予受信任的管理面会话
- 游戏方公共 Key 不应持有此权限（缺省最小权限 = `worlds:read`，见 P2 #3）
```

### 9.2 token 估算保守口径 → SDK 文档化

**问题**：Context Engine 的 token 估算是字符数/4 的保守口径，非模型分词器精确值。

**处置**：在 `docs/SDK-GUIDE.md` Context Budget 节增加：

```markdown
> **Token 估算口径**：`estimatedTokens` 使用 `ceil(chars/4)` 保守估算（非模型分词器精确值）。
> 预算语义是「裁剪依据」而非计费口径——实际模型消耗可能低于估算值。
> 若需精确计费，请从 Gateway 的 usage 记录（`prompt_tokens`/`completion_tokens`）取数。
```

### 9.3 传闻传播（spreadRumor）未接 → 路线记录

**处置**：在 `docs/GAME-PLATFORM-PLAN.md` V2.5 方向节追加：

```markdown
- **传闻传播（spreadRumor）**：跨 NPC 口口相传需要「谁告诉谁」的社交事实
  （`npc_told_npc` 事件类型），引擎暂无对应事件。落地路径：
  ① World Schema 增加 `communication` 事实类型面；② MemoryRuntime 消费该事实
  触发 spreadRumor；③ 衰减按社交距离（关系值）加权。属 V2.5 Relationship Runtime 批次。
```

### 9.4 记忆文本英文 id 拼接 → Adapter 层文档

**处置**：在 `docs/SDK-GUIDE.md` Memory 节增加：

```markdown
> **记忆文本本地化**：缺省记忆描述使用英文 id 拼接（`world-min` 面：`"player talk_started → milu"`）。
> 游戏方可通过 `MemoryEngine.remember()` 自定义叙事化文案（中文/本地化）：
> ```js
> memory.remember(worldId, { owner: 'milu', text: '玩家主动找我搭话，语气友善', ... });
> ```
> 自定义文案优先于缺省拼接（同 sourceEventId 幂等覆盖）。
```

### 9.5 定时事件未被平台消费 → 路线记录

**处置**：在 `docs/GAME-PLATFORM-PLAN.md` V2.5 方向节追加：

```markdown
- **定时事件平台消费**：引擎 `bus.schedule(event, delayDays)` / `bus.due(day)` 已实现，
  但平台 ScheduleRuntime 当前只消费 `new_day` / `hour_advanced` 做位置对齐。
  任务型定时（「第 3 天集市开张」「午夜刺客来袭」）需平台增加 `due` 轮询 →
  触发演化或直接 emit。属 V2.5 Quest Runtime 批次前置。
```

### 9.6 总线投递分级取模块级默认表 → 已知边界文档

**处置**：在 `world-engine/CHANGELOG.md` 已知边界节追加：

```markdown
### 已知边界（P3 记录）
- `channelOf(e)` 取模块级默认 CHANNEL_TABLE：isolated 世界经 `createEventSchema()`
  注册的通道表参与该世界内部的 `channelOf` 判定，但**全局缺省导出**
  （`import { channelOf } from 'world-engine/events'`）始终读默认表。
  影响：直接导入全局 `channelOf` 的宿主代码对 isolated 世界的通道判定不准。
  缓解：isolated 世界应使用 `handle.events.channelOf`（实例方法）而非全局导出。
  通道表参数化（全局导出感知多世界）属 V2.5。
```

### 9.7 Journal 写失败静默 → 纪律文档

**处置**：在 `docs/EVOLUTION-ARCHITECTURE.md` Journal 节追加：

```markdown
> **写失败纪律**：Journal JSONL 落盘失败时**不炸运行时**（演化账本损坏不能反过来
> 伤害世界进程）——失败计数经 `writeFailures()` 暴露，Admin Runtime 观测面可查。
> 这是设计决定而非缺口：世界正确性 > 账本完整性。若需强一致账本，
> 应替换为事务性介质（PostgreSQL）而非改变失败语义。
```

### 验证命令

```bash
# 文档变更无代码影响；确认 markdownlint 通过（若配置了）
cd admin-web && npx markdownlint ../docs/*.md --config .markdownlint.json 2>/dev/null || true
```

### 提交信息

```
docs: P3 文档化批次（/intent 警示 + token 口径 + 传闻路线 + 记忆本地化 + 定时事件 + 通道表边界 + Journal 纪律）
```

---

## C 类：维持现状登记（不修，留档）

| # | 缺口 | 判定 | 依据 |
|---|---|---|---|
| 16 | 调度双源（平台 ScheduleRuntime + 宿主立即对齐） | 幂等无害 | 对齐按「权威状态 vs 日程」比对，已对齐零命令；走查 [26][34] 日程比对断言钉住；长期收敛属 V2.5 Admin UI 收口 |
| 17 | 指纹检测窗口（每 N=10 轮比对 seed） | 有界自愈 | 最坏 ≤10×3s=30s 的触发被误判重（宁阻塞不重复）；P9 已文档化；改订阅制属 P11 规模化议题 |
| 18 | 演示栈引擎纯内存 | 设计边界 | `WORLD_ENGINE_DATA_DIR` opt-in 持久化已具备（V2.4 复审补丁）；dev-stack 缺省不开是刻意的（开发循环快速重启） |

---

## 执行纪律

1. **逐卡片提交**：每张卡片独立 commit，不混合
2. **回归门**：每张卡片完成后跑对应包全量测试 + tsc --noEmit，绿了才进下一张
3. **不触红线**：
   - 引擎公开 API 只增不改（dispose / exportTables / importTables / maxTicksPerAdvance 均为新增）
   - 玩法语义不进引擎（地点校验是数据完整性，不是玩法）
   - AI 无状态写入口
   - 不为前端方便修改 Core
4. **向后兼容**：
   - 卡片 1：缺省 1440 刻上限，既有测试最大推进量远低于此
   - 卡片 3：无地点表时保持既有行为（locations 为空/undefined 不校验）
   - 卡片 6：既有测试若依赖 FULL_CORE_POLICY 缺省需显式传入（grep 确认）
   - 卡片 7：焦点分域锁是放宽（原世界级锁更严），既有串行测试仍通过
   - 卡片 8：SavePort 无 loadEventTables 时行为不变
5. **合并重启**：#1-#3 + #8 engine 一次；#6-#7 platform 一次；#4-#5 前端热加载

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

# P3 专项验证
# 卡片 1：curl -X POST localhost:8787/v1/worlds/w-main/time -d '{"ticks":99999}' → 400
# 卡片 2：create → close → getState → throws
# 卡片 3：move to 'nowhere'（有地点表世界）→ ok:false
# 卡片 7：3 NPC 同时唤醒 → 总耗时 < 2×单次（并行证据）
# 卡片 8：registerEventTables → 重启 → levelOf 保持
```

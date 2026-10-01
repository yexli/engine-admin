/* ============================================================
   AI World Evolution Demo（方案 §十 · Phase B 验收演示）
   ------------------------------------------------------------
   最小世界：村庄 / 酒馆 / 商店 + 米露 / 商人老葛 + 时间 / NPC /
   经济 / 关系。真实引擎（真实 Rules 链、真实事件总线）+
   脚本化 AI 驱动（确定性，不联网、不需要模型凭证）。

   演示三幕：
     第一幕  玩家走进酒馆 → 世界事件 → AI 观察并提案 → Rules → 落地
     第二幕  时间推进三日 → AI 跨系统推演（经济 + 关系） → 落地
     第三幕  AI 提出非法建议 → 白名单 / Rules 当场拒绝 → 世界分毫不动

   运行（先构建：world-engine、world-engine/gateway、platform）：
     node scripts/run-evolution-demo.mjs
   ============================================================ */
import { startWorldServer } from "../world-engine/dist/http/server.js";
import { createWorldRegistry, InMemoryWorldStorage } from "../world-engine/dist/index.js";
import {
  NPC_EVOLUTION_POLICY,
  createEngineClient,
  createEvolutionJournal,
  createEvolutionRuntime,
  createScriptedDriver,
} from "../platform/dist/index.js";

const line = (t = "─") => console.log(t.repeat(64));

/* ---------- 1) 起真实引擎，播种最小世界（种子命令走同一条命令链） ---------- */
const registry = createWorldRegistry();
const world = registry.create({
  worldId: "w-evolution-demo",
  playerName: "旅人",
  startLoc: "village",
  weather: "clear",
  savePort: new InMemoryWorldStorage(),
  definition: {
    locations: [
      { id: "village", type: "urban", attributes: { desc: "村庄" } },
      { id: "tavern", type: "building", attributes: { desc: "米露的酒馆" } },
      { id: "shop", type: "building", attributes: { desc: "老葛的商店" } },
    ],
  },
});
for (const cmd of [
  { type: "create_entity", payload: { id: "milu", type: "npc", name: "米露", location: "tavern", attributes: { tavern_revenue: 100 } } },
  { type: "create_entity", payload: { id: "trader", type: "npc", name: "商人老葛", location: "shop", attributes: { goods_rice: 50 } } },
  { type: "set_relation", actorId: "milu", targetId: "trader", payload: { type: "friend", value: 20 } },
]) {
  const r = world.executeCommand(cmd);
  if (!r.ok) throw new Error(`种子命令被拒绝：${JSON.stringify(r)}`);
}

const server = await startWorldServer({ registry, port: 0 });
const engine = createEngineClient({ baseUrl: server.url });
const evoOf = (driver) => createEvolutionRuntime({ engine, driver, policy: NPC_EVOLUTION_POLICY }, createEvolutionJournal());

function showRun(run, title) {
  line();
  console.log(`■ ${title}`);
  line("·");
  console.log(`  run       : ${run.id}  status=${run.status}  tookMs=${run.tookMs}ms`);
  console.log(`  观察      : ${run.context ? `${Object.keys(run.context.entities).length} 实体 / ${run.context.events.length} 条近期事实` : "（观察失败）"}`);
  if (run.proposal) {
    console.log(`  AI 判断  : ${run.proposal.reason}`);
    for (const o of run.proposal.observations) console.log(`    · 依据 [${o.ref}] ${o.summary}`);
    for (const c of run.proposal.changes) console.log(`    · 建议 ${c.action} → ${c.targetId}（${c.reason}）`);
  }
  for (const o of run.outcomes ?? []) {
    const verdict = o.accepted
      ? "✓ Rules 放行"
      : o.rejectedBy === "translate"
        ? "✗ 白名单拒绝"
        : o.rejectedBy === "policy"
          ? "✗ 策略拒绝"
          : "✗ Rules 拒绝";
    console.log(`  裁决      : ${verdict} ${o.command ? `[${o.command.type}]` : ""}${o.reason ? `（${o.reason}）` : ""}`);
    for (const id of o.eventIds) console.log(`      └─ 事实 ${id}`);
  }
  if (run.error) console.log(`  错误      : ${run.error}`);
}

line("═");
console.log("AI World Evolution Demo —— 最小世界（村庄 / 酒馆 / 商店）");
line("═");

/* ---------- 第一幕：玩家走进酒馆 → AI 反应 ---------- */
const move = world.executeCommand({ type: "move", targetId: "tavern" });
console.log(`\n[世界] 玩家走进酒馆 → ${move.ok ? `事实 ${move.events.join(", ")}` : "被拒绝"}`);
const moveEventId = move.events[0];
const act1 = await evoOf(
  createScriptedDriver([
    {
      reason: "玩家进入酒馆，米露注意到这位旅人",
      observations: [{ ref: moveEventId, kind: "event", summary: "玩家移动到酒馆（真实事件 id）" }],
      changes: [
        { targetId: "milu", action: "set_relation", payload: { type: "noticed", otherId: "player", value: 10 }, reason: "米露看见玩家进店" },
        { targetId: "milu", action: "update_attribute", payload: { key: "tavern_revenue", value: 130 }, reason: "有客上门，营业额上升" },
      ],
      confidence: 0.8,
    },
  ]),
).tick("w-evolution-demo", "admin");
showRun(act1, "第一幕：玩家行为 → 世界事件 → AI 提案 → Rules → 落地");
const s1 = world.getState();
console.log(`\n[世界] 米露 tavern_revenue = ${s1.npcs.milu.attributes.tavern_revenue}（原 100）；关系表新增 noticed 边`);

/* ---------- 第二幕：时间推进三日 → 跨系统演化 ---------- */
const adv = world.executeCommand({ type: "advance_time", amount: 48 * 3 });
console.log(`\n[世界] 时间推进三日 → ${adv.ok ? `事实 ${adv.events.join(", ")}` : "被拒绝"}`);
const act2 = await evoOf(
  createScriptedDriver([
    {
      reason: "玩家离开三日：酒馆收入回落、商店库存下调、商人与米露的供货关系出现张力",
      observations: [{ ref: "state", kind: "state", summary: "三日后状态快照" }],
      changes: [
        { targetId: "milu", action: "update_attribute", payload: { key: "tavern_revenue", value: 80 }, reason: "常客未归，收入回落" },
        { targetId: "trader", action: "update_attribute", payload: { key: "goods_rice", value: 35 }, reason: "库存自然消耗" },
        { targetId: "trader", action: "set_relation", payload: { type: "supply_tension", otherId: "milu", value: -15 }, reason: "供货关系出现张力" },
      ],
      confidence: 0.7,
    },
  ]),
).tick("w-evolution-demo", "admin");
showRun(act2, "第二幕：三日不见 → 跨系统演化（经济 + 关系）");
const s2 = world.getState();
console.log(
  `\n[世界] 米露 tavern_revenue=${s2.npcs.milu.attributes.tavern_revenue}；老葛 goods_rice=${s2.npcs.trader.attributes.goods_rice}；` +
    `关系 supply_tension=${(s2.relations ?? []).find((r) => r.type === "supply_tension")?.value}`,
);

/* ---------- 第三幕：越权建议 → 策略 / 白名单 / Rules 三层围栏 ---------- */
const act3 = await evoOf(
  createScriptedDriver([
    {
      reason: "米露希望改写一切（一连串越权建议）",
      observations: [{ ref: "state", kind: "state", summary: "状态快照" }],
      changes: [
        { targetId: "player", action: "update_attribute", payload: { key: "money", value: 999999 }, reason: "试图给玩家加钱（策略禁止 AI 触碰玩家）" },
        { targetId: "ghost", action: "move_entity", payload: { location: "tavern" }, reason: "试图移动不存在的幽灵（引擎规则会拒）" },
        { targetId: "milu", action: "grant_god_mode", reason: "试图越权（内核白名单没有这个动作）" },
      ],
    },
  ]),
).tick("w-evolution-demo", "admin");
showRun(act3, "第三幕：AI 越权建议 → 策略 / 白名单 / Rules 三层围栏");
const s3 = world.getState();
console.log(`\n[世界] 实体表仍是 ${Object.keys(s3.npcs).join("、")}，玩家钱分文未动——AI 拿世界毫无办法，除非围栏与 Rules 放行`);

/* ---------- 因果链回溯 ---------- */
line("═");
console.log("因果链账本（为什么世界发生了这些变化；每幕独立账本，本进程最近一次：）");
console.log(`  ${act3.id}  ${act3.status}  accepted=${act3.acceptedCount} rejected=${act3.rejectedCount} events=[${act3.eventIds.join(", ")}]`);
line("═");
console.log("闭环成立：系统提供信息 → AI 推演 → Proposal → Rules → Mutation → State → Event → 新的世界信息。");
console.log("接入真实模型：把 createScriptedDriver(...) 换成 gatewayDriver({ gateway, router }) 即可");
console.log("（受管模式下 run-managed.mjs 已内置装配，管理台 → AI 演化 可触发与追溯）。");

await server.close();
process.exit(0);

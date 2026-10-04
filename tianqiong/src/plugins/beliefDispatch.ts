/* ============================================================
   卡 J2 · 信念行动派发（《天穹纪元2.0-后续开发方案-阶段J》）
   —— 把「信念」接到「行动」上：认知闭环的最后一段。

   阶段 J 审计实测的断裂点：
     · MemoryLifecycle.memoryTick():154 → formBeliefs()   —— 信念每天正常聚合 ✓
     · ai/ContextBuilder.ts:191 → beliefsOf()             —— 信念正常进 AI 上下文 ✓
     · beliefActionsFor()                                 —— 生产零调用，规则表为空 ✗
   机制侧其实全就位：matchBeliefRules 支持三重匹配 + minConfidence + once 去重，
   markBeliefActed 能写回 actedAt/actionKind。缺的只是「谁来调」。

   四条纪律：
     1. **白名单是唯一裁判**：规则表写了没登记为 effects 的动作会被 Validator 直接拒，
        这里不做二次过滤——让拒绝理由只有一处，调试时才不会两边打架。
     2. **只驱动确定性后果**：立案 / 冷淡 / 传谣这类有明确规则的后果才进规则表；
        语义模糊的一律留给 AI 通道，否则同一件事会被规则与模型各产生一次后果。
     3. **预检 + 失败记账**（独立审查整改）：handler 的静默 return 会被执行器记为成功
        （WorldExecutor 的 executed++ 只要求不抛异常），于是「账记了、世界没变」。
        结构性不可满足的调用在派发前挡住并写 failedAt——不记就等于每天重试一次。
     4. **不消耗主随机流**：本格排在日结算顺序表末尾。注意这**只是必要条件**，
        真正的保证是「整条调用链不消耗 rng」——由 traceability 的 rng 不变量用例钉住。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { worldExecutor } from '@/execution/WorldExecutor';
import { runLog } from '@/devlog/RunLog';
import { beliefActionsFor, beliefOf, markBeliefActed, markBeliefFailed } from '@/memory/belief/BeliefSystem';
import { memoriesOf } from '@/memory/MemoryStore';
import type { WorldState } from '@/types/world';

/**
 * 需要 target 是真实 NPC 的动作——**镜像** handlers.ts 里同形的守卫
 * （`if (!s || !npc || !WB.npcs[npc]) return;`，见 change_relationship / spread_rumor /
 * form_grudge / befriend / change_goal 五处）。
 * 为什么在派发前预检：那条 return 是静默的，执行器照样计 executed++，
 * 于是派发方以为落地了、账记上了，世界其实一动没动。
 * 若将来 handlers 改了守卫，这里必须同步——两处都是「契约的镜像」，没有单一来源。
 */
const NEEDS_NPC_TARGET = new Set(['change_relationship', 'befriend', 'form_grudge', 'spread_rumor', 'change_goal']);

/** 需要一条真实存在的事件作为依据的动作（同样镜像 handlers.ts 的 start_investigation） */
const NEEDS_TRIGGER_EVENT = new Set(['start_investigation']);

/** 短哈希（FNV-1a，与 events/Sampling 同款）：给 planId 去重，跨平台稳定 */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * 信念的来源事件 id。
 * 为什么必须回查：start_investigation 的处理器要用 plan.triggerEvent 去世界史取那条事实
 * （证据只能来自感知表），拿不到事件 id 就什么也立不了案。
 * 链路：Belief.supporting（记忆 id）→ Memory.sourceEventId → 世界史事实。
 */
function sourceEventOf(owner: string, proposition: string, s: WorldState, memo: Map<string, string>): string | undefined {
  const b = beliefOf(owner, proposition, s);
  if (!b) return undefined;
  for (const id of b.supporting) {
    const ev = memo.get(id);
    if (ev) return ev;
  }
  return undefined;
}

/**
 * 跑一轮信念 → 行动派发。返回真正落地的动作数。
 * 幂等由规则表的 once + Belief 的 actedAt / failedAt 承担：已了结的信念不再命中。
 */
export function dispatchBeliefActions(s: WorldState, day: number): number {
  let fired = 0;
  for (const owner of Object.keys(s.beliefs ?? {})) {
    const hits = beliefActionsFor(owner, s);
    if (!hits.length) continue;
    /* 每个 owner 只扫一次记忆表：行动数往往远少于记忆数，逐条查会白跑 O(n²) */
    const memo = new Map<string, string>();
    for (const m of memoriesOf(owner, s)) if (m.sourceEventId) memo.set(m.id, m.sourceEventId);

    for (const hit of hits) {
      /* 预检：结构性不可满足的调用挡在门外，并留下原因（不这么做就是「账记了、世界没变」） */
      if (NEEDS_NPC_TARGET.has(hit.action) && !WB.npcs[hit.target]) {
        markBeliefFailed(owner, hit.proposition, hit.action + '：目标不是世界书里的 NPC（' + hit.target + '）', s, day);
        continue;
      }
      const evId = sourceEventOf(owner, hit.proposition, s, memo);
      if (NEEDS_TRIGGER_EVENT.has(hit.action) && !evId) {
        markBeliefFailed(owner, hit.proposition, hit.action + '：来源事件已滚出世界史缓冲', s, day);
        continue;
      }

      const res = worldExecutor.execute({
        /* planId 并入命题短哈希：同 owner、同行动、同一天可能来自两条不同命题
           （两桩罪行都命中 spread_rumor），纯拼接会在运行日志里撞名，排障分不清。 */
        planId: 'belief_' + owner + '_' + hit.action + '_' + day + '_' + shortHash(hit.proposition),
        triggerEvent: evId ?? 'belief',
        consequences: [
          {
            action: hit.action,
            actor: owner,
            target: hit.target,
            source: owner,
            reason: '信念驱动：' + hit.proposition,
            params: hit.params,
          },
        ],
      });

      if (res.executed > 0) {
        markBeliefActed(owner, hit.proposition, hit.action, s, day);
        fired += 1;
      } else {
        /* 走到这儿说明执行期被拒（白名单之外 / 数值越界 / 时空约束）。
           记 failedAt 而不是装作没发生：否则明天还会来一遍，且没有人知道。
           原先这里不记账，注释还写着「怕写错名字的规则永远不再重试」——
           因果正好说反了，本次独立审查指出后改正。 */
        const why = res.outcomes.map((o) => o.note ?? '').filter(Boolean).join('；') || '执行期未落地';
        markBeliefFailed(owner, hit.proposition, hit.action + '：' + why, s, day);
        runLog.warn('memory', '信念行动未落地', { owner, action: hit.action, why });
      }
    }
  }
  return fired;
}

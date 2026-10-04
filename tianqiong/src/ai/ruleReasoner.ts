/* ============================================================
   规则推演器（《插件化世界模拟架构方案》§11 / §13 / §25 / §26 / §35）
   —— 无模型兜底通道，与 ai/ruleSim 同构的设计哲学：
      真实模型可用时由 LLM 端口接管；不可用时本模块产出**有依据**的后果。
   铁律 §25：世界推演不是剧情生成器——找不到依据就不产生后果。
   铁律 §26：每条后果都绑定 triggerEvent / reason / source / target。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { isNamedPerson } from '@/events/EventSchema';
import { core } from '@/world/WorldState';
import type { ReasonerPort } from './WorldReasoner';
import type { ContextEntity, ReasonerContext } from './ContextBuilder';
import type { ConsequenceAction, ConsequencePlan } from '@/execution/PlanSchema';

/** 亲近型关系边（死者的这些关系人会产生追凶目标） */
const ALLY_TIES = new Set(['kin', 'friend', 'ally', 'mentor']);

/** 命案/暗杀：由目击者与关系边推导各方反应（§23 完整行动示例的规则版） */
function onDeath(ctx: ReasonerContext, out: ConsequenceAction[]): void {
  const t = ctx.trigger;

  /* 规则 1：有人目击且凶手能承担社会责任 → 目击者所属势力立案调查凶手。
     §26：被调查对象是「事件里的行凶者」，不是固定指向玩家——凶手是怪物时无从立案，
     这与目击者插件的口径一致（同域规则不允许两套说法）。 */
  const witness = ctx.witnesses.find((w) => ctx.entities.some((e) => e.id === w && e.kind === 'npc'));
  const culprit = t.actor;
  /* 人物判定走统一入口（与目击者插件、推演门槛同一处），并带上运行时 NPC 表 */
  if (witness && culprit && (culprit === 'player' || isNamedPerson(culprit, core.S?.npcs))) {
    const witnessEnt = ctx.entities.find((e) => e.id === witness);
    out.push({
      action: 'start_investigation',
      actor: witnessEnt?.faction,
      target: culprit,
      source: witness,
      reason: 'witness_report',
      triggerEvent: t.id,
      priority: 80,
    });
  }

  /* 规则 2：死者的亲族/挚友产生追凶目标（依据：NPC↔NPC 关系边） */
  const avengers = ctx.entities.filter(
    (e) => e.kind === 'npc' && (e.rels ?? []).some((r) => ALLY_TIES.has(r.type) && r.other === t.target),
  );
  for (const avenger of avengers.slice(0, 2)) {
    out.push({
      action: 'change_goal',
      actor: avenger.id,
      target: 'player',
      source: t.target,
      reason: 'kin_grief',
      triggerEvent: t.id,
      priority: 70,
    });
  }

  /* 规则 3：与死者**数据上相关**的委托才受阻（§26：不拿玩家的第一条委托凑因果）。
     相关 = 委托目标指向死者；找不到相关委托就不产生这条后果。 */
  const related = ctx.activeQuests.find((qid) => {
    const def = (WB.quests as Record<string, { target?: string } | undefined>)[qid];
    return !!def?.target && def.target === t.target;
  });
  if (related) {
    out.push({
      action: 'update_quest',
      target: related,
      source: t.target,
      reason: 'target_deceased',
      triggerEvent: t.id,
      priority: 40,
    });
  }
}

/** 重罪：有目击者时该势力的敌意会落到玩家头上 */
function onCrime(ctx: ReasonerContext, out: ConsequenceAction[]): void {
  const witness = ctx.witnesses.find((w) => ctx.entities.some((e) => e.id === w && e.kind === 'npc'));
  if (!witness) return;
  const witnessEnt: ContextEntity | undefined = ctx.entities.find((e) => e.id === witness);
  out.push({
    action: 'change_reputation',
    actor: witnessEnt?.faction,
    target: witnessEnt?.faction ?? 'empire',
    source: witness,
    reason: 'reported_crime',
    triggerEvent: ctx.trigger.id,
    params: { delta: -8 },
    priority: 60,
  });
}

export const ruleReasoner: ReasonerPort = {
  id: 'rule-sim',

  reason(ctx: ReasonerContext): ConsequencePlan | null {
    const t = ctx.trigger;
    const out: ConsequenceAction[] = [];

    if (t.type === 'character_died' || t.type === 'npc_assassinated') onDeath(ctx, out);
    else if (t.type === 'crime_committed') onCrime(ctx, out);
    else if (t.type === 'abyss_breach') {
      /* 裂隙临界是 L3 世界级事实：星枢诸势力对玩家的立场随之重估
         （神殿因封印之功受压、古研会因样本外流得利——依据在事件本身与地点）。 */
      if (!t.location) return null;
      out.push({
        action: 'change_reputation',
        target: 'study',
        source: t.location,
        reason: 'abyss_crisis_fallout',
        triggerEvent: t.id,
        params: { delta: 6 },
        priority: 55,
      });
      out.push({
        action: 'change_reputation',
        target: 'temple_chaos',
        source: t.location,
        reason: 'abyss_crisis_fallout',
        triggerEvent: t.id,
        params: { delta: -6 },
        priority: 50,
      });
    }
    else if (t.type === 'faction_conflict' || t.type === 'city_at_war') {
      /* 势力冲突的战火落到具体地点上：只有事件有落地地点才推演（§26 依据绑定） */
      if (!t.location) return null;
      const loc = ctx.entities.find((e) => e.kind === 'location');
      out.push({
        action: 'change_reputation',
        target: loc?.faction ?? 'empire',
        source: t.location,
        reason: 'faction_conflict_fallout',
        triggerEvent: t.id,
        params: { delta: -5 },
        priority: 50,
      });
    }

    if (!out.length) return null; // §25：没有依据就不推演
    return {
      planId: 'plan_' + t.id,
      triggerEvent: t.id,
      consequences: out,
      narrative: '规则推演：' + t.type + ' 的影响面为 ' + out.map((c) => c.action).join('、'),
    };
  },
};

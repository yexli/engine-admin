/* ============================================================
   卡 J2 · 认知闭环：信念 → 行动（《后续开发方案-阶段J》）
   —— 阶段 J 审计实测：信念每天正常聚合（memoryTick → formBeliefs）、
      正常进 AI 上下文（ContextBuilder.beliefsOf），但 beliefActionsFor
      在生产代码里零调用、规则表为空——「依据认知做出行动」这半句一直
      挂在 AI 通道上，关掉模型就什么都不剩。
   本文件证明这一跳真的通了，且走的是完整真实路径：
     目击 → 感知 → 记忆 → 信念 → 日边界派发 → WorldExecutor → 世界后果。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler, sceneTime } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { worldBus } from '@/events/EventBus';
import { makeEvent, resetEventSeq } from '@/events/EventSchema';
import { plugins } from '@/plugins/PluginRegistry';
import { bootstrapWorld } from '@/plugins/bootstrap';
import { worldExecutor } from '@/execution/WorldExecutor';
import { registerCoreSystems } from '@/plugins/systems';
import { registerConsequenceHandlers } from '@/plugins/handlers';
import { beliefsOf, formBeliefs } from '@/memory/belief/BeliefSystem';
import { attOf } from '@/systems/npc/Npcs';
import type { WorldState } from '@/types/world';

const start = () => newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });

/** 让某事件被显式目击者「亲历」，其余在场者一概不察觉（与 memory-engine.test.ts 同一手法） */
function witness(event: Parameters<typeof worldBus.emit>[0], ids: string[]) {
  const e = { ...event, witnesses: ids };
  const restore = rng.inject(() => 0.99);
  worldBus.emit(e as typeof event);
  restore();
  return e;
}

/** 过一天：日结算顺序表由 new_day 事实驱动（与 arch-day-settle 同一入口） */
function passDay(day: number) {
  worldBus.beginTick();
  worldBus.emit({ id: 'evt_j2_day_' + day, type: 'new_day', day, tick: day * 48, level: 2 });
}

const PROP = 'player|crime_committed|theft';
const beliefOfLita = (s: WorldState) => beliefsOf('lita', s).find((x) => x.proposition === PROP);

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  worldBus.reset();
  plugins.clear();
  worldExecutor.clear();
  resetEventSeq();
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  bootstrapWorld({ reasoner: ruleReasoner });
});

afterEach(() => {
  core.S = null;
  resetWorld();
});

describe('卡 J2 · 信念驱动行动', () => {
  it('被目击的罪行过一天后，相信它的人据此行动（信念被打上 actedAt）', () => {
    start();
    const s = core.S!;
    witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    formBeliefs('lita', s, 1);

    const before = beliefOfLita(s);
    expect(before, '前置：信念已形成').toBeTruthy();
    expect(before!.actedAt, '前置：还没被任何行动驱动过').toBeUndefined();

    passDay(2);

    const after = beliefOfLita(s);
    expect(after, '信念不该被日结算抹掉').toBeTruthy();
    /* 记账的「哪一天」取的是世界时钟的真实天数（daySettle 用 sceneTime(s).day），
       不是 new_day 事件自带的 day 字段——事件字段只是搬运工，时钟才是事实源。 */
    expect(after!.actedAt, '日边界之后应记下驱动发生的那一天').toBe(sceneTime(s).day);
    expect(after!.actionKind, '并记下驱动出的行动名').toBeTruthy();
  });

  it('驱动产生的是世界后果，不只是打标记', () => {
    start();
    const s = core.S!;
    witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    formBeliefs('lita', s, 1);
    const before = attOf('lita', s);

    passDay(2);

    expect(attOf('lita', s), '相信玩家犯了罪的人，态度该往冷淡走').toBeLessThan(before);
  });

  it('同一条信念只驱动一次——不会每过一天就再冷淡一次', () => {
    start();
    const s = core.S!;
    witness(makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' }), ['lita']);
    formBeliefs('lita', s, 1);

    passDay(2);
    const day2 = beliefOfLita(s)!.actedAt;
    const att2 = attOf('lita', s);

    passDay(3);
    passDay(4);

    expect(beliefOfLita(s)!.actedAt, 'actedAt 不该被刷新').toBe(day2);
    expect(attOf('lita', s), 'once 规则下好感不该被反复扣').toBe(att2);
  });

  it('target 不是合法 NPC 时：预检挡住、写 failedAt，而不是「账记了、世界没变」', () => {
    /* 独立审查 M-1：handlers 的守卫是静默 return（if (!WB.npcs[target]) return;），
       而执行器的 executed++ 只要求不抛异常——于是「账记了、世界没变」。
       这里手造一个不在世界书里的 owner，钉住预检这条路。 */
    start();
    const s = core.S!;
    s.beliefs = {
      ghost_npc: [
        {
          proposition: 'player|crime_committed|theft',
          subject: 'player',
          predicate: 'crime_committed',
          object: 'theft',
          ownerId: 'ghost_npc',
          confidence: 0.9,
          supporting: [],
          contradicting: [],
          updatedAt: 1,
        },
      ],
    };

    passDay(2);

    const b = s.beliefs.ghost_npc[0];
    expect(b.actedAt, '不该被记为驱动过').toBeUndefined();
    expect(b.failedAt, '应记为不可满足——不记就等于每天重试一次').toBeTruthy();
    expect(b.failedReason, '失败原因要留在状态里（生产 runLog 默认关闭）').toContain('NPC');
  });

  it('没有信念时派发是空转（不凭空造行动）', () => {
    start();
    const s = core.S!;
    const att0 = attOf('lita', s);
    passDay(2);
    expect(beliefsOf('lita', s).length, '没有目击就没有信念').toBe(0);
    expect(attOf('lita', s), '没有信念就什么都不该发生').toBe(att0);
  });

  it('规则表登记的每条动作都必须是可执行能力（防止写错名字后静默失效）', async () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    const mem = (await import('@/data/world/memory.json')).default as unknown as {
      beliefActions: { rules: { action: string }[] };
    };
    const { capabilities } = await import('@/plugins/CapabilityRegistry');
    const declared = capabilities.executableList();
    for (const r of mem.beliefActions.rules) {
      expect(declared, '规则表里的 ' + r.action + ' 没接入执行器——它会被 Validator 拒，且没人会发现').toContain(r.action);
    }
  });
});

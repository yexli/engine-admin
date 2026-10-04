/* ============================================================
   §34 集成：事件接入试点与推演闭环
   —— 声望 / 好感写入 → 世界事件总线 → 多系统响应；
      事件 → ContextBuilder → Reasoner → ConsequencePlan → Validator → Executor。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler, world } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { worldBus } from '@/events/EventBus';
import { makeEvent, resetEventSeq } from '@/events/EventSchema';
import { attachWorldEventLog, worldEventLog } from '@/events/EventStore';
import { attachPerception, perception, registerPerception } from '@/events/Perception';
import { advance, sceneTime } from '@/world/WorldClock';
/* world 门面：外部注入路径（与 AI 推演同一条 Validator → Executor 通道） */
import { plugins } from '@/plugins/PluginRegistry';
import { SYSTEM_SPECS, registerCoreSystems } from '@/plugins/systems';
import { registerConsequenceHandlers } from '@/plugins/handlers';
import { WB } from '@/data/worldBook';
import { attachMemoryEngine, formBeliefs, memOf, memoryEngine } from '@/memory';
import { addRep, itemCount } from '@/systems/character/Gains';
import { maxHp } from '@/systems/character/Derived';
import { adjAtt, attOf } from '@/systems/npc/Npcs';
import { registerWitnessPlugin } from '@/plugins/witness';
import { validatePlan } from '@/validation/RuleValidator';
import { buildContext } from '@/ai/ContextBuilder';
import { extractJson, planFrom, plannerPrompt } from '@/ai/ConsequencePlanner';
import { attachReasoner, reasonAbout, reasonerStats, setReasonerPort, shouldReason } from '@/ai/WorldReasoner';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { makeHybridReasoner, makeLlmReasoner } from '@/ai/llmReasoner';
import { worldExecutor } from '@/execution/WorldExecutor';
import type { ConsequencePlan } from '@/execution/PlanSchema';
import type { WorldEvent } from '@/events/EventSchema';

const start = () => newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });

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
  worldEventLog.clear();
  perception.clear();
  resetEventSeq();
  setReasonerPort(null);
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

describe('§20 · 系统能力登记', () => {
  it('registerCoreSystems 把全部既有系统登记为世界插件', () => {
    registerCoreSystems();
    expect(plugins.ids().length).toBe(SYSTEM_SPECS.length);
    expect(plugins.has('combat')).toBe(true);
    expect(worldExecutor.actions()).toEqual([]);
  });
});

describe('§22/§34 · 试点接入：状态事实化', () => {
  it('声望实际变化 → reputation_changed（Level 2），带前后值与因果依据', () => {
    start();
    const got: WorldEvent[] = [];
    worldBus.on('reputation_changed', (e) => got.push(e), 'probe');
    addRep('empire', 5);
    expect(got).toHaveLength(1);
    expect(got[0].level).toBe(2);
    expect(got[0].target).toBe('empire');
    expect(got[0].data).toMatchObject({ faction: 'empire', from: 0, to: 5, delta: 5 });
  });

  it('声望被夹取到同一值 → 不发布事件（Action 不等于 Event）', () => {
    start();
    let n = 0;
    worldBus.on('reputation_changed', () => n++, 'probe');
    core.S!.rep.empire = 100;
    addRep('empire', 10);
    expect(n).toBe(0);
    expect(core.S!.rep.empire).toBe(100);
  });

  it('未知势力键仍然静默忽略且不发事件', () => {
    start();
    let n = 0;
    worldBus.on('reputation_changed', () => n++, 'probe');
    addRep('faction_不存在', 5);
    expect(n).toBe(0);
  });

  it('好感实际变化 → relationship_changed，含地点与前后值', () => {
    start();
    const got: WorldEvent[] = [];
    worldBus.on('relationship_changed', (e) => got.push(e), 'probe');
    adjAtt('lita', 8, '赠礼');
    expect(got).toHaveLength(1);
    expect(got[0].target).toBe('lita');
    expect(got[0].location).toBe('plaza');
    expect(got[0].data).toMatchObject({ npc: 'lita', delta: 8 });
  });

  it('零好感变动不发事件', () => {
    start();
    let n = 0;
    worldBus.on('relationship_changed', () => n++, 'probe');
    adjAtt('lita', 0, '无变化');
    expect(n).toBe(0);
  });
});

describe('§29/§34 · 一个事件 → 多系统响应', () => {
  it('自定义订阅者与世界事件日志同时收到同一事实', () => {
    start();
    const off = attachWorldEventLog();
    const seen: string[] = [];
    worldBus.on('reputation_changed', (e) => seen.push(e.id), 'custom');
    addRep('guild', 3);
    expect(seen).toHaveLength(1);
    const logged = worldEventLog.recent().filter((e) => e.type === 'reputation_changed');
    expect(logged).toHaveLength(1);
    expect(logged[0].id).toBe(seen[0]);
    off();
  });

  it('Level 0 内部账目不进世界史（避免噪音淹没因果链）', () => {
    start();
    attachWorldEventLog();
    worldBus.emit(makeEvent({ type: 'damage_applied', day: 1, level: 0 }));
    worldBus.emit(makeEvent({ type: 'character_died', day: 1, level: 2 }));
    expect(worldEventLog.size()).toBe(1);
    expect(worldEventLog.recent()[0].type).toBe('character_died');
  });

  it('retiring 订阅后世界史不再增长', () => {
    start();
    const off = attachWorldEventLog();
    worldBus.emit(makeEvent({ type: 'character_died', day: 1, level: 2 }));
    off();
    worldBus.emit(makeEvent({ type: 'character_died', day: 1, level: 2 }));
    expect(worldEventLog.size()).toBe(1);
  });
});

describe('§14/§43 · Context Builder', () => {
  it('只装配事件相关实体与能力白名单，不倾泻全量状态', () => {
    start();
    registerCoreSystems();
    const e = makeEvent({ type: 'character_died', day: 1, level: 2, target: 'lita', location: 'tavern', witnesses: ['otto'] });
    const ctx = buildContext(e);
    expect(ctx.trigger.id).toBe(e.id);
    /* §14：相关实体 = 事件参与者 + 目击者 + 事件地点 + **一跳关系人**。
       lita 在世界书里有 galon / joe 两条边，这两位正是「死者亲友会追凶」要看到的人；
       全量 NPC 有二十余位，这里仍是 5 个——钉死集合而不是放宽，掉一个也该被看见。 */
    expect(ctx.entities.map((x) => x.id).sort()).toEqual(['galon', 'joe', 'lita', 'otto', 'tavern']);
    expect(ctx.entities.find((x) => x.id === 'lita')?.kind).toBe('npc');
    /* §14/§20：可调用清单只含**有执行器**的动作，且不把空能力的系统列进去 */
    const callable = ctx.capabilities.flatMap((c) => c.capabilities);
    expect(callable).toContain('start_quest');
    expect(callable, '玩家操作不该出现在可调用清单里').not.toContain('travel_to');
    /* 钉死期望集合而不是给个上界：可调用清单掉一半也该被看见 */
    /* 2026-09 收敛后的可执行系统名单：commnet → travel、culture → customs、
       adventuring 并入 quest、world 改名 world_facts，能力名未变。
       负例换用 dungeon（effects 为空），同样验证「effects 为空就不会被列进来」。 */
    expect(ctx.capabilities.map((c) => c.system).sort()).toEqual(
      ['character', 'customs', 'economy', 'faction', 'inventory', 'law', 'npc', 'quest', 'relationship', 'reputation', 'timeslip', 'travel', 'world_facts'],
    );
    expect(ctx.capabilities.map((c) => c.system)).not.toContain('dungeon');
    expect(ctx.time).not.toBeNull();
  });

  it('带出各实体的认知边界（§8：不能让 NPC 对自己不知道的事做出反应）', () => {
    start();
    registerCoreSystems();
    const e = makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza', witnesses: ['lita'] });
    const restore = rng.inject(() => 0.99); // 只有显式目击者 lita 知情
    registerPerception(e, core.S!);
    restore();

    const ctx = buildContext(e);
    const lita = ctx.entities.find((x) => x.id === 'lita');
    expect(lita?.knows?.some((k) => k.eventId === e.id), 'lita 亲历过就该出现在她的认知里').toBe(true);
    expect(lita?.knows?.[0].via).toBe('witness');

    const prompt = plannerPrompt(ctx);
    expect(prompt).toContain('认知边界');
    expect(prompt).toContain('亲眼所见');
  });

  it('记忆进入推演上下文（§39 Memory Retrieval → World Reasoner）', () => {
    start();
    registerCoreSystems();
    const s = core.S!;
    memoryEngine.create(
      { ownerId: 'lita', type: 'personal_event', content: '三年前玩家在王都救过我', source: 'direct_observation', importance: 0.9 },
      s,
      1,
    );
    const e = makeEvent({ type: 'crime_committed', day: 2, level: 2, actor: 'player', target: 'theft', location: 'plaza', witnesses: ['lita'] });
    const ctx = buildContext(e);
    const lita = ctx.entities.find((x) => x.id === 'lita');
    expect(lita?.memories?.length, '推演器应拿到该角色的记忆').toBeGreaterThan(0);
    expect(plannerPrompt(ctx)).toContain('记得');
  });

  it('信念进入推演上下文（§23/§39：动机来自信念，不是世界真相）', () => {
    start();
    registerCoreSystems();
    attachWorldEventLog();
    attachPerception();
    attachMemoryEngine(); // 走真实链路：事件 → 感知 → 记忆 → 信念
    const s = core.S!;
    const crime = makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza', witnesses: ['lita'] });
    const restore = rng.inject(() => 0.99);
    worldBus.emit(crime);
    restore();
    expect(memoryEngine.count(s, 'lita'), '先有记忆，才谈得上信念').toBeGreaterThan(0);
    formBeliefs('lita', s, 2);

    const ctx = buildContext(makeEvent({ type: 'character_died', day: 3, level: 2, actor: 'player', target: 'bandit', location: 'plaza', witnesses: ['lita'] }));
    const lita = ctx.entities.find((x) => x.id === 'lita');
    expect(lita?.beliefs?.length, '推演器应看得到该角色相信什么').toBeGreaterThan(0);
    expect(plannerPrompt(ctx)).toContain('相信');
  });

  it('未开局时上下文装配不抛错（认知边界查询必须容空世界）', () => {
    expect(() => buildContext(makeEvent({ type: 'city_at_war', day: 1, level: 3, location: 'plaza' }))).not.toThrow();
  });
});

describe('§42 · Consequence Planner', () => {
  it('从围栏 JSON / 裸 JSON / 夹带解释的文本中提取计划', () => {
    const obj = { planId: 'p', triggerEvent: 'e', consequences: [{ action: 'x', reason: 'y' }] };
    expect(extractJson('```json\n' + JSON.stringify(obj) + '\n```')).toEqual(obj);
    expect(extractJson(JSON.stringify(obj))).toEqual(obj);
    expect(extractJson('我推演如下：' + JSON.stringify(obj) + ' 完毕')).toEqual(obj);
  });

  it('reason 文案里的花括号不破坏括号配对', () => {
    const obj = { planId: 'p', triggerEvent: 'e', consequences: [{ action: 'x', reason: '他喊了「{危险}」' }] };
    expect(extractJson(JSON.stringify(obj))).toEqual(obj);
  });

  it('解析失败一律返回 null，绝不猜测', () => {
    expect(extractJson('没有 JSON')).toBeNull();
    expect(extractJson('{不完全')).toBeNull();
    expect(planFrom({ planId: 'p' })).toBeNull();
  });

  it('提示词只含上下文中的实体与能力，不泄露无关世界', () => {
    start();
    registerCoreSystems();
    const e = makeEvent({ type: 'city_at_war', day: 4, level: 3, target: 'lita' });
    const prompt = plannerPrompt(buildContext(e));
    expect(prompt).toContain('lita');
    expect(prompt).toContain('change_reputation');
    expect(prompt).toContain(e.id);
  });
});

describe('§35/§47 · World Reasoner 闭环', () => {
  it('分级门槛：L3 无条件进推演，L2 看升格判定', () => {
    expect(shouldReason(makeEvent({ type: 'character_died', day: 1, level: 2 }))).toBe(false);
    expect(shouldReason(makeEvent({ type: 'city_at_war', day: 1 }))).toBe(true);
  });

  it('§12/§23 升格：死的是有名有姓的人进推演，砍翻野狼不进（分级是默认值不是天花板）', () => {
    expect(shouldReason(makeEvent({ type: 'character_died', day: 1, level: 2, target: 'lita' })), '命案必须进推演').toBe(true);
    expect(shouldReason(makeEvent({ type: 'character_died', day: 1, level: 2, target: 'wolf' })), '无名威胁是局部事件').toBe(false);
    expect(shouldReason(makeEvent({ type: 'npc_missing', day: 1, level: 2, target: 'otto' })), '有名有姓的失踪同样升格').toBe(true);
    expect(shouldReason(makeEvent({ type: 'npc_moved', day: 1, level: 1, target: 'lita' })), 'L1 永远不进推演').toBe(false);
  });

  it('§30 推演护栏：推演自己造出来的后果不再触发推演（模型无法用 create_event 自激）', async () => {
    start();
    registerCoreSystems();
    attachWorldEventLog();
    attachPerception();
    registerConsequenceHandlers();
    attachReasoner(); // 通配订阅：合格事件都会尝试推演

    const calls: string[] = [];
    setReasonerPort({
      id: 'looping',
      reason: (ctx) => {
        calls.push(ctx.trigger.id);
        /* 自造一条「有名有姓的人死亡」——正是升格会命中的那类事实 */
        return {
          planId: 'plan_' + ctx.trigger.id,
          triggerEvent: ctx.trigger.id,
          consequences: [{ action: 'create_event', target: 'lita', reason: '自造事实', params: { type: 'character_died' } }],
        };
      },
    });

    worldBus.emit(makeEvent({ type: 'city_at_war', day: 1, level: 3, location: 'plaza' }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length, '推演只跑一轮：自造事件不再唤起模型').toBe(1);
    setReasonerPort(null);
  });

  it('§30 护栏按来源判定：推演安排的延迟事件隔日到期，也不再唤起模型（跨日自激被拦）', async () => {
    start();
    registerCoreSystems();
    attachWorldEventLog();
    attachPerception();
    registerConsequenceHandlers();
    attachReasoner();

    const calls: string[] = [];
    setReasonerPort({
      id: 'scheduler',
      reason: (ctx) => {
        calls.push(ctx.trigger.type);
        /* 排一个「明天死一个有名字的人」——按执行期深度判定时，这条隔日事件是拦不住的 */
        return {
          planId: 'plan_' + ctx.trigger.id,
          triggerEvent: ctx.trigger.id,
          consequences: [{ action: 'schedule_event', target: 'lita', reason: '排一个隔天的命案', params: { type: 'character_died', delayDays: 1 } }],
        };
      },
    });

    worldBus.emit(makeEvent({ type: 'city_at_war', day: 1, level: 3, location: 'plaza' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls, '第一轮推演发生').toEqual(['city_at_war']);

    advance(48); // 跨日：到期的计划事件由 WorldClock 发布
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls, '到期事件带推演来源，不再唤起模型').toEqual(['city_at_war']);
    setReasonerPort(null);
  });

  it('§30 护栏不误杀外部注入：world.execute 发出的 L3 事实照常进推演', async () => {
    start();
    registerCoreSystems();
    attachWorldEventLog();
    attachPerception();
    registerConsequenceHandlers();
    attachReasoner();

    const calls: string[] = [];
    setReasonerPort({
      id: 'probe',
      reason: (ctx) => {
        calls.push(ctx.trigger.type);
        return null;
      },
    });

    world.execute({ action: 'create_event', target: 'player', source: 'player', reason: '外部注入的事实', params: { type: 'city_at_war' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls, '外部注入不带推演来源，应当照常推演').toEqual(['city_at_war']);
    setReasonerPort(null);
  });

  it('§23 命案连锁在真实门槛下可跑通：升格 → 上下文 → 规则推演 → 校验 → 落地立案', async () => {
    start();
    registerCoreSystems();
    attachWorldEventLog();
    attachPerception();
    registerConsequenceHandlers();
    setReasonerPort(ruleReasoner);
    const s = core.S!;
    const death = makeEvent({ type: 'character_died', day: 1, level: 2, actor: 'player', target: 'lita', location: 'plaza', witnesses: ['otto'] });
    const restore = rng.inject(() => 0.99); // 只有显式目击者 otto 知情
    worldBus.emit(death);
    restore();

    expect(shouldReason(death), '有名有姓的人死了 → 升格').toBe(true);
    const res = await reasonAbout(death);
    expect(res, '升格后应真的走完推演通道').not.toBeNull();
    expect(res!.executed, '目击者所辖势力立案').toBeGreaterThan(0);
    expect(res!.outcomes.every((o) => o.ok), '落地动作不该有「无处理器」失败').toBe(true);
    expect(s.cases?.length ?? 0, '案子真的立起来了').toBeGreaterThan(0);
  });

  it('AI 预算：同一 tick 超过上限的推演被跳过并留痕（Phase 5）', async () => {
    start();
    registerCoreSystems();
    attachWorldEventLog();
    let calls = 0;
    setReasonerPort({
      id: 'probe',
      reason: () => {
        calls++;
        return null;
      },
    });
    const t = core.S!.t;
    for (let i = 0; i < 14; i++) {
      const e = makeEvent({ type: 'npc_missing', day: 1, tick: t, level: 3, target: 'lita' });
      await reasonAbout(e);
    }
    /* 事件配额与 AI 配额是两本账：14 条合格的 L3 事件只允许 10 条进模型 */
    expect(calls, '同一 tick 内最多 10 轮').toBe(10);
    expect(reasonerStats().budgetSkipped, '跳过要留痕').toBe(4);
    setReasonerPort(null);
  });
  it('未注入推演端口时完全空转（零副作用）', async () => {
    start();
    registerCoreSystems();
    const res = await reasonAbout(makeEvent({ type: 'city_at_war', day: 1 }));
    expect(res).toBeNull();
  });

  it('闭环：事件 → 上下文 → AI → 计划 → 验证 → 执行', async () => {
    start();
    registerCoreSystems();
    const ran: string[] = [];
    worldExecutor.registerHandler('change_reputation', () => ran.push('rep'));
    setReasonerPort({
      id: 'test-reasoner',
      reason: (ctx) => ({
        planId: 'plan_test',
        triggerEvent: ctx.trigger.id,
        consequences: [{ action: 'change_reputation', target: 'empire', source: 'empire', reason: 'witness_report' }],
      }),
    });
    const res = await reasonAbout(makeEvent({ type: 'city_at_war', day: 1, location: 'plaza' }));
    expect(res?.executed).toBe(1);
    expect(ran).toEqual(['rep']);
    setReasonerPort(null);
  });

  it('AI 提出未登记能力 → 整份计划被拒，零执行', async () => {
    start();
    registerCoreSystems();
    let touched = false;
    worldExecutor.registerHandler('summon_dragon', () => {
      touched = true;
    });
    setReasonerPort({
      id: 'bad-reasoner',
      reason: (ctx) => ({
        planId: 'plan_bad',
        triggerEvent: ctx.trigger.id,
        consequences: [{ action: 'summon_dragon', reason: 'drama' }],
      }),
    });
    const res = await reasonAbout(makeEvent({ type: 'city_at_war', day: 1 }));
    expect(res).toBeNull();
    expect(touched).toBe(false);
  });
});

/* ---------------- §31/§32/§36 · 计划事件在世界 Tick 上结算 ---------------- */

describe('§31/§32/§36 · World Clock 计划事件结算', () => {
  it('跨日边界结算到期事件，未到期的继续等待', () => {
    start();
    const got: WorldEvent[] = [];
    worldBus.on('city_at_war', (e) => got.push(e), 'probe');
    const day0 = sceneTime(core.S!).day;
    const soon = makeEvent({ type: 'city_at_war', day: day0, level: 3 });
    const later = makeEvent({ type: 'city_disaster', day: day0, level: 3 });
    worldBus.schedule(soon, 2);
    worldBus.schedule(later, 5);

    advance(48); // 第 1 日结束：两者都未到期
    expect(got).toHaveLength(0);
    expect(worldBus.stats().scheduled).toBe(2);

    advance(48); // 第 2 日结束：soon 到期并入总线
    expect(got.map((e) => e.id)).toEqual([soon.id]);
    expect(worldBus.stats().scheduled).toBe(1);
  });

  it('结算后的事件进入世界史，可被追溯', () => {
    start();
    attachWorldEventLog();
    const day0 = sceneTime(core.S!).day;
    const e = makeEvent({ type: 'city_at_war', day: day0, level: 3, cause: 'faction_conflict' });
    worldBus.schedule(e, 1);
    advance(48);
    expect(worldEventLog.recent().some((x) => x.id === e.id)).toBe(true);
  });
});

/* ---------------- §26/§35 · 规则推演器（无模型兜底通道） ---------------- */

describe('§25/§26/§35 · 规则推演器', () => {
  beforeEach(() => {
    start();
    registerCoreSystems();
  });

  it('没有依据就不推演（§25：世界推演不是剧情生成器）', () => {
    const plan = ruleReasoner.reason(buildContext(makeEvent({ type: 'city_at_war', day: 1, level: 3 })));
    expect(plan).toBeNull();
  });

  it('命案有目击者 → 势力立案调查玩家，且整份计划通过验证器', () => {
    const e = makeEvent({ type: 'character_died', day: 1, level: 2, actor: 'player', target: 'bandit', location: 'plaza', witnesses: ['lita'] });
    const plan = ruleReasoner.reason(buildContext(e)) as ConsequencePlan | null;
    expect(plan).not.toBeNull();
    const inv = plan!.consequences.find((c) => c.action === 'start_investigation');
    expect(inv?.target).toBe('player');
    expect(inv?.reason).toBe('witness_report');
    expect(inv?.triggerEvent).toBe(e.id);
    expect(validatePlan(plan).ok).toBe(true);
  });

  it('命案无人目击 → 不产生立案（信息不对称）', () => {
    const e = makeEvent({ type: 'character_died', day: 1, level: 2, actor: 'player', target: 'bandit', location: 'plaza' });
    const plan = ruleReasoner.reason(buildContext(e)) as ConsequencePlan | null;
    expect(plan?.consequences.some((c) => c.action === 'start_investigation')).toBeFalsy();
  });

  it('罪案有目击者 → 该目击者所属势力对玩家的声望反应，计划合法', () => {
    const e = makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza', witnesses: ['lita'] });
    const plan = ruleReasoner.reason(buildContext(e)) as ConsequencePlan | null;
    expect(plan).not.toBeNull();
    expect(plan!.consequences[0].action).toBe('change_reputation');
    expect(plan!.consequences[0].params).toEqual({ delta: -8 });
    expect(validatePlan(plan).ok).toBe(true);
  });

  it('attachReasoner 挂载后 L3 事件自动推演并执行（§47 闭环自动接管）', async () => {
    const ran: string[] = [];
    worldExecutor.registerHandler('change_reputation', () => ran.push('rep'));
    setReasonerPort(ruleReasoner);
    const off = attachReasoner();
    worldBus.emit(makeEvent({ type: 'city_at_war', day: 1, level: 3, location: 'plaza' }));
    await new Promise((r) => setTimeout(r, 0));
    off();
    setReasonerPort(null);
    expect(ran).toEqual(['rep']);
  });
});

/* ---------------- §17/§20 · 后果处理器装配（不留落不了地的动作） ---------------- */

describe('§17/§20 · 后果处理器', () => {
  beforeEach(() => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
  });

  it('登记能力与处理器一一对应：推演能产出的四种动作都有落点', () => {
    for (const a of ['start_investigation', 'change_reputation', 'change_goal', 'update_quest']) {
      expect(worldExecutor.hasHandler(a), a + ' 缺处理器').toBe(true);
    }
  });

  it('change_reputation → 势力声望实际变化', () => {
    const before = core.S!.rep.empire;
    const res = worldExecutor.execute({
      planId: 'p',
      triggerEvent: 'e',
      consequences: [{ action: 'change_reputation', target: 'empire', source: 'empire', reason: 'x', params: { delta: -7 } }],
    });
    expect(res.executed).toBe(1);
    expect(core.S!.rep.empire).toBe(before - 7);
  });

  it('change_goal → 写入 NPC 目标并留存来源事件（§44 可追溯）', () => {
    const res = worldExecutor.execute({
      planId: 'p',
      triggerEvent: 'evt_x',
      consequences: [{ action: 'change_goal', actor: 'lita', target: 'player', source: 'lita', reason: 'kin_grief' }],
    });
    expect(res.executed).toBe(1);
    const goal = core.S!.npcs.lita?.goal;
    expect(goal?.target).toBe('player');
    expect(goal?.kind).toBe('kin_grief');
    expect(goal?.sourceEvent).toBe('evt_x');
  });

  it('update_quest → 只做世界侧记录，不改动任务状态（不让 UI 渲染未知 stage）', () => {
    const qid = Object.keys(WB.quests)[0];
    core.S!.player.quests[qid] = { stage: 'go' };
    const res = worldExecutor.execute({
      planId: 'p',
      triggerEvent: 'e',
      consequences: [{ action: 'update_quest', target: qid, source: qid, reason: 'blocked' }],
    });
    expect(res.executed).toBe(1);
    expect(core.S!.player.quests[qid].stage).toBe('go');
  });
});

/* ---------------- §4.2 · World API 世界动词（统一修改入口） ---------------- */

describe('§4.2 · World API 世界动词', () => {
  beforeEach(() => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    attachWorldEventLog();
  });

  it('动词经统一入口落地，走与 AI 推演同一套验证', () => {
    const iid = Object.keys(WB.items)[0];
    const res = world.execute({ action: 'add_item', target: iid, source: iid, reason: 'reward', params: { qty: 3 } });
    expect(res.executed).toBe(1);
    expect(itemCount(iid)).toBe(3);
  });

  it('§4.2 动词清单的落地状态可自查（清单与实现不允许悄悄漂移）', () => {
    const PLAN_VERBS = [
      'move_character', 'damage_character', 'heal_character', 'add_item', 'remove_item',
      'transfer_item', 'add_money', 'remove_money', 'transfer_money',
      'change_relationship', 'change_reputation', 'add_status', 'remove_status',
      'start_quest', 'update_quest', 'complete_quest', 'fail_quest',
      'create_event', 'schedule_event', 'trigger_event',
    ];
    /* 因缺少数据模型而暂无落点：NPC 没有金钱与物品栏、
       NPC 位置由日程驱动（直接搬迁会与自主行动冲突）。
       状态槽（add_status / remove_status）已在二期 H-05 接入，从这一组移出。 */
    const NO_MODEL = new Set(['move_character']);
    for (const v of PLAN_VERBS) {
      const has = worldExecutor.hasHandler(v);
      if (NO_MODEL.has(v)) expect(has, v + ' 本应无落点（无数据模型）').toBe(false);
      else expect(has, v + ' 应有落点').toBe(true);
    }
  });

  it('未登记动词与缺依据一律被同一道防火墙拒绝', () => {
    expect(world.execute({ action: 'summon_dragon', reason: 'drama' }).executed).toBe(0);
    expect(world.execute({ action: 'add_item', target: Object.keys(WB.items)[0] }).executed, '缺 reason 应被拒').toBe(0);
  });

  it('金钱 / 经验 / 声望 / 关系 四类动词都能落地', () => {
    const gold0 = core.S!.player.gold;
    expect(world.execute({ action: 'add_money', target: 'player', source: 'player', reason: 'reward', params: { amount: 120 } }).executed).toBe(1);
    expect(core.S!.player.gold).toBe(gold0 + 120);
    expect(world.execute({ action: 'remove_money', target: 'player', source: 'player', reason: 'fee', params: { amount: 20 } }).executed).toBe(1);
    expect(core.S!.player.gold).toBe(gold0 + 100);

    const exp0 = core.S!.player.exp;
    world.execute({ action: 'gain_exp', target: 'player', source: 'player', reason: 'train', params: { amount: 30 } });
    expect(core.S!.player.exp).toBe(exp0 + 30);

    const rep0 = core.S!.rep.empire;
    world.execute({ action: 'change_reputation', target: 'empire', source: 'empire', reason: 'favor', params: { delta: -4 } });
    expect(core.S!.rep.empire).toBe(rep0 - 4);

    world.execute({ action: 'change_relationship', target: 'lita', source: 'lita', reason: 'gift', params: { delta: 6 } });
    expect(attOf('lita', core.S!)).toBe(6);
  });

  it('授予称号幂等（同一称号只记一次）', () => {
    const tid = 'title_test_alpha';
    const act = { action: 'grant_title', target: 'player', source: 'player', reason: 'deed', params: { title: tid } };
    expect(world.execute(act).executed).toBe(1);
    expect((core.S!.titles ?? []).filter((t) => t === tid)).toHaveLength(1);
    world.execute(act);
    expect((core.S!.titles ?? []).filter((t) => t === tid), '重复授予应幂等').toHaveLength(1);
  });

  it('事件动词把新事实注入总线，分级按类型自动判定（§47 New Events 出口）', () => {
    const seen: WorldEvent[] = [];
    worldBus.on('city_at_war', (e) => seen.push(e), 'probe');
    const res = world.execute({ action: 'create_event', target: 'player', source: 'player', reason: 'plot', params: { type: 'city_at_war' } });
    expect(res.executed).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].level, '未登记类型应按默认分级').toBe(3);
  });

  it('schedule_event 排入未来而非立即发布', () => {
    const seen: WorldEvent[] = [];
    worldBus.on('city_disaster', (e) => seen.push(e), 'probe');
    expect(world.execute({ action: 'schedule_event', target: 'player', source: 'player', reason: 'omen', params: { type: 'city_disaster', delayDays: 2 } }).executed).toBe(1);
    expect(seen).toHaveLength(0);
    expect(worldBus.stats().scheduled).toBe(1);
  });

  it('伤害与治疗遵守边界；归零不擅自触发战斗域的败北流程', () => {
    const max = maxHp(core.S!);
    world.execute({ action: 'heal_character', target: 'player', source: 'player', reason: 'rest', params: { amount: 9999 } });
    expect(core.S!.player.hp).toBeLessThanOrEqual(max);
    world.execute({ action: 'damage_character', target: 'player', source: 'player', reason: 'trap', params: { amount: 999999 } });
    expect(core.S!.player.hp).toBe(0);
    expect(core.CB, '非战斗路径不应产生战斗态').toBeNull();
  });

  it('动词产出的世界事件带因果父（§44 可追溯）', () => {
    const trigger = makeEvent({ type: 'character_died', day: 1, level: 2, location: 'plaza' });
    worldBus.emit(trigger);
    world.execute({
      action: 'create_event',
      target: 'player',
      source: 'player',
      reason: 'aftermath',
      triggerEvent: trigger.id,
      params: { type: 'city_at_war' },
    });
    const child = worldEventLog.recent().find((e) => e.type === 'city_at_war');
    expect(child?.parentId).toBe(trigger.id);
    expect(worldEventLog.chain(child!.id).map((e) => e.id)).toEqual([child!.id, trigger.id]);
  });
});

/* ---------------- §13/§42 · LLM 推演端口与降级 ---------------- */

describe('§13/§42 · LLM 推演端口', () => {
  const ctxOf = (type: string, level: 2 | 3 = 3, witnesses?: string[]) =>
    buildContext(makeEvent({ type, day: 1, level, actor: 'player', target: 'bandit', location: 'plaza', witnesses }));

  it('模型返回严格 JSON → 原样采纳（是否落地仍由 Validator 决定）', async () => {
    const port = makeLlmReasoner(async () => JSON.stringify({ planId: 'llm_1', triggerEvent: 'e', consequences: [{ action: 'x', reason: 'y' }] }));
    const raw = (await port.reason(ctxOf('city_at_war'))) as ConsequencePlan;
    expect(raw.planId).toBe('llm_1');
  });

  it('模型返回散文 / 空 → null（§42 绝不猜测 AI 想做什么）', async () => {
    start();
    const prose = makeLlmReasoner(async () => '我推演不出什么来。');
    expect(await prose.reason(ctxOf('city_at_war'))).toBeNull();
    const dead = makeLlmReasoner(async () => null);
    expect(await dead.reason(ctxOf('city_at_war'))).toBeNull();
  });

  it('围栏 JSON 与夹带解释的文本都能提取出计划', async () => {
    start();
    const plan = { planId: 'fenced', triggerEvent: 'e', consequences: [{ action: 'x', reason: 'y' }] };
    const fence = String.fromCharCode(96).repeat(3);
    const port = makeLlmReasoner(async () => '推演如下：' + fence + 'json\n' + JSON.stringify(plan) + '\n' + fence);
    const raw = (await port.reason(ctxOf('city_at_war'))) as ConsequencePlan;
    expect(raw.planId).toBe('fenced');
  });

  it('混合端口：模型不可用时退回规则推演（没配 Key 世界照样运转）', async () => {
    start();
    registerCoreSystems();
    const hybrid = makeHybridReasoner(async () => null);
    const plan = (await hybrid.reason(ctxOf('character_died', 2, ['lita']))) as ConsequencePlan | null;
    expect(plan).not.toBeNull();
    expect(plan!.consequences.some((c) => c.action === 'start_investigation')).toBe(true);
  });

  it('混合端口：模型给出计划时优先于规则推演', async () => {
    start();
    registerCoreSystems();
    const hybrid = makeHybridReasoner(async () =>
      JSON.stringify({ planId: 'llm', triggerEvent: 'x', consequences: [{ action: 'change_reputation', target: 'empire', reason: 'ai_says' }] }),
    );
    const plan = (await hybrid.reason(ctxOf('city_at_war'))) as ConsequencePlan | null;
    expect(plan!.planId).toBe('llm');
  });
});

/* ---------------- §8/§34 · 目击者反应插件：一个事件 → 多系统响应 ---------------- */

describe('§8/§34 · 目击者反应插件', () => {
  beforeEach(() => {
    start();
    registerCoreSystems();
    registerWitnessPlugin();
  });

  const watch = (e: WorldEvent) => {
    const restore = rng.inject(() => 0.99); // 只让显式目击者知情
    registerPerception(e, core.S!);
    restore();
    worldBus.emit(e);
  };

  it('击杀无名威胁不算命案：在场者不为此记恨（人物判定只此一处）', () => {
    const beast = makeEvent({ type: 'character_died', day: 1, level: 2, actor: 'player', target: 'rabbit', location: 'plaza', witnesses: ['lita'] });
    const before = attOf('lita', core.S!);
    watch(beast);
    expect(attOf('lita', core.S!), '砍翻野兔不是命案').toBe(before);

    const person = makeEvent({ type: 'character_died', day: 2, level: 2, actor: 'player', target: 'joe', location: 'plaza', witnesses: ['lita'] });
    watch(person);
    expect(attOf('lita', core.S!), '有名有姓的人死了才追究').toBe(before - 4);
  });

  it('好感变化是私事：旁人不该「目击」到别人心里的秤', () => {
    const e = makeEvent({ type: 'relationship_changed', day: 1, level: 2, actor: 'player', target: 'lita', location: 'plaza' });
    /* 随机源恒为 0：任何正显眼度都会「命中」，用来证明显眼度确实是 0 而不是碰巧没中 */
    const restore = rng.inject(() => 0);
    const knowers = registerPerception(e, core.S!);
    restore();
    expect(knowers, '显眼度为 0：私事不进入他人感知').toEqual([]);
  });

  it('目击罪行 → 目击者好感下降并留下记忆', () => {
    const e = makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza', witnesses: ['lita'] });
    const before = attOf('lita', core.S!);
    watch(e);
    expect(attOf('lita', core.S!)).toBe(before - 4);
    expect(memOf('lita', core.S!).some((m) => m.event.includes('目击罪行')), '记忆只落在唯一的记忆表里').toBe(true);
  });

  it('没人目击 → 插件不动作（世界记住了，但没人知道）', () => {
    const e = makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'player', target: 'theft', location: 'plaza' });
    const before = attOf('lita', core.S!);
    watch(e);
    expect(attOf('lita', core.S!)).toBe(before);
  });

  it('非玩家所为不触发目击者反应（只追究肇事者）', () => {
    const e = makeEvent({ type: 'crime_committed', day: 1, level: 2, actor: 'somebody_else', target: 'theft', location: 'plaza', witnesses: ['lita'] });
    const before = attOf('lita', core.S!);
    watch(e);
    expect(attOf('lita', core.S!)).toBe(before);
  });
});

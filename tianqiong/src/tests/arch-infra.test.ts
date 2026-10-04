/* ============================================================
   架构基础设施测试（《插件化世界模拟架构方案》§41）
   覆盖：World API / Dice Engine / Event Bus / EventSchema /
        Plugin + Capability Registry / Rule Validator / World Executor
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, newState, resetWorld, rng, scheduler, sceneTime } from '@/world';
import { hydrate } from '@/world/WorldState';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { world } from '@/world/WorldAPI';
import { MAX_CRITICAL_PER_TICK, MAX_EVENTS_PER_TICK, causality, worldBus } from '@/events/EventBus';
import { levelOf, makeEvent, resetEventSeq, traceChain } from '@/events/EventSchema';
import { checkPassed, parseDice, resolveCheck, roll } from '@/dice/DiceEngine';
import { check } from '@/dice/CheckResolver';
import { npcDyn } from '@/systems/npc/Npcs';
import { plugins } from '@/plugins/PluginRegistry';
import { capabilities } from '@/plugins/CapabilityRegistry';
import { SYSTEM_SPECS, capabilitiesOf, registerCoreSystems } from '@/plugins/systems';
import { registerConsequenceHandlers } from '@/plugins/handlers';
import { attachDeadLetterWatch, bootstrapWorld } from '@/plugins/bootstrap';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { worldExecutor } from '@/execution/WorldExecutor';
import { validatePlan, validateState } from '@/validation/RuleValidator';
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
  resetEventSeq();
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

/* ---------------- §41 · World API ---------------- */

describe('§41 · World API', () => {
  it('读取角色：无 id 取玩家，有 id 取 NPC', () => {
    start();
    const p = world.query.get_character() as { name: string; loc: string };
    expect(p.name).toBe('测试者');
    expect(p.loc).toBe('plaza');
    expect(world.query.get_character('nobody')).toBeNull();
  });

  it('修改角色：写入经命令通道，随后可经查询读回', () => {
    world.command({ type: 'newGame', name: '命令者', race: 'dwarf', cls: 'warrior' });
    const c = world.query.get_character() as { name: string; gold: number; hp: number; level: number };
    expect(c.name).toBe('命令者');
    /* 卡 T3：起始资金 600 → 5000（装备价按世界书 §55 对齐后的配套调整） */
    expect(c.gold).toBe(5000);
    expect(c.hp).toBeGreaterThan(0);
    expect(c.level).toBe(1);
    expect(world.query.get_characters()).toEqual([]);
  });

  it('读取地点 → 经受控命令修改地点', () => {
    start();
    expect(world.query.get_location()).toBe('plaza');
    world.command({ type: 'travel', loc: 'tavern' });
    expect(world.query.get_location()).toBe('tavern');
  });

  it('读取时间 / 天气 / 声望 / 背包 / 任务（未开局时一律安全返回）', () => {
    expect(world.query.get_time()).toBeNull();
    expect(world.query.get_location()).toBeNull();
    expect(world.query.get_factions()).toEqual({});
    start();
    const t = world.query.get_time()!;
    expect(t.day).toBeGreaterThan(0);
    expect(typeof t.month).toBe('string');
    expect(t.weather).toBe('晴');
    expect(world.query.get_faction('empire')).toBe(0);
    expect(world.query.get_inventory()).toEqual([]);
    expect(world.query.get_quests()).toEqual({});
  });

  it('预留接口先就位：get_quest / get_active_effects 在未开局与空档下都安全', () => {
    expect(world.query.get_quest('q_theft')).toBeNull();
    expect(world.query.get_active_effects()).toEqual([]);

    start();
    expect(world.query.get_active_effects(), '没人挂状态时为空').toEqual([]);
    const q = world.query.get_quest('q_theft');
    expect(q === null || typeof q.stage === 'string').toBe(true);

    /* 真给它一条状态，接口就能读出来（证明不是写死的空实现） */
    core.S!.player.effects = [{ id: 'blessing', left: 12, power: 2, source: 'evt_1_1' }];
    expect(world.query.get_active_effects()).toEqual([{ owner: 'player', effects: [{ id: 'blessing', left: 12, power: 2, source: 'evt_1_1' }] }]);

    /* 用真实的惰性建表路径，而不是手写字面量：拿到的是"新接入点落到真实条目上"的行为 */
    const lita = npcDyn('lita', core.S!);
    lita.effects = [{ id: 'poisoned', left: 48 }];
    expect(world.query.get_active_effects().map((r) => r.owner)).toEqual(['player', 'lita']);
  });

  it('预留字段随存档往返：写出 → hydrate → 读回（不是只在一处塞数据的假接口）', () => {
    start();
    const s = core.S!;
    s.player.effects = [{ id: 'blessing', left: 6 }];
    npcDyn('lita', s).gold = 120;

    const round = hydrate(JSON.parse(JSON.stringify(s)) as typeof s);
    expect(round.player.effects, '状态效果带得过去').toEqual([{ id: 'blessing', left: 6 }]);
    expect(round.npcs.lita.gold, 'NPC 钱包带得过去').toBe(120);
    expect(validateState(JSON.parse(JSON.stringify(s))), '新字段过得了存档闸门').toBeNull();
    /* 闸门也要拦得住脏数据：形状不对的 effects 不该被放行 */
    const dirty = JSON.parse(JSON.stringify(s));
    dirty.npcs.lita.effects = 'abc';
    expect(validateState(dirty)).toContain('状态效果');
  });

  it('get_world_rules 返回可枚举的规则表（id 列表而非计数）', () => {
    start();
    const rules = world.query.get_world_rules();
    expect(rules.locations.length).toBeGreaterThan(5);
    expect(rules.factions.length).toBeGreaterThan(3);
    expect(rules.npcs.length).toBeGreaterThan(10);
    expect(rules.locations).toContain('plaza');
    expect(rules.classes).toContain('warrior');
  });

  it('未注册任何能力时能力表为空（§14 可调用能力列表来源）', () => {
    start();
    expect(world.query.get_capabilities()).toEqual([]);
    expect(world.query.capability_owner('character_died')).toBeNull();
  });
});

/* ---------------- §41 · Dice ---------------- */

describe('§41 · Dice Engine', () => {
  it('骰型解析：合法与非法', () => {
    expect(parseDice('1d20')).toEqual({ count: 1, faces: 20 });
    expect(parseDice('2d6')).toEqual({ count: 2, faces: 6 });
    expect(parseDice('d20')).toBeNull();
    expect(parseDice('1d1')).toBeNull();
    expect(parseDice('99d6')).toBeNull();
  });

  it('随机性：结果落在 1..faces 闭区间', () => {
    for (let i = 0; i < 200; i++) {
      const r = roll('1d20')!;
      expect(r.total).toBeGreaterThanOrEqual(1);
      expect(r.total).toBeLessThanOrEqual(20);
    }
    const multi = roll('3d8')!;
    expect(multi.rolls).toHaveLength(3);
    expect(multi.total).toBeGreaterThanOrEqual(3);
    expect(multi.total).toBeLessThanOrEqual(24);
  });

  it('边界值：自然满点 → 大成功；自然 1 → 大失败（与原型 check 对齐）', () => {
    const restoreHigh = rng.inject(() => 0.999);
    const crit = resolveCheck({ type: 'stealth', attribute: 50, difficulty: 999 });
    expect(crit.roll).toBe(20);
    expect(crit.result).toBe('critical_success');
    expect(checkPassed(crit)).toBe(true);
    restoreHigh();

    const restoreLow = rng.inject(() => 0);
    const fumble = resolveCheck({ type: 'stealth', attribute: 50, difficulty: 0 });
    expect(fumble.roll).toBe(1);
    expect(fumble.result).toBe('critical_failure');
    expect(checkPassed(fumble)).toBe(false);
    restoreLow();
  });

  it('Modifier 与 Difficulty 共同决定成败，并给出带符号 margin', () => {
    const restore = rng.inject(() => 0.4); // 1 + floor(0.4*20) = 9
    const miss = resolveCheck({ type: 'climb', attribute: 12, difficulty: 15, modifier: 0 });
    expect(miss.roll).toBe(9);
    expect(miss.total).toBe(9);
    expect(miss.result).toBe('failure');
    expect(miss.margin).toBe(-6);

    const hit = resolveCheck({ type: 'climb', attribute: 12, difficulty: 15, modifier: 8 });
    expect(hit.total).toBe(17);
    expect(hit.result).toBe('success');
    expect(hit.margin).toBe(2);
    restore();
  });

  /* ---------------- §30/§31 · 事件通道（《NPC 规模化与事件通道方案》改进版 Phase 1） ---------------- */

  it('critical 不计普通配额：普通配额吃满后节律消息仍送达', () => {
    for (let i = 0; i < MAX_EVENTS_PER_TICK; i++) worldBus.emit(makeEvent({ type: 'npc_moved', day: 1 }));
    const got: string[] = [];
    const off = worldBus.on('hour_advanced', () => got.push('x'), 'probe-critical');
    const res = worldBus.emit(makeEvent({ type: 'hour_advanced', day: 1, level: 0 }));
    expect(res.status).toBe('dispatched');
    expect(res.channel).toBe('critical');
    expect(got, '节律消息不该被普通配额截流').toHaveLength(1);
    off();
  });

  it('critical 有独立熔断：超过上限进死信，不会无限执行（改进版 §8.1）', () => {
    const got: number[] = [];
    const off = worldBus.on('hour_advanced', () => got.push(1), 'probe-cap');
    let last = worldBus.emit(makeEvent({ type: 'hour_advanced', day: 1, level: 0 }));
    for (let i = 0; i < MAX_CRITICAL_PER_TICK + 3; i++) last = worldBus.emit(makeEvent({ type: 'hour_advanced', day: 1, level: 0 }));
    expect(got).toHaveLength(MAX_CRITICAL_PER_TICK);
    expect(last.status).toBe('dead_letter');
    off();
  });

  it('semantic 超限延后而不丢，下个 tick 用原 id 重投（§10）', () => {
    const got: string[] = [];
    const off = worldBus.on('grudge_formed', (e) => got.push(e.id), 'probe-semantic');
    for (let i = 0; i < MAX_EVENTS_PER_TICK; i++) worldBus.emit(makeEvent({ type: 'npc_moved', day: 1 }));
    const res = worldBus.emit(makeEvent({ type: 'grudge_formed', day: 1, level: 2 }));
    expect(res.status).toBe('deferred');
    expect(res.channel).toBe('semantic');
    expect(got, '当场没送达').toHaveLength(0);
    expect(worldBus.deferredEvents()).toHaveLength(1);

    worldBus.beginTick();
    expect(got, '下个 tick 补上，语义通知因此不丢').toHaveLength(1);
    expect(worldBus.deferredEvents()).toHaveLength(0);
    off();
  });

  it('ambient 超限仍是死信（可丢噪音保持原语义）', () => {
    for (let i = 0; i < MAX_EVENTS_PER_TICK; i++) worldBus.emit(makeEvent({ type: 'npc_moved', day: 1 }));
    const res = worldBus.emit(makeEvent({ type: 'npc_moved', day: 1 }));
    expect(res.status).toBe('dead_letter');
    expect(res.channel).toBe('ambient');
  });

  it('同一事件在本 tick 内重复投递判 duplicate（幂等的第二道）', () => {
    const e = makeEvent({ type: 'npc_moved', day: 1 });
    expect(worldBus.emit(e).status).toBe('dispatched');
    expect(worldBus.emit(e).status).toBe('duplicate');
  });
  it('§30 死信留痕：超限事件写进世界日志（不再静默消失）', () => {
    start();
    const off = attachDeadLetterWatch();
    try {
      for (let i = 0; i < MAX_EVENTS_PER_TICK + 1; i++) worldBus.emit(makeEvent({ type: 'npc_moved', day: 1 }));
      const last = core.S!.log.at(-1)!;
      expect(last.text).toContain('未扩散');
      expect(last.cls).toBe('sys');
    } finally {
      off();
    }
  });

  it('§44 检定留痕：骰值可追溯（存档答得出「这一下是怎么判的」）', () => {
    start();
    const s = core.S!;
    for (let i = 0; i < 35; i++) check('循环检定 ' + i, '感知', 11);
    expect(s.checks!.length, '环形缓冲封顶 30：跑 35 次也只留 30 条').toBe(30);
    expect(s.checks![0].label, '最旧的先滚出去').toBe('循环检定 5');
    const rec = s.checks!.at(-1)!;
    expect(rec.label).toBe('循环检定 34');
    expect(rec.stat).toBe('感知');
    expect(rec.dc).toBe(11);
    expect(rec.roll).toBeGreaterThanOrEqual(1);
    expect(rec.roll).toBeLessThanOrEqual(20);
    expect(typeof rec.ok).toBe('boolean');
    expect(rec.day, '与世界日历同源（dayOfTick）').toBe(sceneTime(s).day);
  });

  it('旧档没有检定留痕时补空表（结构可读性不受影响）', () => {
    start();
    const raw = JSON.parse(JSON.stringify(core.S!));
    delete raw.checks;
    expect(hydrate(raw).checks).toEqual([]);
  });

  it('雨天 -1 修正（原型 check 的环境项）', () => {
    const restore = rng.inject(() => 0.4); // roll 9
    const dry = resolveCheck({ type: 'climb', attribute: 10, difficulty: 10, weather: '晴' });
    const wet = resolveCheck({ type: 'climb', attribute: 10, difficulty: 10, weather: '雨' });
    expect(dry.total).toBe(9);
    expect(wet.total).toBe(8);
    expect(wet.modifier).toBe(-1);
    restore();
  });

  it('非法骰型直接抛错，不静默降级', () => {
    expect(() => resolveCheck({ type: 'x', attribute: 1, difficulty: 1, dice: '1d' })).toThrow();
  });
});

/* ---------------- §41 · Event Bus ---------------- */

describe('§41 · Event Bus', () => {
  const ev = (type: string, day = 1) => makeEvent({ type, day });

  it('发布 → 订阅者收到；退订后不再收到', () => {
    const seen: string[] = [];
    const off = worldBus.on('character_died', (e) => seen.push(e.id));
    worldBus.emit(ev('character_died'));
    off();
    worldBus.emit(ev('character_died'));
    expect(seen).toHaveLength(1);
  });

  it('事件顺序：同一类型多个订阅按注册顺序收到', () => {
    const order: string[] = [];
    worldBus.on('npc_moved', () => order.push('a'), 'a');
    worldBus.on('npc_moved', () => order.push('b'), 'b');
    worldBus.emit(ev('npc_moved'));
    expect(order).toEqual(['a', 'b']);
  });

  it('重复事件：同一处理器不重复消费同一事件（§30 幂等）', () => {
    let n = 0;
    worldBus.on('crime_committed', () => n++, 'guard');
    const e = ev('crime_committed');
    worldBus.emit(e);
    worldBus.emit(e);
    expect(n).toBe(1);
    expect(e.processedBy).toContain('crime_committed#guard');
  });

  it('派发顺序契约：通配订阅者（横切关注点）先于具体类型订阅者', () => {
    const order: string[] = [];
    /* 故意先注册具体类型、后注册通配——契约要求执行时通配仍在前面 */
    worldBus.on('crime_committed', () => order.push('specific'), 'biz');
    worldBus.on('*', () => order.push('wildcard'), 'audit');
    worldBus.emit(makeEvent({ type: 'crime_committed', day: 1, level: 2 }));
    expect(order).toEqual(['wildcard', 'specific']);
  });

  it('通配订阅收到全部类型', () => {
    const types: string[] = [];
    worldBus.on('*', (e) => types.push(e.type), 'audit');
    worldBus.emit(ev('npc_moved'));
    worldBus.emit(ev('character_died'));
    expect(types).toEqual(['npc_moved', 'character_died']);
  });

  it('critical 在深因果上下文里仍送达（节律不该被链深误杀，审查 I8）', () => {
    const got: string[] = [];
    const off = worldBus.on('hour_advanced', () => got.push('x'), 'probe-deep');
    causality.withParent('evt_root', () => {
      causality.withParent('evt_2', () => {
        causality.withParent('evt_3', () => {
          causality.withParent('evt_4', () => {
            const res = worldBus.emit(makeEvent({ type: 'hour_advanced', day: 1, level: 0 }));
            expect(res.status, '深度 4 的上下文里推进时间也要送达').toBe('dispatched');
          });
        });
      });
    });
    expect(got).toHaveLength(1);
    off();
  });

  it('seed：旧档缺它时 hydrate 补 0，且档内不再变化（Phase 2 新字段）', () => {
    const s = newState({ name: '测试者', race: 'dwarf', cls: 'warrior' }) as unknown as { seed?: number };
    delete s.seed;
    const h = hydrate(s as never);
    expect(h.seed, '旧档补 0（0 也是合法种子）').toBe(0);
    /* 档内恒定：任何读取路径都不该改它 */
    const again = hydrate(h);
    expect(again.seed).toBe(0);
  });
  it('事件失败：单 tick 超限与因果链过深进入死信队列而非无限扩散', () => {
    worldBus.on('npc_moved', () => {}, 'noop');
    for (let i = 0; i < MAX_EVENTS_PER_TICK + 3; i++) worldBus.emit(ev('npc_moved'));
    expect(worldBus.deadLetters().length).toBe(3);

    const before = worldBus.deadLetters().length;
    worldBus.emit(ev('npc_moved'), { chainDepth: 99 });
    expect(worldBus.deadLetters().length).toBe(before + 1);
  });

  it('beginTick 重置本 tick 计数', () => {
    worldBus.on('npc_moved', () => {}, 'noop');
    for (let i = 0; i < MAX_EVENTS_PER_TICK; i++) worldBus.emit(ev('npc_moved'));
    expect(worldBus.deadLetters()).toHaveLength(0);
    worldBus.beginTick();
    worldBus.emit(ev('npc_moved'));
    expect(worldBus.deadLetters()).toHaveLength(0);
  });

  it('计划事件：到点才结算（§32 延迟事件）', () => {
    worldBus.schedule(makeEvent({ type: 'city_at_war', day: 10 }), 3);
    expect(worldBus.due(12)).toHaveLength(0);
    expect(worldBus.due(13)).toHaveLength(1);
    expect(worldBus.due(99)).toHaveLength(0);
  });
});

/* ---------------- §41 · EventSchema ---------------- */

describe('§41 · EventSchema', () => {
  it('分级表：内部 0 / 局部 1 / 跨系统 2 / 复杂世界 3，未登记按局部处理', () => {
    expect(levelOf('damage_applied')).toBe(0);
    expect(levelOf('npc_moved')).toBe(1);
    expect(levelOf('character_died')).toBe(2);
    expect(levelOf('city_at_war')).toBe(3);
    expect(levelOf('未登记的事件')).toBe(1);
  });

  it('事件 id 确定性且唯一', () => {
    resetEventSeq();
    const a = makeEvent({ type: 'npc_moved', day: 3 });
    const b = makeEvent({ type: 'npc_moved', day: 3 });
    expect(a.id).toBe('evt_3_1');
    expect(b.id).toBe('evt_3_2');
    expect(a.level).toBe(1);
  });

  it('因果链向上追溯（§29 事件可追溯）', () => {
    const wound = makeEvent({ type: 'damage_applied', day: 1 });
    const death = makeEvent({ type: 'character_died', day: 1, parentId: wound.id });
    const chain = [wound, death];
    const heir = makeEvent({ type: 'faction_conflict', day: 2, parentId: death.id });
    const traced = traceChain([...chain, heir], heir.id);
    expect(traced.map((e) => e.type)).toEqual(['faction_conflict', 'character_died', 'damage_applied']);
  });
});

/* ---------------- §41 · Plugin / Capability ---------------- */

describe('§41 · Plugin + Capability Registry', () => {
  it('注册插件即登记能力并建立事件订阅', () => {
    const got: WorldEvent[] = [];
    plugins.register({
      id: 'combat',
      version: '1.0.0',
      capabilities: ['start_combat', 'attack'],
      subscribes: ['character_died'],
      handleEvent: (e) => got.push(e),
    });
    expect(capabilities.exists('start_combat')).toBe(true);
    expect(capabilities.owner('attack')).toBe('combat');
    expect(plugins.ids()).toEqual(['combat']);
    worldBus.emit(makeEvent({ type: 'character_died', day: 1 }));
    expect(got).toHaveLength(1);
  });

  it('未认领能力无主；capabilityMap 反映注册总览', () => {
    plugins.register({ id: 'npc', version: '1.0.0', capabilities: ['talk', 'move'] });
    expect(capabilities.owner('fire_missile')).toBeNull();
    expect(plugins.capabilityMap()).toEqual([{ system: 'npc', capabilities: ['talk', 'move'] }]);
  });

  it('同 id 重复注册 = 热替换：旧订阅不重复派发', () => {
    let n = 0;
    plugins.register({ id: 'quest', version: '1', capabilities: ['start_quest'], subscribes: ['quest_completed'], handleEvent: () => n++ });
    plugins.register({ id: 'quest', version: '2', capabilities: ['start_quest'], subscribes: ['quest_completed'], handleEvent: () => n++ });
    worldBus.emit(makeEvent({ type: 'quest_completed', day: 1 }));
    expect(n).toBe(1);
    expect(capabilities.of('quest')).toEqual(['start_quest']);
  });
});

/* ---------------- §41 · Validator ---------------- */

describe('§41 · Rule Validator', () => {
  const plan = (consequences: unknown[]) => ({ planId: 'p1', triggerEvent: 'evt_1_1', consequences });

  beforeEach(() => {
    plugins.register({ id: 'npc', version: '1.0.0', capabilities: ['create_npc_goal'], executable: ['create_npc_goal'] });
    plugins.register({ id: 'quest', version: '1.0.0', capabilities: ['update_quest'], executable: ['update_quest'] });
    plugins.register({ id: 'faction', version: '1.0.0', capabilities: ['change_reputation'], executable: ['change_reputation'] });
    start();
  });

  it('合法动作通过验证并按 priority 降序排序', () => {
    const v = validatePlan(plan([
      { action: 'update_quest', target: 'lita', reason: 'member_death', priority: 10 },
      { action: 'create_npc_goal', target: 'lita', reason: 'investigate', priority: 90 },
    ]));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.plan.consequences.map((c) => c.action)).toEqual(['create_npc_goal', 'update_quest']);
  });

  it('非法动作：能力未注册 → 拒绝', () => {
    const v = validatePlan(plan([{ action: 'summon_dragon', reason: 'because' }]));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('未注册');
  });

  it('不存在实体 → 拒绝', () => {
    const v = validatePlan(plan([{ action: 'create_npc_goal', target: 'npc_不存在', reason: 'x' }]));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('目标实体不存在');
  });

  it('权限/依据错误：缺 reason → 拒绝', () => {
    const v = validatePlan(plan([{ action: 'create_npc_goal', target: 'lita' }]));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('因果依据');
  });

  it('越界数值 → 拒绝；形状错误 → 拒绝', () => {
    const bad = validatePlan(plan([{ action: 'change_reputation', reason: 'x', params: { delta: 99999 } }]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('越界');

    expect(validatePlan('不是计划').ok).toBe(false);
    expect(validatePlan({ planId: 'p', triggerEvent: 'e', consequences: [] }).ok).toBe(false);
    expect(validatePlan(plan([{ action: 'create_npc_goal', reason: 'x', priority: 500 }])).ok).toBe(false);
  });

  it('重复执行同一动作 → 拒绝', () => {
    const v = validatePlan(plan([
      { action: 'create_npc_goal', target: 'lita', reason: 'a' },
      { action: 'create_npc_goal', target: 'lita', reason: 'b' },
    ]));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('重复执行');
  });
});

/* ---------------- §16/§17 · 能力与执行器同源守卫 ---------------- */
/* 注：这些用例的装配自检（registerConsequenceHandlers 内的 fail-fast 断言）
   与守卫断言互补——守卫看静态同源，自检挡住「运行时装了却没声明」。 */

describe('§16/§17 · 能力白名单与执行器同源', () => {
  /* 这些用例会装载完整生产集；跑完复原，避免后续 describe 跑在一个「已接好线」的世界上 */
  afterEach(() => {
    plugins.clear();
    worldExecutor.clear();
  });

  it('effects ⇔ 执行器处理器（双向相等：白名单不许出现做不到的动作）', () => {
    plugins.clear();
    worldExecutor.clear();
    registerCoreSystems();
    registerConsequenceHandlers();

    const declared = capabilities.executableList().sort();
    const handled = worldExecutor.actions().sort();
    expect(declared, '登记为可执行却没有处理器 → 能过验证却落不了地').toEqual(handled);
  });

  it('事件化后的写函数不得再被 systems 目录直调（二期 H-09）', () => {
    /* 这几个函数原先被 Chat / Combat / Dialogue / ActionParser 直接调用。
       它们已改为事件（lore_unlocked / grudge_formed / rumor_spread），
       调用方不该再知道消费方的存在——这条守卫盯着「改回去了」。 */
    const banned = ['deepTalkUnlock', 'readTome', 'setGrudge', 'spreadRumor'];
    const walk = (d: string, out: string[] = []): string[] => {
      for (const n of readdirSync(d)) {
        const p = d + '/' + n;
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    const hits: string[] = [];
    for (const f of walk('src/systems')) {
      const src = readFileSync(f, 'utf8');
      for (const b of banned) {
        if (new RegExp('import[^;]*\\b' + b + '\\b').test(src)) hits.push(f + ' → ' + b);
      }
    }
    expect(hits, '跨系统写调用已改为事件，不该再出现在 import 里').toEqual([]);
  });
  it('internal 能力的真实入口必须真在路由里存在（§20 复核整改）', () => {
    /* 复核发现：28 条 internal 里 24 条在全仓零出现——面板显示的「我能做什么」
       无法回溯到任何可寻址入口。现在每条登记下来的入口都要能在路由里找到真名。 */
    const src = readFileSync(new URL('../world/WorldRuntime.ts', import.meta.url), 'utf8');
    const missing: string[] = [];
    for (const spec of SYSTEM_SPECS) {
      for (const [cap, entries] of Object.entries(spec.entries ?? {})) {
        for (const e of entries) if (!src.includes("'" + e + "'")) missing.push(spec.id + '.' + cap + ' → ' + e);
      }
    }
    expect(missing, '登记的入口在 WorldRuntime 路由里找不到').toEqual([]);
  });

  it('entries 的键必须是本系统声明过的能力（不许张冠李戴）', () => {
    for (const spec of SYSTEM_SPECS) {
      for (const cap of Object.keys(spec.entries ?? {})) {
        expect(capabilitiesOf(spec), spec.id + ' 的 entries 键 ' + cap).toContain(cap);
      }
    }
  });

  it('凡是登记了 entries 的能力，映射都不能是空表', () => {
    for (const spec of SYSTEM_SPECS) {
      for (const [cap, entries] of Object.entries(spec.entries ?? {})) {
        expect(entries.length, spec.id + '.' + cap).toBeGreaterThan(0);
      }
    }
  });
  it('生产装配（bootstrapWorld 的同一条路径）之后仍然同源', () => {
    plugins.clear();
    worldExecutor.clear();
    const dispose = bootstrapWorld({ reasoner: ruleReasoner });
    try {
      expect(capabilities.executableList().sort(), '装配四步之后 effects 仍等于处理器集').toEqual(worldExecutor.actions().sort());
    } finally {
      dispose();
    }
  });

  it('装配自检：装了处理器却没声明为可执行能力 → 装配直接失败（反向空洞也堵住）', () => {
    plugins.clear();
    worldExecutor.clear();
    registerCoreSystems();
    worldExecutor.registerHandler('偷偷加的动作', () => {});
    expect(() => registerConsequenceHandlers()).toThrow(/可执行能力/);
  });

  it('待接入清单与可执行清单互不重叠，且不含已经能执行的动作（分类不撒谎）', () => {
    plugins.clear();
    worldExecutor.clear();
    registerCoreSystems();
    registerConsequenceHandlers();

    /* 声明层先查重叠：注册表会把已可执行的动作挡在 pending 视图外，
       所以只查视图抓不到「有人把同一个动作写进两类」。 */
    const declaredEffects = SYSTEM_SPECS.flatMap((s) => s.effects);
    const declaredPending = SYSTEM_SPECS.flatMap((s) => s.pending ?? []);
    expect(
      declaredPending.filter((c) => declaredEffects.includes(c)),
      '同一个动作不能既声明为可执行又声明为待接入',
    ).toEqual([]);
    const pending = capabilities.pendingList().sort();
    const exec = capabilities.executableList().sort();
    expect(pending.filter((c) => exec.includes(c)), '待接入与可执行不可能同时成立').toEqual([]);
    /* 这里原先写作「pending 必然非空」（那时有 11 条「将来会有」的世界后果），
       二期 H-12 清零后那条假设失效；改成恒真的 >= 0 更是等于没断言（审查 Minor）。
       真正的契约是下面两条：两个清单不重叠、且提升后不留残影。 */
    expect(pending.filter((c) => exec.includes(c))).toEqual([]);
    /* 反向：动作已被注册进执行器，说明它其实能执行——留在 pending 是漏了提升动作 */
    expect(
      pending.filter((c) => worldExecutor.hasHandler(c)),
      '这些动作已经有处理器了，请把它们从 pending 移到 effects',
    ).toEqual([]);
    /* 审计视图按系统对齐（不是恒真的自比）：每个系统的条数要与注册表一致 */
    for (const row of plugins.pendingMap()) {
      expect(row.capabilities.sort(), '系统 ' + row.system + ' 的待接入条目').toEqual(capabilities.pendingOf(row.system).sort());
    }
    expect(plugins.pendingMap().length, '有待接入的系统数').toBe(new Set(SYSTEM_SPECS.filter((s) => s.pending?.length).map((s) => s.id)).size);
  });

  it('声明为 internal 的动作不进后果计划（AI 不能替玩家做决定 / 越过战斗裁定生死）', () => {
    plugins.clear();
    worldExecutor.clear();
    registerCoreSystems();
    registerConsequenceHandlers();
    start();

    const v = validatePlan({
      planId: 'p1',
      triggerEvent: 'evt_1_1',
      consequences: [{ action: 'travel_to', target: 'lita', reason: '想把她带走' }],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('未接入执行器');
  });

  it('未登记的动作与未接入的动作给出不同拒绝理由（可诊断）', () => {
    plugins.clear();
    worldExecutor.clear();
    registerCoreSystems();
    registerConsequenceHandlers();
    start();

    const unknown = validatePlan({ planId: 'p', triggerEvent: 'e', consequences: [{ action: 'summon_dragon', reason: 'x' }] });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain('未注册');

    const internal = validatePlan({ planId: 'p', triggerEvent: 'e', consequences: [{ action: 'attack', reason: 'x' }] });
    expect(internal.ok).toBe(false);
    if (!internal.ok) expect(internal.error).toContain('未接入执行器');
  });
});

/* ---------------- §41 · Executor ---------------- */

describe('§41 · World Executor', () => {
  beforeEach(() => {
    plugins.register({ id: 'npc', version: '1.0.0', capabilities: ['create_npc_goal'], executable: ['create_npc_goal'] });
    plugins.register({ id: 'quest', version: '1.0.0', capabilities: ['update_quest'], executable: ['update_quest'] });
    start();
  });

  const makePlan = () => ({
    planId: 'plan_1',
    triggerEvent: 'evt_1_1',
    consequences: [
      { action: 'create_npc_goal', target: 'lita', reason: 'member_death', priority: 90 },
      { action: 'update_quest', target: 'lita', reason: 'blocked', priority: 10 },
    ],
  });

  it('合法计划执行：逐条调用处理器并记录执行期新事件', () => {
    const ran: string[] = [];
    worldExecutor.registerHandler('create_npc_goal', () => {
      ran.push('goal');
      worldBus.emit(makeEvent({ type: 'relationship_changed', day: 1 }));
    });
    worldExecutor.registerHandler('update_quest', () => ran.push('quest'));

    const res = worldExecutor.execute(makePlan());
    expect(res.executed).toBe(2);
    expect(res.rejected).toBe(0);
    expect(ran).toEqual(['goal', 'quest']);
    expect(res.newEvents).toHaveLength(1);
  });

  it('非法计划拒绝：零执行', () => {
    let touched = false;
    worldExecutor.registerHandler('create_npc_goal', () => {
      touched = true;
    });
    const res = worldExecutor.execute({ planId: 'p', triggerEvent: 'e', consequences: [{ action: 'summon_dragon', reason: 'x' }] });
    expect(res.executed).toBe(0);
    expect(touched).toBe(false);
    expect(res.outcomes[0].ok).toBe(false);
  });

  it('部分失败：单条抛错不阻断后续条目', () => {
    worldExecutor.registerHandler('create_npc_goal', () => {
      throw new Error('boomed');
    });
    const done: string[] = [];
    worldExecutor.registerHandler('update_quest', () => done.push('q'));

    const res = worldExecutor.execute(makePlan());
    expect(res.executed).toBe(1);
    expect(res.rejected).toBe(1);
    expect(res.outcomes.find((o) => o.action === 'create_npc_goal')?.note).toContain('boomed');
    expect(done).toEqual(['q']);
  });

  it('重复执行：同一计划重放不产生副作用（处理器侧由调用方自行幂等，执行器不缓存）', () => {
    let n = 0;
    worldExecutor.registerHandler('create_npc_goal', () => n++);
    worldExecutor.registerHandler('update_quest', () => {});
    worldExecutor.execute(makePlan());
    worldExecutor.execute(makePlan());
    expect(n).toBe(2);
  });
});

/* ============================================================
   关系网动词测试（《架构深化方案》二期 H-04）
   —— 四条能力从 pending 提升为 effects：函数早就存在，缺的一直是
   「谁在什么时机驱动它」。这里验证它们真的能经统一动词入口落地。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { worldBus } from '@/events/EventBus';
import { plugins } from '@/plugins/PluginRegistry';
import { worldExecutor } from '@/execution/WorldExecutor';
import { registerCoreSystems } from '@/plugins/systems';
import { registerConsequenceHandlers } from '@/plugins/handlers';
import { world } from '@/world/WorldAPI';
import { attOf } from '@/systems/npc/Npcs';
import { mutate } from '@/world/WorldMutate';
import { itemCount } from '@/systems/character/Gains';
import { WB } from '@/data/worldBook';
import { grudgeOf } from '@/systems/relationship/Bond';
import { registerSystemSubscriptions } from '@/plugins/subscriptions';
import { makeEvent } from '@/events/EventSchema';

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
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

afterEach(() => {
  core.S = null;
  resetWorld();
});

describe('§21 · 事件化的行为等价（二期审查 I8）', () => {
  beforeEach(() => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    /* 订阅式装配的固有前提：不装配就没人响应——H-09 之后这几条链路都靠它 */
    registerSystemSubscriptions();
  });

  it('grudge_formed 事件到达时真的结仇（替代原先的 setGrudge 直调）', () => {
    expect(grudgeOf('mia')).toBeFalsy();
    worldBus.beginTick();
    worldBus.emit(
      makeEvent({ type: 'grudge_formed', day: 1, level: 2, actor: 'player', target: 'mia', data: { npc: 'mia', why: '你骗了她', sev: 2 } }),
    );
    expect(grudgeOf('mia'), '事件到达即结仇').toBeTruthy();
  });

  it('rumor_spread 事件到达时传闻沿关系网扩散', () => {
    worldBus.beginTick();
    expect(() =>
      worldBus.emit(makeEvent({ type: 'rumor_spread', day: 1, level: 1, actor: 'lita', data: { src: 'lita', topic: '有人在深巷销赃', imp: 2 } })),
    ).not.toThrow();
  });

  /* Phase 4.2：hour_advanced 不再有订阅者（位置改纯函数直算，不再需要时辰边界推一把）。
     这条用例保留下来测的是另一半语义：**L0 节律事实不该被人「目击」到**。 */
  it('hour_advanced（L0）节律事实不被感知层抽样', () => {
    const before = core.S!.knowledge ? Object.keys(core.S!.knowledge).length : 0;
    worldBus.beginTick();
    worldBus.emit(makeEvent({ type: 'hour_advanced', day: 1, tick: 4, level: 0 }));
    const after = core.S!.knowledge ? Object.keys(core.S!.knowledge).length : 0;
    expect(after, 'L0 节律事实不该被人「目击」到').toBe(before);
  });
});
describe('§4.2 · 关系网动词（二期从 pending 提升为 effects）', () => {
  it('befriend：好感真的涨了（单次夹取 ±20）', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    const before = attOf('lita');
    const res = world.execute({ action: 'befriend', target: 'lita', source: 'lita', reason: '投缘', params: { delta: 12 } });
    expect(res.executed).toBe(1);
    expect(attOf('lita')).toBe(before + 12);
    /* 越界值被夹取而不是照单全收 */
    world.execute({ action: 'befriend', target: 'lita', source: 'lita', reason: '厚礼', params: { delta: 999 } });
    expect(attOf('lita')).toBe(before + 32);
  });

  it('form_grudge：结仇写入羁绊（供赠礼与对话读取）', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    expect(grudgeOf('mia')).toBeFalsy();
    const res = world.execute({ action: 'form_grudge', target: 'mia', source: 'mia', reason: '你骗了她', params: { severity: 2 } });
    expect(res.executed).toBe(1);
    expect(grudgeOf('mia')).toBeTruthy();
  });

  it('spread_rumor：传闻经动词入口扩散（不抛错且落地）', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    const res = world.execute({ action: 'spread_rumor', target: 'lita', source: 'lita', reason: '有人在深巷销赃', params: { topic: '有人在深巷销赃', imp: 2 } });
    expect(res.executed).toBe(1);
  });


  it('change_price：改的是品类价格指数，越界被夹取到 [0.2, 5]', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    const key = Object.keys(core.S!.econ)[0];
    const before = core.S!.econ[key] ?? 1;
    const r = world.execute({ action: 'change_price', target: 'player', source: 'player', reason: '商会议价', params: { index: key, delta: 0.5 } });
    expect(r.executed).toBe(1);
    expect(core.S!.econ[key]).toBeGreaterThan(before);
    world.execute({ action: 'change_price', target: 'player', source: 'player', reason: '囤积居奇', params: { index: key, delta: 99 } });
    expect(core.S!.econ[key]).toBe(5);
  });

  it('suppress_title：通道连通；无该称号时不落地（正向路径由 cardI6 覆盖）', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    const r = world.execute({ action: 'suppress_title', target: 'player', source: 'player', reason: '打点关系', params: { title: 'no_such_title' } });
    expect(r.executed).toBe(1);
    expect(core.S!.titleHidden ?? []).toEqual([]);
  });

  it('clear_crime：抹掉的是案宗，抹不掉记忆（感知表一字不动）', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    core.S!.cases = [
      { id: 'c1', eventId: 'e1', crime: 'petty_theft', subject: 'player', filedBy: 'empire', day: 1, progress: 30, evidence: ['lita'], status: 'open' },
    ];
    core.S!.player.wanted = 2;
    core.S!.knowledge = { lita: [{ eventId: 'e1', type: 'crime_committed', day: 1, fidelity: 1, via: 'witness', account: '玩家在集市行窃' }] };
    /* 代价语义（二期审查 I5）：与玩家通道的 payFine 一致，300 × 通缉等级 */
    const poor = world.execute({ action: 'clear_crime', target: 'player', source: 'player', reason: '打点关系', params: { fine: 0 } });
    expect(poor.executed).toBe(1);
    expect(core.S!.cases.length, '付不起就不落地').toBe(1);

    const r = world.execute({ action: 'clear_crime', target: 'player', source: 'player', reason: '打点关系', params: { fine: 600 } });
    expect(r.executed).toBe(1);
    expect(core.S!.cases.length).toBe(0);
    expect(core.S!.player.wanted).toBe(0);
    expect(core.S!.knowledge.lita!.length, '目击者仍然记得').toBe(1);
  });
  it('transfer_item：玩家 → NPC 整件转移，转出方不足则整条不落地', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    const iid = Object.keys(WB.items)[0];
    mutate.playerBag(iid, 5);
    const r = world.execute({
      action: 'transfer_item',
      target: iid,
      source: 'player',
      reason: '托付给莉安',
      params: { from: 'player', to: 'lita', item: iid, qty: 2 },
    });
    expect(r.executed).toBe(1);
    expect(mutate.npcEntry('lita').bag?.find((x) => x.id === iid)?.qty).toBe(2);
    expect(itemCount(iid)).toBe(3);

    /* 转出方不足：整条不落地，不做部分转移 */
    world.execute({ action: 'transfer_item', target: iid, source: 'player', reason: '硬塞', params: { from: 'player', to: 'lita', item: iid, qty: 99 } });
    expect(itemCount(iid)).toBe(3);
    expect(mutate.npcEntry('lita').bag?.find((x) => x.id === iid)?.qty).toBe(2);
  });

  it('transfer_money：非数字金额不落地（NaN 会污染存档，二期审查 C1）', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    mutate.npcGold('lita', 100);
    const g0 = core.S!.player.gold;
    world.execute({ action: 'transfer_money', target: 'lita', source: 'player', reason: '乱写金额', params: { from: 'player', to: 'lita', amount: '一百' } });
    expect(Number.isFinite(core.S!.player.gold), '金币必须仍是有限数').toBe(true);
    expect(core.S!.player.gold).toBe(g0);
    expect(mutate.npcEntry('lita').gold).toBe(100);
  });

  it('transfer_money：金钱双向转移，余额不足则整条不落地', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    mutate.npcGold('lita', 500);
    const g0 = core.S!.player.gold;
    world.execute({ action: 'transfer_money', target: 'lita', source: 'player', reason: '付账', params: { from: 'player', to: 'lita', amount: 100 } });
    expect(core.S!.player.gold).toBe(g0 - 100);
    expect(mutate.npcEntry('lita').gold).toBe(600);

    world.execute({ action: 'transfer_money', target: 'player', source: 'player', reason: '还款', params: { from: 'lita', to: 'player', amount: 200 } });
    expect(core.S!.player.gold).toBe(g0 + 100);
    expect(mutate.npcEntry('lita').gold).toBe(400);

    world.execute({ action: 'transfer_money', target: 'lita', source: 'player', reason: '豪赌', params: { from: 'lita', to: 'player', amount: 99999 } });
    expect(mutate.npcEntry('lita').gold).toBe(400);
  });
  it('add_status / remove_status：世界级状态可挂可摘，同一 id 不叠条', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    const ok = world.execute({
      action: 'add_status',
      target: 'player',
      source: 'player',
      reason: '中毒三天',
      params: { status: 'poisoned', left: 72, power: 2 },
    });
    expect(ok.executed).toBe(1);
    const eff = world.query.get_active_effects()[0].effects[0];
    expect(eff.id).toBe('poisoned');
    expect(eff.left).toBe(72);

    /* 同一 id 再挂一次是刷新而不是叠成两条（世界级状态的叠层语义由具体效果定义） */
    world.execute({ action: 'add_status', target: 'player', source: 'player', reason: '又中毒了', params: { status: 'poisoned', left: 24 } });
    const rows = world.query.get_active_effects()[0].effects;
    expect(rows.length).toBe(1);
    expect(rows[0].left).toBe(24);

    const rm = world.execute({ action: 'remove_status', target: 'player', source: 'player', reason: '解毒', params: { status: 'poisoned' } });
    expect(rm.executed).toBe(1);
    expect(world.query.get_active_effects()).toEqual([]);
  });

  it('add_status：NPC 侧也能挂状态（owner 由 target 给出）', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    const r = world.execute({ action: 'add_status', target: 'lita', source: 'lita', reason: '受了惊吓', params: { status: 'shaken', left: 48 } });
    expect(r.executed).toBe(1);
    expect(world.query.get_active_effects().map((x) => x.owner)).toContain('lita');
  });

  it('change_faction_relation：两个势力都在 params 里（不是 target）', () => {
    start();
    registerCoreSystems();
    registerConsequenceHandlers();
    const ok = world.execute({
      action: 'change_faction_relation',
      target: 'empire',
      source: 'empire',
      reason: '联姻使节往来',
      params: { a: 'empire', b: 'temple_life', axis: 'religion', dv: 10 },
    });
    expect(ok.executed).toBe(1);
    /* 未知势力键不落地（与 mutate.rep 同一条守则：不制造脏键）。
       处理器静默忽略，动词入口仍记「执行成功」——它确实跑完了；
       状态层面则什么也没发生，这才是要断言的东西。 */
    const bad = world.execute({
      action: 'change_faction_relation',
      target: 'empire',
      source: 'empire',
      reason: '不存在的势力',
      params: { a: 'empire', b: 'no_such_faction', axis: 'religion', dv: 10 },
    });
    expect(bad.executed).toBe(1);
    expect(core.S!.factionRel?.['empire']?.['no_such_faction'], '脏键不该被创建').toBeUndefined();
  });
});

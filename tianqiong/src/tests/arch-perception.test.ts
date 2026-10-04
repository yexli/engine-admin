/* ============================================================
   §8 NPC 感知分离 + §34 系统接入世界事件
   —— World Truth ≠ NPC Knowledge：世界史记事实，感知表记「谁知道」。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, core, importState, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { worldBus } from '@/events/EventBus';
import { makeEvent, resetEventSeq } from '@/events/EventSchema';
import { cancelWorldLogPersist, restoreWorldLog, worldEventLog } from '@/events/EventStore';
import { injectSampling } from '@/events/Sampling';
import { attachPerception, knownBy, perception, registerPerception, spreadPerception, subtletyOf, witnessesOf } from '@/events/Perception';
import { plugins } from '@/plugins/PluginRegistry';
import { presentByBruteForce, presentNPCs } from '@/systems/npc/Npcs';
import { commitCrime } from '@/systems/law/Law';
import { turnIn } from '@/systems/quest/Quests';
import { buy, shopRows } from '@/systems/economy/Shop';
import { playerAct, startCombat } from '@/systems/combat/Combat';
import { advance } from '@/world/WorldClock';
import { buildContext } from '@/ai/ContextBuilder';
import { reasonAbout, setReasonerPort, shouldReason } from '@/ai/WorldReasoner';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { caseView, investigationTick, openCase } from '@/systems/law/Investigation';
import { worldExecutor } from '@/execution/WorldExecutor';
import { attachWorldEventLog } from '@/events/EventStore';
import { registerCoreSystems } from '@/plugins/systems';
import { registerDaySettle } from '@/plugins/daySettle';
import abyssRaw from '@/data/world/abyss.json';
import { WB } from '@/data/worldBook';
import lawRaw from '@/data/world/law.json';
import type { WorldEvent } from '@/events/EventSchema';

const start = () => newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });
let offDay: () => void;
const CRIME_IDS = Object.keys((lawRaw as unknown as { crimes?: Record<string, unknown> }).crimes ?? {});

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  worldBus.reset();
  plugins.clear();
  worldEventLog.clear();
  perception.clear();
  resetEventSeq();
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  /* §27：日边界结算走 new_day 订阅（WorldClock 不再内联日 tick）——
     订阅式装配的固有前提：不装配就没人响应，这里显式补上并逐例退订。 */
  offDay = registerDaySettle();
});

afterEach(() => {
  offDay();
});

/* ---------------- §8 感知分离 ---------------- */

describe('§8 · NPC 感知分离', () => {
  it('显眼程度表：死亡满城可见，私事几乎无人察觉', () => {
    expect(subtletyOf(makeEvent({ type: 'character_died', day: 1 }))).toBeGreaterThan(0.8);
    expect(subtletyOf(makeEvent({ type: 'relationship_changed', day: 1 }))).toBeLessThan(0.2);
    expect(subtletyOf(makeEvent({ type: '未登记类型', day: 1 }))).toBe(0.5);
  });

  it('位置索引与直算一致（Phase 3）：跨时辰、跨门禁位都不许偏', () => {
    /* 索引是缓存而不是事实来源：事实始终是 npcAt 纯函数。
       这条用例拿它跟直算逐个比——索引一旦漏掉某类失效（时辰变了没重建、
       门禁位变了没重建），这里就会红。 */
    start();
    const locs = ['plaza', 'tavern', 'market', 'temple', 'guild', 'gate', 'alley', 'cave'];
    for (let t = 0; t < 96; t += 4) {
      core.S!.t = t;
      for (const loc of locs) {
        const idx = presentNPCs(loc, core.S!).map((x) => x.id).sort();
        const brute = presentByBruteForce(loc, core.S!).map((x) => x.id).sort();
        expect(idx, 't=' + t + ' loc=' + loc).toEqual(brute);
      }
    }
  });

  it('事件显式声明的目击者无条件计入', () => {
    start();
    const e = makeEvent({ type: 'relationship_changed', day: 1, location: 'plaza', witnesses: ['lita'] });
    /* Phase 2 后察觉走确定性采样，不再吃 rng——注入点必须用它 */
    const restore = injectSampling(() => false); // 其余在场者一律察觉失败
    let seen: string[];
    try {
      seen = registerPerception(e, core.S!);
    } finally {
      restore();
    }
    expect(seen).toEqual(['lita']);
  });

  it('显眼事件：在场者全部目击（察觉判定注入为必成）', () => {
    start();
    const present = presentNPCs('plaza', core.S!).map((n) => n.id);
    /* Phase 2 之后察觉判定走确定性采样，不再吃 rng——注入点改用 injectSampling（二期审查 I3 同类） */
    const seen = (() => {
      const restore = injectSampling(() => true);
      try {
        return registerPerception(makeEvent({ type: 'character_died', day: 1, location: 'plaza', level: 2 }), core.S!);
      } finally {
        restore();
      }
    })();
    expect(seen.sort()).toEqual(present.sort());
  });

  it('World Truth ≠ NPC Knowledge：真相已成立，但无人目击时没人知道', () => {
    start();
    const e = makeEvent({ type: 'relationship_changed', day: 1, location: 'plaza', level: 2 });
    const seen = (() => {
      const restore = injectSampling(() => false);
      try {
        return registerPerception(e, core.S!);
      } finally {
        restore();
      }
    })();
    expect(seen).toEqual([]);
    expect(perception.size()).toBe(0);
  });

  it('Level 0 内部账目无人感知（掉血/扣蓝不进任何人的认知）', () => {
    start();
    const seen = registerPerception(makeEvent({ type: 'damage_applied', day: 1, location: 'plaza', level: 0 }), core.S!);
    expect(seen).toEqual([]);
    expect(perception.size()).toBe(0);
  });

  it('谣言传播：二手信息保真度衰减并标注为听说', () => {
    start();
    const e = makeEvent({ type: 'character_died', day: 1, location: 'plaza', level: 2, target: 'bandit', cause: 'combat' });
    const seen = (() => {
      const restore = injectSampling(() => true); // 有人察觉
      try {
        return registerPerception(e, core.S!);
      } finally {
        restore();
      }
    })();
    expect(seen.length).toBeGreaterThan(0);
    const witness = seen[0];
    expect(spreadPerception(e.id, witness, 'unknown_npc', 0.6)).toBe(true);
    const heard = knownBy('unknown_npc');
    expect(heard).toHaveLength(1);
    expect(heard[0].via).toBe('rumor');
    expect(heard[0].fidelity).toBeCloseTo(0.6);
    expect(heard[0].account).toContain('听说');
  });

  it('亲眼所见不会被传闻覆盖；保真度过低时传闻自行中断', () => {
    start();
    /* 显式目击者保证「亲历者」存在；其余在场者一律察觉失败 */
    const e = makeEvent({ type: 'character_died', day: 1, location: 'plaza', level: 2, witnesses: ['lita'] });
    const restore = rng.inject(() => 0.99);
    registerPerception(e, core.S!);
    restore();
    expect(knownBy('lita')).toHaveLength(1);
    expect(spreadPerception(e.id, 'lita', 'lita', 0.6)).toBe(false); // 亲历优先，传闻不覆盖
    expect(spreadPerception(e.id, 'nobody', 'someone', 0.6)).toBe(false); // 无来源
    expect(spreadPerception(e.id, 'lita', 'other', 0.6)).toBe(true); // 一手传闻：0.6 保真
    expect(knownBy('other')[0].fidelity).toBeCloseTo(0.6);
    expect(spreadPerception(e.id, 'other', 'third', 0.1)).toBe(false); // 0.6×0.1 低于阈值 → 中断
    expect(knownBy('third')).toHaveLength(0);
  });

  it('knowers 支持「谁泄露了消息」类调查', () => {
    start();
    const e = makeEvent({ type: 'crime_committed', day: 1, location: 'plaza', level: 2, witnesses: ['lita'] });
    const restore = rng.inject(() => 0.99);
    registerPerception(e, core.S!);
    restore();
    const knowers = perception.knowers(e.id);
    expect(knowers).toContain('lita');
    expect(perception.knowers('evt_不存在')).toEqual([]);
  });

  it('引擎契约：未开局时直接判定会抛错，挂载版订阅已在入口判空', () => {
    const e = makeEvent({ type: 'character_died', day: 1, location: 'plaza', level: 2 });
    expect(() => witnessesOf(e, core.S as never)).toThrow();
  });

  it('attachPerception 挂载后自动登记；退订后不再记录', () => {
    start();
    const off = attachPerception();
    const restore = rng.inject(() => 0);
    worldBus.emit(makeEvent({ type: 'character_died', day: 1, location: 'plaza', level: 2 }));
    restore();
    expect(perception.size()).toBeGreaterThan(0);
    off();
    const before = perception.size();
    worldBus.emit(makeEvent({ type: 'character_died', day: 1, location: 'plaza', level: 2 }));
    expect(perception.size()).toBe(before);
  });
});

/* ---------------- §34 系统接入 ---------------- */

describe('§34 · 系统接入世界事件', () => {
  it('立案 → crime_committed（含罪名的通缉增量）', () => {
    start();
    expect(CRIME_IDS.length, 'law.json 未取到罪名表').toBeGreaterThan(0);
    const got: WorldEvent[] = [];
    worldBus.on('crime_committed', (e) => got.push(e), 'probe');
    expect(commitCrime(CRIME_IDS[0])).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0].level).toBe(2);
    expect(got[0].actor).toBe('player');
    expect(got[0].target).toBe(CRIME_IDS[0]);
  });

  it('未知罪名不立案也不发事件', () => {
    start();
    let n = 0;
    worldBus.on('crime_committed', () => n++, 'probe');
    expect(commitCrime('crime_不存在')).toBe(false);
    expect(n).toBe(0);
  });

  it('任务交付 → quest_completed', () => {
    start();
    const killEntry = Object.entries(WB.quests).find(([, q]) => q.type === 'kill');
    expect(killEntry, '世界书缺少击杀类委托').toBeTruthy();
    const [qid, qdef] = killEntry!;
    /* 直接构造「已达成」的委托状态：击杀类达标判定只看计数，不看 stage */
    core.S!.player.quests[qid] = { stage: 'go', count: (qdef as { count?: number }).count ?? 0 };
    const got: WorldEvent[] = [];
    worldBus.on('quest_completed', (e) => got.push(e), 'probe');
    turnIn(qid);
    expect(got).toHaveLength(1);
    expect(got[0].target).toBe(qid);
    expect(got[0].level).toBe(2);
  });

  it('战斗胜利 → character_died（行为级：真打完一场）', () => {
    start();
    const got: WorldEvent[] = [];
    worldBus.on('character_died', (e) => got.push(e), 'probe');
    startCombat(['rabbit']);
    for (let i = 0; i < 60 && core.CB; i++) playerAct('atk');
    expect(got.length, '战斗结束后应发布 character_died').toBeGreaterThan(0);
    expect(got[0].actor).toBe('player');
    expect(got[0].cause).toBe('combat');
    expect(got[0].level).toBe(2);
  });

  it('制作 / 称号接入已就位（源码级契约：事件不得被悄悄摘除）', async () => {
    const { readFileSync } = await import('node:fs');
    const craft = readFileSync(new URL('../systems/inventory/Craft.ts', import.meta.url), 'utf8');
    const title = readFileSync(new URL('../systems/reputation/Title.ts', import.meta.url), 'utf8');
    expect(craft).toContain("type: 'item_crafted'");
    expect(title).toContain("type: 'title_granted'");
  });

  it('大额交易 → large_trade；低于门槛不上总线', () => {
    start();
    core.S!.player.gold = 999999;
    core.curShop = 'grocer';
    const rows = shopRows('grocer');
    expect(rows.length).toBeGreaterThan(0);
    const top = rows.reduce((a, b) => (b.price > a.price ? b : a));
    const cheap = rows.reduce((a, b) => (b.price < a.price ? b : a));
    const got: WorldEvent[] = [];
    worldBus.on('large_trade', (e) => got.push(e), 'probe');
    const expected = (x: { price: number }) => (x.price >= 1000 ? 1 : 0);

    buy(cheap.iid);
    expect(got.length, '小额交易不应上世界总线').toBe(expected(cheap));
    buy(top.iid);
    expect(got.length).toBe(expected(cheap) + expected(top));
    expect(got.every((e) => e.actor === 'player')).toBe(true);
  });
});

/* ---------------- §12 · L3 事件源：推演通道的入口 ---------------- */

describe('§12/§36 · L3 复杂世界事件源', () => {
  it('裂隙跨过临界 → abyss_breach（Level 3），且满足推演门槛', () => {
    start();
    const cfg = (abyssRaw as unknown as { crisisAtLeak: number }).crisisAtLeak;
    expect(cfg).toBeGreaterThan(0);
    core.S!.abyss = { leak: cfg - 1, sealed: 0 };
    const got: WorldEvent[] = [];
    worldBus.on('abyss_breach', (e) => got.push(e), 'probe');
    const restore = rng.inject(() => 0); // 当日魔气必增
    advance(48);
    restore();
    expect(got).toHaveLength(1);
    expect(got[0].level).toBe(3);
    expect(got[0].cause).toBe('leak_crisis');
    expect(shouldReason(got[0]), 'L3 事件应满足推演门槛').toBe(true);
  });

  it('未达临界不发布（跨过阈值只触发一次）', () => {
    start();
    const cfg = (abyssRaw as unknown as { crisisAtLeak: number }).crisisAtLeak;
    core.S!.abyss = { leak: 0, sealed: 0 };
    const got: WorldEvent[] = [];
    worldBus.on('abyss_breach', (e) => got.push(e), 'probe');
    const restore = rng.inject(() => 0);
    advance(48);
    restore();
    expect(got.filter((e) => e.type === 'abyss_breach')).toHaveLength(0);
    expect(cfg).toBeGreaterThan(1);
  });
});

/* ---------------- §8/§36 · 感知持久化与调查证据链 ---------------- */

/* ---------------- §29/§44 · 世界史持久化（二期 H-10） ---------------- */

describe('§29 · 世界史持久化', () => {
  it('随档往返：节流写盘 → 清空 → 恢复', () => {
    start();
    const repo = new MemorySaveRepository();
    setSavePort(repo);
    attachWorldEventLog();
    worldBus.beginTick();
    worldBus.emit(makeEvent({ type: 'reputation_changed', day: 1, level: 2, actor: 'player', target: 'empire' }));
    expect(worldEventLog.size(), '世界史记账').toBe(1);
    /* 测试注入的 scheduler 是同步的，所以节流写盘当场发生 */
    expect(repo.loadWorldLog()?.length, '节流已把世界史交给介质').toBe(1);

    /* 模拟重启：内存日志清空 → 从介质恢复 */
    const dumped = worldEventLog.dump();
    worldEventLog.clear();
    expect(worldEventLog.size()).toBe(0);
    worldEventLog.restore(dumped);
    expect(worldEventLog.size()).toBe(1);
    expect(worldEventLog.recent(1)[0].type).toBe('reputation_changed');
  });

  it('节流旗标在重置后复位，世界史仍能继续落盘（二期审查 C2）', () => {
    start();
    const repo = new MemorySaveRepository();
    setSavePort(repo);
    attachWorldEventLog();
    worldBus.beginTick();
    worldBus.emit(makeEvent({ type: 'reputation_changed', day: 1, level: 2, actor: 'player', target: 'empire' }));
    expect(repo.loadWorldLog()?.length).toBe(1);

    /* 模拟 resetWorld：清世界史 + 复位节流旗标。
       旗标不复位的话，scheduler.cancelAll() 之后的排程会一直被短路——
       本会话内世界史静默不再落盘。 */
    worldEventLog.clear();
    cancelWorldLogPersist();
    restoreWorldLog([]);
    worldBus.beginTick();
    worldBus.emit(makeEvent({ type: 'reputation_changed', day: 1, level: 2, actor: 'player', target: 'empire' }));
    expect(repo.loadWorldLog()?.length, '复位后仍能落盘').toBe(1);
  });

  it('上限不变：恢复时只留最后 500 条', () => {
    start();
    const many = Array.from({ length: 520 }, (_, i) => makeEvent({ type: 'npc_moved', day: 1, level: 1, actor: 'npc' + i }));
    worldEventLog.restore(many);
    expect(worldEventLog.size()).toBe(500);
  });
});

describe('§8/§36 · 感知持久化与调查', () => {
  const witnessed = (witnesses: string[] = ['lita'], day = 1) => {
    const e = makeEvent({ type: 'crime_committed', day, level: 2, actor: 'player', target: 'theft', location: 'plaza', witnesses });
    const restore = rng.inject(() => 0.99); // 除显式目击者外无人察觉
    registerPerception(e, core.S!);
    restore();
    return e;
  };

  it('感知表随存档持久化：导出 → 新局 → 导入后依然知道', () => {
    start();
    const e = witnessed();
    const json = JSON.stringify(core.S);
    resetWorld();
    newGame({ name: '另一个人', race: 'dwarf', cls: 'warrior' });
    expect(perception.size('lita'), '新局不应继承旧认知').toBe(0);
    expect(importState(json)).toBe(true);
    expect(perception.size('lita')).toBe(1);
    expect(knownBy('lita')[0].eventId).toBe(e.id);
  });

  it('旧档缺感知表 / 案件表时 hydrate 补默认，不崩', () => {
    start();
    const raw = JSON.parse(JSON.stringify(core.S)) as Record<string, unknown>;
    delete raw.knowledge;
    delete raw.cases;
    resetWorld();
    expect(importState(JSON.stringify(raw))).toBe(true);
    expect(perception.size()).toBe(0);
    expect(caseView().rows).toEqual([]);
  });

  it('有人目击才立得了案；重复立案幂等（§8 信息不对称）', () => {
    start();
    const e = witnessed(['lita']);
    const c = openCase(e, 'empire');
    expect(c).not.toBeNull();
    expect(c!.evidence).toContain('lita');
    expect(c!.subject).toBe('player');
    expect(c!.status).toBe('open');
    expect(openCase(e, 'empire'), '同一事件不重复立案').toBeNull();

    const unseen = makeEvent({ type: 'crime_committed', day: 3, level: 2, actor: 'player', target: 'theft', location: 'plaza' });
    expect(openCase(unseen), '没人看见就没有案子').toBeNull();
  });

  it('取证推进 → 结案：通缉上升、立案势力敌意', () => {
    start();
    const e = witnessed(['lita', 'otto']);
    openCase(e, 'empire');
    const wanted0 = core.S!.player.wanted;
    const rep0 = core.S!.rep.empire;
    const restore = rng.inject(() => 0);
    for (let i = 0; i < 10; i++) investigationTick(core.S!);
    restore();
    const row = caseView().rows[0];
    expect(row.status).toBe('concluded');
    expect(row.progress).toBe(100);
    expect(core.S!.player.wanted).toBeGreaterThan(wanted0);
    expect(core.S!.rep.empire).toBeLessThan(rep0);
  });

  it('推演 → 校验 → 执行 → 立案：全链闭环（§17/§47）', async () => {
    start();
    registerCoreSystems();
    attachWorldEventLog();
    const e = makeEvent({ type: 'character_died', day: 1, level: 2, actor: 'player', target: 'bandit', location: 'plaza', witnesses: ['lita'] });
    const restore = rng.inject(() => 0.99);
    registerPerception(e, core.S!);
    restore();
    worldBus.emit(e); // 进世界史，Executor 才能按 triggerEvent 回查

    /* 组合根同款接线：把 start_investigation 后果交给调查系统 */
    worldExecutor.registerHandler('start_investigation', (a, plan) => {
      const ev = worldEventLog.byId(plan.triggerEvent);
      if (ev) openCase(ev, a.actor ?? 'empire');
    });

    /* L2 命案不进 World Reasoner（§12 分级门槛），但规则推演器对它同样有依据可循：
       这里直接走「计划 → 校验 → 执行」，验证执行器与调查系统的接线。 */
    const plan = ruleReasoner.reason(buildContext(e));
    expect(plan).not.toBeNull();
    const res = worldExecutor.execute(plan);
    setReasonerPort(null);

    expect(res.executed).toBe(1);
    expect(caseView().open).toBe(1);
    expect(caseView().rows[0].evidence).toContain('lita');
    expect(caseView().rows[0].subject).toBe('player');
  });

  it('L3 事件走完整推演通道：abyss_breach → 上下文 → 推演 → 校验 → 执行', async () => {
    start();
    registerCoreSystems();
    const ran: string[] = [];
    worldExecutor.registerHandler('change_reputation', () => ran.push('rep'));
    setReasonerPort(ruleReasoner);
    const e = makeEvent({ type: 'abyss_breach', day: 1, level: 3, location: 'plaza', cause: 'leak_crisis' });
    const res = await reasonAbout(e);
    setReasonerPort(null);
    expect(res).not.toBeNull();
    expect(res!.executed).toBeGreaterThan(0);
    expect(ran.length).toBe(res!.executed);
  });

  it('无人目击的命案推演得出计划，但执行后仍无案可立（信息不对称穿透全链）', async () => {
    start();
    registerCoreSystems();
    const e = makeEvent({ type: 'character_died', day: 1, level: 2, actor: 'player', target: 'bandit', location: 'plaza' });
    worldExecutor.registerHandler('start_investigation', (a, plan) => {
      const ev = worldEventLog.byId(plan.triggerEvent);
      if (ev) openCase(ev, a.actor ?? 'empire');
    });
    setReasonerPort(ruleReasoner);
    const res = await reasonAbout(e);
    setReasonerPort(null);
    /* 规则推演本身会因无目击者而不产出立案后果 */
    expect(res).toBeNull();
    expect(caseView().open).toBe(0);
  });
});

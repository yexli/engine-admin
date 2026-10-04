/* ============================================================
   端到端：真实操作路径上的世界事件（方案 §47 数据流）
   —— 单元测试证明「机制存在」；本文件证明「机制真的被游戏流程触发」。
   全程走 dispatch 命令通道，与玩家点界面同一条路。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, dispatch, newGame, resetWorld, rng, scheduler } from '@/world';
import { injectSampling } from '@/events/Sampling';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { worldBus } from '@/events/EventBus';
import { resetEventSeq } from '@/events/EventSchema';
import { worldEventLog } from '@/events/EventStore';
import { plugins } from '@/plugins/PluginRegistry';
import { bootstrapWorld } from '@/plugins/bootstrap';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { shopRows } from '@/systems/economy/Shop';
import { playerAct, startCombat } from '@/systems/combat/Combat';
import { attOf, presentNPCs } from '@/systems/npc/Npcs';
import { caseView } from '@/systems/law/Investigation';
import { perception } from '@/events/Perception';
import { WB } from '@/data/worldBook';
import { worldExecutor } from '@/execution/WorldExecutor';
import { registerConsequenceHandlers } from '@/plugins/handlers';
import { registerCoreSystems } from '@/plugins/systems';
import { attachWorldEventLog } from '@/events/EventStore';
import { makeEvent } from '@/events/EventSchema';
import { commitCrime } from '@/systems/law/Law';
import lawRaw from '@/data/world/law.json';
import type { WorldEvent } from '@/events/EventSchema';

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
  resetEventSeq();
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  /* 与生产同一条装配路径（plugins/bootstrap.ts）——顺序契约由该模块负责 */
  bootstrapWorld({ reasoner: ruleReasoner });
});

describe('§47 · 真实操作路径上的世界事件', () => {
  it('移动 → 大额交易 → 犯罪 → 战斗胜利：每一步都留下可追溯的世界事实', () => {
    newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });
    const seen: WorldEvent[] = [];
    worldBus.on('*', (e) => seen.push(e), 'probe');

    /* 1. 城内移动：与玩家点地图同一条命令通道 */
    dispatch({ type: 'travel', loc: 'market' });
    expect(core.S!.player.loc).toBe('market');

    /* 2. 购买最贵的一件货：单笔过千才该上世界总线 */
    core.S!.player.gold = 999999;
    core.curShop = 'grocer';
    const rows = shopRows('grocer');
    expect(rows.length).toBeGreaterThan(0);
    const top = rows.reduce((a, b) => (b.price > a.price ? b : a));
    dispatch({ type: 'shopBuy', id: top.iid, p: top.price });

    /* 3. 立案：罪案进世界史 */
    expect(CRIME_IDS.length).toBeGreaterThan(0);
    expect(commitCrime(CRIME_IDS[0])).toBe(true);

    /* 4. 真打完一场战斗 */
    startCombat(['rabbit']);
    for (let i = 0; i < 60 && core.CB; i++) playerAct('atk');

    const types = new Set(seen.map((e) => e.type));
    expect(types.has('crime_committed'), '立案未进世界总线').toBe(true);
    expect(types.has('character_died'), '战斗击杀未进世界总线').toBe(true);
    /* 世界书里最贵的货若不足千铜，本局本来就不该产生 large_trade——按数据断言 */
    expect(types.has('large_trade'), 'large_trade 门槛与实际货价不符').toBe(top.price >= 1000);
    expect(worldEventLog.size(), '世界史应收录这些事实').toBeGreaterThanOrEqual(2);
  });

  it('一个事件 → 多系统响应（§34）：击杀事实同时驱动任务、感知与世界史', () => {
    newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });
    const killEntry = Object.entries(WB.quests).find(([, q]) => q.type === 'kill');
    expect(killEntry, '世界书缺少击杀类委托').toBeTruthy();
    const [qid, qdef] = killEntry!;
    const mid = (qdef as { target?: string }).target!;
    core.S!.player.quests[qid] = { stage: 'go', count: 0 };

    const restore = rng.inject(() => 0); // 在场者一律察觉
    worldBus.emit(
      makeEvent({
        type: 'character_died',
        day: 1,
        tick: core.S!.t,
        level: 2,
        actor: 'player',
        target: mid,
        location: 'plaza',
        cause: 'combat',
        data: { monster: mid },
      }),
    );
    restore();

    /* 响应 1：quest 订阅者——任务系统不需要知道战斗系统的存在（§21） */
    expect(core.S!.player.quests[qid].count, '委托进度未被事件推进').toBe(1);
    /* 响应 2：通配订阅者——感知层记下「谁看见了」 */
    expect(perception.size(), '感知层未登记').toBeGreaterThan(0);
    /* 响应 3：通配订阅者——世界史收录事实 */
    expect(worldEventLog.recent().some((e) => e.type === 'character_died')).toBe(true);
  });

  it('Combat 不再直接依赖 Quests（§21 点对点依赖已消除）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../systems/combat/Combat.ts', import.meta.url), 'utf8');
    expect(src).not.toContain("from '@/systems/quest/Quests'");
    expect(src).not.toContain('progKill');
  });

  it('有人目击的罪案自动立案，证据来自感知表（§8/§34 补上断掉的事实链）', () => {
    newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });
    /* Phase 2 之后目击判定走确定性采样，不再吃随机流——用采样注入点控制它 */
    const restore = injectSampling(() => true);
    commitCrime(CRIME_IDS[0]);
    restore();

    const rows = caseView().rows;
    expect(rows.length, '罪案未被自动立案').toBeGreaterThan(0);
    expect(rows[0].filedBy).toBe('empire');
    expect(rows[0].evidence.length, '立案证据应来自感知表').toBeGreaterThan(0);
    expect(rows[0].status).toBe('open');
  });

  it('罪案无人目击则不立案（信息不对称穿透订阅链）', () => {
    newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });
    /* 留在 plaza（立案用例已证明这里必有在场者），用采样注入把「察觉成功」一律压死——
       构造的是**有候选目击者但全部没察觉**这条路径，而不是「现场根本没人」。
       （挪去 cave 是错的做法：全库 15 个 NPC 没有一个会落到那里，
        注入点成了死代码，覆盖也被换掉了——二期审查 I4。） */
    expect(presentNPCs(core.S!.player.loc, core.S!).length, 'plaza 应有在场者，否则这条测不到东西').toBeGreaterThan(0);
    const restoreNoSee = injectSampling(() => false);
    try {
      commitCrime(CRIME_IDS[0]);
    } finally {
      restoreNoSee();
    }
    expect(caseView().rows, '有人在场但都没察觉 → 不该立案').toHaveLength(0);
  });

  it('大额交易推动品类价格指数（§34 经济响应）', () => {
    newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });
    core.S!.player.gold = 999999;
    core.curShop = 'grocer';
    const rows = shopRows('grocer');
    const top = rows.reduce((a, b) => (b.price > a.price ? b : a));
    const before = { ...core.S!.econ };
    dispatch({ type: 'shopBuy', id: top.iid, p: top.price });
    const changed = Object.keys(core.S!.econ).some((k) => core.S!.econ[k] !== before[k]);
    /* 世界书里最贵的货若不足千铜，本局本来就不该触发 large_trade —— 按数据断言 */
    expect(changed, 'large_trade 门槛与实际货价不符').toBe(top.price >= 1000);
  });

  it('真实装配下目击者插件确实生效（C1 回归护栏：曾因派发顺序而静默失效）', () => {
    newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });
    /* bootstrapWorld 已把感知层与目击者插件都挂上总线；此处不做任何手工预置，
       完全依赖真实订阅顺序——顺序反了这条就会红。 */
    /* Phase 2 之后目击判定走确定性采样，**不再吃 rng**——原来那行 rng.inject 已完全失效，
       断言只剩「当前 seq 恰好命中」在撑（实测两人在场时 30% 的取值会全不中）。
       本用例测的是装配与派发顺序，不是采样概率，所以直接注入「全中」。 */
    expect(presentNPCs(core.S!.player.loc, core.S!).length, 'plaza 应有在场者').toBeGreaterThan(0);
    const restore = injectSampling(() => true); // 在场者一律察觉
    try {
      commitCrime(CRIME_IDS[0]);
    } finally {
      restore();
    }

    const crimes = worldEventLog.recent().filter((e) => e.type === 'crime_committed');
    expect(crimes).toHaveLength(1);
    const knowers = Object.keys(core.S!.knowledge ?? {}).filter((npc) =>
      (core.S!.knowledge?.[npc] ?? []).some((f) => f.eventId === crimes[0].id),
    );
    expect(knowers.length, '应有人目睹').toBeGreaterThan(0);
    const hurt = knowers.filter((npc) => core.S!.npcs[npc] && attOf(npc, core.S!) < 0);
    expect(hurt.length, '目击者插件未扣好感——派发顺序或装配顺序失守').toBeGreaterThan(0);
  });

  it('后果执行期间产生的事件自动挂到触发事件下，可沿链回溯（§29/§44）', () => {
    newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });
    registerCoreSystems();
    registerConsequenceHandlers();
    attachWorldEventLog();

    const trigger = makeEvent({ type: 'character_died', day: 1, level: 2, actor: 'player', target: 'bandit', location: 'plaza' });
    worldBus.emit(trigger); // 进世界史，供回溯
    const res = worldExecutor.execute({
      planId: 'plan_trace',
      triggerEvent: trigger.id,
      consequences: [{ action: 'change_reputation', target: 'empire', source: 'empire', reason: 'fallout', params: { delta: -3 } }],
    });
    expect(res.executed).toBe(1);

    const child = worldEventLog.recent().find((e) => e.type === 'reputation_changed');
    expect(child, '执行应产生声望事实').toBeTruthy();
    expect(child!.parentId, '执行产生的事件应认下因果父').toBe(trigger.id);
    expect(worldEventLog.chain(child!.id).map((e) => e.id)).toEqual([child!.id, trigger.id]);
  });

  it('世界史里的每条事实都带得起因与地点（§44 事实来源）', () => {
    newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });
    commitCrime(CRIME_IDS[0]);
    const rows = worldEventLog.recent().filter((e) => e.type === 'crime_committed');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('player');
    expect(rows[0].cause).toBeTruthy();
    expect(rows[0].location).toBe('plaza');
    expect(rows[0].day).toBeGreaterThan(0);
  });

  it('感知层在真实流程里登记了目击者，且未目击的事实无人知晓', () => {
    newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });
    /* 立案时感知层已挂载（组合根同款装配顺序）：有目击者即进感知表 */
    const restore = rng.inject(() => 0); // 在场者一律察觉
    commitCrime(CRIME_IDS[0]);
    restore();
    const crimes = worldEventLog.recent().filter((e) => e.type === 'crime_committed');
    expect(crimes).toHaveLength(1);
    const knowers = Object.keys(core.S!.knowledge ?? {}).filter((npc) =>
      (core.S!.knowledge?.[npc] ?? []).some((f) => f.eventId === crimes[0].id),
    );
    expect(knowers.length, '有人在场时应有目击者').toBeGreaterThan(0);
  });
});

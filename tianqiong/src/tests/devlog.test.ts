/* ============================================================
   运行日志（开发观测）验收
   —— 只读通道：能记、能滤、能导出、关掉零成本，且不影响世界判定。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { worldBus } from '@/events/EventBus';
import { makeEvent, resetEventSeq } from '@/events/EventSchema';
import { resetRunLog, runLog, setRunLogSnapshot, type RunChan, type RunEntry } from '@/devlog/RunLog';
import { filterRunEntries } from '@/devlog/RunLogFilter';
import { attachRunLog, shrink } from '@/plugins/runlog';
import { registerCoreSystems } from '@/plugins/systems';
import { registerConsequenceHandlers } from '@/plugins/handlers';
import { plugins } from '@/plugins/PluginRegistry';
import { worldExecutor } from '@/execution/WorldExecutor';
import { validatePlan } from '@/validation/RuleValidator';
import { startCombat, playerAct } from '@/systems/combat/Combat';
import { memoryEngine } from '@/memory/MemoryEngine';
import { mutate } from '@/world/WorldMutate';

const start = () => newGame({ name: '观测者', race: 'dwarf', cls: 'warrior' });

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
  resetRunLog();
  runLog.enable(true);
});

afterEach(() => {
  runLog.enable(false);
  resetRunLog();
});

describe('运行日志 · 缓冲与开关', () => {
  it('环形缓冲封顶：写 1200 条只留 1000，丢的条数单独计数', () => {
    for (let i = 0; i < 1200; i++) runLog.info('perf', 'n' + i);
    const st = runLog.stats();
    expect(st.total).toBe(1200);
    expect(st.kept).toBe(1000);
    expect(st.dropped).toBe(200);
    const kept = runLog.entries();
    expect(kept[0].msg, '最旧的先滚出去').toBe('n200');
    expect(kept.at(-1)!.msg).toBe('n1199');
  });

  it('关闭后一条不记（观测通道不能给运行中的世界加成本）', () => {
    runLog.enable(false);
    runLog.info('event', '不该出现');
    expect(runLog.stats().total).toBe(0);
    expect(runLog.enabled).toBe(false);
  });

  it('通道与级别各自计数；clear 清空视图但保留累计写入数', () => {
    runLog.debug('event', 'a');
    runLog.warn('event', 'b');
    runLog.error('ai', 'c');
    const st = runLog.stats();
    expect(st.byChan.event).toBe(2);
    expect(st.byChan.ai).toBe(1);
    expect(st.byLvl.warn).toBe(1);
    expect(st.byLvl.error).toBe(1);

    runLog.clear();
    const after = runLog.stats();
    expect(runLog.entries(), '缓冲清空').toHaveLength(0);
    expect(after.kept).toBe(0);
    expect(after.total, '累计写入数不归零——否则「丢了多少」无从判断').toBe(3);
    expect(after.byChan.event, '通道计数属于视图，随清空一起归零').toBeUndefined();
  });

  it('订阅能收到新条目，退订后不再收到；观察者抛错不影响写入', () => {
    const got: string[] = [];
    const off = runLog.subscribe((e) => {
      if (e) got.push(e.msg);
    });
    runLog.subscribe(() => {
      throw new Error('观察者自己炸了');
    });
    runLog.info('boot', '第一条');
    off();
    runLog.info('boot', '第二条');
    expect(got).toEqual(['第一条']);
    expect(runLog.stats().total, '观察者抛错不该回滚写入').toBe(2);
  });

  it('清空会通知订阅者（传 null），seq 不归零——持旧游标的消费者不会静默停摆', () => {
    let cleared = 0;
    const off = runLog.subscribe((e) => {
      if (e === null) cleared++;
    });
    runLog.info('boot', 'a');
    const cursor = runLog.entries()[0].seq;
    runLog.clear();
    expect(cleared, '清空要通知').toBe(1);
    runLog.info('boot', 'b');
    expect(runLog.since(cursor).map((e) => e.msg), '清空之后仍能增量取到新条目').toEqual(['b']);
    off();
  });

  it('计时器跨关闭边界：创建后才关日志，收尾也不写', () => {
    const done = runLog.timer('exec', '长命计时');
    runLog.enable(false);
    const ms = done();
    expect(ms).toBeGreaterThanOrEqual(0);
    runLog.enable(true);
    expect(runLog.entries().filter((e) => e.chan === 'perf'), '关闭期间的收尾不该落进缓冲').toHaveLength(0);
  });

  it('观察者抛错不影响世界判定：坏掉的快照注入也只是少一个字段', () => {
    plugins.clear();
    worldExecutor.clear();
    registerCoreSystems();
    registerConsequenceHandlers();
    start();
    /* 注入一个会抛的世界快照：日志侧必须自己吞掉，绝不能冒泡进事件派发链 */
    setRunLogSnapshot(() => {
      throw new Error('快照炸了');
    });
    let threw = false;
    try {
      worldBus.emit(makeEvent({ type: 'npc_moved', day: 1, level: 1 }));
    } catch {
      threw = true;
    }
    expect(threw, '总线上不该看到异常').toBe(false);
    const res = worldExecutor.execute({
      planId: 'p',
      triggerEvent: 'evt_1_1',
      consequences: [{ action: 'grant_title', target: 'player', reason: '试', params: { title: 't' } }],
    });
    expect(res.executed, '执行照常').toBe(1);
    setRunLogSnapshot(() => null);
  });

  it('since(cursor) 只回游标之后的条目（面板增量取用）', () => {
    runLog.info('boot', 'a');
    runLog.info('boot', 'b');
    const cursor = runLog.entries()[0].seq;
    expect(runLog.since(cursor).map((e) => e.msg)).toEqual(['b']);
  });

  it('导出成可解析的 JSON，带统计与全部条目', () => {
    runLog.warn('save', '写盘失败', { m: 'quota' });
    const doc = JSON.parse(runLog.exportJson()) as { stats: { total: number }; entries: { msg: string; data?: Record<string, unknown> }[] };
    expect(doc.stats.total).toBe(1);
    expect(doc.entries[0].msg).toBe('写盘失败');
    expect(doc.entries[0].data).toEqual({ m: 'quota' });
  });

  it('计时器在启用时记录耗时，关闭时返回空函数且不留痕', () => {
    const done = runLog.timer('perf', '某段耗时');
    const ms = done({ what: 'test' });
    expect(ms).toBeGreaterThanOrEqual(0);
    const perf = runLog.entries().filter((e) => e.chan === 'perf');
    expect(perf).toHaveLength(1);
    expect(perf[0].data?.ms).toBeTypeOf('number');

    runLog.enable(false);
    const noop = runLog.timer('perf', '不该记');
    noop();
    expect(runLog.stats().total, '关闭后计时器也不写').toBe(1);
  });
});

describe('运行日志 · 面板筛选（纯函数）', () => {
  const rows: RunEntry[] = [
    { seq: 1, at: 1, wall: 1, chan: 'event', lvl: 'info', msg: 'crime_committed', data: { actor: 'player' } },
    { seq: 2, at: 2, wall: 2, chan: 'ai', lvl: 'warn', msg: '推演落地', data: { plan: 'p1' } },
    { seq: 3, at: 3, wall: 3, chan: 'exec', lvl: 'debug', msg: '计划执行完成', data: { executed: 2 } },
    { seq: 4, at: 4, wall: 4, chan: 'error', lvl: 'error', msg: '未捕获异常', data: { line: 42 } },
  ];

  it('无条件时原样返回；按通道、级别、关键字逐层收敛', () => {
    expect(filterRunEntries(rows).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(filterRunEntries(rows, { chans: new Set<RunChan>(['ai', 'exec']) }).map((r) => r.seq)).toEqual([2, 3]);
    expect(filterRunEntries(rows, { minLvl: 'warn' }).map((r) => r.seq), 'warn 以上 = warn + error').toEqual([2, 4]);
    expect(filterRunEntries(rows, { q: 'player' }).map((r) => r.seq), '关键字也能搜载荷').toEqual([1]);
    expect(filterRunEntries(rows, { chans: new Set<RunChan>(), minLvl: 'debug', q: '  ' }).map((r) => r.seq), '空条件等于不过滤').toEqual([1, 2, 3, 4]);
  });

  it('多个条件是「与」的关系', () => {
    const hit = filterRunEntries(rows, { chans: new Set<RunChan>(['ai', 'exec']), minLvl: 'info', q: '落地' });
    expect(hit.map((r) => r.seq)).toEqual([2]);
  });
});

describe('运行日志 · 载荷收敛', () => {
  it('长字符串截断、容器只留形状，避免整份状态被灌进日志', () => {
    const s = shrink({
      short: 'ok',
      long: 'x'.repeat(400),
      arr: [1, 2, 3],
      obj: { a: 1 },
      n: 7,
      b: true,
      nil: null,
    });
    expect(s.short).toBe('ok');
    expect(String(s.long).length).toBeLessThan(140);
    expect(s.arr, '容器只留形状，但要与「恰好长这样的字符串」可分辨').toBe('{arr:3}');
    expect(s.obj).toBe('{obj:1}');
    expect(s.n).toBe(7);
    expect(s.b).toBe(true);
    expect('nil' in s).toBe(false);
  });
});

describe('运行日志 · 自动装配', () => {
  it('世界事件自动入日志（含级别、参与者、因果父与来源标记）', () => {
    const off = attachRunLog();
    start();
    try {
      worldBus.emit(
        makeEvent({
          type: 'character_died',
          day: 1,
          level: 2,
          actor: 'player',
          target: 'lita',
          location: 'plaza',
          cause: 'combat',
          parentId: 'evt_1_9',
          origin: 'reasoner',
        }),
      );
      const rows = runLog.entries().filter((e) => e.chan === 'event');
      expect(rows, '事件通道应有这条').toHaveLength(1);
      expect(rows[0].msg).toBe('character_died');
      expect(rows[0].lvl, 'L2 记 info').toBe('info');
      expect(rows[0].data?.actor).toBe('player');
      expect(rows[0].data?.parent).toBe('evt_1_9');
      expect(rows[0].data?.origin).toBe('reasoner');
      expect(rows[0].day, '写入时带上世界日快照').toBe(1);
    } finally {
      off();
    }
  });

  it('L3 事件记 warn（观测时一眼看出复杂世界事件）', () => {
    const off = attachRunLog();
    start();
    try {
      worldBus.emit(makeEvent({ type: 'city_at_war', day: 3, level: 3 }));
      expect(runLog.entries().find((e) => e.chan === 'event')?.lvl).toBe('warn');
    } finally {
      off();
    }
  });

  it('界面信号进日志：场景切换记 info、坏消息 toast 记 warn', () => {
    const off = attachRunLog();
    try {
      bus.emit({ type: 'screen', to: 'game' });
      bus.emit({ type: 'toast', text: '存档写入失败：x', cls: 'bad' });
      bus.emit({ type: 'changed' }); // 高频信号不该进日志
      const ui = runLog.entries().filter((e) => e.chan === 'ui');
      expect(ui.map((e) => e.lvl)).toEqual(['info', 'warn']);
      expect(ui[0].msg).toContain('屏幕切换');
    } finally {
      off();
    }
  });

  it('卸载后不再记录，且订阅者数量回到原样（观察者不能泄漏到下一次装配）', () => {
    const before = worldBus.stats().subscribers;
    const off = attachRunLog();
    expect(worldBus.stats().subscribers, '装配应当多一个订阅者').toBe(before + 1);
    off();
    expect(worldBus.stats().subscribers, '卸载后必须还原').toBe(before);
    start();
    worldBus.emit(makeEvent({ type: 'npc_moved', day: 1, level: 1 }));
    expect(runLog.entries().filter((e) => e.chan === 'event')).toHaveLength(0);
  });

  it('快照注入：没注入时不留日/刻，注入后有', () => {
    runLog.info('boot', '无快照');
    expect(runLog.entries()[0].day).toBeUndefined();
    setRunLogSnapshot(() => ({ day: 9, tick: 432 }));
    runLog.info('boot', '有快照');
    expect(runLog.entries()[1].day).toBe(9);
    expect(runLog.entries()[1].tick).toBe(432);
  });
});

describe('运行日志 · 关键路径插桩', () => {
  /* 战斗与记忆是补的两处盲区：前者按 §12 是 L0「不进总线」，后者是认知层。
     两条都不该因为「不上总线」就变成事后查不回来的东西。 */
  it('战斗过程进 combat 通道（L0 的伤害不进总线，但不该不可观测）', () => {
    start();
    startCombat(['rabbit']);
    expect(
      runLog.entries().some((e) => e.chan === 'combat' && e.msg === '战斗开始'),
      '开战要留痕',
    ).toBe(true);

    let guard = 0;
    while (core.CB && !core.CB.over && guard++ < 30) playerAct('atk');

    const rows = runLog.entries().filter((e) => e.chan === 'combat');
    const hits = rows.filter((e) => e.msg === '伤害');
    expect(hits.length, '每击一条').toBeGreaterThan(0);
    expect(hits[0].data, '要答得出「谁挨了多少、还剩多少」').toMatchObject({
      foe: expect.any(String),
      dmg: expect.any(Number),
      hp: expect.any(Number),
    });
    expect(hits[0].lvl, '伤害记 debug：面板可按通道过滤，不淹没 info').toBe('debug');
    expect(rows.some((e) => e.msg === '战斗胜利'), '收束也要留痕').toBe(true);
  });

  it('记忆写入与日边界生命周期进 memory 通道', () => {
    start();
    const s = core.S!;
    /* Phase 6：逐条衰减只对 L0/L1（相关/接触过）的 owner 生效，从未被投射的 NPC 只做归并。
       mia 世界书里有名有姓但本局没被投影过 → 先按规则手段立条目，别把断言放宽。 */
    mutate.npcMet('mia');
    memoryEngine.create({ ownerId: 'mia', type: 'conversation', content: '很久以前的一句闲话', source: 'conversation' }, s, 1);
    const wrote = runLog.entries().filter((e) => e.chan === 'memory');
    expect(wrote.some((e) => e.msg === '写入记忆')).toBe(true);
    expect(String(wrote[0].data?.body), '载荷要能读出正文，否则等于没记').toContain('闲话');

    runLog.clear();
    memoryEngine.tick(s, 400); // 推得足够远：这条低重要度记忆必然跌破遗忘阈值
    const ticked = runLog.entries().filter((e) => e.chan === 'memory');
    expect(
      ticked.some((e) => e.msg === '日边界生命周期' && Number(e.data?.forgotten) > 0),
      '遗忘发生时要留痕',
    ).toBe(true);
  });

  it('记忆提案被拒进 memory 通道的 warn（安全边界的现场）', () => {
    start();
    const r = memoryEngine.propose({ ownerId: 'nobody', type: 'rumor', content: 'x', source: 'rumor' }, core.S!, 1);
    expect(r.ok).toBe(false);
    const warn = runLog.entries().filter((e) => e.chan === 'memory' && e.lvl === 'warn');
    expect(warn, '「它想写什么、为什么被拒」要查得到').toHaveLength(1);
  });

  it('校验拒绝会留下原因（整份计划的拒绝对开发者最重要）', () => {
    plugins.clear();
    registerCoreSystems();
    start();
    const v = validatePlan({ planId: 'p', triggerEvent: 'e', consequences: [{ action: 'summon_dragon', reason: 'x' }] });
    expect(v.ok).toBe(false);
    const rows = runLog.entries().filter((e) => e.chan === 'valid');
    expect(rows).toHaveLength(1);
    expect(rows[0].lvl).toBe('warn');
    expect(String(rows[0].data?.why)).toContain('未注册');
  });

  it('白名单与执行器脱节时：验证放行、执行期告警，现场留在日志里', () => {
    plugins.clear();
    worldExecutor.clear();
    registerCoreSystems(); // 登记了能力（grant_title 在 effects 里），但没有注册任何处理器
    start();
    const res = worldExecutor.execute({
      planId: 'p1',
      triggerEvent: 'evt_1_1',
      consequences: [{ action: 'grant_title', target: 'player', reason: '试', params: { title: 't' } }],
    });
    expect(res.executed, '没有处理器 → 一条也没落地').toBe(0);
    expect(res.outcomes[0].ok).toBe(false);
    const rows = runLog.entries();
    const warn = rows.find((e) => e.chan === 'exec' && e.lvl === 'warn');
    expect(warn, '这条告警正是排查白名单脱节的入口').toBeDefined();
    expect(String(warn!.msg)).toContain('没有执行器');
    expect(rows.some((e) => e.chan === 'valid'), '验证阶段放行了，所以不该有 valid 记录').toBe(false);
  });

  it('拒绝与执行结果分别进 valid / exec 通道（两条都要能查）', () => {
    plugins.clear();
    worldExecutor.clear();
    registerCoreSystems();
    registerConsequenceHandlers();
    start();
    runLog.clear();
    worldExecutor.execute({ planId: 'p2', triggerEvent: 'evt_1_1', consequences: [{ action: 'nope', reason: 'x' }] });
    const rejected = runLog.entries();
    expect(rejected.some((e) => e.chan === 'valid' && e.lvl === 'warn'), '拒绝原因进 valid').toBe(true);
    expect(rejected.some((e) => e.chan === 'perf'), '耗时进 perf').toBe(true);

    runLog.clear();
    worldExecutor.execute({
      planId: 'p3',
      triggerEvent: 'evt_1_1',
      consequences: [{ action: 'grant_title', target: 'player', reason: '试', params: { title: 't' } }],
    });
    const done = runLog.entries();
    expect(done.some((e) => e.chan === 'exec' && e.lvl === 'info'), '执行完成进 exec').toBe(true);
    expect(String(done.find((e) => e.chan === 'exec')?.msg)).toContain('执行完成');
  });
});

/* ============================================================
   World Engine Adapter 缝合面测试（V0.2 · 工作项 V2.5，方案 §37）
   —— 天穹经 6 个重接文件运行在引擎上；这里钉住「缝合处」的行为：
     · 容器三槽位（core.S/CB/curShop）与引擎 holder 同一性
     · 历法标签注入（引擎时钟吃天穹月名/时辰名）
     · 事件分级/通道表注册（天穹世界观注册进引擎）
     · isNamedPerson（依赖世界书，留在天穹的部分）
     · 写入原语桥接（引擎通用原语 + 天穹 entryOf/stamp 钩子）
     · 查询面下沉（world.query 通用子集与引擎同源）
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler, sceneTime, timeStr } from '@/world';
import { need } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { world } from '@/world/WorldAPI';
import { SHARD_FIELDS } from '@/world/Shards';
import { WB } from '@/data/worldBook';
import { worldBus } from '@/events/EventBus';
import { levelOf, channelOf, makeEvent, isNamedPerson } from '@/events/EventSchema';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  core.curShop = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  worldBus.reset();
  rng.seed(7);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '缝合', race: 'human', cls: 'warrior' });
});

describe('容器缝合（引擎 holder ← 天穹 core）', () => {
  it('三槽位同一对象：need() 与 core.S 同源，CB/curShop 槽位可用', () => {
    const s = core.S!;
    expect(need()).toBe(s);
    core.CB = { foes: [], round: 1, ctx: {}, cds: {}, ward: 0, buff: 0, over: false, log: [] };
    expect(core.CB.round).toBe(1);
    core.curShop = 'grocer';
    expect(core.curShop).toBe('grocer');
  });
});

describe('历法标签注入（引擎时钟吃天穹历法）', () => {
  it('sceneTime 月名来自 WB.months，纪年起点 612', () => {
    const s = core.S!;
    s.t = 0;
    const t = sceneTime(s);
    expect(t.month).toBe(WB.months[0]);
    expect(t.year).toBe(612);
    expect(timeStr(s)).toBe(t.month + t.date + '日·' + WB.shichen[t.h] + '时');
  });
});

describe('事件分级/通道表注册（天穹世界观 → 引擎）', () => {
  it('注册表生效：节律 critical、日边界 L2、未知类型回落 L1/ambient', () => {
    expect(levelOf('new_day')).toBe(2);
    expect(levelOf('hour_advanced')).toBe(0);
    expect(levelOf('npc_moved')).toBe(1);
    expect(levelOf('引擎没见过的类型')).toBe(1);
    expect(channelOf(makeEvent({ type: 'new_day', day: 1 }))).toBe('critical');
    expect(channelOf(makeEvent({ type: 'npc_moved', day: 1 }))).toBe('ambient');
  });

  it('isNamedPerson 仍由世界书裁决（留在天穹的部分）', () => {
    const someNpc = Object.keys(WB.npcs)[0];
    expect(isNamedPerson(someNpc)).toBe(true);
    expect(isNamedPerson('no_such_npc_here')).toBe(false);
    expect(isNamedPerson(undefined)).toBe(false);
  });
});

describe('写入原语桥接（引擎通用原语 + 天穹钩子）', () => {
  it('pushLog 时间戳来自天穹历法（stamp 钩子），seq 单调', () => {
    const s = core.S!;
    mutate.pushLog('缝合测试');
    const last = s.log[s.log.length - 1];
    expect(last.t).toBe(timeStr(s));
    expect(last.cls).toBe('nar');
    expect(last.id).toBe(s.logSeq);
  });

  it('npcEntry 建档带世界书关系种子投影（entryOf 钩子）——经 npcAtt 旁路建档同样投影', () => {
    const s = core.S!;
    const withRels = Object.keys(WB.npcs).find((id) => Object.keys(WB.npcs[id].rels ?? {}).length > 0);
    if (withRels) {
      mutate.npcAtt(withRels, 5); // 旁路建档：不经 mutate.npcEntry 显式调用
      expect(s.npcs[withRels].rels).toBeDefined();
      expect(s.npcs[withRels].att).toBe(5);
    }
    mutate.npcMet(withRels ?? 'any_npc');
  });

  it('通用原语行为不变：playerBag 堆叠 / rep 夹取 / weaveLogs 保留玩家原话', () => {
    mutate.playerBag('herb', 2);
    mutate.playerBag('herb', 3);
    expect(core.S!.player.bag).toEqual([{ id: 'herb', qty: 5 }]);

    mutate.rep('empire', 999);
    expect(core.S!.rep['empire']).toBe(100);

    mutate.pushLog('规则原文', 'nar');
    mutate.pushLog('＞ 玩家原话', 'say');
    mutate.weaveLogs((core.S!.logSeq ?? 0) - 2, (core.S!.logSeq ?? 0) - 1, '织成的正文');
    expect(core.S!.log.slice(-2).map((e) => e.text)).toEqual(['织成的正文', '＞ 玩家原话']);
  });
});

describe('查询面下沉（world.query 通用子集与引擎同源）', () => {
  it('get_world_state/get_time 与天穹状态/时钟同源；引擎扩展查询在场', () => {
    expect(world.query.get_world_state()).toBe(core.S);
    const t = world.query.get_time()!;
    expect(t.month).toBe(sceneTime().month);
    expect(t.tick).toBe(core.S!.t);
    /* 引擎查询面新增项（与 createWorld 门面同名，SDK 演进的一致性凭据） */
    expect(typeof world.query.get_entities).toBe('function');
    expect(typeof world.query.get_log).toBe('function');
    expect(world.query.get_log(1).length).toBeLessThanOrEqual(1);
  });
});

describe('分片字段表（天穹分片世界观声明完整）', () => {
  it('五张增长表齐全且空值形状正确', () => {
    const names = SHARD_FIELDS.map(([f]) => f);
    expect(names).toEqual(['npcs', 'memories', 'beliefs', 'knowledge', 'cases']);
    for (const [, empty] of SHARD_FIELDS) {
      const v = empty();
      expect(typeof v === 'object' && v !== null).toBe(true);
    }
  });
});

/* ============================================================
   规模化 Phase 6 · 记忆分级（关注度 LOD）验收
   —— 《剩余工作实施方案》§2：三层判据各一条 + 连续 7 天处理次数 7/3/1 + L2 只归并不衰减。
   为什么单独成文件：memory-engine.test.ts 覆盖的是衰减与归并的**语义**，
   本文件覆盖的是「多久跑一次」的**调度**。混在一起，调度细节一旦变化
   就会被误读成语义回归。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { core, newGame, resetWorld, rng, scheduler, bus } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { worldBus } from '@/events/EventBus';
import { WB } from '@/data/worldBook';
import { hydrate } from '@/world/WorldState';
import { LOD_PERIOD, memoryEngine, memoryLodOf, memoryTick, memoriesOf } from '@/memory';
import { validateState } from '@/validation/RuleValidator';
import type { Memory, WorldState } from '@/types/world';

/* 三个世界书里真实存在的 NPC：分层只认「世界书有条目」+「有没有 NpcDynamic」 */
const NPC_L0 = 'lita';
const NPC_L1 = 'galon';
const NPC_L2 = 'selina';
/* 世界书里不存在的 owner（势力）：形状与 NPC 不同，判据必须放行成每天处理 */
const FACTION = 'empire';

const start = () => newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  worldBus.reset();
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

/* ---------------- 探针 ----------------
   调度是「有没有跑」这件事，不看结果。所以用**可观测副产物**当探针：
   4 条同类型、低重要度、已过保护期的 active 记忆 —— 本轮若被处理，
   compress 一定会把它们压成一条摘要并转 archived；没被处理则原样躺平。 */

function makeProbe(ownerId: string, i: number): Memory {
  return {
    id: ownerId + '_probe_' + i,
    ownerId,
    type: 'observation',
    content: '探针记忆 ' + i,
    source: 'direct_observation',
    confidence: 1,
    importance: 0.1,
    createdAt: 0,
    lastUpdatedAt: 0,
    recalledCount: 0,
    /* 衰减率拉满：只要被衰减扫到，这条必跌破遗忘阈值（下面「不衰减」用例用它） */
    decayRate: 1,
    visibility: 'private',
    status: 'active',
  };
}

function resetProbe(s: WorldState, ownerId: string): void {
  s.memories![ownerId] = [0, 1, 2, 3].map((i) => makeProbe(ownerId, i));
}

/** 跑一天，返回「该 owner 本轮是否被处理」 */
function ticked(s: WorldState, ownerId: string, day: number): boolean {
  resetProbe(s, ownerId);
  memoryTick(s, day);
  return (s.memories?.[ownerId] ?? []).some((m) => m.status === 'archived');
}

function countOver7Days(s: WorldState, ownerId: string, firstDay: number): number {
  let n = 0;
  for (let d = firstDay; d < firstDay + 7; d++) if (ticked(s, ownerId, d)) n++;
  return n;
}

/** 三层的运行时分身：L0 有相关度、L1 只有条目、L2 连条目都没有 */
function seedLads(s: WorldState): void {
  s.npcs = {};
  s.npcs[NPC_L0] = { att: 30, mem: [], met: true };
  s.npcs[NPC_L1] = { att: 0, mem: [], met: false };
  delete s.npcs[NPC_L2];
}

describe('Phase 6 · 关注度分层判据', () => {
  it('三层判据：有任何关联 → L0；只有条目 → L1；没条目 → L2', () => {
    start();
    const s = core.S!;
    seedLads(s);
    expect(memoryLodOf(NPC_L0, s), '好感不为 0 = 有关系的活人').toBe('L0');
    expect(memoryLodOf(NPC_L1, s), '见过一面但还没立起关系').toBe('L1');
    expect(memoryLodOf(NPC_L2, s), '从未被投影：世界书里有名有姓，但玩家没碰过').toBe('L2');
  });

  it('met 与当天交互同样抬到 L0（不看距离，只看关联度）', () => {
    start();
    const s = core.S!;
    seedLads(s);
    s.npcs[NPC_L1] = { att: 0, mem: [], met: true };
    expect(memoryLodOf(NPC_L1, s)).toBe('L0');
    s.npcs[NPC_L1] = { att: 0, mem: [], met: false, chatDay: { day: 42, gain: 1 } };
    expect(memoryLodOf(NPC_L1, s, 42), '当天刚聊过，不该在当天被降级').toBe('L0');
    expect(memoryLodOf(NPC_L1, s, 43), '隔天回落：聊天只说明「当天相关」').toBe('L1');
  });

  it('非 NPC 的 owner（势力/玩家）按最保守的 L0 处理：分级只该省随 NPC 增长的成本', () => {
    start();
    const s = core.S!;
    expect(memoryLodOf(FACTION, s)).toBe('L0');
  });

  it('周期表就是契约：1 / 3 / 7', () => {
    expect(LOD_PERIOD).toEqual({ L0: 1, L1: 3, L2: 7 });
  });
});

describe('Phase 6 · 分频调度', () => {
  it('连续 7 天：L0 处理 7 次 / L1 处理 3 次 / L2 处理 1 次', () => {
    start();
    const s = core.S!;
    seedLads(s);
    expect(countOver7Days(s, NPC_L0, 10), '相关的人：每天').toBe(7);
    expect(countOver7Days(s, NPC_L1, 10), '接触过：第 1、4、7 天').toBe(3);
    expect(countOver7Days(s, NPC_L2, 10), '从未接触：只在第 1 天').toBe(1);
  });

  it('记账随档：处理日写进 state，读档后节奏不重置', () => {
    start();
    const s = core.S!;
    seedLads(s);
    ticked(s, NPC_L1, 10);
    expect(s.memTickAt?.[NPC_L1]).toBe(10);
    ticked(s, NPC_L1, 11);
    expect(s.memTickAt?.[NPC_L1], '没到点就不改记账——否则周期会被自己的空跑推后').toBe(10);
    ticked(s, NPC_L1, 13);
    expect(s.memTickAt?.[NPC_L1]).toBe(13);
  });

  it('旧档没有记账表 → 补空表，第一次日边界照旧全量跑一遍（行为与改造前一致）', () => {
    const legacy = { ver: 1, player: { name: '旧档', gold: 1 } } as unknown as WorldState;
    delete legacy.memTickAt;
    hydrate(legacy);
    expect(legacy.memTickAt).toEqual({});
  });

  it('清空某 owner 的记忆时记账一起清：否则新记忆要白等一个周期才第一次归并', () => {
    start();
    const s = core.S!;
    s.npcs = {};
    memoriesOf(NPC_L2, s).push(makeProbe(NPC_L2, 1));
    memoryTick(s, 10);
    expect(s.memTickAt?.[NPC_L2]).toBe(10);

    memoryEngine.clear(s, NPC_L2);
    expect(s.memTickAt?.[NPC_L2], '记账不能比记忆活得久').toBeUndefined();

    for (const i of [2, 3, 4]) memoriesOf(NPC_L2, s).push(makeProbe(NPC_L2, i));
    memoryTick(s, 11);
    expect((s.memories?.[NPC_L2] ?? []).some((m) => m.status === 'archived'), '重新有记忆当天就该被处理').toBe(true);
  });

  it('记账表过校验闸：合法空表放行，脏值拒绝（存在即校验，缺失放行）', () => {
    const base = { ver: 1, player: { name: '合法' } };
    expect(validateState({ ...base })).toBeNull();
    expect(validateState({ ...base, memTickAt: {} })).toBeNull();
    expect(validateState({ ...base, memTickAt: { lita: 12 } })).toBeNull();
    expect(validateState({ ...base, memTickAt: { lita: '昨天' } })).toBe('记忆记账表非法');
  });
});

describe('Phase 6 · L2 只归并、不逐条衰减', () => {
  it('未接触 NPC 的细碎记忆不会被衰减扫掉（它只被归纳成摘要）', () => {
    start();
    const s = core.S!;
    seedLads(s);
    const list = memoriesOf(NPC_L2, s);
    const m = makeProbe(NPC_L2, 9);
    list.push(m); // 单条：够不上归并的 3 条门槛，只剩「衰减会不会碰它」这一个变量
    for (let d = 10; d < 17; d++) memoryTick(s, d);
    expect(m.status, 'L2 不跑逐条衰减：强度再低也不落 forgotten').toBe('active');
  });

  it('对照组：同样的记忆挂在 L0 名下，第一天就被遗忘', () => {
    start();
    const s = core.S!;
    seedLads(s);
    const list = memoriesOf(NPC_L0, s);
    const m = makeProbe(NPC_L0, 9);
    list.push(m);
    memoryTick(s, 10);
    expect(m.status).toBe('forgotten');
  });
});

describe('Phase 6 · 成本解耦（量级证明）', () => {
  it('15 个未接触 NPC：改造前每天扫 15 个 owner，改造后一周只扫 15 次', () => {
    start();
    const s = core.S!;
    const owners: string[] = Object.keys(WB.npcs);
    s.npcs = {};
    s.memories = {};
    for (const id of owners) resetProbe(s, id);
    const days: number[] = [];
    for (let d = 10; d < 17; d++) {
      memoryTick(s, d);
      days.push(owners.filter((id) => (s.memTickAt?.[id] ?? -1) === d).length);
    }
    expect(days[0], '首日：全体到点（与改造前一致）').toBe(owners.length);
    expect(days.slice(1).reduce((a, b) => a + b, 0), '此后 6 天：没有任何一个到点').toBe(0);
  });
});


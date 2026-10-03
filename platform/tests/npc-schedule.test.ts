/* ============================================================
   NPC Schedule Runtime 测试（方案 V2.1 §九：确定性行为归
   World Time + Schedule + Rules；AI 不参与日程）
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { applyNpcSchedule, type NpcScheduleTable } from '../src/npc/schedule.ts';
import type { EngineClient } from '../src/types.ts';

/* 引擎客户端桩：记录发出的命令，状态可编程 */
function stubEngine(state: unknown, results: Array<{ ok: true; result: { ok: boolean; events: string[]; reason?: string } } | { ok: false; status: number; error: string }> = []) {
  const commands: unknown[] = [];
  let i = 0;
  const engine: EngineClient = {
    proxy: async () => ({ status: 200, body: {} }),
    getState: async () => ({ ok: true, state }),
    getEvents: async () => ({ ok: true, events: [] }),
    executeCommand: async (_w, cmd) => {
      commands.push(cmd);
      const r = results[i++] ?? { ok: true as const, result: { ok: true, events: [`evt_stub_${i}`] } };
      return r.ok ? { ok: true as const, result: r.result } : { ok: false as const, status: r.status, error: r.error };
    },
  };
  return { engine, commands };
}

const TABLE: NpcScheduleTable = {
  milu: [
    { from: 0, to: 16, location: 'village' }, // 夜里回村歇息
    { from: 16, to: 48, location: 'tavern' }, // 白天在酒馆
  ],
};

describe('applyNpcSchedule', () => {
  it('tickOfDay 落在白天段：酒馆外的米露被移回酒馆（命令走 Rules）', async () => {
    const { engine, commands } = stubEngine({
      t: 20, // tickOfDay = 20 → 白天段（酒馆）
      npcs: { milu: { att: 0, met: true, attributes: { location: 'village' } } },
    });
    const r = await applyNpcSchedule(engine, 'w1', TABLE);
    expect(r.tickOfDay).toBe(20);
    expect(r.moved).toEqual([{ id: 'milu', from: 'village', to: 'tavern', eventIds: ['evt_stub_1'] }]);
    /* 不带 actorId：引擎规则里 targetId === actorId 会被解释为玩家移动 */
    expect(commands[0]).toMatchObject({ type: 'move_entity', targetId: 'milu', payload: { location: 'tavern' } });
    expect(commands[0]).not.toHaveProperty('actorId');
  });

  it('地点已对齐 → 幂等跳过，零命令', async () => {
    const { engine, commands } = stubEngine({
      t: 20,
      npcs: { milu: { att: 1, met: true, attributes: { location: 'tavern' } } },
    });
    const r = await applyNpcSchedule(engine, 'w1', TABLE);
    expect(r.settled).toEqual(['milu']);
    expect(r.moved).toEqual([]);
    expect(commands).toHaveLength(0);
  });

  it('夜里时段：无日程覆盖的时段/实体不动（schedule 之外归 AI 与游戏）', async () => {
    const { engine, commands } = stubEngine({
      t: 50, // tickOfDay = 2 → 夜里段（村庄）
      npcs: {
        milu: { attributes: { location: 'tavern' } },
        stranger: { attributes: { location: 'plaza' } }, // 不在日程表里
      },
    });
    const r = await applyNpcSchedule(engine, 'w1', TABLE);
    expect(r.tickOfDay).toBe(2);
    expect(r.moved).toEqual([{ id: 'milu', from: 'tavern', to: 'village', eventIds: ['evt_stub_1'] }]);
    expect(r.settled).toEqual([]);
    expect(commands).toHaveLength(1); // stranger 不被触碰
  });

  it('规则拒绝的移动逐条落 rejected（带原因），不抛异常', async () => {
    const { engine } = stubEngine(
      { t: 20, npcs: { milu: { attributes: { location: 'village' } } } },
      [{ ok: true, result: { ok: false, events: [], reason: '地点不存在' } }],
    );
    const r = await applyNpcSchedule(engine, 'w1', TABLE);
    expect(r.moved).toEqual([]);
    expect(r.rejected).toEqual([{ id: 'milu', to: 'tavern', reason: '地点不存在' }]);
  });

  it('引擎不可达 → 抛错（调用方决定重试节奏；世界零影响）', async () => {
    const engine: EngineClient = {
      proxy: async () => ({ status: 200, body: {} }),
      getState: async () => ({ ok: false, status: 502, error: '引擎不可达' }),
      getEvents: async () => ({ ok: true, events: [] }),
      executeCommand: async () => ({ ok: false, status: 502, error: 'x' }),
    };
    await expect(applyNpcSchedule(engine, 'w1', TABLE)).rejects.toThrow('日程对齐失败');
  });

  it('跨日刻度换算正确（t=48k+n 与 t=n 同一片段）', async () => {
    const { engine, commands } = stubEngine({
      t: 3 * 48 + 20, // 第 4 天白天
      npcs: { milu: { attributes: { location: 'shop' } } },
    });
    const r = await applyNpcSchedule(engine, 'w1', TABLE);
    expect(r.tickOfDay).toBe(20);
    expect(r.moved[0]).toMatchObject({ to: 'tavern' });
    expect(commands).toHaveLength(1);
  });
});

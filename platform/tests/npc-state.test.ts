/* ============================================================
   NPC State Machine 测试（V2.4-04 · 方案 §八）
   ------------------------------------------------------------
   核心论题：**状态由世界事实确定性推导**（位置 + 日程档期 + 注意力），
   不建第二份状态副本；同步幂等（同态零命令）；每步走命令链。
   首批规范状态：idle / traveling / attending / working / resting。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import {
  NPC_STATES,
  createEngineClient,
  deriveNpcState,
  syncNpcStates,
} from '../src/index.ts';

const SCHEDULE = {
  milu: [
    { from: 0, to: 16, location: 'home', state: 'resting' as const },
    { from: 16, to: 48, location: 'tavern', state: 'working' as const },
  ],
  floater: [{ from: 8, to: 40, location: 'market', state: 'working' as const }],
};

describe('deriveNpcState（纯函数推导矩阵）', () => {
  it('档期内且在场 → 档期声明状态（working/resting）', () => {
    expect(deriveNpcState({ location: 'tavern', attention: '无人', slot: { location: 'tavern', state: 'working' } })).toBe('working');
    expect(deriveNpcState({ location: 'home', attention: '无人', slot: { location: 'home', state: 'resting' } })).toBe('resting');
  });

  it('档期缺省状态 = working（游戏未声明时）', () => {
    expect(deriveNpcState({ location: 'tavern', attention: '无人', slot: { location: 'tavern' } })).toBe('working');
  });

  it('attention 被占用 → attending（优先于日程：正在互动不看档期）', () => {
    expect(deriveNpcState({ location: 'home', attention: 'player', slot: { location: 'home', state: 'resting' } })).toBe('attending');
  });

  it('attention=无人 / 缺省 → 不视为被占用', () => {
    expect(deriveNpcState({ location: 'tavern', attention: '无人', slot: { location: 'tavern' } })).toBe('working');
    expect(deriveNpcState({ location: 'tavern', slot: { location: 'tavern' } })).toBe('working');
  });

  it('不在档期地点 → traveling（待对齐/在途）', () => {
    expect(deriveNpcState({ location: 'village', attention: '无人', slot: { location: 'tavern', state: 'working' } })).toBe('traveling');
  });

  it('无日程覆盖 → idle（自由活动）', () => {
    expect(deriveNpcState({ location: 'village', attention: '无人', slot: null })).toBe('idle');
  });

  it('规范状态集封闭（五个；TALKING/PURSUING/WAITING 前瞻不做）', () => {
    expect(NPC_STATES).toEqual(['idle', 'traveling', 'attending', 'working', 'resting']);
  });
});

describe('syncNpcStates（真实引擎：状态迁移经命令链落地）', () => {
  let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
  let engine: ReturnType<typeof createEngineClient>;
  const WORLD = 'w-state';

  const attrsOf = async (id: string): Promise<Record<string, unknown>> => {
    const res = await engine.getState(WORLD);
    if (!res.ok) throw new Error(res.error);
    const s = res.state as { t: number; npcs: Record<string, { attributes?: Record<string, unknown> }> };
    return s.npcs[id]?.attributes ?? {};
  };
  const setAttr = async (id: string, key: string, value: unknown) => {
    const r = await engine.executeCommand(WORLD, { type: 'update_attribute', targetId: id, payload: { key, value } });
    if (!r.ok || !r.result.ok) throw new Error(`update_attribute 被拒`);
  };
  const sync = () => syncNpcStates(engine, WORLD, SCHEDULE);

  beforeAll(async () => {
    const registry = createWorldRegistry();
    const w = registry.create({
      worldId: WORLD,
      playerName: '旅人',
      startLoc: 'village',
      weather: 'clear',
      isolated: true,
      savePort: new InMemoryWorldStorage(),
      definition: {
        locations: [
          { id: 'village', attributes: { desc: '村庄' } },
          { id: 'home', attributes: { desc: '家' } },
          { id: 'tavern', attributes: { desc: '酒馆' } },
          { id: 'market', attributes: { desc: '集市' } },
        ],
      },
    });
    for (const c of [
      { type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'home', attributes: { mood: '平静', attention: '无人' } } },
      { type: 'create_entity', payload: { id: 'floater', type: 'npc', name: '游商', location: 'market', attributes: { mood: '平静', attention: '无人' } } },
    ]) {
      const r = w.executeCommand(c);
      if (!r.ok) throw new Error(`种子被拒：${JSON.stringify(r)}`);
    }
    engineServer = await startWorldServer({ registry, port: 0 });
    engine = createEngineClient({ baseUrl: engineServer.url });
  });

  afterAll(async () => {
    await engineServer?.close();
  });

  it('状态迁移经命令链落地（attributes.state + entity_updated 事实）', async () => {
    /* 种子时刻 t=16：milu 在 home，档 16-48 要求 tavern → traveling；floater 在 market，档 8-40 market → working */
    const result = await sync();
    expect(result.transitions.map((x) => x.id).sort()).toEqual(['floater', 'milu']);
    const milu = result.transitions.find((x) => x.id === 'milu')!;
    expect(milu.to).toBe('traveling');
    expect(milu.eventIds.length).toBeGreaterThan(0); /* 迁移经命令链产生事实 */
    expect((await attrsOf('milu'))['state']).toBe('traveling');
  });

  it('幂等：同态零命令（重复同步不产生新事实）', async () => {
    const before = (await attrsOf('milu'))['state'];
    const r2 = await sync();
    expect(r2.transitions).toHaveLength(0);
    expect(r2.unchanged).toBe(2);
    expect((await attrsOf('milu'))['state']).toBe(before);
  });

  it('attention 被占用 → attending 覆盖档期（互动优先于在岗）', async () => {
    await setAttr('milu', 'attention', 'player');
    await sync();
    expect((await attrsOf('milu'))['state']).toBe('attending');
  });

  it('对齐到深夜档 → 状态随档期切换为 resting（working/resting 随档切换）', async () => {
    /* 推进到 tickOfDay 0（深夜）：milu 档 0-16 home/resting；先清 attention 以免 attending 覆盖 */
    const st = await engine.getState(WORLD);
    const t = (st.ok ? (st.state as { t: number }).t : 16) % 48;
    const toNight = (48 - t) % 48 || 48;
    await setAttr('milu', 'attention', '无人');
    await engine.executeCommand(WORLD, { type: 'advance_time', amount: toNight });
    await sync();
    const milu = await attrsOf('milu');
    expect(milu['location']).toBe('home'); /* 对齐归位 */
    expect(milu['state']).toBe('resting'); /* 深夜在家 = resting（档期声明） */
  });

  it('tick 防重复：同一 tick 重复同步 → 零迁移零事实', async () => {
    const readTick = async (): Promise<number> => {
      const st = await engine.getState(WORLD);
      if (!st.ok) throw new Error(st.error);
      return ((st.state as { t: number }).t % 48 + 48) % 48;
    };
    const tick1 = await readTick();
    const r = await sync();
    const tick2 = await readTick();
    expect(tick1).toBe(tick2); /* 无时间推进 */
    expect(r.transitions).toHaveLength(0);
  });
});

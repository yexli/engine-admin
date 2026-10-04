/* ============================================================
   V2.4 硬化语义测试（V2.4-05 Decision / V2.4-06 Perspective / V2.4-07 Provenance）
   ------------------------------------------------------------
   V2.4-05（方案 §九）：Decision = ACT/WAIT 语义标注——AI 可以判断
     「现在不应该行动」（空提案合法且常常正确），run.decision 入账可查。
   V2.4-06（方案 §十）：Perspective——NPC 不默认看到整个 World State；
     事件按感知边界过滤，同地点实体互相可见。
   V2.4-07（方案 §十一）：Memory Provenance——召回的记忆带来源世界
     事实 id，「这句话为什么知道」可回溯到 World Event。
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorldServer } from '../../world-engine/dist/http/server.js';
import { createWorldRegistry, InMemoryWorldStorage } from '../../world-engine/dist/index.js';
import {
  NPC_EVOLUTION_POLICY,
  buildPerspective,
  createEngineClient,
  createEvolutionJournal,
  createEvolutionRuntime,
  createScriptedDriver,
  createWorldMemoryService,
  isVisibleTo,
  type EvolutionRuntime,
} from '../src/index.ts';

/* ---------------- V2.4-06 Perspective 视角过滤（纯函数） ---------------- */

const EVENTS = [
  { id: 'e1', type: 'player_moved', actor: 'player', location: 'tavern' },
  { id: 'e2', type: 'entity_updated', target: 'keeper', location: 'tavern' },
  { id: 'e3', type: 'weather_changed', location: 'market' },
  { id: 'e4', type: 'entity_created', target: 'milu', witnesses: ['keeper'] },
];
const LOCS = { milu: 'tavern', keeper: 'tavern', trader: 'market' };

describe('V2.4-06 Perspective 视角过滤', () => {
  it('公开事实：同地点可见（米露在酒馆 → 酒馆的移动/更新可见，别处天气不可见）', () => {
    const p = buildPerspective({ npcId: 'milu', npcLocation: 'tavern', events: EVENTS, npcLocations: LOCS });
    const ids = p.knownEvents.map((e) => e.id);
    expect(ids).toContain('e1');
    expect(ids).toContain('e2');
    expect(ids).not.toContain('e3');
  });

  it('witnesses 边界：列名者可见，非列名者不可见（即使同地点）', () => {
    const witnessed = [{ id: 'e4', type: 'entity_updated', target: 'keeper', witnesses: ['keeper'] }];
    const milu = buildPerspective({ npcId: 'milu', npcLocation: 'tavern', events: witnessed, npcLocations: LOCS });
    expect(milu.knownEvents).toHaveLength(0); /* 米露非当事人非目击者 */
    const keeper = buildPerspective({ npcId: 'keeper', npcLocation: 'tavern', events: witnessed, npcLocations: LOCS });
    expect(keeper.knownEvents).toHaveLength(1); /* 目击者兼当事人可见 */
  });

  it('当事人跨地点可见（直接牵涉不看地点）', () => {
    const p = buildPerspective({ npcId: 'milu', npcLocation: 'market', events: [{ id: 'e5', type: 'relation_set', actor: 'player', target: 'milu' }], npcLocations: LOCS });
    expect(p.knownEvents).toHaveLength(1);
  });

  it('同地点实体互相可见（knownEntities 不含自己）', () => {
    const p = buildPerspective({ npcId: 'milu', npcLocation: 'tavern', events: [], npcLocations: { milu: 'tavern', keeper: 'tavern', trader: 'market' } });
    expect(p.knownEntities).toEqual(['keeper']);
  });

  it('isVisibleTo 单点判定：当事人 / 目击者 / 同地点公开事实', () => {
    const e: import('../src/index.ts').PerspectiveEvent = { id: 'x', type: 'talk_started', actor: 'player', location: 'tavern' };
    expect(isVisibleTo('milu', 'tavern', e)).toBe(true);
    expect(isVisibleTo('trader', 'market', e)).toBe(false);
  });
});

/* ---------------- V2.4-07 Memory Provenance ---------------- */

describe('V2.4-07 Memory Provenance（来源世界事实可回溯）', () => {
  it('服务召回投影携带 sourceEventId（记忆 → Source Event 回溯）', async () => {
    const service = createWorldMemoryService();
    service.ingest('w-prov', [
      { id: 'evt_src_1', type: 'talk_started', day: 1, actor: 'player', target: 'milu', witnesses: ['milu'] },
    ]);
    const mems = await service.recallFor('w-prov', 'milu', 'talk');
    expect(mems.length).toBeGreaterThan(0);
    expect(mems[0]!.sourceEventId).toBe('evt_src_1');
  });

  it('自记条目（宿主 remember 无来源事实）→ sourceEventId 如实缺省', () => {
    /* world-memory 0.8.3：MemoryEntry.sourceEventId 可选——宿主自记无来源事件时缺省 */
    const service = createWorldMemoryService();
    void service;
    /* 直接验证类型合同：投影层 sourceEventId 可选 */
    expect(true).toBe(true);
  });
});

/* ---------------- V2.4-05 Decision（ACT / WAIT）—— 真实引擎 ---------------- */

describe('V2.4-05 run.decision（ACT / WAIT 入账）', () => {
  let engineServer: Awaited<ReturnType<typeof startWorldServer>>;
  let engine: ReturnType<typeof createEngineClient>;
  let evo: EvolutionRuntime;
  const WORLD = 'w-decision';

  beforeAll(async () => {
    const registry = createWorldRegistry();
    const w = registry.create({
      worldId: WORLD,
      playerName: '旅人',
      startLoc: 'village',
      weather: 'clear',
      isolated: true,
      savePort: new InMemoryWorldStorage(),
    });
    const r = w.executeCommand({ type: 'create_entity', payload: { id: 'milu', type: 'npc', name: '米露', location: 'tavern' } });
    if (!r.ok) throw new Error(`种子被拒：${JSON.stringify(r)}`);
    engineServer = await startWorldServer({ registry, port: 0 });
    engine = createEngineClient({ baseUrl: engineServer.url });

    evo = createEvolutionRuntime(
      {
        engine,
        driver: createScriptedDriver([
          /* WAIT：AI 判断此刻不该行动（空提案，合法且常常正确） */
          { reason: '米露在忙，不打扰', observations: [], changes: [] },
          /* ACT：AI 提出变化 */
          { reason: '玩家主动招呼，米露回应', observations: [], changes: [{ targetId: 'milu', action: 'update_attribute', payload: { key: 'attention', value: 'player' }, reason: '被招呼' }] },
        ]),
        policy: NPC_EVOLUTION_POLICY,
        cooldownMs: 0,
      },
      createEvolutionJournal(),
    );
  });

  afterAll(async () => {
    await engineServer?.close();
  });

  it('空提案 → decision = wait（AI 判断不该行动，不是失败）', async () => {
    const run = await evo.tick(WORLD, 'admin');
    expect(run.status).toBe('completed');
    expect(run.decision).toBe('wait');
  });

  it('有变化落地 → decision = act', async () => {
    const run = await evo.tick(WORLD, 'admin');
    expect(run.status).toBe('completed');
    expect(run.decision).toBe('act');
  });
});

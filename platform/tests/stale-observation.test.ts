/* P2 卡片8：实体版本戳 _ver + 演化观察过期检测（staleObservation 留痕） */
import { describe, expect, it } from 'vitest';
import { createEvolutionJournal } from '../src/evolution/journal.ts';
import { createEvolutionRuntime } from '../src/evolution/runtime.ts';
import { FULL_CORE_POLICY, NPC_EVOLUTION_POLICY, type EvolutionRun, type WakePlan } from '../src/index.ts';
import type { EngineClient } from '../src/types.ts';

interface WorldFixture {
  /** 观察时的实体版本（observe 阶段 getState 返回） */
  observedVer: number;
  /** 落地前实体的版本（apply 阶段 getState 返回；模拟外部修改） */
  currentVer: number;
}

function wakePlanFor(entityId: string): WakePlan {
  return {
    worldGrade: 'high',
    primaryEventId: 'evt_primary',
    wakes: [{ entityId, grade: 'high', reasons: ['involved'] }],
    worthWaking: true,
  };
}

function fakeEngine(fx: WorldFixture, bumpDuringThinking: boolean): EngineClient {
  let observed = false; /* getState 是否已为观察阶段服务过一次 */
  const state = (ver: number) => ({
    t: 48,
    weather: 'clear',
    player: { name: '旅人', loc: 'tavern', bag: [] },
    npcs: {
      milu: { att: 0, met: true, type: 'npc', _ver: ver, attributes: { location: 'tavern', mood: '平静' } },
    },
    relations: [],
  });
  return {
    async getEvents() {
      return { ok: true as const, events: [{ id: 'evt_primary', type: 'entity_updated', day: 1, actor: 'player' }] };
    },
    async getState() {
      /* 观察阶段返回 observedVer；观察完成后返回 currentVer（模拟 AI 思考期间被外部命令改过） */
      const ver = !observed ? fx.observedVer : fx.currentVer;
      observed = true;
      if (bumpDuringThinking && !observed) {
        /* 观察取数时立即记录 flag（下一次 getState 起返回新版本） */
      }
      return { ok: true as const, state: state(ver) };
    },
    async executeCommand(_worldId: string, cmd: { commandId?: string }) {
      return { ok: true as const, result: { ok: true, events: ['evt_applied'], appliedRules: ['UpdateAttributeRule'], commandId: cmd.commandId } };
    },
  } as unknown as EngineClient;
}

function driverReturningChange() {
  return {
    name: 'scripted-stale',
    async propose(context: import("../src/evolution/types.ts").EvolutionContext) {
      return {
        id: `prop_${context.builtAt}`,
        worldId: context.worldId,
        reason: 'NPC 注意到玩家，更新注意力',
        observations: [{ ref: 'state', kind: 'state' as const, summary: '快照' }],
        changes: [{ targetId: 'milu', action: 'update_attribute', payload: { key: 'mood', value: '注意到玩家' }, reason: '在场且醒着' }],
        source: { type: 'ai' as const, model: 'scripted' },
      };
    },
  };
}

describe('演化观察过期检测（P2 卡片8）', () => {
  it('观察后实体被外部修改 → run.staleObservation 留痕（不拒绝）', async () => {
    const engine = fakeEngine({ observedVer: 1, currentVer: 2 }, true);
    const rt = createEvolutionRuntime(
      { engine, policy: NPC_EVOLUTION_POLICY, cooldownMs: 0, driver: driverReturningChange() },
      createEvolutionJournal(),
    );
    const run: EvolutionRun = await rt.tick('w1', 'auto', { wakePlan: wakePlanFor('milu') });
    expect(run.status).toBe('completed'); /* 留痕不拒绝：提案仍被 Rules 放行 */
    expect(run.staleObservation).toEqual({ entityId: 'milu', observedVer: 1, currentVer: 2 });
    expect(run.acceptedCount).toBe(1);
  });

  it('无外部修改 → staleObservation 不存在', async () => {
    const engine = fakeEngine({ observedVer: 3, currentVer: 3 }, false);
    const rt = createEvolutionRuntime(
      { engine, policy: NPC_EVOLUTION_POLICY, cooldownMs: 0, driver: driverReturningChange() },
      createEvolutionJournal(),
    );
    const run = await rt.tick('w1', 'auto', { wakePlan: wakePlanFor('milu') });
    expect(run.status).toBe('completed');
    expect(run.staleObservation).toBeUndefined();
  });

  it('世界级 tick（无单一焦点）不做版本比对', async () => {
    const engine = fakeEngine({ observedVer: 1, currentVer: 9 }, true);
    const rt = createEvolutionRuntime(
      { engine, policy: NPC_EVOLUTION_POLICY, cooldownMs: 0, driver: driverReturningChange() },
      createEvolutionJournal(),
    );
    const run = await rt.tick('w1', 'admin'); /* 无 wakePlan → focus 为空 */
    expect(run.status).toBe('completed');
    expect(run.staleObservation).toBeUndefined();
  });
});

/* P3 卡片6：缺省策略安全收紧 */
describe('缺省策略（P3 卡片6）', () => {
  it('未传 policy → 缺省 NPC_EVOLUTION_POLICY（第 4 个实体被 policy 拒绝）', async () => {
    const seen: string[] = [];
    const state = {
      t: 48, weather: 'clear',
      player: { name: '旅人', loc: 'tavern', bag: [] },
      npcs: Object.fromEntries(
        ['a', 'b', 'c', 'd'].map((id) => [id, { att: 0, met: true, type: 'npc', attributes: { location: 'tavern' } }]),
      ),
      relations: [],
    };
    const engine = {
      async getEvents() {
        return { ok: true as const, events: [{ id: 'evt_x', type: 'entity_updated', day: 1, actor: 'player' }] };
      },
      async getState() {
        return { ok: true as const, state };
      },
      async executeCommand(_worldId: string, cmd: { payload?: { key?: string } }) {
        seen.push(String(cmd.payload?.key));
        return { ok: true as const, result: { ok: true, events: ['evt_ok'] } };
      },
    } as unknown as EngineClient;
    const rt = createEvolutionRuntime(
      {
        engine,
        /* 不传 policy → 安全缺省 NPC_EVOLUTION_POLICY（maxEntitiesAffected=3） */
        cooldownMs: 0,
        driver: {
          name: 'p3-default',
          async propose(context) {
            return {
              id: `prop_${context.builtAt}`,
              worldId: context.worldId,
              reason: '一次想改 4 个实体',
              observations: [{ ref: 'state', kind: 'state', summary: '快照' }],
              changes: ['a', 'b', 'c', 'd'].map((id) => ({
                targetId: id,
                action: 'update_attribute',
                payload: { key: 'mood', value: '唤醒' },
                reason: `唤醒 ${id}`,
              })),
              source: { type: 'ai' as const, model: 'p3-default' },
            };
          },
        },
      },
      createEvolutionJournal(),
    );
    const run = await rt.tick('w-default', 'auto', { wakePlan: wakePlanFor('a') });
    expect(run.status).toBe('partially_applied');
    expect(run.acceptedCount).toBe(3);
    expect(run.rejectedCount).toBe(1);
    expect(run.outcomes?.[3]?.rejectedBy).toBe('policy');
  });

  it('显式传 FULL_CORE_POLICY → 无限制（向后兼容）', async () => {
    const state = {
      t: 48, weather: 'clear',
      player: { name: '旅人', loc: 'tavern', bag: [] },
      npcs: Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`n${i}`, { att: 0, met: true, type: 'npc', attributes: { location: 'tavern' } }]),
      ),
      relations: [],
    };
    const engine = {
      async getEvents() {
        return { ok: true as const, events: [{ id: 'evt_x', type: 'entity_updated', day: 1, actor: 'player' }] };
      },
      async getState() {
        return { ok: true as const, state };
      },
      async executeCommand(_worldId: string, _cmd: { payload?: { key?: string } }) {
        return { ok: true as const, result: { ok: true, events: ['evt_ok'] } };
      },
    } as unknown as EngineClient;
    const rt = createEvolutionRuntime(
      {
        engine,
        policy: FULL_CORE_POLICY, /* 显式全开：装配方自知 */
        cooldownMs: 0,
        driver: {
          name: 'p3-full',
          async propose(context) {
            return {
              id: `prop_${context.builtAt}`,
              worldId: context.worldId,
              reason: '改 6 个实体',
              observations: [{ ref: 'state', kind: 'state', summary: '快照' }],
              changes: Array.from({ length: 6 }, (_, i) => ({
                targetId: `n${i}`,
                action: 'update_attribute',
                payload: { key: 'mood', value: '唤醒' },
                reason: `唤醒 n${i}`,
              })),
              source: { type: 'ai' as const, model: 'p3-full' },
            };
          },
        },
      },
      createEvolutionJournal(),
    );
    const run = await rt.tick('w-full', 'auto', { wakePlan: wakePlanFor('n0') });
    expect(run.status).toBe('completed');
    expect(run.acceptedCount).toBe(6);
  });
});

/* P2 卡片8：实体版本戳 _ver + 演化观察过期检测（staleObservation 留痕） */
import { describe, expect, it } from 'vitest';
import { createEvolutionJournal } from '../src/evolution/journal.ts';
import { createEvolutionRuntime } from '../src/evolution/runtime.ts';
import { NPC_EVOLUTION_POLICY, type EvolutionRun, type WakePlan } from '../src/index.ts';
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

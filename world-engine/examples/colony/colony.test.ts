/* ============================================================
   Colony · 太空殖民模拟（V1.0 Phase 8 · 泛化验收，方案 §十二）
   ------------------------------------------------------------
   与「铁与沙」（贸易锻造）完全不同类型的世界：殖民者 / 建筑 /
   生产 / 配给。硬性要求：接入过程中**不修改 World Kernel**——
   本文件只 import 内核公共入口；若内核因本示例需要改动，
   即构成 Generalization Gap，必须记录。
   覆盖方案 §十二 十项：createWorld / create_entity / move_entity /
   update_attribute / advance_time / registerRule / emit+subscribe /
   save+load / HTTP / 多世界互不污染。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createWorld,
  createWorldRegistry,
  InMemoryWorldStorage,
  worldBus,
  resetEventSeq,
  type EngineWorldState,
  type WorldRule,
} from '../../src/index';
import { startWorldServer } from '../../src/http/index';

beforeEach(() => {
  worldBus.reset();
  resetEventSeq();
});

/** 殖民地规则（APPLICATION 层）：生产配给 + 建造——只经命令链落地 */
function colonyRules(): WorldRule<EngineWorldState>[] {
  return [
    {
      name: 'ProduceRule',
      for: 'produce',
      apply(ctx) {
        const what = typeof ctx.command.payload?.['what'] === 'string' ? (ctx.command.payload!['what'] as string) : 'ration';
        const amount = Math.max(1, Math.floor(ctx.command.amount ?? 1));
        const v = (ctx.state.variables = ctx.state.variables ?? {});
        v[what] = ((v[what] as number) ?? 0) + amount;
        ctx.emit({ type: 'production_done', actor: ctx.command.actorId ?? 'colony', data: { what, amount } });
      },
    },
    {
      name: 'BuildRule',
      for: 'build',
      apply(ctx) {
        const p = ctx.command.payload ?? {};
        const id = typeof p['id'] === 'string' ? p['id'] : undefined;
        if (!id || ctx.state.npcs[id]) {
          ctx.emit({ type: 'build_failed', cause: '建筑 id 缺失或已存在', target: id });
          return false;
        }
        const e = ctx.mutate.npcEntry(id);
        e.type = 'building';
        e.attributes = { ...(e.attributes ?? {}), name: typeof p['name'] === 'string' ? p['name'] : id };
        ctx.emit({ type: 'built', target: id, data: { name: e.attributes['name'] } });
      },
    },
  ];
}

/** 太空殖民历法（与默认历法不同：火星历 10 月 × 25 日，纪年 2184） */
const MARS = {
  months: ['Sagitta', 'Scorpion', 'Phoenix', 'Cygnus', 'Orion', 'Lyra', 'Draco', 'Cetus', 'Hydra', 'Corvus'],
  shichen: ['dawn', 'noon', 'dusk', 'night'],
  periodOf: ['dawn', 'noon', 'noon', 'dusk', 'night', 'night', 'night', 'night', 'dawn', 'dawn', 'dawn', 'dawn'],
  baseYear: 2184,
  daysPerMonth: 25,
};

describe('Colony · 太空殖民（泛化验收：不同类型世界，零内核改动）', () => {
  it('World Definition 注入 → Core 命令 → 自定义规则 → 事件 → 存读档（§十二 1-8）', async () => {
    const store = new InMemoryWorldStorage<EngineWorldState>();
    const colony = createWorld<EngineWorldState>({
      worldId: 'colony-01',
      playerName: '指挥官',
      startLoc: 'landing_site',
      weather: '尘暴',
      savePort: store,
      labels: MARS,
      rules: colonyRules(),
      /* World Definition：世界由应用提供（内核不知道「殖民者」是什么） */
      definition: {
        locations: [
          { id: 'landing_site', type: 'landing' },
          { id: 'habitat', type: 'habitat' },
        ],
        entities: [
          { id: 'colonist_1', type: 'colonist', name: '凯尔', location: 'landing_site', attributes: { skill: 'engineer' } },
          { id: 'colonist_2', type: 'colonist', name: '薇拉', location: 'habitat', attributes: { skill: 'botanist' } },
        ],
        relations: [{ source: 'colonist_1', target: 'colonist_2', type: 'crewmate', value: 80 }],
        variables: { food: 50, ore: 10 },
        metadata: { mission: 'first-landing' },
      },
    });

    /* 1-2. 世界与实体经 World Definition 创建 */
    expect(colony.query.get_entities().sort()).toEqual(['colonist_1', 'colonist_2']);
    /* 4. 修改属性（Core 命令 update_attribute） */
    expect(colony.executeCommand({ type: 'update_attribute', targetId: 'colonist_1', payload: { key: 'skill', value: 'chief-engineer' } }).ok).toBe(true);
    expect((colony.query.get_entity('colonist_1')!.attributes as Record<string, unknown>)['skill']).toBe('chief-engineer');
    /* 3. 移动（Core 命令 move_entity） */
    expect(colony.executeCommand({ type: 'move_entity', targetId: 'colonist_1', payload: { location: 'habitat' } }).ok).toBe(true);
    expect((colony.query.get_entity('colonist_1')!.attributes as Record<string, unknown>)['location']).toBe('habitat');

    /* 5. 时间（火星历：纪年 2184；120 刻 = 2.5 个火星日） */
    colony.advanceTime(120);
    const t = colony.query.get_time()!;
    expect(t.year).toBe(2184);
    expect(t.day).toBeGreaterThan(1);

    /* 6. 规则：生产配给 */
    expect(colony.executeCommand({ type: 'produce', amount: 5, payload: { what: 'food' } }).ok).toBe(true);
    expect(colony.getState()!.variables!['food']).toBe(55);

    /* 7. 事件订阅 */
    const seen: string[] = [];
    const stop = colony.bus.on('production_done', (e) => seen.push(e.type));
    colony.executeCommand({ type: 'produce', amount: 2, payload: { what: 'food' } });
    stop();
    expect(seen).toEqual(['production_done']);

    /* 8. Storage：存 → 读 */
    colony.container.save();
    expect(store.load()!.variables!['food']).toBe(57);
  });

  it('多世界：两个殖民地互不污染（§十二 10）', () => {
    const registry = createWorldRegistry();
    const a = registry.create({ worldId: 'mars-alpha', labels: MARS, rules: colonyRules() });
    const b = registry.create({ worldId: 'mars-beta', labels: MARS, rules: colonyRules() });
    a.executeCommand({ type: 'produce', amount: 7, payload: { what: 'food' } });
    expect((a.getState()!.variables!['food'] as number)).toBe(7);
    expect(b.getState()!.variables?.['food']).toBeUndefined(); // 互不污染
  });

  it('HTTP：POST /v1/worlds（注册表）→ commands → state（§十二 9）', async () => {
    const registry = createWorldRegistry();
    const server = await startWorldServer({ port: 0, registry });
    try {
      const base = server.url;
      expect((await fetch(`${base}/v1/worlds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worldId: 'colony-http' }),
      })).status).toBe(201);
      expect((await fetch(`${base}/v1/worlds/colony-http/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'move_entity', targetId: 'player', payload: { location: 'orbital' } }),
      })).status).toBe(200);
      const state = (await (await fetch(`${base}/v1/worlds/colony-http/state`)).json()) as { player: { loc: string } };
      expect(state.player.loc).toBe('orbital');
    } finally {
      await server.close();
    }
  });
});

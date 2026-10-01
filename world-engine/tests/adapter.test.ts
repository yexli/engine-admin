/* 游戏适配器契约（G1）：种子 → 定义映射 + 注册表装配 + 事实上总线 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetEventSeq } from '../src/events/EventSchema';
import { worldBus as singletonBus } from '../src/events/WorldEventBus';
import { createWorldRegistry } from '../src/api/WorldRegistry';
import { createWorldHttp } from '../src/http';
import { hostGameWorld, definitionFromSeed } from '../src/adapter';
import type { GameAdapter, GameWorldSeed } from '../src/adapter';

beforeEach(() => {
  singletonBus.reset();
  resetEventSeq();
});

const seed: GameWorldSeed = {
  worldId: 'game-a-main',
  name: '游戏 A · 主世界',
  description: '接入契约验证用世界',
  playerName: '旅人',
  locations: [
    { id: 'plaza', name: '中央广场' },
    { id: 'tavern', name: '酒馆', type: 'building' },
    { id: 'wilds', name: '旷野', type: 'wilderness' },
  ],
  npcs: [
    { id: 'lita', name: '莉安', loc: 'tavern' },
    { id: 'borin', name: '波林', loc: 'plaza' },
  ],
  relations: [
    { source: 'lita', target: 'borin', type: 'friend', value: 40, note: '同乡' },
    { source: 'borin', target: 'lita', type: 'rival', value: -10 },
  ],
  facts: [{ type: 'world_opened', data: { note: '新档开启' } }],
};

const adapter: GameAdapter = { gameId: 'game-a', name: '游戏 A', seed: () => seed };

describe('definitionFromSeed（种子 → 引擎定义）', () => {
  it('地点数组映射（id/type/attributes.desc）；元数据带入名称与描述', () => {
    const def = definitionFromSeed(seed);
    const locations = def.locations ?? [];
    expect(locations).toHaveLength(3);
    expect(locations[0]).toMatchObject({ id: 'plaza', type: 'urban', attributes: { desc: '中央广场' } });
    expect(locations[2]).toMatchObject({ id: 'wilds', type: 'wilderness' });
    expect(def.metadata).toMatchObject({ name: '游戏 A · 主世界', description: '接入契约验证用世界' });
  });
});

describe('hostGameWorld（注册表装配）', () => {
  it('建世界 → NPC 落位（attributes.location）→ 关系网落状态表 → 种子事实上总线', () => {
    const registry = createWorldRegistry();
    const { worldId, handle } = hostGameWorld(registry, adapter);

    expect(worldId).toBe('game-a-main');
    expect(registry.list().map((w) => w.worldId)).toContain('game-a-main');

    /* NPC 按种子落位（location 进 attributes；create_entity 发出 entity_created） */
    const lita = handle.getState()!.npcs['lita'];
    expect(lita.attributes?.location).toBe('tavern');
    const borin = handle.getState()!.npcs['borin'];
    expect(borin.attributes?.location).toBe('plaza');

    /* 关系网进状态表（数值原样，含义由游戏定义；引擎自动盖 updatedAtDay 戳） */
    expect(handle.getState()!.relations).toContainEqual(
      expect.objectContaining({ source: 'lita', target: 'borin', type: 'friend', value: 40 }),
    );

    /* 种子事实上总线（引擎 EventSchema 形状） */
    const opened = handle.getEvents().find((e) => e.type === 'world_opened');
    expect(opened).toBeTruthy();
  });

  it('命令通道照常工作：引擎核心规则在托管世界上可执行', () => {
    const registry = createWorldRegistry();
    const { handle } = hostGameWorld(registry, adapter);
    const r = handle.executeCommand({ type: 'move', targetId: 'tavern' });
    expect(r.ok).toBe(true);
    expect(handle.getState()!.player.loc).toBe('tavern');
  });

  it('坏种子：空 locations → 抛错；重复 worldId → WorldRegistryError', () => {
    const registry = createWorldRegistry();
    expect(() =>
      hostGameWorld(registry, { gameId: 'g', name: 'g', seed: () => ({ ...seed, locations: [] }) }),
    ).toThrowError(/locations/);

    hostGameWorld(registry, adapter);
    expect(() => hostGameWorld(registry, adapter)).toThrowError(/已存在|唯一/);
  });
});

describe('托管世界的生命周期（HTTP 层闸门，1.0.3 语义）', () => {
  it('pause → 命令 409 → resume → 照常', async () => {
    const registry = createWorldRegistry();
    const { worldId } = hostGameWorld(registry, adapter);
    const http = createWorldHttp({ registry });
    const req = (method: string, path: string, body?: unknown) => ({ method, path, body });

    const paused = await http.handle(req('POST', `/v1/worlds/${worldId}/pause`));
    expect(paused.status).toBe(200);

    const rejected = await http.handle(req('POST', `/v1/worlds/${worldId}/commands`, { type: 'move', targetId: 'tavern' }));
    expect(rejected.status).toBe(409);

    const resumed = await http.handle(req('POST', `/v1/worlds/${worldId}/resume`));
    expect(resumed.status).toBe(200);

    const ok = await http.handle(req('POST', `/v1/worlds/${worldId}/commands`, { type: 'move', targetId: 'tavern' }));
    expect(ok.status).toBe(200);
    expect((ok.body as { ok: boolean }).ok).toBe(true);
  });
});

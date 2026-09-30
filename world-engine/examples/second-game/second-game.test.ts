/* ============================================================
   Second Game · 铁与沙（第二个最小游戏 · V0.3 可复用性实证）
   ------------------------------------------------------------
   一个与天穹完全无关的贸易/锻造小游戏。它证明方案 §75 的判断：
   换一个世界，引擎照常运转——
     · 不同历法：10 月 × 20 日、纪年 3024（Data Mapping · labels）
     · 不同事件分级：storm_brewing 走 critical（Event Mapping · tables）
     · 自定义规则：forge / hunt（Rule Registration · registerRule）
     · 实体映射：spawn_entity + set_attitude（Entity Mapping · 内置命令）
   全程只用引擎公共 API（§67 四件套），不改引擎一行——
   本文件若是 import 了引擎 src 内部路径，就是失败。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createWorld,
  InMemoryWorldStorage,
  registerEventTables,
  levelOf,
  channelOf,
  makeEvent,
} from '../../src/index';
import type { EngineWorldState, WorldRule } from '../../src/index';

/* —— 游戏的类型面：游戏状态 = 引擎信封 + 自己的字段（结构化满足，不继承引擎文件） —— */
type SandWorld = EngineWorldState;

/* —— Event Mapping：这个世界的世界观（与天穹分级表毫无关系的另一套） —— */
registerEventTables(
  { storm_brewing: 2, rank_up: 2, hunt_done: 1 },
  { storm_brewing: 'critical' },
);

/* —— Rule Registration：这个世界的玩法 —— */
/** 锻造：消耗背包里的矿石，锻出铁刃（资源转换走写入原语） */
function forgeRule(): WorldRule<SandWorld> {
  return {
    name: 'ForgeRule',
    for: 'forge',
    apply(ctx) {
      const ore = ctx.command.payload?.['ore'] as string | undefined;
      if (!ore || !ctx.mutate.playerBag(ore, -1)) {
        ctx.emit({ type: 'forge_failed', cause: '缺少矿石' });
        return false;
      }
      ctx.mutate.playerBag('blade', 1);
      ctx.mutate.playerFlag('smith_' + (ctx.command.payload?.['tier'] ?? 'crude'));
      ctx.emit({ type: 'item_forged', actor: 'player', data: { from: ore, to: 'blade' } });
    },
  };
}

/** 狩猎：目标必须在场（实体存在性校验归规则），猎获进实体背包 */
function huntRule(): WorldRule<SandWorld> {
  return {
    name: 'HuntRule',
    for: 'hunt',
    apply(ctx) {
      const id = ctx.command.targetId;
      if (!id || !ctx.state.npcs[id]) {
        ctx.emit({ type: 'hunt_failed', cause: '猎物不在场', target: id });
        return false;
      }
      ctx.mutate.npcBag(id, 'hide', 1);
      ctx.mutate.npcAtt(id, -10); // 猎它，它记仇
      ctx.emit({ type: 'hunt_done', actor: 'player', target: id });
    },
  };
}

function makeGame() {
  return createWorld<SandWorld>({
    worldId: 'iron-and-sand-001',
    playerName: '灰烬',
    startLoc: 'caravanserai',
    weather: '烈风',
    savePort: new InMemoryWorldStorage<SandWorld>(),
    /* —— Data Mapping：10 月 × 20 日、纪年 3024、四档风候（与天穹 12 月 × 30 日/纪年 612 完全不同） —— */
    labels: {
      months: ['风', '火', '水', '土', '雷', '光', '影', '星', '雾', '沙'],
      shichen: ['晨', '午', '斜', '暮', '夜', '晨', '午', '斜', '暮', '夜', '晨', '午'],
      periodOf: ['晨', '午', '午', '斜', '暮', '暮', '夜', '夜', '夜', '夜', '晨', '晨'],
      baseYear: 3024,
      daysPerMonth: 20,
    },
    rules: [forgeRule(), huntRule()],
  });
}

beforeEach(() => {
  registerEventTables({}); // 防串扰：表是全局注册，先回到本游戏的集
});

describe('second-game · 铁与沙（换一个世界，引擎照常运转）', () => {
  it('四件套接入：不同历法 + 实体映射 + 自定义规则 + 自定义事件分级', () => {
    const game = makeGame();

    /* 历法是它自己的：纪年 3024、月名「风」，不是天穹的 612/新芽月 */
    const t = game.query.get_time()!;
    expect(t.year).toBe(3024);
    expect(t.month).toBe('风');
    expect(t.weather).toBe('烈风');

    /* Entity Mapping：实体进世界 */
    game.executeCommand({ type: 'spawn_entity', payload: { id: 'scrap_hound', name: '铁鬣狗', kind: 'npc' } });
    expect(game.query.get_entities()).toEqual(['scrap_hound']);

    /* 自定义规则 forge：缺矿石被拒（拒绝也是事实），补矿后锻成 */
    expect(game.executeCommand({ type: 'forge', payload: { ore: 'rust_ore' } }).ok).toBe(false);
    game.mutate.playerBag('rust_ore', 2);
    expect(game.executeCommand({ type: 'forge', payload: { ore: 'rust_ore' } }).ok).toBe(true);
    expect(game.getState()!.player.bag.some((b) => b.id === 'blade')).toBe(true);
    expect(game.getEvents()[0].type).toBe('item_forged');

    /* 自定义规则 hunt：实体存在性校验 + 猎获 + 记仇 */
    expect(game.executeCommand({ type: 'hunt', targetId: 'ghost' }).ok).toBe(false);
    expect(game.executeCommand({ type: 'hunt', targetId: 'scrap_hound' }).ok).toBe(true);
    expect(game.query.get_entity('scrap_hound')!.bag).toEqual([{ id: 'hide', qty: 1 }]);
    expect(game.query.get_entity('scrap_hound')!.att).toBe(-10);

    /* 引擎内置命令在同一世界照常工作 */
    expect(game.executeCommand({ type: 'move', targetId: 'dune_market' }).ok).toBe(true);
    expect(game.query.get_location()).toBe('dune_market');
  });

  it('Event Mapping 生效：这个世界的分级/通道与天穹不同', () => {
    /* 表是本游戏注册的全局集：storm_brewing 走 critical（天穹的 critical 是 new_day/hour_advanced） */
    expect(levelOf('storm_brewing')).toBe(2);
    expect(channelOf(makeEvent({ type: 'storm_brewing', day: 1 }))).toBe('critical');
    expect(levelOf('hunt_done')).toBe(1);
  });

  it('存档往返：这个世界的状态经引擎 SavePort 落盘可读回', () => {
    const store = new InMemoryWorldStorage<SandWorld>();
    const game = createWorld<SandWorld>({ worldId: 'iron-and-sand-002', savePort: store, labels: { baseYear: 3024 } });
    game.executeCommand({ type: 'move', targetId: 'salt_flats' });
    game.container.save();
    expect(store.load()!.worldId).toBe('iron-and-sand-002');
    expect(store.load()!.player.loc).toBe('salt_flats');
  });
});

/* ============================================================
   卡 C2 · 七塔分置（世界书 §9「七塔架构」+ §11 星符授权）
   一塔一城：一塔圣辉城 / 二塔翠风港 / 三塔金砂城 / 四塔霜锚堡 /
   五塔血吼城 / 六塔深井城 / 七塔天穹之城。
   分置在游戏里的意思：**你栖在哪座塔，就只够得着那座塔的东西**。
   例外只有一条 —— §11「连名星符通行七塔」；无名星符只在本塔有效。
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import type { StarTower } from '@/data/starhub';
import { STARHUB } from '@/data/starhub';
import { WB } from '@/data/worldBook';
import { core } from '@/world/WorldState';
import { newGame } from '@/world/WorldRuntime';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { bus, rng, scheduler, worldBus } from '@/events/EventBus';
import {
  arenaBet,
  enterNet,
  insight,
  isOnline,
  netTower,
  towerBlocks,
  towerHere,
  towerLocalGate,
  towerOf,
  towerPanel,
  towerView,
} from '@/systems/starnet/StarNet';
import { abyssMenu } from '@/systems/dungeon/Abyss';

const s = () => core.S!;
const setSeal = (id: string) => {
  (s().player as { starSeal?: string }).starSeal = id;
};

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  worldBus.reset();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(41);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: 'C2', race: 'human', cls: 'warrior' });
});

describe('卡 C2 · 七塔分置的数据契约（§9）', () => {
  it('七塔齐备：一塔一城、一塔一职，城市与职能都不重样', () => {
    expect(STARHUB.towers.length).toBe(7);
    const locs = STARHUB.towers.map((t) => t.loc);
    expect(new Set(locs).size, '两座塔落在同一个地点就不叫分置了').toBe(7);
    const funcs = STARHUB.towers.map((t) => t.func);
    expect(new Set(funcs).size, '两座塔干同一件事就不叫七塔').toBe(7);
  });

  it('每座塔都在 geo 里的真实地点，且 loc/city/continent 三样齐全', () => {
    for (const t of STARHUB.towers) {
      expect(WB.locations[t.loc], t.id + ' 的 loc 必须是 geo 里的地点').toBeTruthy();
      expect(t.city, t.id + ' 缺 city').toBeTruthy();
      expect(t.continent, t.id + ' 缺 continent').toBeTruthy();
    }
  });

  it('塔的所在地与 geo 记的大陆一致（深井城在地下深渊、金砂城在南方沙漠……）', () => {
    for (const t of STARHUB.towers) {
      const L = WB.locations[t.loc] as unknown as { continent?: string };
      expect(L.continent, t.name).toBe(t.continent);
    }
  });

  it('世界书点名的七塔归属逐条对上（§9 的表格就是这张表）', () => {
    const expectMap: Record<string, [string, string]> = {
      star1: ['plaza', '圣辉城'],
      star2: ['windport', '翠风港'],
      star3: ['goldveil', '金砂城'],
      star4: ['frosthold', '霜锚堡'],
      star5: ['bloodhold', '血吼城'],
      star6: ['deepwell', '深井城'],
      star7: ['skycap', '天穹之城'],
    };
    for (const [id, [loc, city]] of Object.entries(expectMap)) {
      const t = STARHUB.towers.find((x) => x.id === id) as StarTower;
      expect(t, id).toBeTruthy();
      expect(t.loc, id).toBe(loc);
      expect(t.city, id).toBe(city);
    }
  });
});

describe('卡 C2 · 你栖在哪座塔（地理归属）', () => {
  it('站在塔的所在地，就是那座塔', () => {
    for (const t of STARHUB.towers) {
      s().player.loc = t.loc;
      expect(towerHere(s())?.id, t.city).toBe(t.id);
      expect(towerOf(t.loc)?.id).toBe(t.id);
    }
  });

  it('同城的非塔地点回落到该城的塔（圣辉城各处都栖一塔）', () => {
    for (const loc of ['tavern', 'market', 'temple', 'guild', 'gate', 'alley', 'wild', 'cave']) {
      s().player.loc = loc;
      expect(towerHere(s())?.id, loc).toBe('star1');
    }
  });

  it('投影落在本体定神之处：在翠风港入网就栖二塔', () => {
    s().player.loc = 'windport';
    expect(netTower(s())?.id).toBe('star2');
    enterNet();
    expect(netTower(s())?.id).toBe('star2');
  });
});

describe('卡 C2 · 塔功能门禁（§11 连名星符通行七塔）', () => {
  it('连名星符（缺省）：人在圣辉城也能用金砂城的星塔、霜锚堡的星演场', () => {
    enterNet();
    expect(isOnline(s())).toBe(true);
    s().player.loc = 'plaza';
    for (const f of ['market', 'insight', 'trial', 'duel', 'arena', 'council'] as const) {
      expect(towerBlocks(f, s()), f).toBeNull();
    }
  });

  it('无名星符：只在本塔有效，别的塔够不着——且说清那座塔在哪座城', () => {
    enterNet();
    setSeal('anonymous');
    s().player.loc = 'plaza';
    expect(towerBlocks('market', s()), '本塔的功能照旧').toBeNull();
    const why = towerBlocks('trial', s());
    expect(why).toBeTruthy();
    expect(why).toContain('无名星符');
    expect(why).toContain('金砂城');
  });

  it('无名星符走到那座城，那座塔就开了（同时离了自家塔）', () => {
    enterNet();
    setSeal('anonymous');
    s().player.loc = 'goldveil';
    expect(towerBlocks('trial', s())).toBeNull();
    expect(towerBlocks('market', s()), '离开圣辉城，星市也就远了').toBeTruthy();
  });

  it('星殿另需鉴印连名之符（§11）：无名符到了天穹之城也进不去', () => {
    enterNet();
    setSeal('anonymous');
    s().player.loc = 'skycap';
    const why = towerBlocks('council', s());
    expect(why).toBeTruthy();
    expect(why).toContain('星殿');
  });

  it('星渊不靠 status 说了算：魔气未起时哪座塔都打不开门', () => {
    enterNet();
    s().player.loc = 'deepwell';
    const why = towerBlocks('abyss', s());
    expect(why).toBeTruthy();
    expect(why).toContain('星渊');
  });
});

describe('卡 C2 · 端到端：分置真的拦得住', () => {
  it('无名符在圣辉城爬不了金砂城的星塔（不耗时、不产星币）', () => {
    enterNet();
    setSeal('anonymous');
    s().player.loc = 'plaza';
    const t0 = s().t;
    const coin0 = s().net!.starcoin;
    for (let i = 0; i < 5; i++) insight();
    expect(s().t).toBe(t0);
    expect(s().net!.starcoin).toBe(coin0);
  });

  it('连名符同一动作照常推进——分置不是把功能关掉', () => {
    enterNet();
    s().player.loc = 'plaza';
    const t0 = s().t;
    insight();
    expect(s().t).toBeGreaterThan(t0);
  });

  it('未入网时塔功能一律不生效（卡 C1 的定神铁律在前）', () => {
    const t0 = s().t;
    insight();
    arenaBet(10);
    expect(s().t).toBe(t0);
  });
});

describe('卡 C2 · 现实侧门禁与七塔面板', () => {
  it('星渊之门在深井城：人在别处够不着，到了那儿才放行', () => {
    s().player.loc = 'plaza';
    const far = towerLocalGate('abyss', s());
    expect(far).toBeTruthy();
    expect(far).toContain('深井城');
    s().player.loc = 'deepwell';
    expect(towerLocalGate('abyss', s())).toBeNull();
  });

  it('星渊面板：人不在深井城时拒绝，在深井城才摊开（两处都不抛）', () => {
    s().player.loc = 'plaza';
    s().abyss = { leak: 5, sealed: 0 };
    expect(() => abyssMenu()).not.toThrow();
    expect(() => {
      s().player.loc = 'deepwell';
      abyssMenu();
    }).not.toThrow();
  });

  it('towerView：七行、here 唯一、usable 与 why 互斥', () => {
    enterNet();
    s().player.loc = 'bloodhold';
    const rows = towerView(s());
    expect(rows.length).toBe(7);
    expect(rows.filter((r) => r.here).map((r) => r.id)).toEqual(['star5']);
    for (const r of rows) expect(r.usable, r.id).toBe(r.why === null);
    expect(rows.filter((r) => r.usable).length, '连名符通行七塔').toBe(6); // 星渊未开
  });

  it('towerView：无名符下只有本塔可用', () => {
    enterNet();
    setSeal('anonymous');
    s().player.loc = 'windport';
    const rows = towerView(s());
    expect(rows.filter((r) => r.usable).map((r) => r.id)).toEqual(['star2']);
    expect(rows.find((r) => r.id === 'star2')!.here).toBe(true);
  });

  it('towerPanel：网内网外都能开（towerView 的生产消费者，不是只给测试用的 API）', () => {
    expect(() => towerPanel()).not.toThrow();
    enterNet();
    s().player.loc = 'goldveil';
    expect(() => towerPanel()).not.toThrow();
  });

  it('未入网时面板逐行给出「尚未入网」，而不是假装可用', () => {
    s().player.loc = 'plaza';
    const rows = towerView(s());
    expect(rows.every((r) => !r.usable)).toBe(true);
    expect(rows.every((r) => r.why === '尚未入网')).toBe(true);
  });
});

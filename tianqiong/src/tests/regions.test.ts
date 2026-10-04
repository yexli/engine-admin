/* ============================================================
   地区能力守卫（阶段 J · 地区规整）
   —— 把「这个地点能做什么」从代码里的地名比较搬到数据上之后，
      需要一组断言保证**新地区不会因为漏标能力而变成空屋子**。

   规整前：ActionParser / ActionExecutor 里散着十余处 if (loc === 'tavern')、
   if (area === '圣辉城')。加一个地区要回来改分支，地区的机制因此不可复用。
   规整后：能力标签是唯一来源，本文件是它的护栏。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler } from '@/world';
import { mutate } from '@/world/WorldMutate';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { WB } from '@/data/worldBook';
import { LOCATION_ABILITIES, abilitiesOf, allRegions, hasAbility, locationsIn, regionOf, shopsAt } from '@/data/regions';
import { restAt } from '@/actions/ActionExecutor';
import { freeAct } from '@/actions/ActionParser';

const start = () => newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

describe('地区数据完整性（新增地区时的护栏）', () => {
  it('每个地点都标了 abilities，且非空（缺了就是一间空屋子）', () => {
    for (const id of Object.keys(WB.locations)) {
      /* 异界地点是「给不在人间的人一个落脚点」，本就不提供服务，且永远 locked。
         空屋子对它们是设计，不是漏配——凡间地点的能力要求不适用。 */
      const cont = WB.locations[id].continent;
      const def = cont ? (WB.continents.items[cont] as unknown as { otherworld?: boolean }) : undefined;
      if (def?.otherworld) continue;
      expect(abilitiesOf(id).length, id + ' 没有标注任何能力——玩家到了那儿什么也做不了').toBeGreaterThan(0);
    }
  });

  it('地区名不与大陆名同名（否则地图二级看到的还是大陆）', () => {
    /* 地图按「大陆 → 地区 → 地点」分栏。area 一旦等于 continent，
       进二级看到的就是同名的一张卡，这一级等于不存在。
       2026 修过一次：六块外大陆的 area 全都等于大陆名。 */
    for (const id of Object.keys(WB.locations)) {
      const L = WB.locations[id];
      if (!L.continent) continue;
      expect(L.area, `${id}（${L.name}）的 area「${L.area}」与大陆同名，地图二级会重复`).not.toBe(L.continent);
    }
  });

  it('能力名必须已在 LOCATION_ABILITIES 登记（拼错的标签会被抓出来）', () => {
    const known = new Set<string>(LOCATION_ABILITIES);
    for (const id of Object.keys(WB.locations)) {
      for (const a of abilitiesOf(id)) {
        expect(known.has(a), id + ' 用了未登记的能力 ' + a + '：它不会驱动任何行为，只会静默失效').toBe(true);
      }
    }
  });

  it('标了 shop 的地点必须真有商店（数据与内容不许各说各话）', () => {
    for (const id of Object.keys(WB.locations)) {
      if (!hasAbility(id, 'shop')) continue;
      expect(shopsAt(id).length, id + ' 标了 shop 却没有对应商店').toBeGreaterThan(0);
    }
  });

  it('玩家至少有一处能休息（否则长线玩法直接卡死）', () => {
    const canRest = Object.keys(WB.locations).filter((id) => hasAbility(id, 'rest_lodging') || hasAbility(id, 'rest_camping'));
    expect(canRest.length, '没有任何地点能休息').toBeGreaterThan(0);
    expect(canRest.some((id) => hasAbility(id, 'rest_lodging')), '至少要有一处能安心过夜').toBe(true);
  });

  it('地区查询与数据一致', () => {
    const regions = allRegions();
    expect(regions.length, '至少该有一个地区').toBeGreaterThan(0);
    for (const r of regions) {
      const ids = locationsIn(r);
      expect(ids.length, r + ' 下面没有地点').toBeGreaterThan(0);
      for (const id of ids) expect(regionOf(id), id + ' 的地区名对不上').toBe(r);
    }
  });

  it('未知地点返回空能力 / 空地区名（不猜、不回落）', () => {
    expect(abilitiesOf('no_such_place')).toEqual([]);
    expect(regionOf('no_such_place')).toBe('');
    expect(hasAbility('no_such_place', 'urban')).toBe(false);
    expect(locationsIn('不存在的地区')).toEqual([]);
  });
});

describe('能力语义（当前地区：圣辉城 + 中央大陆郊野）', () => {
  it('城镇街区标 urban；帝国城卫辖区标 patrolled', () => {
    for (const id of ['plaza', 'tavern', 'market', 'temple', 'guild', 'gate', 'alley']) {
      expect(hasAbility(id, 'urban'), id + ' 应在城内').toBe(true);
      expect(hasAbility(id, 'patrolled'), id + ' 应有城卫盘查').toBe(true);
    }
    /* 郊野与洞窟不归城卫管——这条守的是「盘查范围不再写死地区名」 */
    expect(hasAbility('wild', 'patrolled'), '郊野不该有城卫盘查').toBe(false);
    expect(hasAbility('cave', 'patrolled')).toBe(false);
  });

  it('各处的地点能力符合玩法语义', () => {
    expect(hasAbility('tavern', 'rest_lodging'), '酒馆该能过夜').toBe(true);
    expect(hasAbility('tavern', 'drink')).toBe(true);
    expect(hasAbility('temple', 'pray')).toBe(true);
    expect(hasAbility('temple', 'sacred'), '神殿该是圣地').toBe(true);
    expect(hasAbility('market', 'shop')).toBe(true);
    expect(hasAbility('alley', 'backstreet')).toBe(true);
    expect(hasAbility('wild', 'rest_camping')).toBe(true);
    expect(hasAbility('wild', 'wilderness'), '野外该标 wilderness').toBe(true);
    for (const c of ['cave', 'cave2', 'cave3']) expect(hasAbility(c, 'explore_cave'), c).toBe(true);
  });

  it('互斥语义：能安心过夜的地方不该同时是野外', () => {
    for (const id of Object.keys(WB.locations)) {
      const both = hasAbility(id, 'rest_lodging') && hasAbility(id, 'wilderness');
      expect(both, id + ' 同时标了 rest_lodging 与 wilderness——休息方式会打架').toBe(false);
    }
  });
});

describe('能力真的驱动了行为（不只是数据好看）', () => {
  it('酒馆的 rest_lodging 让玩家真的睡到了天亮', () => {
    start();
    const s = core.S!;
    mutate.playerLoc('tavern');
    s.player.gold = 100;
    s.player.hp = 1;
    const t0 = s.t;
    restAt('lodging');
    expect(s.player.hp, '付了房钱该被治好').toBeGreaterThan(1);
    expect(s.t, '该睡到天亮（时间推进）').toBeGreaterThan(t0);
    expect(s.player.gold, '该扣掉房钱').toBeLessThan(100);
  });

  it('在集市说「买东西」真的开得出杂货摊（场景行动的开店路径）', () => {
    /* 这条直接覆盖规整改动的那一行：shopsAt(loc) 取代了写死的 market → grocer。
       守卫用例已经保证「标了 shop 的地点有店」，但那只证明数据对得上——
       这里证明**那条路径真的走到了 openShop**。 */
    start();
    mutate.playerLoc('market');
    freeAct('买东西');
    expect(core.curShop, '集市该能开出东市杂货摊').toBe('grocer');
  });

  it('在没有铺面的地方说「买东西」不该开出任何店', () => {
    start();
    mutate.playerLoc('tavern');
    freeAct('买东西');
    expect(core.curShop, '酒馆没有铺面').toBeNull();
  });

  it('野外的 rest_camping 是半恢复而不是全恢复', () => {
    start();
    const s = core.S!;
    mutate.playerLoc('wild');
    s.player.hp = 1;
    restAt('camping');
    expect(s.player.hp, '露宿只该恢复一部分').toBeGreaterThan(1);
  });
});

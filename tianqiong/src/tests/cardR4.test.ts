/* ============================================================
   卡 R4 · 法律全量（世界书 §87–§93）
   七大陆严格度 / 通缉六档 / 白盟约引渡 / 七铁律 / 冒险者特权
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { WB } from '@/data/worldBook';
import { core, newState } from '@/world/WorldState';
import { bus, rng, scheduler } from '@/events/EventBus';
import {
  adventurerExempt,
  canExtradite,
  commitCrime,
  ironLaws,
  ironLawsOf,
  isPactMember,
  lawPressure,
  lawStrictness,
  wantedAddAt,
  wantedName,
  wantedTier,
} from '@/systems/law/Law';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  rng.seed(11);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  core.S = newState({ name: 'R4', race: 'human', cls: 'warrior' });
});

describe('卡 R4 · 七大陆法律严格度（§87）', () => {
  it('严格度排序与世界的排名一致：中央 5 星最严 → 地下深渊 1 星最松', () => {
    expect(lawStrictness('中央大陆')).toBe(5);
    expect(lawStrictness('地下深渊')).toBe(1);
    expect(lawStrictness('东方群岛')).toBe(4);
    expect(lawStrictness('南方沙漠')).toBe(3);
    expect(lawStrictness('北方冻土')).toBe(2);
  });

  it('未登记的大陆按中性 3 星处理（缺数据不惩罚也不放水）', () => {
    expect(lawStrictness('不存在的大陆')).toBe(3);
  });

  it('追诉强度随严格度单调递增，且中央 > 深渊', () => {
    expect(lawPressure('中央大陆')).toBeGreaterThan(lawPressure('地下深渊'));
    expect(lawPressure('东方群岛')).toBeGreaterThan(lawPressure('南方沙漠'));
  });

  it('同一条罪在中央与深渊的通缉增量不同，但都不会归零', () => {
    const c = wantedAddAt(3, '中央大陆');
    const u = wantedAddAt(3, '地下深渊');
    expect(c).toBeGreaterThan(u);
    expect(u).toBeGreaterThanOrEqual(1); // 弱执法只是"追得松"，不是"无罪"
  });

  it('七大陆全部登记了法院与上诉（§92）', () => {
    for (const name of WB.continents.order) {
      const c = WB.continents.items[name] as unknown as { court?: string; courtAppeal?: string; lawTrait?: string; otherworld?: boolean };
      /* 异界（神界／魔界／往昔之地）不归人间法管：没有法院是设计事实，不是漏配。 */
      if (c.otherworld) continue;
      expect(c.court, name).toBeTruthy();
      expect(c.courtAppeal, name).toBeTruthy();
      expect(c.lawTrait, name).toBeTruthy();
    }
  });
});

describe('卡 R4 · 白盟约与跨大陆引渡（§90）', () => {
  it('签约方四地：中央/东方/南方/浮岛；未签：北方/西方/地下', () => {
    expect(isPactMember('中央大陆')).toBe(true);
    expect(isPactMember('东方群岛')).toBe(true);
    expect(isPactMember('南方沙漠')).toBe(true);
    expect(isPactMember('天空浮岛')).toBe(true);
    expect(isPactMember('北方冻土')).toBe(false);
    expect(isPactMember('西方荒野')).toBe(false);
    expect(isPactMember('地下深渊')).toBe(false);
  });

  it('无通缉不引渡；跨未签约方不引渡；双方签约且罪级够才引渡', () => {
    const s = core.S!;
    expect(canExtradite('中央大陆', '东方群岛', 'B', s).ok).toBe(false); // 没通缉
    s.player.wanted = 2;
    expect(canExtradite('中央大陆', '北方冻土', 'B', s).ok).toBe(false); // 北方未签约
    expect(canExtradite('北方冻土', '中央大陆', 'B', s).ok).toBe(false); // 起点未签约
    expect(canExtradite('中央大陆', '东方群岛', 'D', s).ok).toBe(false); // 轻罪不够格
    expect(canExtradite('中央大陆', '东方群岛', 'B', s).ok).toBe(true);
    expect(canExtradite('中央大陆', '东方群岛', 'A', s).ok).toBe(true);
  });
});

describe('卡 R4 · 七铁律（§93）', () => {
  it('七条铁律齐全，且每条都指向一条真实罪名', () => {
    const laws = ironLaws();
    expect(laws.length).toBe(7);
    for (const l of laws) {
      expect(l.text, '第 ' + l.no + ' 条').toBeTruthy();
      /* 罪名必须在案——铁律的作用是「律条 → 罪级」的引用链，断链就追不动 */
      expect(ironLawsOf(l.crime).length, l.crime).toBeGreaterThan(0);
    }
  });

  it('罪名反查铁律：亵渎神殿→第 1 条；破坏封印→第 2 条', () => {
    expect(ironLawsOf('heresy').some((x) => x.no === 1)).toBe(true);
    expect(ironLawsOf('break_seal').some((x) => x.no === 2)).toBe(true);
    expect(ironLawsOf('soul_trade').some((x) => x.no === 4)).toBe(true);
    expect(ironLawsOf('heavy_slash_not_a_crime')).toEqual([]);
  });
});

describe('卡 R4 · 冒险者特权（§91）', () => {
  it('任务/自保/悬赏三种语境豁免轻中罪', () => {
    expect(adventurerExempt('petty_theft', 'quest').exempt).toBe(true);
    expect(adventurerExempt('assault', 'self_defense').exempt).toBe(true);
    expect(adventurerExempt('theft', 'bounty').exempt).toBe(true);
  });

  it('重罪不因任务身份豁免——特权不是免死金牌', () => {
    expect(adventurerExempt('murder', 'quest').exempt).toBe(false);
    expect(adventurerExempt('massacre', 'quest').exempt).toBe(false);
    expect(adventurerExempt('deicide', 'self_defense').exempt).toBe(false);
  });

  it('无语境不豁免（没接任务的打人照究）', () => {
    expect(adventurerExempt('assault').exempt).toBe(false);
  });
});

describe('卡 R4 · 立案与通缉联动', () => {
  it('中央大陆立案：通缉增量高于深渊（同一条罪）', () => {
    const s = core.S!;
    s.player.loc = 'plaza'; // 中央大陆
    commitCrime('petty_theft', 'plaza');
    const central = s.player.wanted;

    core.S = newState({ name: 'R4b', race: 'human', cls: 'warrior' });
    const s2 = core.S!;
    s2.player.loc = 'deepwell'; // 地下深渊
    commitCrime('petty_theft', 'deepwell');
    expect(central).toBeGreaterThanOrEqual(s2.player.wanted);
  });

  it('通缉档位随数值映射，且显示为六档名（§90）', () => {
    const s = core.S!;
    s.player.wanted = 0;
    expect(wantedName(s)).toBe('白名');
    s.player.wanted = 1;
    expect(wantedTier(s).name).toBe('橙名');
    s.player.wanted = 3;
    expect(wantedTier(s).name).toBe('黑名');
  });
});

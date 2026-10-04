/* ============================================================
   卡 R2 · 境界六阶与细分（世界书 §29–§30）
   原 ranks 缺第 1 阶「信徒」、末阶误标「圣徒」；§30 的圣阶/神阶细分与各系别称无载体。
   本用例钉住：六阶齐全、细分映射、别称表、以及「规则判定用通用境界名」这条分工。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { WB } from '@/data/worldBook';
import { core, newState } from '@/world/WorldState';
import { rankAliases, rankFull, rankName, rankSub, rankTierName } from '@/systems/character/Derived';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  core.S = newState({ name: 'R2', race: 'human', cls: 'warrior' });
});

describe('卡 R2 · 通用六阶（§29）', () => {
  it('六阶齐全且顺序正确：信徒→见习→正式→主教→圣徒→神阶', () => {
    expect(WB.ranks.map((r) => r.name)).toEqual(['信徒', '见习', '正式', '主教', '圣徒', '神阶']);
    expect(WB.ranks.map((r) => r.tier)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('每阶都有特征说明（面板与叙事可直接引用）', () => {
    for (const r of WB.ranks) expect(r.feature, r.name).toBeTruthy();
  });

  it('等级→境界一致：Lv.3 是「正式」，不再是旧表的「见习」', () => {
    const s = core.S!;
    s.player.level = 3;
    expect(rankTierName(s)).toBe('正式');
    s.player.level = 1;
    expect(rankTierName(s)).toBe('信徒');
    s.player.level = 6;
    expect(rankTierName(s)).toBe('神阶');
  });

  it('越界等级回落末阶，不返回 undefined', () => {
    const s = core.S!;
    s.player.level = 99;
    expect(rankTierName(s)).toBe('神阶');
  });
});

describe('卡 R2 · 细分与别称（§29 末两阶 / §30）', () => {
  it('中间等级无细分，末两阶才有', () => {
    const s = core.S!;
    for (const lv of [1, 2, 3, 4]) {
      s.player.level = lv;
      expect(rankSub(s), 'Lv.' + lv).toBe('');
    }
    s.player.level = 5;
    expect(rankSub(s)).toBe('圣阶·中');
    s.player.level = 6;
    expect(rankSub(s)).toBe('圣阶·极');
  });

  it('细分链条完整：圣阶·中/高/极 与 神官级/神将级/神王级', () => {
    expect((WB.rankTiers?.[5] ?? []).map((x) => x.name)).toEqual(['圣阶·中', '圣阶·高', '圣阶·极']);
    expect((WB.rankTiers?.[6] ?? []).map((x) => x.name)).toEqual(['神官级', '神将级', '神王级']);
  });

  it('§30 别称表可查：圣阶·极 → 剑圣级/武圣级/法圣级/匠圣级', () => {
    const s = core.S!;
    s.player.level = 6;
    const al = rankAliases(s);
    expect(al.some((x) => x.includes('剑圣级'))).toBe(true);
    expect(al.some((x) => x.includes('匠圣级'))).toBe(true);
  });

  it('rankFull 组合称号与细分；无细分时自动降级为纯称号', () => {
    const s = core.S!;
    s.player.level = 6;
    expect(rankFull(s)).toContain('·圣阶·极');
    s.player.level = 2;
    expect(rankFull(s)).not.toContain('·'); // 职业链称号无细分
  });

  it('分工：rankName 是「被怎么称呼」，rankTierName 是「落在哪一阶」', () => {
    const s = core.S!;
    s.player.level = 3;
    expect(rankName(s)).toBe('剑师'); // 职业链称号（warrior.path[2]）
    expect(rankTierName(s)).toBe('正式'); // 通用境界
  });
});

/* ============================================================
   卡 E5 · 势力扩到十（世界书 §12）
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { WB } from '@/data/worldBook';
import { newState } from '@/world';
import { initPlayerRep, relBetween, standingBetween } from '@/systems/faction/Factions';

describe('卡 E5 · 十四势力', () => {
  it('世界书含 14 个势力（神殿拆五后），且 FactionId 全有名称', () => {
    expect(Object.keys(WB.factions).length).toBe(14);
    for (const f of ['frost', 'verdant', 'sand', 'blood', 'deep']) expect(WB.factions[f as keyof typeof WB.factions]).toBeTruthy();
  });
  it('newState 初始化 14 势力声望为 0，playerRep 覆盖全 14', () => {
    const s = newState({ name: 'X', race: 'human', cls: 'warrior' });
    expect(Object.keys(s.rep).length).toBe(14);
    initPlayerRep(s);
    expect(Object.keys(s.playerRep!).length).toBe(14);
  });
  it('新势力入矩阵：苍翠↔血吼 世仇（高敌意·负通商），霜铁↔幽暗 同族（高态度）', () => {
    const s = newState({ name: 'X', race: 'human', cls: 'warrior' });
    const vb = relBetween('verdant', 'blood', s);
    expect(vb.hostility).toBeGreaterThanOrEqual(60);
    expect(vb.trade).toBeLessThan(0);
    expect(standingBetween('frost', 'deep', 'attitude', s)).toBeGreaterThanOrEqual(30);
  });
  it('旧五势力关系不破（D3 断言）：暗影↔公会 通商友好但互不信任', () => {
    const s = newState({ name: 'X', race: 'human', cls: 'warrior' });
    expect(standingBetween('shadow', 'guild', 'trade', s)).toBeGreaterThan(0);
    expect(standingBetween('shadow', 'guild', 'trust', s)).toBeLessThan(0);
  });
});

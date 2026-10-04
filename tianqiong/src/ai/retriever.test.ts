/* lore 数据契约 + 检索层单测（纯函数、确定性、不触网/不依赖 WorldState） */
import { describe, it, expect } from 'vitest';
import { LORE, loadPersonLore, type LoreCard } from '@/data/lore';
import { matchLore, loreLines, loreCanonBlock, canonicalCards, persistentCanon } from './retriever';

describe('lore 数据契约', () => {
  it('每卡有 id/topic/seed 且 id 唯一', () => {
    const ids = new Set<string>();
    for (const c of LORE) {
      expect(c.id).toBeTruthy();
      expect(c.topic).toBeTruthy();
      expect(c.seed.length).toBeGreaterThan(0);
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
    }
  });
  it('§7 时间流速订正为 1:5、不再含 1:7', () => {
    const s7 = LORE.find((c) => c.id === 's7') as LoreCard;
    expect(s7.canon).toContain('1:5');
    expect(s7.canon).not.toMatch(/1:7|7:1/);
  });
});

describe('matchLore 检索', () => {
  it('按地点关键词命中相关设定卡', () => {
    const cards = matchLore({ area: '圣辉城', locName: '圣辉城 · 集市' }, { max: 6 });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(6);
  });
  it('按在场 NPC 名命中其人物 canon（懒加载后）', async () => {
    await loadPersonLore();
    const cards = matchLore({ npcNames: ['莉塔'] }, { max: 3 });
    expect(cards.some((c) => c.kind === 'person' && c.name.includes('莉塔'))).toBe(true);
  });
  it('空查询返回空（不注入噪声）', () => {
    expect(matchLore({}, { max: 5 })).toEqual([]);
  });
  it('结果确定性：同输入两次一致', () => {
    const q = { area: '中央大陆', locName: '酒馆', npcNames: ['布伦丹'] };
    expect(matchLore(q, { max: 5 }).map((c) => c.id)).toEqual(matchLore(q, { max: 5 }).map((c) => c.id));
  });
});

describe('卡 R7 · 常驻准则层（constant 卡的唯一消费者）', () => {
  it('constant 卡全部进常驻池，且按优先级排序（NPC 准则在最前）', () => {
    const cards = canonicalCards();
    const 应然 = LORE.filter((c) => c.constant === true).length;
    expect(cards.length).toBe(应然);
    expect(cards.length).toBeGreaterThan(0);
    /* 优先级表把 §118–121 放在最前：NPC 行为准则是「角色是否像人」的红线，
       必须优先于任何背景设定进上下文。 */
    expect(cards[0].num).toBeLessThanOrEqual(121);
    expect(cards.slice(0, 4).map((c) => c.num).sort((a, b) => b - a)).toContain(121);
  });
  it('常驻块受预算约束，且每行以 · 开头', () => {
    const p = persistentCanon(300);
    expect(p.used).toBeGreaterThan(0);
    const lines = p.text.split(String.fromCharCode(10)).filter(Boolean);
    expect(lines.every((l) => l.startsWith('· '))).toBe(true);
    expect(p.text.length).toBeLessThanOrEqual(300 + 80); // 容一行越界（截断按整行判）
  });
  it('小预算不会空手而归：至少注入优先级最高的那一张', () => {
    const p = persistentCanon(10);
    expect(p.used).toBeGreaterThanOrEqual(1);
  });
  it('常驻层与场景检索互不干扰（预算各自独立）', () => {
    const scene = matchLore({ area: '圣辉城', locName: '集市' }, { max: 5 });
    const before = scene.map((c) => c.id);
    const p = persistentCanon(900);
    expect(p.used).toBeGreaterThan(0);
    const after = matchLore({ area: '圣辉城', locName: '集市' }, { max: 5 }).map((c) => c.id);
    expect(after).toEqual(before); // 常驻层不改变场景检索结果
  });
  it('37 张常驻卡在 900 字符预算内能注入大部分（防止未来数据膨胀后静默只喂 1 条）', () => {
    const p = persistentCanon(900);
    const total = LORE.filter((c) => c.constant === true).length;
    expect(p.used).toBeGreaterThanOrEqual(Math.floor(total * 0.4));
  });
});

describe('prompt 组装', () => {
  it('loreCanonBlock 不超预算且每行以 · 开头', () => {
    const cards = matchLore({ area: '圣辉城', locName: '圣辉城' }, { max: 20 });
    const block = loreCanonBlock(cards, 120);
    expect(block.length).toBeLessThanOrEqual(120 + 12); // 容一行边界
    if (block) expect(block.split('\n').every((l) => l.startsWith('· '))).toBe(true);
  });
  it('loreLines 一卡一行', () => {
    const cards = matchLore({ area: '圣辉城' }, { max: 4 });
    expect(loreLines(cards)).toHaveLength(cards.length);
  });
});

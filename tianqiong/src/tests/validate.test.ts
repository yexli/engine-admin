import { describe, expect, it } from 'vitest';
import { newState } from '@/world/WorldState';
import { validateState } from '@/validation/RuleValidator';

/* F-02 验收：结构不全 / 越界 / 脏键一律拒绝，且任何输入都不抛错 */
describe('validateState · 存档结构校验', () => {
  it('空对象与缺字段被拒', () => {
    expect(validateState({})).toBeTruthy();
    expect(validateState({ ver: 1, player: {} })).toBeTruthy();
    expect(validateState(null)).toBeTruthy();
    expect(validateState('not json')).toBeTruthy();
  });

  it('姓名超长或含标签字符被拒', () => {
    const base = newState({ name: '无名旅人', race: 'human', cls: 'warrior' });
    expect(validateState(base)).toBeNull();
    expect(validateState({ ...base, player: { ...base.player, name: '一二三四五六七八九十十一十二十三' } })).toBeTruthy();
    expect(validateState({ ...base, player: { ...base.player, name: '<b>x</b>' } })).toBeTruthy();
    expect(validateState({ ...base, player: { ...base.player, name: '' } })).toBeTruthy();
  });

  it('等级越界与金币 NaN 被拒', () => {
    const base = newState({ name: '无名旅人', race: 'human', cls: 'warrior' });
    expect(validateState({ ...base, player: { ...base.player, level: 99 } })).toBeTruthy();
    expect(validateState({ ...base, player: { ...base.player, level: 0 } })).toBeTruthy();
    expect(validateState({ ...base, player: { ...base.player, gold: NaN } })).toBeTruthy();
    expect(validateState({ ...base, player: { ...base.player, gold: -1 } })).toBeTruthy();
  });

  it('背包未知物品 id 被拒', () => {
    const base = newState({ name: '无名旅人', race: 'human', cls: 'warrior' });
    expect(validateState({ ...base, player: { ...base.player, bag: [{ id: 'nope', qty: 1 }] } })).toBeTruthy();
    expect(validateState({ ...base, player: { ...base.player, bag: [{ id: 'moonherb', qty: 0 }] } })).toBeTruthy();
  });

  it('声望脏键被拒，合法十势力通过', () => {
    const base = newState({ name: '无名旅人', race: 'human', cls: 'warrior' });
    expect(validateState({ ...base, rep: { ...base.rep, nope: 5 } })).toBeTruthy();
  });

  it('字段缺失放行（由 hydrate 按 §4 旧档可读补齐）', () => {
    expect(validateState({ ver: 1, player: { name: 'X', gold: 500 }, rep: {}, log: [] })).toBeNull();
  });

  it('字段存在但类型错被拒', () => {
    const base = newState({ name: '无名旅人', race: 'human', cls: 'warrior' });
    expect(validateState({ ...base, log: 'x' })).toBeTruthy();
    expect(validateState({ ...base, npcs: [] })).toBeTruthy();
    expect(validateState({ ...base, t: -1 })).toBeTruthy();
  });
});

/* ============================================================
   C 卡 · 对话预算账本（《NPC 立体化与深入对话方案》§4.1(c)）的回归防线。
   守四条：

   ① 五块之和不得超过场景上限——账本不是「想给多少给多少」；
   ② 档位真的分流：世界重要度高 / LOD 近 → 人设与 canon 的额度更大
      （此前人设只按通道分，神祇与报童同长）；
   ③ 通道上限与档位上限**都要满足**（取小）：一个报童不会因为「在聊天通道」
      就拿到 300 字传记；
   ④ 比例被改坏时不许把整块预算变成 0——静默变空比截断难查一百倍。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { chatBudget, personaCharsFor, resolveBudget } from '@/systems/npc/ContextProfile';

const SCENES = ['npc_dialogue', 'world_reasoner', 'quest'] as const;
const LODS = ['L0', 'L1', 'L2'] as const;

describe('C 卡 · 对话预算账本', () => {
  it('五块之和 = 总字数（比例之和为 1，四舍五入误差 ≤ 2 字）', () => {
    for (const imp of [0, 1, 2, 3, 4]) {
      for (const lod of LODS) {
        for (const sc of SCENES) {
          const p = chatBudget(imp, lod, sc);
          const sum = p.persona + p.memory + p.canon + p.relations + p.reserve;
          expect(Math.abs(sum - p.chars), imp + '/' + lod + '/' + sc + ' 分块之和与总字数不符').toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('tokens 与 resolveBudget 同源（min(场景上限, Profile 上限)）', () => {
    for (const imp of [0, 2, 4]) {
      for (const lod of LODS) {
        expect(chatBudget(imp, lod, 'npc_dialogue').tokens).toBe(resolveBudget(imp, lod, 'npc_dialogue').tokens);
      }
    }
  });

  it('档位分流：世界重要度越高、关系越近，额度越大；背景路人不吃满预算', () => {
    const god = chatBudget(4, 'L0', 'npc_dialogue');
    const mortal = chatBudget(1, 'L2', 'npc_dialogue');
    expect(god.persona).toBeGreaterThan(mortal.persona);
    expect(god.canon).toBeGreaterThan(mortal.canon);
    expect(mortal.chars, '背景路人的总预算应明显小于世界级 NPC').toBeLessThan(god.chars * 0.8);
    expect(mortal.memory).toBeLessThan(god.memory);
    /* 同一重要度下 LOD 由远到近，额度只增不减 */
    const far = chatBudget(2, 'L2', 'npc_dialogue');
    const near = chatBudget(2, 'L0', 'npc_dialogue');
    expect(near.memory).toBeGreaterThanOrEqual(far.memory);
  });

  it('记忆块不再吃满整个场景预算（此前 tokens 直接给的是场景上限）', () => {
    const p = chatBudget(3, 'L0', 'npc_dialogue');
    expect(p.memory, '记忆只该拿自己的那一份').toBeLessThan(p.chars);
    expect(p.persona + p.canon, '人设与 canon 拿到的份额应大于零').toBeGreaterThan(0);
  });
});

describe('C 卡 · 人设字数上限（通道 × 档位取小）', () => {
  it('聊天通道：maximum 仍是 300（通道上限更严），minimal 降到 120（档位更严）', () => {
    expect(personaCharsFor('chat', 'maximum')).toBe(300);
    expect(personaCharsFor('chat', 'minimal')).toBe(120);
  });

  it('开场白通道同理，且五档单调不减', () => {
    const order = ['minimal', 'low', 'medium', 'high', 'maximum'] as const;
    let prev = 0;
    for (const pf of order) {
      const v = personaCharsFor('greet', pf);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(240);
      prev = v;
    }
  });
});

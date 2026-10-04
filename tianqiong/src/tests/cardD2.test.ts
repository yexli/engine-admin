/* ============================================================
   卡 D2 · NPC 关系网 + 消息传播 + 记忆分级压缩
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler, newGame } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { addMem } from '@/systems/npc/Npcs';
import { adjRel, relOf, relsOf, spreadRumor } from '@/systems/relationship/Relations';
import { memOf, memoriesOf, memoryCount } from '@/memory';

beforeEach(() => {
  core.S = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  const r = rng.seed(11);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return r;
});

const start = () => newGame({ name: 'D2', race: 'human', cls: 'warrior' });

describe('卡 D2 · 关系网（NPC↔NPC）', () => {
  it('hydrate 惰性从世界书种子投影关系边；非对称保留', () => {
    start();
    const s = core.S!;
    expect(relOf('lita', 'joe', s)?.type).toBe('creditor'); // 莉安视老乔为欠债人
    expect(relOf('joe', 'lita', s)?.type).toBe('debtor'); // 反向为欠账者，非对称
    expect(relOf('lita', 'galon', s)?.val).toBe(25);
    expect(relOf('lita', 'adrian', s)).toBeNull(); // 无关系
  });
  it('adjRel 调整强度并 clamp ±100、记一条 rel 记忆', () => {
    start();
    const s = core.S!;
    adjRel('brendan', 'vandel', 200, '共事');
    expect(relsOf('brendan', s)['vandel'].val).toBe(100); // 封顶
    expect(memOf('brendan', core.S!).some((m) => m.event.includes('关系·'))).toBe(true);
    expect(memoriesOf('brendan', core.S!).some((m) => m.type === 'personal_event'), '关系类记忆按个人事件归档').toBe(true);
  });
});

describe('卡 D2 · 消息传播（沿关系边、imp 衰减、去环）', () => {
  it('莉安散布话题 → 深交者（老乔/戈林）听闻并记 event 记忆', () => {
    start();
    const s = core.S!;
    const heard = spreadRumor('lita', '有人在深巷销赃', 3, s);
    expect(heard).toContain('joe');
    expect(heard).toContain('galon');
    expect(heard).not.toContain('lita'); // 不传回自己（visited）
    expect(memOf('joe', s).some((m) => m.event.includes('传闻'))).toBe(true);
  });
  it('imp<=0 时停止扩散（自然收敛，不成环）', () => {
    start();
    const s = core.S!;
    expect(spreadRumor('lita', '秘闻', 0, s)).toEqual([]);
  });
});

describe('卡 D2 · 记忆容量（统一由记忆表执行；老表的压缩归档已退役）', () => {
  it('超过容量上限按强度淘汰：弱记忆先走，高重要度留得住', () => {
    start();
    const s = core.S!;
    addMem('selina', '唯一的重要事', 3); // imp=3 → 0.7，强度最高
    for (let i = 0; i < 100; i++) addMem('selina', `琐事${i}`, 1);
    expect(memoryCount(s, 'selina')).toBeLessThanOrEqual(80); // 封顶（MEMORY_CAP）
    expect(
      memoriesOf('selina', s).some((m) => m.content === '唯一的重要事'),
      '高重要度不因容量被淘汰',
    ).toBe(true);
  });
  it('未超上限时 addMem 只追加（不多写、不丢条数）', () => {
    start();
    const s = core.S!;
    addMem('mia', '卖了一份报纸', 1);
    expect(memOf('mia', s).length).toBe(1);
    expect(memOf('mia', s)[0].event).toBe('卖了一份报纸');
  });
});

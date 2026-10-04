import { describe, expect, it } from 'vitest';
import { buildPromptBlock, DEFAULT_EMBEDS, DEFAULT_PROMPT, type PromptConfig } from './promptPreset';
import { injectUserPrompt } from './openaiCompat';

const base = (patch: Partial<PromptConfig> = {}): PromptConfig => ({ ...DEFAULT_PROMPT, embeds: [], ...patch });

describe('提示词组装（promptPreset）', () => {
  it('总开关关掉时一段都不注入——行为与没有本功能时逐字相同', () => {
    expect(buildPromptBlock({ ...DEFAULT_PROMPT, enabled: false }, 'chat')).toBe('');
    expect(buildPromptBlock(undefined, 'chat')).toBe('');
  });

  it('默认配置只注入人称（嵌入条目为空），人称与内置风格同义', () => {
    const out = buildPromptBlock(DEFAULT_PROMPT, 'chat');
    expect(out).toContain('第二人称');
    expect(DEFAULT_PROMPT.embeds).toHaveLength(0);
  });

  it('嵌入条目按权重降序，权重只决定顺序不改变内容', () => {
    const cfg = base({
      embeds: [
        { id: 'a', name: 'A', text: '低权', weight: 10, enabled: true, channels: 'all' },
        { id: 'b', name: 'B', text: '高权', weight: 90, enabled: true, channels: 'all' },
        { id: 'c', name: 'C', text: '中权', weight: 50, enabled: true, channels: 'all' },
      ],
    });
    const out = buildPromptBlock(cfg, 'intent');
    expect(out.indexOf('高权')).toBeLessThan(out.indexOf('中权'));
    expect(out.indexOf('中权')).toBeLessThan(out.indexOf('低权'));
  });

  it('通道限定生效：不匹配的条目不会注入', () => {
    const cfg = base({ embeds: [{ id: 'x', name: 'X', text: '只给叙事', weight: 50, enabled: true, channels: ['narrative'] }] });
    expect(buildPromptBlock(cfg, 'narrative')).toContain('只给叙事');
    expect(buildPromptBlock(cfg, 'intent')).toBe('');
    const all = base({ embeds: [{ id: 'y', name: 'Y', text: '全体', weight: 50, enabled: true, channels: 'all' }] });
    expect(buildPromptBlock(all, 'reason')).toContain('全体');
  });

  it('关掉的条目与空文本条目都不注入', () => {
    const cfg = base({
      embeds: [
        { id: 'a', name: 'A', text: '被关掉', weight: 99, enabled: false, channels: 'all' },
        { id: 'b', name: 'B', text: '   ', weight: 98, enabled: true, channels: 'all' },
        { id: 'c', name: 'C', text: '留着', weight: 1, enabled: true, channels: 'all' },
      ],
    });
    const out = buildPromptBlock(cfg, 'intent');
    expect(out).toContain('留着');
    expect(out).not.toContain('被关掉');
  });

  it('人称只进「讲故事」的通道；解析器与推演通道只拿嵌入条目', () => {
    const cfg = base({ person: 'first' });
    expect(buildPromptBlock(cfg, 'narrative')).toContain('第一人称');
    expect(buildPromptBlock(cfg, 'chat')).toContain('第一人称');
    expect(buildPromptBlock(cfg, 'intent')).not.toContain('人称');
    expect(buildPromptBlock(cfg, 'reason')).not.toContain('人称');
  });

  it('系统提示词排在最前（优先级最高）', () => {
    const cfg = base({ systemPrompt: '最高优先级的指令', embeds: [{ id: 'a', name: 'A', text: '普通条目', weight: 100, enabled: true, channels: 'all' }] });
    const out = buildPromptBlock(cfg, 'chat');
    expect(out.indexOf('最高优先级的指令')).toBeLessThan(out.indexOf('普通条目'));
  });

  it('超预算从尾部整条丢弃，不切句子', () => {
    const long = 'x'.repeat(60);
    const cfg = base({
      embeds: [
        { id: 'a', name: 'A', text: '甲' + long, weight: 90, enabled: true, channels: 'all' },
        { id: 'b', name: 'B', text: '乙' + long, weight: 50, enabled: true, channels: 'all' },
      ],
    });
    /* intent 通道没有叙事方式/人称，块内容 = 两条嵌入条目，预算设成只装得下第一条 */
    const out = buildPromptBlock(cfg, 'intent', 70);
    expect(out).toContain('甲');
    expect(out).not.toContain('乙');
    expect(out).not.toContain('…');
  });

  it('示例条目是一份可直接载入的基线（供面板的「载入示例」用）', () => {
    expect(DEFAULT_EMBEDS.length).toBeGreaterThan(0);
    for (const e of DEFAULT_EMBEDS) {
      expect(e.text.length).toBeGreaterThan(4);
      expect(e.weight).toBeGreaterThanOrEqual(0);
      expect(e.weight).toBeLessThanOrEqual(100);
    }
  });
});

describe('附加设定的注入位置（审查 I2）', () => {
  const base = { ...DEFAULT_PROMPT, systemPrompt: '请用中文详细解释每一件事。' };

  it('注入块前置于 system：JSON 通道的「只输出 JSON」必须留在最后', () => {
    const msgs = [
      { role: 'system', content: '你是意图解析器。只输出 JSON：{"a":1}' },
      { role: 'user', content: '我观察四周' },
    ];
    const out = injectUserPrompt(msgs, base, 'intent');
    expect(out[0].content.startsWith('【玩家的附加设定】')).toBe(true);
    expect(out[0].content.endsWith('只输出 JSON：{"a":1}')).toBe(true);
    expect(out[1]).toBe(msgs[1]); // 非 system 消息不动
  });

  it('空配置时原样返回（不添标签、不改引用）', () => {
    const msgs = [{ role: 'system', content: 'S' }];
    const off = { ...DEFAULT_PROMPT, enabled: false, person: 'first' as const };
    expect(injectUserPrompt(msgs, off, 'intent')).toBe(msgs);
  });

  it('没有 system 消息时补一条在最前', () => {
    const out = injectUserPrompt([{ role: 'user', content: 'hi' }], base, 'intent');
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('system');
  });
});

describe('默认配置不可变（审查 I4）', () => {
  it('冻结到底：就地 push 会抛错，而不是悄悄污染所有落盘分支', () => {
    expect(Object.isFrozen(DEFAULT_PROMPT)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PROMPT.embeds)).toBe(true);
    expect(Object.isFrozen(DEFAULT_EMBEDS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_EMBEDS[0])).toBe(true);
    expect(() =>
      (DEFAULT_PROMPT.embeds as { id: string }[]).push({ id: 'x' }),
    ).toThrow();
    expect(() => {
      (DEFAULT_EMBEDS[0] as { weight: number }).weight = 1;
    }).toThrow();
  });
});

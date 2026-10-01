/* 思考强度适配器注册表（可复用）：检测 / 档位支持 / 出站翻译 / 扩展性 */
import { describe, expect, it } from 'vitest';
import {
  detectVendor,
  isThinkingLevel,
  thinkingOutbound,
  vendorSupportsLevel,
  VENDOR_PROFILES,
} from '../src/admin/vendors';

describe('厂商检测（wireModel 前缀）', () => {
  it('四家优先适配 + generic 回退', () => {
    expect(detectVendor('deepseek-chat').id).toBe('deepseek');
    expect(detectVendor('DeepSeek-R1').id).toBe('deepseek'); /* 大小写不敏感 */
    expect(detectVendor('glm-4.6').id).toBe('glm');
    expect(detectVendor('kimi-k2-thinking').id).toBe('kimi');
    expect(detectVendor('moonshot-v1-8k').id).toBe('kimi');
    expect(detectVendor('qwen3-max').id).toBe('qwen');
    expect(detectVendor('gpt-4o').id).toBe('generic');
    expect(detectVendor('claude-sonnet-4').id).toBe('generic');
  });
});

describe('出站翻译（thinkingOutbound）', () => {
  it('GLM：thinking.type enabled/disabled', () => {
    expect(thinkingOutbound('medium', 'glm-4.6')?.extra).toEqual({ thinking: { type: 'enabled' } });
    expect(thinkingOutbound('off', 'glm-4.6')?.extra).toEqual({ thinking: { type: 'disabled' } });
  });

  it('Qwen：enable_thinking；high 追加 thinking_budget', () => {
    expect(thinkingOutbound('off', 'qwen3-max')?.extra).toEqual({ enable_thinking: false });
    expect(thinkingOutbound('medium', 'qwen3-max')?.extra).toEqual({ enable_thinking: true });
    expect(thinkingOutbound('high', 'qwen3-max')?.extra).toEqual({
      enable_thinking: true,
      thinking_budget: 8192,
    });
  });

  it('DeepSeek：官方参数化（thinking.type + reasoning_effort 三档 low/high/max）', () => {
    expect(thinkingOutbound('off', 'deepseek-chat')?.extra).toEqual({ thinking: { type: 'disabled' } });
    expect(thinkingOutbound('low', 'deepseek-chat')?.extra).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    });
    /* 官方映射：medium → high */
    expect(thinkingOutbound('medium', 'deepseek-chat')?.extra).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(thinkingOutbound('high', 'deepseek-chat')?.extra).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    /* 不做模型名翻转（参数化机制），wireModel 原样出站 */
    expect(thinkingOutbound('medium', 'deepseek-chat')?.modelOverride).toBeUndefined();
  });

  it('Kimi：不做模型名翻转（用户在 wireModel 里选思考版），档位仅用于展示', () => {
    expect(thinkingOutbound('medium', 'kimi-k2-thinking')?.modelOverride).toBeUndefined();
  });

  it('generic：reasoning_effort（off = 无字段可发 → null）', () => {
    expect(thinkingOutbound('high', 'gpt-4o')?.extra).toEqual({ reasoning_effort: 'high' });
    expect(thinkingOutbound('off', 'gpt-4o')).toBeNull(); /* 无字段可合并 = 未配置同义 */
  });

  it('档位不被厂商支持 → null（调用方按未配置处理）', () => {
    expect(thinkingOutbound('high', 'glm-4.6')).toBeNull(); /* GLM 只有 off/medium */
    expect(thinkingOutbound('low', 'glm-4.6')).toBeNull();
    expect(thinkingOutbound(undefined, 'glm-4.6')).toBeNull();
  });
});

describe('扩展性契约', () => {
  it('新增厂商 = 追加 profile（检测/档位/出站自动生效）', () => {
    /* 用既有 profile 验证"注册即可用"的形状契约，不实际修改注册表 */
    for (const p of VENDOR_PROFILES) {
      expect(p.id).toBeTruthy();
      expect(p.match.length).toBeGreaterThan(0);
      expect(p.levels.length).toBeGreaterThan(0);
    }
    expect(isThinkingLevel('medium')).toBe(true);
    expect(isThinkingLevel('ultra')).toBe(false);
    expect(vendorSupportsLevel('qwen', 'high')).toBe(true);
    expect(vendorSupportsLevel('glm', 'high')).toBe(false);
    expect(vendorSupportsLevel('generic', 'low')).toBe(true);
  });
});

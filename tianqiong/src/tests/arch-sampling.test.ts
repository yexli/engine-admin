/* ============================================================
   确定性采样测试（《NPC 规模化与事件通道方案》改进版 §11 / Phase 2）
   —— 四条性质：可复现、维度独立、边界正确、**不消耗随机流**。
   最后一条是整件事的目的：NPC 数量变化不该改变其他系统的随机结果。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { rng } from '@/world';
import { injectSampling, sampleHit, sampleValue } from '@/events/Sampling';

describe('§11 · 确定性采样', () => {
  it('同一组输入总是同一结论（可复现）', () => {
    const a = sampleHit(7, 'evt_1', 'lita', 'witness', 0.5);
    const b = sampleHit(7, 'evt_1', 'lita', 'witness', 0.5);
    expect(b).toBe(a);
    expect(sampleValue(7, 'evt_1', 'lita', 'witness')).toBe(sampleValue(7, 'evt_1', 'lita', 'witness'));
  });

  it('四个维度各自独立：换种子 / 换事件 / 换 NPC / 换用途都会换一组结果', () => {
    const base = sampleValue(7, 'evt_1', 'lita', 'witness');
    expect(sampleValue(8, 'evt_1', 'lita', 'witness')).not.toBe(base);
    expect(sampleValue(7, 'evt_2', 'lita', 'witness')).not.toBe(base);
    expect(sampleValue(7, 'evt_1', 'otto', 'witness')).not.toBe(base);
    /* 同一事件对同一 NPC 的「目击」与「传闻」必须是两次独立判定，
       否则两者永远同真同假（这是 purpose 存在的理由） */
    expect(sampleValue(7, 'evt_1', 'lita', 'rumor')).not.toBe(base);
  });

  it('边界：概率 0 恒不命中、概率 1 恒命中', () => {
    for (let i = 0; i < 50; i++) {
      expect(sampleHit(1, 'e' + i, 'n', 'witness', 0)).toBe(false);
      expect(sampleHit(1, 'e' + i, 'n', 'witness', 1)).toBe(true);
    }
  });

  it('**不消耗随机流**：采样前后主随机流的下一值不变', () => {
    rng.seed(42);
    const before = rng.next();
    rng.seed(42);
    for (let i = 0; i < 100; i++) sampleHit(7, 'evt_' + i, 'npc_' + i, 'witness', 0.5);
    const after = rng.next();
    expect(after, '采样把随机流推进了，NPC 数量就会改变其他系统的结果').toBe(before);
  });

  it('命中率与给定概率相符（大样本）', () => {
    let hit = 0;
    for (let i = 0; i < 4000; i++) if (sampleHit(7, 'evt_' + i, 'npc', 'witness', 0.3)) hit++;
    const rate = hit / 4000;
    expect(rate).toBeGreaterThan(0.26);
    expect(rate).toBeLessThan(0.34);
  });

  it('注入点可控制结果（测试用，与 rng.inject 同构）', () => {
    const off = injectSampling(() => true);
    expect(sampleHit(1, 'e', 'n', 'witness', 0.0001)).toBe(true);
    off();
    const off2 = injectSampling(() => false);
    expect(sampleHit(1, 'e', 'n', 'witness', 0.9999)).toBe(false);
    off2();
  });
});

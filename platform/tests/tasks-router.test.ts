/* 任务分析与模型路由单测 */
import { describe, expect, it } from 'vitest';
import { analyzeTask } from '../src/tasks.ts';
import { ModelRouter } from '../src/router/modelrouter.ts';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('analyzeTask', () => {
  const chat = (content: string, world = false) =>
    analyzeTask({ messages: [{ role: 'user', content }] }, world);

  it('显式 capability 优先', () => {
    const a = analyzeTask({ capability: 'reasoning', messages: [{ role: 'user', content: '你好' }] }, true);
    expect(a.capability).toBe('reasoning');
    expect(a.reason).toContain('显式');
  });

  it('关键词规则：记忆 / 推理 / 叙事', () => {
    expect(chat('请总结一下这段对话').capability).toBe('memory');
    expect(chat('为什么会发生这件事？分析一下原因').capability).toBe('reasoning');
    expect(chat('给我讲个故事').capability).toBe('narrative');
  });

  it('缺省：带世界 → roleplay，不带 → fast', () => {
    expect(chat('你好呀', true).capability).toBe('roleplay');
    expect(chat('你好呀', false).capability).toBe('fast');
  });

  it('未知显式 capability 被忽略，落入缺省', () => {
    const a = analyzeTask({ capability: 'hack', messages: [] }, false);
    expect(a.capability).toBe('fast');
  });
});

describe('ModelRouter', () => {
  it('缺省路由来自 Gateway 六通道', () => {
    const r = new ModelRouter(null);
    expect(r.route('roleplay').primary).toBe('npc');
    expect(r.route('reasoning').primary).toBe('reasoning');
  });

  it('select：primary 可用 → primary；冷却 → fallback；全冷却 → null', () => {
    let now = 0;
    const r = new ModelRouter(null, () => now);
    expect(r.select('roleplay')).toEqual({ model: 'npc', usedFallback: false });

    r.markFailed('npc');
    expect(r.select('roleplay')).toEqual({ model: 'narrative', usedFallback: true });

    r.markFailed('narrative');
    expect(r.select('roleplay')).toBeNull();

    now += 31_000; // 冷却期满自动恢复
    expect(r.select('roleplay')).toEqual({ model: 'npc', usedFallback: false });
  });

  it('primary=null 的能力 → 503 语义（select 返回 null）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'platform-router-'));
    const file = join(dir, 'router.json');
    const config = {
      version: 1,
      routes: { roleplay: { primary: null, fallback: null } },
    };
    writeFileSync(file, JSON.stringify(config));
    const r = new ModelRouter(file);
    expect(r.select('roleplay')).toBeNull();
    expect(r.route('narrative').primary).toBe('narrative'); // 其余走缺省
    rmSync(dir, { recursive: true, force: true });
  });

  it('seedDefault：写出缺省文件且不覆盖已有', () => {
    const dir = mkdtempSync(join(tmpdir(), 'platform-router-'));
    const file = join(dir, 'router.json');
    ModelRouter.seedDefault(file);
    expect(existsSync(file)).toBe(true);
    const first = readFileSync(file, 'utf8');
    ModelRouter.seedDefault(file);
    expect(readFileSync(file, 'utf8')).toBe(first);
    rmSync(dir, { recursive: true, force: true });
  });
});

/* ============================================================
   W7.5 · Multi-Model 协作 E2E（方案 §65/§45）
   一轮自由行动 = 意图模型（intent 通道）+ 叙事模型（weave 通道）
   两个被路由的端点协作完成；世界变更全程经命令链与 WorldExecutor。
   ============================================================ */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setSavePort } from '@/plugins/PluginInterface';
import { registerSystemSubscriptions } from '@/plugins/subscriptions';
import { freeActSmart, resetFreeInputState } from '@/actions/ActionParser';
import { narrationIdle, resetNarrationState } from '@/world/Narration';
import { gateway } from '@/ai/gateway';
import { saveLlmConfig, DEFAULT_LLM } from '@/ai/llmConfig';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  bus.clear();
  rng.seed(42);
  resetNarrationState();
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  registerSystemSubscriptions();
  resetFreeInputState();
  newGame({ name: '协作测试者', race: 'human', cls: 'warrior' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  saveLlmConfig({ ...DEFAULT_LLM });
  gateway.reload();
});

describe('W7.5 · 一轮自由行动的多模型协作', () => {
  it('intent 打 fast 端点、weave 打 narrative 端点（双端点双模型，一轮完成）', async () => {
    const calls: { url: string; body: { model?: string; messages?: { role: string; content: string }[] } }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: unknown, init?: { body?: string }) => {
        const u = String(url);
        let parsed: { model?: string; messages?: { role: string; content: string }[] } = {};
        try {
          parsed = JSON.parse(init?.body ?? '{}');
        } catch {
          /* 连通性探测等无 body 调用 */
        }
        calls.push({ url: u, body: parsed });
        const isIntent = u.startsWith('https://fast.example.com');
        const payload = JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: isIntent ? JSON.stringify({ intent: 'observe', target: '' }) : '他环顾四周，鸽子掠过钟塔。',
              },
            },
          ],
        });
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(payload),
          json: () => Promise.resolve(JSON.parse(payload)),
        });
      }),
    );

    saveLlmConfig({
      ...DEFAULT_LLM,
      enabled: true,
      baseURL: 'https://main.example.com/v1',
      model: 'main-model',
      apiKey: 'sk-main',
      stream: false,
      tiers: {
        light: { baseURL: 'https://fast.example.com/v1', model: 'fast-mini', apiKey: 'sk-fast' },
        heavy: { baseURL: 'https://tale.example.com/v1', model: 'tale-teller', apiKey: 'sk-tale' },
      },
      channelRoutes: { intent: 'light', weave: 'heavy' },
    });
    gateway.reload();

    /* 一轮自由行动：意图解析（fast 端点）→ 命令链执行 → 编织正文（tale 端点） */
    await freeActSmart('我看看四周');
    await narrationIdle();

    const intentCalls = calls.filter((c) => c.url.startsWith('https://fast.example.com'));
    const weaveCalls = calls.filter((c) => c.url.startsWith('https://tale.example.com'));
    expect(intentCalls.length).toBeGreaterThan(0); // 意图模型参与了这一轮
    expect(weaveCalls.length).toBeGreaterThan(0); // 叙事模型参与了这一轮
    expect(weaveCalls.some((c) => (c.body.messages ?? []).some((m) => m.content.includes('观察')) || c.body.model === 'tale-teller')).toBe(true);

    /* 世界状态确实变了：观察给了见闻（经命令链，不是 AI 直改） */
    expect(core.S!.log.length).toBeGreaterThan(0);
    /* 主端点未被牵连：主模型只服务未配置通道（本轮两个通道都有专属路由） */
    expect(calls.some((c) => c.url.startsWith('https://main.example.com'))).toBe(false);
  });
});

/* ============================================================
   第二轮实测修复回归（2026-09-29 报告 BUG-001 / BUG-002 / UX-005）
   - BUG-001 通讯·寄信：点目的地先给写信浮层，确认后才扣费寄出；
     够不到的目的地不再是无 case 的死按钮。
   - BUG-002 攀谈双执行：一句话拆出的 [talk, askinfo] 合并为一次交谈——
     一条记忆、一条流言、一份台词、一批编织正文。
   - UX-005 会话记录写玩家原文，不再是剥过动词的意图片段。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, dispatch, newGame, resetWorld, rng, scheduler } from '@/world';
import { worldBus } from '@/events/EventBus';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { registerSystemSubscriptions } from '@/plugins/subscriptions';
import { freeAct, resetFreeInputState } from '@/actions/ActionParser';
import { narrationIdle, resetNarrationState } from '@/world/Narration';
import { commCompose } from '@/systems/commnet/CommNet';
import type { CommSheet, SheetDesc } from '@/types/uispec';
import type { WorldState } from '@/types/world';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  rng.seed(42);
  resetNarrationState();
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  registerSystemSubscriptions();
  resetFreeInputState();
  newGame({ name: '测试者', race: 'human', cls: 'warrior' });
});

const s = (): WorldState => core.S!;

describe('BUG-001 · 通讯：先写信，确认后才寄', () => {
  it('点目的地打开写信浮层：收件地/手段/费用/时效齐全，不直接扣钱', () => {
    const sheets: SheetDesc[] = [];
    bus.on((e) => {
      if (e.type === 'sheet' && e.desc) sheets.push(e.desc);
    });
    const gold0 = s().player.gold;
    commCompose('windport');
    const d = sheets[0];
    expect(d, '写信浮层该打开').toBeTruthy();
    expect(d.kind).toBe('comm');
    const comm = d as CommSheet;
    expect(comm.toLoc).toBe('windport');
    expect(comm.toName).toBe('翠风港');
    expect(comm.cost).toBe(500); // 信纸/书信 5 银币
    expect(comm.days).toBe(15);
    expect(s().player.gold).toBe(gold0); // 还没寄，一分不扣
  });

  it('确认寄出：按玩家写的正文寄，扣 5 银币，落一条 message_sent 与一条见闻', () => {
    const gold0 = s().player.gold;
    const seen: string[] = [];
    worldBus.on('message_sent', (e) => seen.push(String(e.data?.topic ?? '')), 'r2-send');
    dispatch({ type: 'ui', a: 'cm_send_ok', p: { id: 'windport', t: '家里一切都好，勿念' } });
    expect(s().player.gold).toBe(gold0 - 500);
    expect(seen).toEqual(['家里一切都好，勿念']);
    expect(s().log.some((l) => l.text.includes('翠风港') && l.text.includes('送往'))).toBe(true);
  });

  it('正文留空就捎一句口信（默认话题仍在）', () => {
    const seen: string[] = [];
    worldBus.on('message_sent', (e) => seen.push(String(e.data?.topic ?? '')), 'r2-empty');
    dispatch({ type: 'ui', a: 'cm_send_ok', p: { id: 'windport', t: '   ' } });
    expect(seen).toEqual(['口信']);
  });

  it('够不到的目的地有反馈了（此前是点了毫无反应的死按钮）', () => {
    const toasts: string[] = [];
    bus.on((e) => {
      if (e.type === 'toast') toasts.push(e.text);
    });
    expect(() => dispatch({ type: 'ui', a: 'cm_none', p: { id: 'windport' } })).not.toThrow();
    expect(toasts.some((t) => t.includes('够得到'))).toBe(true);
  });
});

describe('BUG-002 · 一句攀谈只执行一次', () => {
  it('正则通道：「跟米露打个招呼，问问她有什么新鲜事」合并为一次交谈', () => {
    freeAct('跟米露打个招呼，问问她有什么新鲜事');
    const turns = s().chats?.mia ?? [];
    /* 双执行事故里这里是 4 条（两轮对话各两条）——现在一轮就一轮 */
    expect(turns.filter((t) => t.who === 'p').length).toBe(1);
    expect(turns.filter((t) => t.who === 'n').length).toBe(1);
    /* 台词只有一份，不出现两份互相矛盾的回话 */
    const says = s().log.filter((l) => l.cls === 'say' && l.text.startsWith('米露：'));
    expect(says.length).toBe(1);
  });

  it('LLM 通道 steps 同样合并：一次攀谈只织一批正文，台词在同一批里', async () => {
    const { gateway } = await import('@/ai/gateway');
    const calls: string[][] = [];
    gateway.use({
      ...ruleSim,
      intentAsync: async () => ({
        intent: 'talk',
        target: '米露',
        topic: '你好呀',
        steps: [
          { intent: 'talk', target: '米露', topic: '你好呀' },
          { intent: 'askinfo', target: '米露', topic: '广场上有什么新鲜事' },
        ],
      }),
      chatAsync: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { line: '（测试回话。）', mem: '他来搭话', rumor: '新鲜事' };
      },
      narrateAsync: async (facts: string[]) => {
        calls.push(facts);
        return '（一段织好的正文。）';
      },
    });
    dispatch({ type: 'freeText', text: '跟米露打个招呼，问问她广场上有什么新鲜事' });
    await new Promise((r) => setTimeout(r, 80)); // 等异步回包落地
    await narrationIdle();
    gateway.use(ruleSim);
    const turns = s().chats?.mia ?? [];
    expect(turns.filter((t) => t.who === 'p').length).toBe(1);
    expect(turns.filter((t) => t.who === 'n').length).toBe(1);
    expect(calls.length, '一轮输入只开一个编织窗').toBe(1);
    const all = calls[0].join('\n');
    expect(all).toContain('【玩家提出】'); // 回显行同批
    expect(all).toContain('米露：（测试回话。）'); // 异步回包也在同一批（单批化的核心断言）
  });

  it('UX-005 · 会话记录写玩家原文，不是剥过动词的片段', () => {
    const text = '跟米露打个招呼，问问她有什么新鲜事';
    freeAct(text);
    const turns = s().chats?.mia ?? [];
    const mine = turns.find((t) => t.who === 'p');
    expect(mine?.text).toBe(text);
  });
});

/* ============================================================
   状态同步与意图通道（F-12 / F-14 / F-19）
   —— dispatch 出口兜底 sync；自由行动异常降级与去重；检定演出不互相踩。
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler } from '@/world';
import { dispatch, newGame } from '@/world/WorldRuntime';
import { freeActSmart } from '@/actions/ActionParser';
import { check } from '@/dice/CheckResolver';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import type { AiPort, SavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { MemorySaveRepository } from '@/repo';
import { SAVE_THROTTLE_MS } from '@/world/WorldState';
import type { WorldState } from '@/types/world';

let changed = 0;
let toasts: string[] = [];

beforeEach(() => {
  core.S = null;
  core.CB = null;
  core.curShop = null;
  changed = 0;
  toasts = [];
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(31);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '同步', race: 'human', cls: 'warrior' });
  bus.on((e) => {
    if (e.type === 'changed') changed++;
    if (e.type === 'toast') toasts.push(e.text);
  });
});

describe('F-12 · dispatch 出口兜底 sync', () => {
  it('对话接任务这条无 sync 路径也会发 changed', () => {
    changed = 0;
    dispatch({ type: 'dialogChoice', n: 'lita', a: 'q_debt' });
    expect(changed).toBeGreaterThan(0);
    expect(core.S!.player.quests.q_debt).toBeTruthy();
  });

  it('买情报（扣 200 铜）落盘并通知 UI', () => {
    const s = core.S!;
    s.player.gold = 5000;
    s.player.flags.msg_unlock = true;
    changed = 0;
    dispatch({ type: 'dialogChoice', n: 'selina', a: 'info_buy' });
    expect(changed).toBeGreaterThan(0);
    expect(s.player.gold).toBe(4800);
  });

  it('自由行动与战斗入口同样经出口兜底', () => {
    changed = 0;
    dispatch({ type: 'sceneAction', k: 'observe' });
    expect(changed).toBeGreaterThan(0);
  });

  it('落盘节流：一串命令只写一次盘，changed 立即发', async () => {
    /* 还原真实定时器，验尾节流（其余用例走同步调度器 → 行为等价于立即落盘） */
    let saves = 0;
    const repo: SavePort = {
      load: () => null,
      save: (_s: WorldState) => {
        saves++;
      },
      clear: () => undefined,
    };
    setSavePort(repo);
    scheduler.inject((ms, fn) => setTimeout(fn, ms) as unknown as ReturnType<typeof setTimeout>);
    changed = 0;
    saves = 0;
    dispatch({ type: 'travel', loc: 'tavern' });
    dispatch({ type: 'travel', loc: 'plaza' });
    dispatch({ type: 'travel', loc: 'market' });
    expect(changed).toBeGreaterThanOrEqual(3); // changed 不被节流
    expect(saves).toBe(0); // 节流窗口内还没落盘
    await new Promise((r) => setTimeout(r, SAVE_THROTTLE_MS + 120));
    expect(saves).toBe(1); // 合并为一次
  });
});

describe('F-14 · 自由行动降级与去重', () => {
  it('Intent 通道抛错时降级正则：无未捕获 rejection，且玩家有反馈', async () => {
    const boom: AiPort = {
      ...ruleSim,
      intentAsync: async () => {
        throw new Error('llm down');
      },
    };
    setAiPort(boom);
    changed = 0;
    await freeActSmart('观察环境');
    expect(changed).toBeGreaterThan(0); // 未捕获异常会吞掉这条路径，从而抓不到 changed
  });

  it('同一句并发提交只执行一次（in-flight 去重 + toast 提示）', async () => {
    let calls = 0;
    const slow: AiPort = {
      ...ruleSim,
      intentAsync: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return null;
      },
    };
    setAiPort(slow);
    toasts = [];
    await Promise.all([freeActSmart('观察环境'), freeActSmart('观察环境')]);
    expect(calls).toBe(1);
    expect(toasts.some((t) => t.includes('还在解析'))).toBe(true);
  });

  it('freeBusy 事件成对发出（true → false）', async () => {
    const seen: boolean[] = [];
    const stop = bus.on((e) => {
      if (e.type === 'freeBusy') seen.push(e.busy);
    });
    await freeActSmart('观察四周');
    stop();
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
  });
});

describe('F-19 · 检定演出并发收束', () => {
  it('后一次检定未被前一次的收束关掉浮层', () => {
    /* 手动控制调度：模拟"第二次检定已开演，第一次的 1450ms 才到点" */
    const pending: { ms: number; fn: () => void }[] = [];
    scheduler.inject((ms, fn) => {
      pending.push({ ms, fn });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const seqs: (unknown | null)[] = [];
    const stop = bus.on((e) => {
      if (e.type === 'check') seqs.push(e.desc);
    });
    check('第一次', '感知', 5);
    check('第二次', '感知', 5);
    pending[0].fn(); // 旧检定的收束：不得关闭浮层
    expect(seqs.filter((d) => d === null).length).toBe(0);
    pending[1].fn(); // 最新检定的收束：正常关闭
    stop();
    expect(seqs.filter((d) => d === null).length).toBe(1);
  });
});

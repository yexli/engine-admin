/* ============================================================
   开场白 AI 化（greet 通道）单元测试
   覆盖：接了模型不预填固定台词（等待态）· 回包落笔 · 模型不给话回落数据台词 ·
        关窗不弹回 · 连开两次/中途切人不越窗 · 无通道时零变化（降级铁律）
   ============================================================ */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus, core, dispatch, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { registerSystemSubscriptions } from '@/plugins/subscriptions';
import { ruleSim } from '@/ai/ruleSim';
import { gateway } from '@/ai/gateway';
import { GREET_TIMEOUT_MS, openDlg } from '@/systems/dialogue/Dialogue';
import type { SheetDesc } from '@/types/uispec';

let sheet: SheetDesc | null | 'unset' = 'unset';
const flush = () => new Promise((r) => setTimeout(r, 0));
/** 当前对话框（非 dialog 浮层 → null） */
const dlg = (): Extract<SheetDesc, { kind: 'dialog' }> | null =>
  sheet && sheet !== 'unset' && sheet.kind === 'dialog' ? sheet : null;

/** 把端口换成「有 greetAsync」的假模型；返回逐个回包的 resolve 句柄 */
function useFakeModel() {
  const resolvers: ((v: string | null) => void)[] = [];
  gateway.use({
    ...ruleSim,
    greetAsync: () =>
      new Promise<string | null>((r) => {
        resolvers.push(r);
      }),
  });
  return resolvers;
}

beforeEach(() => {
  core.S = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  sheet = 'unset';
  bus.on((e) => {
    if (e.type === 'sheet') sheet = e.desc;
  });
  rng.seed(7);
  registerSystemSubscriptions();
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

const start = (name = '闲谈者') => newGame({ name, race: 'human', cls: 'mage' });

describe('开场白 · 降级路径（无模型）', () => {
  it('无 greetAsync 时：数据台词直接上屏，且不被异步改写', async () => {
    start();
    openDlg('mia');
    expect(dlg()?.text).toContain('一个铜板一条消息');
    await flush();
    expect(dlg()?.text).toContain('一个铜板一条消息');
  });

  it('warm 档数据台词里的 {name} 占位符照旧替换', () => {
    start('阿澈');
    core.S!.npcs.mia = { att: 50, mem: [], met: true };
    openDlg('mia');
    expect(dlg()?.text).toContain('阿澈最照顾我生意啦');
  });
});

describe('开场白 · AI 通道', () => {
  it('接了模型就不预填固定台词：先等待态，回包后才落笔', async () => {
    start();
    const rs = useFakeModel();
    openDlg('mia');
    expect(dlg()?.busy, '等待期间必须是等待态').toBe(true);
    expect(dlg()?.text, '不得出现原本固定的台词').not.toContain('一个铜板一条消息');
    rs[0]('这个时辰还在街上？先说，谁在追你。');
    await flush();
    expect(dlg()?.text).toContain('这个时辰还在街上');
    expect(dlg()?.busy).toBeFalsy();
    gateway.use(ruleSim);
  });

  it('模型不给话（null）：回落到数据台词——人必须开得了口', async () => {
    start();
    gateway.use({ ...ruleSim, greetAsync: async () => null });
    openDlg('mia');
    expect(dlg()?.busy).toBe(true);
    await flush();
    expect(dlg()?.text).toContain('一个铜板一条消息');
    expect(dlg()?.busy).toBeFalsy();
    gateway.use(ruleSim);
  });

  it('通道抛错：同样回落数据台词，不吞窗', async () => {
    start();
    gateway.use({
      ...ruleSim,
      greetAsync: async () => {
        throw new Error('端点挂了');
      },
    });
    openDlg('mia');
    await flush();
    expect(dlg()?.text).toContain('一个铜板一条消息');
    gateway.use(ruleSim);
  });
});

describe('开场白 · 回包不得越权（F-17 同源）', () => {
  it('回包前玩家关窗：不弹回', async () => {
    start();
    const rs = useFakeModel();
    openDlg('mia');
    dispatch({ type: 'ui', a: 'close', p: {} });
    sheet = 'unset';
    rs[0]('迟到的开场白');
    await flush();
    expect(sheet).toBe('unset');
    gateway.use(ruleSim);
  });

  it('同一 NPC 连开两次：旧回包被世代号丢弃，不盖新窗', async () => {
    start();
    const rs = useFakeModel();
    openDlg('mia');
    openDlg('mia');
    rs[0]('第一次的旧台词');
    await flush();
    expect(dlg()?.text, '旧世代的回包必须被丢弃').not.toContain('第一次的旧台词');
    rs[1]('第二次的新台词');
    await flush();
    expect(dlg()?.text).toContain('第二次的新台词');
    gateway.use(ruleSim);
  });

  it('模型迟迟不回（软超时）：先落回数据台词，迟到回包不再改写', async () => {
    vi.useFakeTimers();
    try {
      start();
      const rs = useFakeModel();
      openDlg('mia');
      expect(dlg()?.busy, '超时前仍是等待态').toBe(true);
      await vi.advanceTimersByTimeAsync(GREET_TIMEOUT_MS + 1);
      expect(dlg()?.text, '到点必须把话还给数据台词').toContain('一个铜板一条消息');
      expect(dlg()?.busy).toBeFalsy();
      rs[0]('迟到的台词');
      await vi.advanceTimersByTimeAsync(0);
      expect(dlg()?.text, 'race 已结束，迟到回包不得再改写').toContain('一个铜板一条消息');
      gateway.use(ruleSim);
    } finally {
      vi.useRealTimers();
    }
  });

  it('中途切到别人：旧回包不越窗', async () => {
    start();
    const rs = useFakeModel();
    openDlg('mia');
    openDlg('lita');
    const before = dlg()?.text;
    rs[0]('米露的迟到台词'); // 第 0 个回包属于米露那次打开
    await flush();
    expect(dlg()?.text).toBe(before);
    expect(dlg()?.text).not.toContain('米露的迟到台词');
    rs[1]('莉安的开场白');
    await flush();
    expect(dlg()?.text).toContain('莉安的开场白');
    gateway.use(ruleSim);
  });
});

describe('开场白 · 记得（对话影响剧情之二）', () => {
  it('上次对话的尾巴进开场白上下文：接得住旧话头', async () => {
    start();
    core.S!.chats = { mia: [{ who: 'n', text: '你上次说到弟弟的病还没好', day: 1, id: 'c1' }] };
    const seen: { lastChat?: string }[] = [];
    gateway.use({
      ...ruleSim,
      greetAsync: async (ctx) => {
        seen.push(ctx as { lastChat?: string });
        return '又来了？';
      },
    });
    openDlg('mia');
    await flush();
    gateway.use(ruleSim);
    expect(seen[0]?.lastChat, '开场白拿到上次对话的尾巴').toBe('你上次说到弟弟的病还没好');
    expect(dlg()?.text).toContain('又来了？');
  });

  it('没聊过就没有 lastChat（初次见面不发空话头）', async () => {
    start();
    const seen: { lastChat?: string }[] = [];
    gateway.use({
      ...ruleSim,
      greetAsync: async (ctx) => {
        seen.push(ctx as { lastChat?: string });
        return '初次见面。';
      },
    });
    openDlg('mia');
    await flush();
    gateway.use(ruleSim);
    expect(seen[0]?.lastChat).toBeUndefined();
  });
});

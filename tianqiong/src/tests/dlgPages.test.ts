/* ============================================================
   对话浮层双页（星穹剧场）单元测试
   覆盖：默认此刻页 · 深谈页带会话流 · 翻页保留正文与选项 ·
        关窗后翻页不重开 · 重开复位 · 异步回包不把人拽回此刻 · 流封顶
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, dispatch, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { registerSystemSubscriptions } from '@/plugins/subscriptions';
import { ruleSim } from '@/ai/ruleSim';
import { gateway } from '@/ai/gateway';
import { openDlg } from '@/systems/dialogue/Dialogue';
import type { SheetDesc } from '@/types/uispec';

let sheet: SheetDesc | null | 'unset' = 'unset';
const flush = () => new Promise((r) => setTimeout(r, 0));
const dlg = (): Extract<SheetDesc, { kind: 'dialog' }> | null =>
  sheet && sheet !== 'unset' && sheet.kind === 'dialog' ? sheet : null;
const flip = (page: 'now' | 'timeline') => dispatch({ type: 'ui', a: 'dlgPage', p: { page } });

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

describe('对话双页 · 此刻 ⇄ 深谈', () => {
  it('开窗默认落在「此刻」页', () => {
    start();
    openDlg('mia');
    expect(dlg()?.page).toBe('now');
  });

  it('深谈页带本 NPC 的会话流（旧→新，含日期）', () => {
    start();
    core.S!.chats = {
      mia: [
        { who: 'p', text: '一个铜板一条消息？', day: 11, id: 'c1' },
        { who: 'n', text: '你买不买？', day: 11, id: 'c2' },
      ],
    };
    openDlg('mia');
    const texts = dlg()?.turns?.map((t) => t.text) || [];
    expect(texts.slice(0, 2)).toEqual(['一个铜板一条消息？', '你买不买？']);
    expect(dlg()?.turns?.[0].day).toBe(11);
    /* 开场白也入流（它是这段对话的第一句，但不是"旧记录"里的第一条） */
    expect(texts[texts.length - 1]).toContain('一个铜板一条消息');
  });

  it('翻页保留正文与选项（不是重开一次对话）', () => {
    start();
    openDlg('mia');
    const before = dlg()?.text;
    flip('timeline');
    expect(dlg()?.page).toBe('timeline');
    expect(dlg()?.text).toBe(before);
    expect((dlg()?.opts || []).length).toBeGreaterThan(0);
  });

  it('深谈页带追问入口（core 判过门槛的话题）', () => {
    start();
    openDlg('mia');
    flip('timeline');
    expect((dlg()?.chips || []).length).toBeGreaterThan(0);
  });

  it('浮层已关时翻页：只记页号，不重开窗（F-17 同源）', () => {
    start();
    openDlg('mia');
    dispatch({ type: 'ui', a: 'close', p: {} });
    sheet = 'unset';
    flip('timeline');
    expect(sheet).toBe('unset');
  });

  it('页号绑定对话：切到深谈后换人，新对话一律从「此刻」起', () => {
    start();
    openDlg('mia');
    flip('timeline');
    expect(dlg()?.page).toBe('timeline');
    openDlg('lita'); // 换人：页号属于上一段对话，不得带过来
    expect(dlg()?.page).toBe('now');
  });

  it('深谈页必须"有东西可看"才允许停留（内容为空即落回此刻）', () => {
    start();
    openDlg('mia');
    flip('timeline');
    const d = dlg();
    /* 页 2 至少要有正文或时间线；都没有时 UI 会兜回页 1——
       这条断言守的是「不留空白页」的前提条件。 */
    expect(!!d?.text || !!d?.stage || (d?.turns || []).length > 0).toBe(true);
  });

  it('重新开口复位到「此刻」（不从上次翻到的页续）', () => {
    start();
    openDlg('mia');
    flip('timeline');
    expect(dlg()?.page).toBe('timeline');
    openDlg('mia');
    expect(dlg()?.page).toBe('now');
  });

  it('开场白异步回包不把人拽回此刻：正文更新，页号保持', async () => {
    start();
    let resolveIt: (v: string | null) => void = () => {};
    gateway.use({
      ...ruleSim,
      greetAsync: () =>
        new Promise<string | null>((r) => {
          resolveIt = r;
        }),
    });
    openDlg('mia');
    flip('timeline'); // 等待期间玩家翻到深谈页
    resolveIt('这个时辰还在街上？');
    await flush();
    expect(dlg()?.page, '回包不得改页').toBe('timeline');
    expect(dlg()?.text, '正文照常落笔').toContain('这个时辰还在街上');
    gateway.use(ruleSim);
  });

  it('深谈页里说话：回复落在对话页，不弹聊天浮层', () => {
    start();
    openDlg('mia');
    expect(dlg()?.page).toBe('now');
    dispatch({ type: 'ui', a: 'dlgPage', p: { page: 'timeline' } });
    const before = dlg()?.turns?.length ?? 0;
    dispatch({ type: 'chatSend', id: 'mia', text: '最近有什么消息？' });
    /* 关键：浮层仍是对话（没有被换成聊天窗） */
    expect((sheet as Extract<SheetDesc, { kind: string }>).kind).toBe('dialog');
    const d = dlg();
    expect(d?.turns?.length ?? 0).toBeGreaterThan(before);
    expect(d?.turns?.some((t) => t.who === 'p' && t.text.includes('最近有什么消息'))).toBe(true);
  });

  it('AI 回复同样回流：落地后进时间线，浮层不变', async () => {
    start();
    gateway.use({ ...ruleSim, chatAsync: async () => ({ line: '这条回复应该留在深谈页' }) });
    openDlg('mia');
    dispatch({ type: 'ui', a: 'dlgPage', p: { page: 'timeline' } });
    dispatch({ type: 'chatSend', id: 'mia', text: '在吗' });
    await flush();
    expect((sheet as Extract<SheetDesc, { kind: string }>).kind).toBe('dialog');
    expect(dlg()?.turns?.some((t) => t.text.includes('这条回复应该留在深谈页'))).toBe(true);
    gateway.use(ruleSim);
  });

  it('不在深谈页时不回流：消息入档，但「此刻」页不会被会话淹没', () => {
    start();
    openDlg('mia'); // 停在「此刻」页
    dispatch({ type: 'chatSend', id: 'mia', text: '最近有什么消息？' });
    expect((sheet as Extract<SheetDesc, { kind: string }>).kind).toBe('dialog');
    expect(core.S!.chats?.mia?.some((t) => t.text.includes('最近有什么消息'))).toBe(true);
  });

  it('会话流封顶 12 条，且留最新的', () => {
    start();
    core.S!.chats = {
      mia: Array.from({ length: 30 }, (_, i) => ({ who: i % 2 ? ('p' as const) : ('n' as const), text: 'x' + i, day: 1 })),
    };
    openDlg('mia');
    const t = dlg()?.turns || [];
    expect(t.length, '开场白入流后仍封顶 12 条').toBe(12);
    expect(t[t.length - 1].text, '最新一条 = 本次开场白').toContain('一个铜板一条消息');
    expect(t[t.length - 2].text, '旧记录里最新的一条紧随其后').toBe('x29');
  });
});

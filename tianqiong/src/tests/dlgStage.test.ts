/* ============================================================
   排版两则（星穹剧场）单元测试
   覆盖：句首舞台指示拆分（完整/嵌套/未闭合/半角）· 下沉字判定（只认汉字）·
        与 openDlg 的集成（拆出的 stage 进描述符、text 不再含括号）
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, resetWorld, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { registerSystemSubscriptions } from '@/plugins/subscriptions';
import { ruleSim } from '@/ai/ruleSim';
import { canDropCap, openDlg, splitStage } from '@/systems/dialogue/Dialogue';
import type { SheetDesc } from '@/types/uispec';

let sheet: SheetDesc | null | 'unset' = 'unset';
const dlg = (): Extract<SheetDesc, { kind: 'dialog' }> | null =>
  sheet && sheet !== 'unset' && sheet.kind === 'dialog' ? sheet : null;

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

describe('句首舞台指示拆分', () => {
  it('完整配对：括号段归 stage，其余归 line', () => {
    expect(splitStage('（打铁声重了几分）……自己看，别乱摸。')).toEqual({
      stage: '（打铁声重了几分）',
      line: '……自己看，别乱摸。',
    });
  });

  it('括号段之后没有台词：**不拆**，整句留在正文（否则界面上"话就没了"）', () => {
    /* 这条是实测复现出来的：AI 生成的开场白常常整句只有动作描写，
       若照拆，正文会变成空串——只剩一行小字，玩家看到的是"内容消失"。 */
    expect(splitStage('（躲开了你的视线）')).toEqual({ stage: '', line: '（躲开了你的视线）' });
    expect(splitStage('（他抬眼看你，没说话。）')).toEqual({ stage: '', line: '（他抬眼看你，没说话。）' });
  });

  it('嵌套括号：按深度取到最外层', () => {
    expect(splitStage('（他（微微）一顿）你来了。')).toEqual({ stage: '（他（微微）一顿）', line: '你来了。' });
  });

  it('未闭合：一律当普通文本，不拆也不猜', () => {
    const raw = '（枪声还没停，跑。';
    expect(splitStage(raw)).toEqual({ stage: '', line: raw });
  });

  it('不以括号开头：原样返回', () => {
    expect(splitStage('要打听事儿吗？')).toEqual({ stage: '', line: '要打听事儿吗？' });
  });

  it('半角括号同样识别', () => {
    expect(splitStage('(sighs) fine.')).toEqual({ stage: '(sighs)', line: 'fine.' });
  });

  it('空串安全', () => {
    expect(splitStage('')).toEqual({ stage: '', line: '' });
  });
});

describe('首字下沉判定（只认汉字）', () => {
  it('汉字可下沉', () => {
    expect(canDropCap('要打听事儿吗？')).toBe(true);
  });
  it('标点／引号／省略号不下沉', () => {
    expect(canDropCap('……我不认识你。')).toBe(false);
    expect(canDropCap('「来啦？」')).toBe(false);
    expect(canDropCap('——先别说话。')).toBe(false);
  });
  it('字母数字不下沉', () => {
    expect(canDropCap('abc')).toBe(false);
    expect(canDropCap('123')).toBe(false);
  });
  it('空串不下沉', () => {
    expect(canDropCap('')).toBe(false);
  });
});

describe('集成：描述符带上 stage 与 dropCap', () => {
  const start = () => newGame({ name: '闲谈者', race: 'human', cls: 'mage' });

  it('括号开头的台词：括号进 stage，正文不再含它，且不下沉', () => {
    start();
    core.S!.npcs.brendan = { att: -25, mem: [], met: true }; // cold 档 → 以（开头的问候
    openDlg('brendan');
    expect(dlg()?.stage).toBe('（打铁声重了几分）');
    expect(dlg()?.text).toBe('……自己看，别乱摸。');
    expect(dlg()?.dropCap, '省略号开头不下沉').toBe(false);
  });

  it('汉字开头的台词：无 stage，可下沉', () => {
    start();
    openDlg('mia');
    expect(dlg()?.stage).toBeUndefined();
    expect(dlg()?.text).toContain('一个铜板一条消息');
    expect(dlg()?.dropCap).toBe(true);
  });
});

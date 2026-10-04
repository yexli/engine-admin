/* ============================================================
   历法与季节（F-06）：12 月一轮回、跨年递增、事件历法与 UI 同源。
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, dispatch, rng, scheduler } from '@/world';
import { newGame } from '@/world/WorldRuntime';
import { evalTrigger } from '@/events/EventProcessor';
import { sceneTime, seasonName, timeStr, periodSeg } from '@/world/WorldClock';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim, PERIOD_TEXT } from '@/ai/ruleSim';
import { tintOf } from '@/ui/SceneView';
import { WB } from '@/data/worldBook';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(7);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '历法', race: 'human', cls: 'warrior' });
});

const S = () => core.S!;

describe('历法 · 12 月轮回（F-06）', () => {
  it('第 401 天不越界：月名合法、timeStr 不含 undefined', () => {
    const s = S();
    s.t = 48 * 400;
    const t = sceneTime(s);
    expect(WB.months).toContain(t.month);
    expect(timeStr(s)).not.toContain('undefined');
    expect(seasonName(s)).toMatch(/^[春夏秋冬]$/);
  });

  it('三年制修业（1080 天）区间内月名始终合法', () => {
    const s = S();
    for (const day of [0, 30, 359, 360, 719, 720, 1079, 1080]) {
      s.t = 48 * day;
      expect(WB.months).toContain(sceneTime(s).month);
    }
  });

  it('四季抽样：第 0 / 90 / 180 / 270 天', () => {
    const s = S();
    const at = (day: number) => {
      s.t = 48 * day;
      return seasonName(s);
    };
    expect(at(0)).toBe('春');
    expect(at(90)).toBe('夏');
    expect(at(180)).toBe('秋');
    expect(at(270)).toBe('冬');
    expect(at(370)).toBe('春'); // 折返第二年
  });

  it('跨年递增：第 360 天进入 613 年且月份回到首月', () => {
    const s = S();
    s.t = 48 * 360;
    expect(sceneTime(s).year).toBe(613);
    expect(sceneTime(s).month).toBe(WB.months[0]);
    expect(sceneTime(s).monthIndex).toBe(0);
  });

  it('事件历法与 sceneTime 同源：400 天后 month 判定仍命中', () => {
    const s = S();
    s.t = 48 * 370; // 绝对月 12 → 折回 0（新芽月）
    expect(evalTrigger({ month: 0 }, s)).toBe(true);
    expect(evalTrigger({ month: 1 }, s)).toBe(false);
  });
});

/* ============================================================
   一日三段：分组只有一处实现（WorldClock.periodSeg），
   场景光色与取景句都是它的消费者。这里断言分组本身，
   以及两个消费端确实落在同一套分组上——两处各写一套就会「文字说清晨、画面是夜」。
   ============================================================ */
describe('一日三段（periodSeg）', () => {
  it('十二时辰全覆盖且切点正确：晨 2–5 / 昼 6–8 / 余下归暮夜', () => {
    const segs = Array.from({ length: 12 }, (_, h) => periodSeg(h));
    expect(segs).toEqual([2, 2, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2]);
  });

  it('子时是 0 不是 12：取模的时辰里，半夜必须落在暮夜段', () => {
    /* 这条守的是 tintOf 曾经踩过的坑：写成 h <= 8 的区间会把 h=0/1 判成白昼 */
    expect(periodSeg(0)).toBe(2);
    expect(periodSeg(11)).toBe(2);
  });
});

describe('原地等待（wait · 自动流逝的载体）', () => {
  it('推进指定刻数，且经命令链（dispatch 出口统一 sync）', () => {
    const s = S();
    const t0 = s.t;
    dispatch({ type: 'wait', ticks: 3 });
    expect(s.t).toBe(t0 + 3);
  });

  it('刻数夹在 1..48：0 至少走一刻，超一日按一日算', () => {
    const s = S();
    s.t = 100;
    dispatch({ type: 'wait', ticks: 0 });
    expect(s.t).toBe(101);
    s.t = 100;
    dispatch({ type: 'wait', ticks: 999 });
    expect(s.t).toBe(100 + 48);
  });
});

describe('场景光色（tintOf）', () => {
  it('十二时辰都有落点，不留空档', () => {
    const tints = Array.from({ length: 12 }, (_, h) => tintOf(h));
    expect(tints.every((x) => /^rgba\(/.test(x))).toBe(true);
  });

  it('清晨与黄昏不同色、子丑同属夜——晨用冷色中和底图的橘是刻意的', () => {
    expect(tintOf(4)).not.toBe(tintOf(9));
    expect(tintOf(0)).toBe(tintOf(1));
    expect(tintOf(11)).toBe(tintOf(0));
  });
});

describe('分时段取景句（ruleSim.narrative）', () => {
  it('三段齐全的地点按时段取固定句（plaza 的晨 / 昼 / 暮）', () => {
    const s = S();
    s.weather = '晴'; // 排除「非晴且 h<10 追加天气句」的干扰
    const at = (h: number) => {
      s.t = h * 4;
      return ruleSim.narrative('enter', { loc: 'plaza' });
    };
    expect(at(4)).toBe(WB.locations.plaza.desc[0]);
    expect(at(6)).toBe(WB.locations.plaza.desc[1]);
    expect(at(9)).toBe(WB.locations.plaza.desc[2]);
  });

  it('单句地点在 desc 之后拼一层时段氛围句，而不是替换 desc', () => {
    const s = S();
    s.weather = '晴';
    s.t = 6 * 4;
    const txt = ruleSim.narrative('enter', { loc: 'tavern' });
    const desc = WB.locations.tavern.desc;
    expect(desc.some((d) => txt === d)).toBe(false);
    expect(desc.some((d) => txt.startsWith(d))).toBe(true);
  });

  it('时段氛围句不得指向具体场所——它会在任意地点冒出来', () => {
    /* 初版写过「面包房的第一炉气」，于是它在银鸥酒馆里漏了出来。
       这条断言就是为了让那件事不能再发生。 */
    const BANNED = /店|铺|摊|楼|塔|馆|庙|殿|仓|坊|院|局/;
    for (const seg of PERIOD_TEXT) for (const line of seg) expect(line).not.toMatch(BANNED);
  });
});

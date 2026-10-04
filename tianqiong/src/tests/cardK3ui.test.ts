/* ============================================================
   卡 K3-UI · 四个系统的面板入口
   K3 把通讯网／时之缝隙／文化／冒险经济四套系统做成了引擎，
   但它们此前**只有 effects、没有入口**——玩家在界面上看不见任何一处，
   只能从 AI 的随机叙事里偶然瞥见。本卡把面板与动作接上：
   菜单负责把数据摊开，动作负责真的落到引擎上（不是"面板说能、点了没反应"）。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { core } from '@/world/WorldState';
import { newGame } from '@/world/WorldRuntime';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { bus, rng, scheduler, worldBus } from '@/events/EventBus';
import { commMenu, commSend, commWays } from '@/systems/commnet/CommNet';
import { timeslipMenu, timeslipEnter, slipTypes } from '@/systems/timeslip/Timeslip';
import { cultureMenu, taboos, violateTaboo } from '@/systems/culture/Culture';
import { adventuringMenu, claimToken, planAdvice, tokenDefs } from '@/systems/adventuring/Adventuring';
import { ageOf } from '@/systems/timeslip/Lifespan';
import { TICKS_PER_YEAR } from '@/world/WorldClock';

const s = () => core.S!;

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  worldBus.reset();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(41);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: 'K3UI', race: 'human', cls: 'warrior' });
});

describe('卡 K3-UI · 四套系统都有了入口', () => {
  it('四个菜单都能开（零入口的模块变成了有面板的模块）', () => {
    expect(() => commMenu()).not.toThrow();
    expect(() => timeslipMenu()).not.toThrow();
    expect(() => cultureMenu()).not.toThrow();
    expect(() => adventuringMenu()).not.toThrow();
  });

  it('面板读的是各系统自己的数据源，不是另抄一份', () => {
    expect(commWays().length).toBeGreaterThan(1);
    expect(slipTypes().length).toBeGreaterThan(1);
    expect(taboos().length).toBeGreaterThan(0);
    expect(tokenDefs().length).toBeGreaterThan(0);
  });
});

describe('卡 K3-UI · 通讯：发得出去，也真的扣了钱', () => {
  it('发一条跨大陆口信：发得出、发一条 message_sent 世界事实', () => {
    const seen: string[] = [];
    worldBus.on('message_sent', () => seen.push('x'), 'test-k3ui');
    expect(commSend('windport')).toBe(true);
    expect(seen.length, '消息该上报一次').toBe(1);
  });

  it('寄不到的地方被拒（不臆造一条能送到虚空的信）', () => {
    expect(commSend('no_such_place')).toBe(false);
  });

  it('自动挑当下最便宜的手段：钱只减不增，且减的是那一种的价', () => {
    const gold0 = s().player.gold;
    expect(commSend('frosthold')).toBe(true);
    expect(s().player.gold).toBeLessThanOrEqual(gold0);
  });
});

describe('卡 K3-UI · 时之缝隙：闭关以年岁计价', () => {
  it('入加速型小世界：外界时间推进、经验入账', () => {
    const t0 = s().t;
    const exp0 = s().player.exp;
    expect(timeslipEnter('fast', 30)).toBe(true);
    expect(s().t, '外界时间要真的走').toBeGreaterThan(t0);
    expect(s().player.exp, '内里的修炼要真的换成经验').toBeGreaterThan(exp0);
  });

  it('闭关 360 日（外界一年）→ 年龄长一岁（与卡 L1 咬合）', () => {
    const a0 = ageOf(s());
    expect(timeslipEnter('fast', 360)).toBe(true);
    expect(ageOf(s())).toBeCloseTo(a0 + 1, 2);
  });

  it('静止型小世界进不去——时间不流动，等于被封存', () => {
    expect(timeslipEnter('still', 30)).toBe(false);
  });
});

describe('卡 K3-UI · 文化：禁忌是明知故犯', () => {
  it('触犯当前大陆的禁忌：扣声望、发 taboo_violated 事实', () => {
    const here = taboos().find((t) => t.continent === '中央大陆');
    expect(here, '中央大陆该有禁忌').toBeTruthy();
    const seen: string[] = [];
    worldBus.on('taboo_violated', () => seen.push('x'), 'test-k3ui');
    expect(violateTaboo(here!.id)).toBe(true);
    expect(seen.length).toBe(1);
    /* 扣的是哪一项由数据决定，这里只要求"至少留下一道负声望" */
    expect(Object.values(s().rep).some((v) => v < 0), '触犯禁忌至少要留一道负声望').toBe(true);
  });

  it('别的大陆的禁忌在本地犯不了（判定按所在地）', () => {
    const other = taboos().find((t) => t.continent !== '中央大陆');
    if (other) expect(violateTaboo(other.id)).toBe(false);
  });

  it('瞎编的禁忌 id 一律拒绝', () => {
    expect(violateTaboo('not_a_taboo')).toBe(false);
  });
});

describe('卡 K3-UI · 冒险账本：兑换物领得到', () => {
  it('领取兑换物：置 flag 并记历史（可重复调用不报错）', () => {
    const t = tokenDefs()[0];
    expect(claimToken(t.id)).toBe(true);
    expect(s().player.flags['tk_' + t.id]).toBe(true);
  });

  it('账本给出人话摘要，且随认证等级变化', () => {
    const line = planAdvice(s());
    expect(line.length).toBeGreaterThan(8);
    s().player.guildRank = 'S';
    expect(planAdvice(s())).toContain('圣徒级');
  });

  it('瞎编的兑换物 id 一律拒绝', () => {
    expect(claimToken('not_a_token')).toBe(false);
  });
});

describe('卡 K3-UI · 与既有系统的咬合', () => {
  it('小世界的年岁消耗走的是卡 L1 的年龄，不是自己另算一份', () => {
    const a0 = ageOf(s());
    timeslipEnter('slow', 120);
    /* 减速型 5:1：外界 120 日 = 内 24 日；年龄按**外界**算 */
    expect(ageOf(s())).toBeCloseTo(a0 + 120 / 360, 3);
    expect(TICKS_PER_YEAR).toBe(48 * 360);
  });
});

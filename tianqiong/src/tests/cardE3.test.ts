/* ============================================================
   卡 E3 · 跨大陆交通系统（世界书 §10）
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler, newGame } from '@/world';
import { advance } from '@/world/WorldClock';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { allRoutes, canDepart, depart, routeTo } from '@/systems/travel/Travel';

beforeEach(() => {
  core.S = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  const r = rng.seed(23);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return r;
});
const start = () => newGame({ name: 'E3', race: 'human', cls: 'warrior' });

describe('卡 E3 · 路线与前置校验', () => {
  it('6 条跨大陆路线，枢纽均有对应 routeTo', () => {
    expect(allRoutes().length).toBe(6);
    expect(routeTo('frosthold')!.id).toBe('r_north');
    expect(routeTo('skycap')!.needPass).toBe('pass_sky');
  });
  it('不在出发地 → 不可出发', () => {
    start();
    core.S!.player.loc = 'plaza';
    expect(canDepart('r_north').ok).toBe(false);
  });
  it('旅费不足 → 不可出发', () => {
    start();
    const s = core.S!;
    s.player.loc = 'gate';
    s.player.gold = 100; // < 800
    expect(canDepart('r_north').ok).toBe(false);
  });
  it('缺通行凭证 → 不可出发；置 flag 后可', () => {
    start();
    const s = core.S!;
    s.player.loc = 'gate';
    s.player.gold = 9999;
    s.weather = '晴';
    /* 卡 J5 起路线凭证有两条来路，任一满足即可（独立审查 L-2 整改：
       原断言会被「缺凭证」与「大陆未解锁」两个原因同时满足，覆盖被稀释）。
       这里把两条来路分别钉一次。 */
    expect(canDepart('r_east').ok, '两样都没有 → 不可出发').toBe(false);

    /* 来路 ①：显式通行凭证（不必等大陆声望） */
    s.player.flags.pass_sea = true;
    expect(canDepart('r_east').ok, '持凭证即放行').toBe(true);

    /* 来路 ②：目的地大陆已解锁 */
    s.player.flags.pass_sea = false;
    expect(canDepart('r_east').ok, '清掉凭证后又被拦').toBe(false);
    s.rep.guild = 60;
    expect(canDepart('r_east').ok, '大陆解锁同样放行——被接纳了，文书自然办得下来').toBe(true);
  });
});

describe('卡 E3 · 远行落地', () => {
  it('成功远行：扣旅费、推进天数、抵达目的地', () => {
    start();
    const s = core.S!;
    s.player.loc = 'gate';
    s.player.gold = 5000;
    s.weather = '晴';
    s.rep.empire = 30; // 卡 J5：北方冻土需帝国声望 ≥ 20（关文房才给开具北境文书）
    /* 卡 T4：北方航线 12–2 月冰封（世界书 §74）。开局在 1 月，若不动时间，
       测的就是「季节拦人」——推到初夏再走，用例回到它原本要验的远行链路。 */
    advance(100 * 48);
    const t0 = s.t;
    const g0 = s.player.gold;
    const res = depart('r_north');
    expect(res.ok).toBe(true);
    expect(s.player.loc).toBe('frosthold');
    expect(s.player.gold).toBe(g0 - 800);
    expect(s.t).toBeGreaterThanOrEqual(t0 + 6 * 48); // ≥ 6 日（天气可能延误）
    expect(s.history.some((h) => h.c.includes('远行抵达霜锚堡'))).toBe(true);
  });
});

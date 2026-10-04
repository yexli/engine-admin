/* ============================================================
   卡 G · 分支事件下游内容（flag 解锁/封锁玩法 + 剧情链）
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler, newGame } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { shopRows } from '@/systems/economy/Shop';
import { guardChance } from '@/systems/faction/Diplomacy';
import { go } from '@/actions/ActionExecutor';
import { adjRepAxis } from '@/systems/faction/Factions';
import { directorTick } from '@/events/EventProcessor';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  const r = rng.seed(37);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return r;
});
const start = () => newGame({ name: 'G', race: 'human', cls: 'warrior' });

describe('卡 G · shadow_ally 下游：黑市独家货', () => {
  it('未入伙：黑市无虚空精华；入伙后上架', () => {
    start();
    const s = core.S!;
    s.player.loc = 'alley';
    expect(shopRows('black').some((r) => r.iid === 'void_essence')).toBe(false);
    s.player.flags.shadow_ally = true;
    expect(shopRows('black').some((r) => r.iid === 'void_essence')).toBe(true);
  });
});

describe('卡 G · manhunt 下游：盘查逼近上限', () => {
  it('海捕旗标抬高城卫盘查概率', () => {
    start();
    const s = core.S!;
    const base = guardChance(s);
    s.player.flags.manhunt = true;
    expect(guardChance(s)).toBeGreaterThanOrEqual(0.75);
    expect(guardChance(s)).toBeGreaterThan(base);
  });
});

describe('卡 G · heretic 下游：踏入神殿遭圣殿守卫', () => {
  it('异端进入神殿 → 触发战斗', () => {
    start();
    const s = core.S!;
    s.player.loc = 'plaza';
    s.player.flags.heretic = true;
    go('temple');
    expect(core.CB).toBeTruthy(); // 战斗已开
    expect(core.CB!.foes.some((f) => f.mid === 'templar')).toBe(true);
  });
  it('非异端进入神殿 → 不触发守卫战斗', () => {
    start();
    core.S!.player.loc = 'plaza';
    go('temple');
    expect(core.CB).toBeFalsy();
  });
});

describe('卡 G · 剧情链：分支事件派生后续', () => {
  it('暗影招揽触发后，同 tick 级联出「暗影的契约」', () => {
    start();
    const s = core.S!;
    s.t = 6 * 48;
    adjRepAxis('shadow', 'trust', 30, s);
    directorTick(s);
    expect(s.events.some((e) => e.id === 'shadow_pact')).toBe(true);
    expect(s.events.some((e) => e.id === 'shadow_contract')).toBe(true);
    expect(s.player.flags.shadow_contract).toBe(true);
  });
  it('异端审判触发后，级联出「审判官的眼睛」', () => {
    start();
    const s = core.S!;
    s.t = 6 * 48;
    adjRepAxis('temple_life', 'religion', -30, s);
    directorTick(s);
    expect(s.player.flags.heretic).toBe(true);
    expect(s.player.flags.inquisited).toBe(true);
  });
  it('海捕触发后，级联出「赏金令」', () => {
    start();
    const s = core.S!;
    s.t = 6 * 48;
    adjRepAxis('empire', 'hostility', 50, s);
    directorTick(s);
    expect(s.player.flags.manhunt).toBe(true);
    expect(s.player.flags.bounty).toBe(true);
  });
});

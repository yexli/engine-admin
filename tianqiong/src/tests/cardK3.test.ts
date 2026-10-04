/* ============================================================
   卡 N1–N4 · K3 四个新系统（世界书 §60–§63 / §84 / §7·§80·§89 / §94–§98）
   commnet 通讯 / timeslip 时间流速 / culture 文化 / adventuring 冒险经济
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { core, newState } from '@/world/WorldState';
import { bus, rng, scheduler, worldBus } from '@/events/EventBus';
import { commLimits, commView, commWays, distanceOf, sendMessage, wayById } from '@/systems/commnet/CommNet';
import { exileInnerYears, innerDays, lifespanOf, outerDays, slipTypes, slipView } from '@/systems/timeslip/Timeslip';
import { attires, cultureHere, foodOf, games, taboos, taboosOf, violateTaboo } from '@/systems/culture/Culture';
import { claimToken, expectedReturn, industryOf, playerReturn, roiTiers, tokenDefs, wealthBands } from '@/systems/adventuring/Adventuring';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  rng.seed(37);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  core.S = newState({ name: 'K3', race: 'human', cls: 'warrior' });
});

describe('卡 N2 · 通讯网络（§84）', () => {
  it('八种通讯方式齐备', () => {
    expect(commWays().map((w) => w.id)).toEqual(['word', 'letter', 'pigeon', 'scroll', 'stone', 'tower', 'oracle', 'starnet']);
  });

  it('即时与非即时分得清：书信要等、传音石即时', () => {
    expect(wayById('letter')!.speedDays).toBeGreaterThan(0);
    expect(wayById('stone')!.speedDays).toBe(0);
    expect(wayById('pigeon')!.speedDays).toBeGreaterThan(0);
    expect(wayById('pigeon')!.speedDays).toBeLessThan(wayById('letter')!.speedDays);
  });

  it('距离口径：同大陆近、跨大陆远', () => {
    expect(distanceOf('plaza', 'market')).toBeLessThan(distanceOf('plaza', 'frosthold'));
  });

  it('传音石够不到跨大陆（§84：100 米–10 公里）', () => {
    const s = core.S!;
    const r = commView(s).reachable('plaza', 'frosthold').find((x) => x.id === 'stone')!;
    expect(r.ok).toBe(false);
  });

  it('神谕术需神官级以上（§84 限制）', () => {
    const s = core.S!;
    s.player.level = 3;
    expect(commView(s).reachable('plaza', 'market').find((x) => x.id === 'oracle')!.ok).toBe(false);
    s.player.level = 6;
    expect(commView(s).reachable('plaza', 'market').find((x) => x.id === 'oracle')!.ok).toBe(true);
  });

  it('发讯扣费并发 message_sent 事件（带到达日）', () => {
    const s = core.S!;
    s.player.gold = 999999;
    /* 世界事实走 worldBus（bus 是 UI 通道，两者不是同一条总线） */
    const seen: string[] = [];
    const off = worldBus.on('message_sent', (e) => {
      seen.push(String((e.data as Record<string, unknown>).arriveDay));
    }, 'test-k3');
    expect(sendMessage('letter', 'frosthold', '问安')).toBe(true);
    off();
    expect(seen.length).toBe(1);
    expect(Number(seen[0])).toBeGreaterThan(1);
  });

  it('钱不够时发不出去', () => {
    const s = core.S!;
    s.player.gold = 0;
    expect(sendMessage('scroll', 'market', '急报')).toBe(false);
  });

  it('限制清单来自数据（$84 的五条）', () => {
    expect(Object.keys(commLimits()).length).toBeGreaterThanOrEqual(5);
  });
});

describe('卡 N3 · 小世界与寿命（§7/§80/§89）', () => {
  it('四类型齐备，加速 1:5、减速 5:1（裁决 D1）', () => {
    const t = slipTypes();
    expect(t.map((x) => x.id)).toEqual(['fast', 'slow', 'variant', 'still']);
    expect(t.find((x) => x.id === 'fast')!.ratio).toBe('1:5');
    expect(t.find((x) => x.id === 'slow')!.ratio).toBe('5:1');
  });

  it('内外换算：加速型外 10 日 = 内 50 日；减速型反之', () => {
    expect(innerDays('fast', 10)).toBe(50);
    expect(innerDays('slow', 10)).toBe(2);
    expect(outerDays('slow', 1)).toBe(5);
    expect(innerDays('still', 10)).toBe(0);
  });

  it('§89 流放换算：外界 100 年 ≈ 狱内 20 年（D1=1:5，旧版 14 年已作废）', () => {
    expect(exileInnerYears(100)).toBe(20);
  });

  it('五档寿命表，境界越高越长', () => {
    const s = core.S!;
    s.player.level = 1;
    const low = lifespanOf(1, s);
    s.player.level = 6;
    const high = lifespanOf(6, s);
    expect(high.min).toBeGreaterThan(low.min);
    expect(lifespanOf(6, s).rank).toMatch(/神阶/);
  });

  it('slipView 带出时间魔法三限制与流放示例', () => {
    const v = slipView();
    expect(Object.keys(v.timeMagic).length).toBe(3);
    expect(v.exileExample.inner).toBe(20);
  });
});

describe('卡 N4 · 文化判定（§94–§98）', () => {
  it('七大陆的饮食都登记（主食/特色/餐具）', () => {
    for (const c of ['中央大陆', '东方群岛', '南方沙漠', '北方冻土', '西方荒野', '地下深渊', '天空浮岛']) {
      const f = foodOf(c);
      expect(f?.staple, c).toBeTruthy();
      expect(f?.specialty, c).toBeTruthy();
      expect(f?.utensil, c).toBeTruthy();
    }
  });

  it('七条禁忌各归其大陆，且都带声望惩罚', () => {
    expect(taboos().length).toBe(7);
    for (const t of taboos()) expect(Object.keys(t.penalty.rep ?? {}).length, t.id).toBeGreaterThan(0);
    expect(taboosOf('中央大陆').length).toBeGreaterThan(0);
  });

  it('触犯本地禁忌：扣声望 + 发 taboo_violated 事件', () => {
    const s = core.S!;
    s.player.loc = 'plaza'; // 中央大陆
    const before = s.rep.temple_life ?? 0;
    let fired = false;
    const off = worldBus.on('taboo_violated', () => { fired = true; }, 'test-k3');
    expect(violateTaboo('tb_cen', s)).toBe(true);
    off();
    expect(fired).toBe(true);
    expect(s.rep.temple_life).toBeLessThan(before);
  });

  it('不在该大陆时触犯不了（判定按所在地）', () => {
    const s = core.S!;
    s.player.loc = 'plaza';
    expect(violateTaboo('tb_deep', s)).toBe(false);
  });

  it('服饰身份标识五类、竞技五项齐备', () => {
    expect(attires().length).toBe(5);
    expect(games().length).toBe(5);
  });

  it('cultureHere 给出当前大陆的饮食与禁忌', () => {
    const h = cultureHere(core.S!);
    expect(h.continent).toBe('中央大陆');
    expect(h.food).toBeTruthy();
    expect(h.taboos.length).toBeGreaterThan(0);
  });
});

describe('卡 N1 · 冒险经济（§60–§63）', () => {
  it('四档 ROI 齐备，死亡率随阶递增（§62）', () => {
    const r = roiTiers();
    expect(r.length).toBe(4);
    for (let i = 1; i < r.length; i++) expect(r[i].death).toBeGreaterThan(r[i - 1].death);
  });

  it('expectedReturn 给出投入/期望/死亡率', () => {
    const e = expectedReturn('见习级')!;
    expect(e.invest).toBe(10);
    expect(e.avg).toBeGreaterThan(e.invest);
  });

  it('五阶层财富占比合计为 1（§63）', () => {
    const sum = wealthBands().reduce((a, x) => a + x.pop, 0);
    expect(Math.round(sum * 100) / 100).toBe(1);
  });

  it('七大陆产业进出口齐备（§61）', () => {
    for (const c of ['中央大陆', '东方群岛', '南方沙漠', '北方冻土', '西方荒野', '地下深渊', '天空浮岛']) {
      expect(industryOf(c)?.main, c).toBeTruthy();
    }
  });

  it('四种特殊兑换物可领取（§60）', () => {
    expect(tokenDefs().length).toBe(4);
    expect(claimToken('tk_explore', core.S!)).toBe(true);
    expect(core.S!.player.flags.tk_tk_explore).toBe(true);
  });

  it('playerReturn 按认证等级给出期望（与 R5 的认证联动）', () => {
    const s = core.S!;
    expect(playerReturn(s)?.rank).toBe('见习级');
    s.player.guildRank = 'B';
    expect(playerReturn(s)?.rank).toBe('主教级');
  });
});

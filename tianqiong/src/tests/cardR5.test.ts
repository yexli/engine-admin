/* ============================================================
   卡 R5 · 公会认证与规约（世界书 §23 / §91 / §104）
   认证等级映射 / 委托抽成 / 接单门槛 / 管辖边界
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { core, newState } from '@/world/WorldState';
import { bus, rng, scheduler } from '@/events/EventBus';
import {
  canAccept,
  certify,
  doCertify,
  dungeonWarden,
  floorAccess,
  guildFee,
  guildRank,
  guildView,
  GUILD_CUT,
  GUILD_RANKS,
  questIncome,
  rankByLevel,
} from '@/systems/quest/Guild';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  rng.seed(13);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  core.S = newState({ name: 'R5', race: 'human', cls: 'warrior' });
});

describe('卡 R5 · 认证等级映射（§104）', () => {
  it('五档齐全且境界门槛单调递增', () => {
    expect(GUILD_RANKS.map((r) => r.id)).toEqual(['D', 'C', 'B', 'A', 'S']);
    for (let i = 1; i < GUILD_RANKS.length; i++) {
      expect(GUILD_RANKS[i].minLevel).toBeGreaterThan(GUILD_RANKS[i - 1].minLevel);
    }
  });

  it('境界推算等级：Lv.1→D、Lv.3→C、Lv.6→S', () => {
    expect(rankByLevel(1)).toBe('D');
    expect(rankByLevel(2)).toBe('D');
    expect(rankByLevel(3)).toBe('C');
    expect(rankByLevel(5)).toBe('A');
    expect(rankByLevel(6)).toBe('S');
  });

  it('未认证过的角色一律是最低档 D（认证须主动取得，不是境界别名）', () => {
    const s = core.S!;
    s.player.level = 4;
    s.player.guildRank = undefined;
    expect(guildRank(s)).toBe('D');
    expect(rankByLevel(4), 'rankByLevel 只回答「该档要多少境界」').toBe('B');
  });
});

describe('卡 R5 · 认证晋升', () => {
  it('境界不足时拒，并说明差在哪一档', () => {
    const s = core.S!;
    s.player.level = 1; // D 级，下一档是 C（需 Lv.3）
    const r = certify(s);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/境界不足/);
    expect(r.to).toBe('C');
  });

  it('境界达标但钱不够时给出所需认证费', () => {
    const s = core.S!;
    s.player.level = 3;
    s.player.gold = 0;
    const r = certify(s);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/认证费/);
    expect(r.fee).toBeGreaterThan(0);
  });

  it('达标后认证落库为独立字段（不是 flags——那层是 boolean）', () => {
    const s = core.S!;
    s.player.level = 3;
    s.player.gold = 999999;
    expect(doCertify(s)).toBe(true);
    expect(guildRank(s)).toBe('C');
    expect(s.player.guildRank).toBe('C');
    expect(typeof s.player.flags).toBe('object');
    expect(s.player.flags.guild_rank).toBeUndefined();
  });

  it('最高档之后不再晋升', () => {
    const s = core.S!;
    s.player.level = 6;
    s.player.guildRank = 'S';
    expect(certify(s).ok).toBe(false);
    expect(certify(s).why).toMatch(/最高认证/);
  });
});

describe('卡 R5 · 委托抽成（§23）', () => {
  it('抽成比例 10%，整数取整', () => {
    expect(GUILD_CUT).toBe(0.1);
    expect(guildFee(4000)).toBe(400);
    expect(guildFee(1000)).toBe(100);
    expect(guildFee(0)).toBe(0);
  });

  it('悬赏类不抽成（§91 特权③：悬赏所得归自己）', () => {
    expect(guildFee(4000, 'bounty')).toBe(0);
  });

  it('questIncome 只对标了 guildCut 的委托扣费', () => {
    expect(questIncome(4000, 'q_rabbit')).toBe(3600); // 标了 guildCut
    expect(questIncome(4000, 'q_debt')).toBe(4000); // 没标
  });
});

describe('卡 R5 · 接单门槛', () => {
  it('委托未声明 reqRank 时默认可接', () => {
    const s = core.S!;
    expect(canAccept('q_rabbit', s).ok).toBe(true);
  });

  it('不存在的委托被拒', () => {
    expect(canAccept('q_nope', core.S!).ok).toBe(false);
  });
});

describe('卡 R5 · 管辖边界（§23 末条）', () => {
  it('50 层以下归掘渊，以上归冒险者公会', () => {
    expect(dungeonWarden(1)).toBe('deep');
    expect(dungeonWarden(50)).toBe('deep');
    expect(dungeonWarden(51)).toBe('guild');
    expect(dungeonWarden(100)).toBe('guild');
  });

  it('掘渊声望为负时进不去 50 层以下', () => {
    const s = core.S!;
    s.rep.deep = -20;
    expect(floorAccess(30, s).ok).toBe(false);
    expect(floorAccess(30, s).why).toMatch(/掘渊/);
  });

  it('深层需 C 级以上认证（D 级只能到 60 层）', () => {
    const s = core.S!;
    s.rep.deep = 10;
    s.player.level = 1; // D 级
    expect(floorAccess(55, s).ok).toBe(true);
    expect(floorAccess(70, s).ok).toBe(false);
    s.player.guildRank = 'C';
    expect(floorAccess(70, s).ok).toBe(true);
  });
});

describe('卡 R5 · 视图', () => {
  it('guildView 给出当前档、说明与下一档费用', () => {
    const s = core.S!;
    s.player.level = 3;
    const v = guildView(s);
    /* 认证须主动取得：Lv.3 仍是最低档 D，下一档才是 C */
    expect(v.rank).toBe('D');
    expect(v.next?.id).toBe('C');
    expect(v.note).toBeTruthy();
    expect(v.all.length).toBe(5);
    expect(v.cutPct).toBe(GUILD_CUT);
  });
});

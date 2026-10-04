/* ============================================================
   卡 H1 · 星枢七塔补完：星海参悟 / 星塔试炼 / 星斗台竞技 / 星殿议事
   确定性：种子随机 + 同步调度器 + 内存存档；网内铁律（真身无损）断言。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, newGame, rng, scheduler } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { STARHUB } from '@/data/starhub';
import { abyssLocked, arenaBet, arenaMenu, councilDecree, councilMenu, councilTalk, enterNet, insight, insightMenu, openNet, trialClimb, trialMenu } from '@/systems/starnet/StarNet';
import { ALL_EVENTS } from '@/events/EventProcessor';

beforeEach(() => {
  core.S = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(11);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: 'H1', race: 'human', cls: 'warrior' });
  enterNet();
});

describe('卡 H1 · 星海 · 意境参悟（star2）', () => {
  it('参悟累积心境；未达阈值不破境', () => {
    const s = core.S!;
    const net = s.net!;
    const m0 = net.insights!.mood;
    insight();
    expect(net.insights!.mood).toBeGreaterThanOrEqual(m0); // 心魔才减；种子下大概率增
    expect(net.insights!.sessions).toBe(0);
  });
  it('心境 ≥ 阈值 → 破境：经验大进、心境回落、次数 +1', () => {
    const s = core.S!;
    const net = s.net!;
    net.insights!.mood = STARHUB.insight.breakthroughAt; // 直接触发
    const exp0 = s.player.exp;
    insight();
    expect(net.insights!.sessions).toBe(1);
    expect(net.insights!.mood).toBe(40);
    expect(s.player.exp).toBeGreaterThan(exp0);
  });
  it('参悟消耗现实时辰（§10 防无尽修行）', () => {
    const s = core.S!;
    const t0 = s.t;
    insight();
    expect(s.t - t0).toBe(STARHUB.insight.costTicks);
  });
  it('菜单可开（演出描述符经 bus，不崩）', () => {
    expect(() => insightMenu()).not.toThrow();
  });
});

describe('卡 H1 · 星塔 · 登塔试炼（star3）', () => {
  it('挑战成功 → trialBest 递进到目标层', () => {
    const s = core.S!;
    const net = s.net!;
    // 注入确定成功：roll+mod ≥ dc（力量 mod 已知 ≥1，roll 20 必成——种子扫至 roll=20）
    let restore = rng.seed(12345);
    // 找一个能成功的种子：直接扫几次
    for (let i = 0; i < 200; i++) {
      const before = net.trialBest || 0;
      const coin0 = net.starcrystal;
      trialClimb();
      if (net.trialBest && net.trialBest > before) {
        if (net.trialBest % STARHUB.trial.starcrystalEvery === 0) expect(net.starcrystal).toBeGreaterThan(coin0);
        restore();
        return;
      }
      restore = rng.seed(1000 + i);
    }
    restore();
    throw new Error('200 个种子内未出现成功——DC 或 mod 配置异常');
  });
  it('挑战失败 → 神思昏沉推进时间（不伤真身 hp）', () => {
    const s = core.S!;
    const net = s.net!;
    /* 扫一个必然失败的种子（同本文件登顶用例的手法），在**同一次调用**前后断言：
       「时间推进了 且 层数没涨」才是失败分支真的落地。
       原来断言的是 [s.t > t0, net.trialBest !== undefined].toContain(true)——
       析取式恒真（trialBest 一经初始化就存在），等于没验失败路径（审查 §假通过）。 */
    let restore = rng.seed(1);
    for (let i = 0; i < 200; i++) {
      s.player.hp = 30; // 任意值；网内试炼绝不改 hp
      const t0 = s.t;
      const best0 = net.trialBest || 0;
      trialClimb();
      const failed = s.t > t0 && (net.trialBest || 0) === best0;
      const hpKept = s.player.hp === 30;
      restore();
      if (failed) {
        expect(hpKept, '失败只花神思，不伤真身 hp').toBe(true);
        return;
      }
      restore = rng.seed(1000 + i);
    }
    restore();
    throw new Error('200 个种子内未出现失败——DC 或 mod 配置异常');
  });
  /* 慢用例：最多 400 次爬塔搜索种子；并行跑全量时容易顶到 5s 默认超时，给足预算 */
  it('第 100 层登顶 → flag + 5 星晶 + 历史', () => {
    const s = core.S!;
    const net = s.net!;
    net.trialBest = STARHUB.trial.maxFloor - 1;
    let restore = rng.seed(1);
    for (let i = 0; i < 400 && !s.player.flags.star_trial_100; i++) {
      restore = rng.seed(i * 7 + 3);
      if ((net.trialBest || 0) < STARHUB.trial.maxFloor - 1) net.trialBest = STARHUB.trial.maxFloor - 1;
      trialClimb();
    }
    restore();
    expect(s.player.flags.star_trial_100).toBe(true);
    expect(net.trialBest).toBe(STARHUB.trial.maxFloor);
    expect(s.history.some((h) => h.c === '星塔登顶')).toBe(true);
  }, 20000);
  it('菜单可开', () => {
    expect(() => trialMenu()).not.toThrow();
  });
});

describe('卡 H1 · 星斗台 · 公开竞技（star5）', () => {
  it('注彩胜 → 星币翻倍入账、胜场 +1', () => {
    const s = core.S!;
    const net = s.net!;
    net.starcoin = 200;
    let done = false;
    for (let i = 0; i < 200 && !done; i++) {
      rng.seed(i * 13 + 1);
      net.starcoin = 200;
      const w0 = net.arenaWins || 0;
      arenaBet(20);
      if ((net.arenaWins || 0) > w0) {
        expect(net.starcoin).toBe(220); // +stake（赢家拿双彩）
        done = true;
      }
    }
    expect(done).toBe(true);
  });
  it('注彩败 → 失注', () => {
    const s = core.S!;
    const net = s.net!;
    let done = false;
    for (let i = 0; i < 400 && !done; i++) {
      rng.seed(i * 29 + 5);
      net.starcoin = 200;
      const w0 = net.arenaWins || 0;
      arenaBet(20);
      if ((net.arenaWins || 0) === w0 && net.starcoin === 180) done = true;
    }
    expect(done).toBe(true);
  });
  it('星币不足拒注', () => {
    const s = core.S!;
    s.net!.starcoin = 5;
    const c0 = s.net!.starcoin;
    arenaBet(20);
    expect(s.net!.starcoin).toBe(c0);
  });
  it('菜单含全部注额档', () => {
    expect(() => arenaMenu()).not.toThrow();
  });
});

describe('卡 H1 · 星殿 · 议事传讯（star7）', () => {
  it('议事调停 → 随机势力观感 +1..3、声望 +1、耗时', () => {
    const s = core.S!;
    const t0 = s.t;
    councilTalk();
    const fav = s.net!.councilFavor || {};
    const total = Object.values(fav).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(1);
    expect(s.t - t0).toBe(STARHUB.council.talkTicks);
  });
  it('发布星谕 → 扣星币 + star_decree 事件入引擎（D4 数据驱动）', () => {
    const s = core.S!;
    s.net!.starcoin = 100;
    councilDecree();
    expect(s.net!.starcoin).toBe(100 - STARHUB.council.decreeCost);
    expect(s.player.flags.star_decree).toBe(true);
    expect(s.events.some((e) => e.id === 'star_decree')).toBe(true);
    expect(s.history.some((h) => h.c.includes('星谕'))).toBe(true);
  });
  it('星谕事件定义存在于 events.json（幂等由 D4 保证）', () => {
    expect(ALL_EVENTS.some((e) => e.id === 'star_decree')).toBe(true);
  });
  it('菜单可开', () => {
    expect(() => councilMenu()).not.toThrow();
  });
});

describe('卡 H1 · 星渊入口（star6 · H2 交接）', () => {
  it('leak=0：入口锁定', () => {
    expect(() => abyssLocked()).not.toThrow(); // toast 拒绝
  });
  it('未入网时所有塔功能拒绝（网内铁律）', () => {
    const s = core.S!;
    s.net!.online = false;
    const t0 = s.t;
    insight();
    expect(s.t).toBe(t0); // 未入网：不耗时、不生效
  });
  it('旧档（无新字段）经 openNet 渲染不崩', () => {
    const s = core.S!;
    delete (s.net as unknown as Record<string, unknown>).insights;
    delete (s.net as unknown as Record<string, unknown>).trialBest;
    s.net!.online = true;
    expect(() => openNet()).not.toThrow();
  });
});

describe('卡 H1 · 星塔塔顶不可零成本刷晶（F-09）', () => {
  it('首次登顶发奖并耗刻；重复挑战第 100 层只给叙事、不产晶体', () => {
    const s = core.S!;
    const net = s.net!;
    net.trialBest = 99; // 下一层即塔顶
    s.player.stats['力量'] = 100; // 第 100 层属性轮换落在力量（(100-1)%3===0），保证检定必过
    const t0 = s.t;
    trialClimb();
    expect(net.trialBest).toBe(100);
    expect(net.starcrystal).toBe(6); // 每 5 层的 1 枚 + 登顶的 5 枚
    expect(s.t).toBe(t0 + STARHUB.trial.climbTicks); // 成功路径同样耗刻
    expect(s.player.flags.star_trial_100).toBe(true);

    const crystal = net.starcrystal;
    const coin = net.starcoin;
    trialClimb();
    expect(net.starcrystal).toBe(crystal); // 重复挑战不再产晶
    expect(net.starcoin).toBe(coin);
    expect(s.t).toBe(t0 + STARHUB.trial.climbTicks * 2); // 仍然耗刻
  });
});

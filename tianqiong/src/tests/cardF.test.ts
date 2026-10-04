/* ============================================================
   卡 F · 六维关系真正驱动剧情走向（引擎侧后果 + 分支事件）
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler, newGame } from '@/world';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { WB } from '@/data/worldBook';
import { guardChance, militaryLeniency, templeFee, templeServiceOk, tradeBuyMod, trustOk } from '@/systems/faction/Diplomacy';
import { HOME_TEMPLE, adjRepAxis } from '@/systems/faction/Factions';
import { buyPrice } from '@/systems/economy/Shop';
import { healSvc } from '@/actions/ActionExecutor';
import { giveQuest, turnIn } from '@/systems/quest/Quests';
import { commitCrime, trial } from '@/systems/law/Law';
import { directorTick } from '@/events/EventProcessor';

beforeEach(() => {
  core.S = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  const r = rng.seed(31);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  return r;
});
const start = () => newGame({ name: 'F', race: 'human', cls: 'warrior' });

describe('卡 F · 通商 → 商店价格', () => {
  it('通商越深买价越低（grocer 属帝国）', () => {
    start();
    const s = core.S!;
    s.player.loc = 'market';
    const iid = 'bread';
    s.playerRep!.empire!.trade = 0;
    const p0 = buyPrice('grocer', iid);
    s.playerRep!.empire!.trade = 60;
    const p1 = buyPrice('grocer', iid);
    expect(p1).toBeLessThan(p0);
    expect(tradeBuyMod('empire', s)).toBeLessThan(1);
  });
});

describe('卡 F · 信仰 → 神殿服务', () => {
  it('信仰过低：治疗被拒、费用上浮', () => {
    start();
    const s = core.S!;
    s.player.gold = 1000;
    s.player.hp = 1;
    adjRepAxis(HOME_TEMPLE, 'religion', -40, s);
    expect(templeServiceOk(s)).toBe(false);
    healSvc();
    expect(s.player.hp).toBe(1); // 未获治疗
    expect(s.player.gold).toBe(1000); // 未扣费
    // 虔诚信徒打折
    adjRepAxis(HOME_TEMPLE, 'religion', 80, s);
    expect(templeServiceOk(s)).toBe(true);
    expect(templeFee(100, s)).toBeLessThan(100);
  });
});

describe('卡 F · 敌意 → 城卫盘查', () => {
  it('帝国敌意抬高盘查概率', () => {
    start();
    const s = core.S!;
    const base = guardChance(s);
    adjRepAxis('empire', 'hostility', 80, s);
    expect(guardChance(s)).toBeGreaterThan(base);
  });
});

describe('卡 F · 信任 → 委托门槛 & 任务累积', () => {
  it('星穹碎片需古研会信任≥10：不足则不开放，达标后可接', () => {
    start();
    const s = core.S!;
    expect(WB.quests.q_shard.reqTrust).toBeTruthy();
    giveQuest('q_shard');
    expect(s.player.quests.q_shard).toBeUndefined(); // 被拒
    adjRepAxis('study', 'trust', 10, s);
    expect(trustOk('study', 10, s)).toBe(true);
    giveQuest('q_shard');
    expect(s.player.quests.q_shard?.stage).toBe('go'); // 达标后开放
  });
  it('完成任务累积该势力信任', () => {
    start();
    const s = core.S!;
    expect(s.playerRep!.guild!.trust).toBe(0);
    giveQuest('q_rabbit');
    s.player.quests.q_rabbit.stage = 'done';
    s.player.quests.q_rabbit.count = 3; // kill 型需达标才可复命
    turnIn('q_rabbit');
    expect(s.playerRep!.guild!.trust).toBeGreaterThan(0); // reward.rep 含 guild → 复命累积信任
  });
});

describe('卡 F · 军事 → 审判从轻', () => {
  it('无军功：重罪监禁；军功≥30：罚金代刑', () => {
    start();
    commitCrime('smuggling', 'market'); // B 级→监禁
    expect(militaryLeniency()).toBe(false);
    expect(trial()).toBe('jail');
    // 重来：高军功
    core.S = null;
    start();
    adjRepAxis('empire', 'military', 40);
    commitCrime('smuggling', 'market');
    expect(militaryLeniency()).toBe(true);
    expect(trial()).toBe('fine'); // 从轻
  });
});

describe('卡 F · 分支剧情事件（数值改变世界走向）', () => {
  it('暗影信任≥30 → 触发招揽事件，置 shadow_ally 旗标', () => {
    start();
    const s = core.S!;
    s.t = 6 * 48; // 越过前 5 日基础事件
    adjRepAxis('shadow', 'trust', 30, s);
    directorTick(s);
    expect(s.events.some((e) => e.id === 'shadow_pact')).toBe(true);
    expect(s.player.flags.shadow_ally).toBe(true);
  });
  it('帝国敌意≥50 → 全城海捕事件', () => {
    start();
    const s = core.S!;
    s.t = 6 * 48;
    adjRepAxis('empire', 'hostility', 50, s);
    directorTick(s);
    expect(s.player.flags.manhunt).toBe(true);
  });
  it('神殿信仰≤-30 → 异端审判事件，关闭圣职（heal 被拒）', () => {
    start();
    const s = core.S!;
    s.t = 6 * 48;
    adjRepAxis(HOME_TEMPLE, 'religion', -30, s);
    directorTick(s);
    expect(s.player.flags.heretic).toBe(true);
    expect(templeServiceOk(s)).toBe(false);
  });
  it('未达阈值时分支事件不触发（世界保持常态）', () => {
    start();
    const s = core.S!;
    s.t = 6 * 48;
    directorTick(s);
    expect(s.player.flags.shadow_ally).toBeFalsy();
    expect(s.player.flags.manhunt).toBeFalsy();
    expect(s.player.flags.heretic).toBeFalsy();
  });
});

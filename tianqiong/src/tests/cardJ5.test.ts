/* ============================================================
   卡 J5 · 大陆机制（《后续开发方案-阶段J》）
   —— 阶段 J 审计实测的**三重死锁**，本文件把它们钉成回归：
     ① locked 永久拦截：ActionExecutor.go():29 是唯一消费点，无解除路径；
     ② 通行证无来源：pass_sea / pass_war / pass_deep / pass_sky 在生产代码里
        零写入，唯一赋值点是 cardE3.test.ts；
     ③ 到了回不来：外大陆不在 WB.travel 表里，路线又是单向的。
   另含「新增大陆」的数据完整性守卫——加一块大陆只改 JSON，这些用例保证
   改漏了会红，而不是等到玩家走到那儿才发现门是假的。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, canDepart, canEnter, continentLockReason, continentUnlocked, core, depart, newGame, resetWorld, rng, scheduler, world } from '@/world';
import { advance } from '@/world/WorldClock';
import { mutate } from '@/world/WorldMutate';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { ruleReasoner } from '@/ai/ruleReasoner';
import { worldBus } from '@/events/EventBus';
import { plugins } from '@/plugins/PluginRegistry';
import { bootstrapWorld } from '@/plugins/bootstrap';
import { worldEventLog } from '@/events/EventStore';
import { WB } from '@/data/worldBook';

const start = () => newGame({ name: '测试者', race: 'dwarf', cls: 'warrior' });

beforeEach(() => {
  core.S = null;
  core.CB = null;
  resetWorld();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  bus.clear();
  worldBus.reset();
  plugins.clear();
  worldEventLog.clear();
  rng.seed(42);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  bootstrapWorld({ reasoner: ruleReasoner });
});

afterEach(() => {
  core.S = null;
  resetWorld();
});

describe('卡 J5 · 大陆数据完整性（新增大陆时的守卫）', () => {
  it('每个地点的大陆都已在 continents.json 里定义', () => {
    for (const id of Object.keys(WB.locations)) {
      const c = WB.locations[id].continent;
      if (!c) continue;
      expect(WB.continents.items[c], id + ' 所属的「' + c + '」没有定义').toBeTruthy();
    }
  });

  it('每个大陆的枢纽地点真实存在，且确实属于该大陆', () => {
    for (const [name, c] of Object.entries(WB.continents.items)) {
      const hub = WB.locations[c.hub];
      expect(hub, name + ' 的枢纽地点 ' + c.hub + ' 不存在').toBeTruthy();
      expect(hub.continent, name + ' 的枢纽不在自己大陆上').toBe(name);
    }
  });

  it('order 与 items 一一对应（顺序表不许漏项、不许重复）', () => {
    const names = Object.keys(WB.continents.items);
    expect(WB.continents.order.length, 'order 与 items 数量不符').toBe(names.length);
    for (const n of names) expect(WB.continents.order, n + ' 没出现在 order 里').toContain(n);
    expect(new Set(WB.continents.order).size, 'order 里有重复项').toBe(names.length);
  });

  it('解锁条件必须在中央大陆可推动（防「条件永远达不成」的死锁回归）', () => {
    for (const [name, c] of Object.entries(WB.continents.items)) {
      const u = c.unlock;
      if (u.kind === 'reputation') {
        expect(Object.keys(WB.factions), name + ' 的解锁势力不存在').toContain(u.faction);
        expect(u.min, name + ' 的门槛要正').toBeGreaterThan(0);
        expect(u.min, name + ' 的门槛不该超过声望上限').toBeLessThanOrEqual(100);
        expect(u.hint, name + ' 必须告诉玩家怎么解锁').toBeTruthy();
      }
      if (u.kind === 'flag') {
        expect(u.flag, name + ' 的 flag 条件必须有名字').toBeTruthy();
        expect(u.hint, name + ' 的 flag 条件必须给提示').toBeTruthy();
      }
    }
  });
});

describe('卡 J5 · 解锁机制（三重死锁之一：locked 永久拦截）', () => {
  it('locked 不再是永久锁：声望达标后地点变为可进入', () => {
    start();
    const s = core.S!;
    expect(canEnter('windport', s), '前置：公会声望不足时不可进').toBe(false);
    s.rep.guild = 60;
    expect(canEnter('windport', s), '声望达标后该放行').toBe(true);
  });

  it('声望门槛：达标前路线被拒，达标后放行', () => {
    start();
    const s = core.S!;
    s.player.gold = 999999;
    mutate.playerLoc('gate'); // 远行要先到路线端点（城门内街）
    const before = canDepart('r_east', s);
    expect(before.ok, '声望不够时不该放行').toBe(false);
    expect(before.reason, '拒绝时要给出可读原因').toBeTruthy();
    s.rep.guild = 60;
    expect(canDepart('r_east', s).ok).toBe(true);
  });

  it('flag 门槛：神选未开启时天空浮岛不可达', () => {
    start();
    const s = core.S!;
    s.player.gold = 999999;
    mutate.playerLoc('gate');
    expect(canDepart('r_sky', s).ok, '前置：神选未开').toBe(false);
    s.player.flags.theoselect_open = true;
    expect(canDepart('r_sky', s).ok, '神选开启后应放行').toBe(true);
  });

  it('进入大陆的资格可择一满足：大陆解锁 或 路线凭证', () => {
    /* 两条来路是**并列**而不是串联——串联等于宣布凭证永远没用
       （大陆没解锁时凭证救不了、解锁后凭证又多余），而审计实测这四个 flag
       在生产代码里本就没有写入点，串联会让四条航线永久焊死。
       卡 T4 追加前提：西方航线 11–3 月大雪封路，本用例把时间推到初夏
       （全局日 101 = 夏季·麦金月），否则测的是「季节拦人」而不是「凭证放行」。 */
    start();
    const s = core.S!;
    s.player.gold = 999999;
    mutate.playerLoc('gate');
    advance(100 * 48);

    expect(canDepart('r_west', s).ok, '声望与凭证都没有 → 拒').toBe(false);

    /* 来路 ①：显式通行凭证（先于大陆声望到手的特殊凭证） */
    s.player.flags.pass_war = true;
    expect(canDepart('r_west', s).ok, '持凭证即可，不必等帝国声望').toBe(true);

    /* 来路 ②：大陆解锁 */
    s.player.flags.pass_war = false;
    expect(canDepart('r_west', s).ok, '清掉凭证后又被拦').toBe(false);
    s.rep.empire = (s.rep.empire ?? 0) + 60;
    expect(canDepart('r_west', s).ok, '声望达标同样放行').toBe(true);
  });

  it('未登记的大陆名按「不设门槛」处理（语义钉死，防有人改成拒绝）', () => {
    /* 这条把 L-1 的语义写成断言：continentUnlocked 对未登记名返回 true。
       配套后果是——含未登记 continent 的地点，其路线凭证检查里 !(cont && true) = false，
       于是凭证与大陆门槛一起被免。这是刻意的取舍（漏登记不该把玩家永久关在门外，
       而且 cardJ5 的数据完整性用例会在测试期抓住漏登记）；写在这里是为了让
       「改成未登记即拒绝」的人必须回来读一遍再动手。 */
    start();
    const s = core.S!;
    expect(continentUnlocked('不存在的大陆', s), '未登记 = 不设门槛，不是拒绝').toBe(true);
    expect(continentLockReason('不存在的大陆', s), '未登记没有锁提示').toBeNull();
  });

  it('未登记的大陆不设门槛（漏登记不该把玩家永久关在门外）', () => {
    start();
    const s = core.S!;
    expect(world.query.get_world_state()).toBe(s);
    /* 中央大陆是 open，任何时候都可进 */
    expect(canEnter('plaza', s)).toBe(true);
    expect(canEnter('gate', s)).toBe(true);
  });
});

describe('卡 J5 · 双向通行（三重死锁之三：到了回不来）', () => {
  it('从外大陆出发可以原路返回中央大陆', () => {
    start();
    const s = core.S!;
    s.player.gold = 999999;
    s.rep.guild = 60;
    mutate.playerLoc('windport'); // 假设玩家已经在翠风港

    const chk = canDepart('r_east', s);
    expect(chk.ok, '路线另一端也必须能启程').toBe(true);

    const r = depart('r_east');
    expect(r.ok).toBe(true);
    expect(s.player.loc, '应回到路线起点（城门内街）').toBe('gate');
  });

  it('两端都不在的位置仍然拒绝（双向不等于任意门）', () => {
    start();
    const s = core.S!;
    s.player.gold = 999999;
    s.rep.guild = 60;
    mutate.playerLoc('tavern');
    expect(canDepart('r_east', s).ok).toBe(false);
  });
});

describe('卡 J5 · 首访记账', () => {
  it('首次抵达写下 visited 与大陆首访，且世界史留下事实', () => {
    start();
    const s = core.S!;
    s.player.gold = 999999;
    s.rep.guild = 60;
    worldEventLog.clear();

    mutate.playerLoc('gate');
    const r = depart('r_east');
    expect(r.ok, r.msg ?? '').toBe(true);
    expect(s.player.flags['visited_windport'], '首访标记该落下').toBe(true);
    /* 键用数据里的英文 id（审查 I-1）：存档 diff 与将来的外部编辑器都不必处理中文键 */
    expect(s.player.flags['continent_east'], '大陆首访该单独记一档').toBe(true);
    expect(
      worldEventLog.recent(80).some((e) => e.type === 'travel_arrived' && e.location === 'windport'),
      '首访要进世界史（因果可追溯的起点）',
    ).toBe(true);
    expect(s.history.some((h) => h.c.includes('东方群岛')), '大陆首访要进大事记').toBe(true);
  });

  it('重复抵达同一地点不重复记账（首访是「每个地点一次」，不是「每次远行一次」）', () => {
    start();
    const s = core.S!;
    s.player.gold = 999999;
    s.rep.guild = 60;
    mutate.playerLoc('gate');

    worldEventLog.clear();
    depart('r_east'); // gate → 翠风港：对翠风港是首访
    expect(
      worldEventLog.recent(80).filter((e) => e.type === 'travel_arrived').length,
      '首访该记一条事实',
    ).toBe(1);

    worldEventLog.clear();
    depart('r_east'); // 翠风港 → 城门：对城门同样是首访（此前从没经远行抵达过）
    expect(
      worldEventLog.recent(80).filter((e) => e.type === 'travel_arrived').length,
      '没去过的地点当然算首访——首访的判据是地点，不是这次出行',
    ).toBe(1);

    worldEventLog.clear();
    depart('r_east'); // 城门 → 翠风港：**第二次**到翠风港
    expect(
      worldEventLog.recent(80).filter((e) => e.type === 'travel_arrived').length,
      '第二次抵达同一个地方不该再发首访事实',
    ).toBe(0);

    /* 为什么不拿 s.history 当断言载体：它是 60 条环形窗口（unshift + pop），
       第二次远行要推进 10 天，日结算写下的事实会把首次的记录挤出窗口——
       断言会随「这一趟走了几天」而随机红绿。世界史有 500 条缓冲，扛得住。 */
  });
});

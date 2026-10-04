/* ============================================================
   卡 S1 · 地理补全（世界书 §64/§72/§73/§74/§75）
   地标 14 处 / 六星险区 7 处 / 气候细节 / 农时矩阵 / 季节封路（T4 已建）
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { WB } from '@/data/worldBook';
import { core, newState } from '@/world/WorldState';
import { bus, rng, scheduler } from '@/events/EventBus';
import { advance } from '@/world/WorldClock';
import { canDepart, seasonalBlock, routeById } from '@/systems/travel/Travel';
import { dangerZones, landmarks, landmarksHere, landmarksOf, zoneById, zoneEncounterChance, zonesOf } from '@/systems/travel/Travel';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  rng.seed(29);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  core.S = newState({ name: 'S1', race: 'human', cls: 'warrior' });
});

describe('卡 S1 · 地标（§75）', () => {
  it('14 处地标齐备，自然/人工各占一半', () => {
    const l = landmarks();
    expect(l).toHaveLength(14);
    expect(l.filter((x) => x.kind === 'natural').length).toBe(7);
    expect(l.filter((x) => x.kind === 'artificial').length).toBe(7);
  });

  it('世界书点名的地标都在（银顶/世界树/金顶/永冻之巅/血吼峰/主井/风暴眼）', () => {
    const names = landmarks().map((x) => x.name);
    for (const n of ['银顶', '世界树', '金顶', '永冻之巅', '血吼峰', '主井', '风暴眼']) {
      expect(names, n).toContain(n);
    }
  });

  it('每处地标都归属到已登记的大陆（地图能聚合）', () => {
    for (const l of landmarks()) expect(WB.continents.order, l.name).toContain(l.continent);
  });

  it('按大陆取地标：人间七块大陆都至少有一处', () => {
    for (const c of WB.continents.order) {
      /* 地标是世界书给凡间记的地名；异界不在凡间地理的账上。 */
      if ((WB.continents.items[c] as unknown as { otherworld?: boolean }).otherworld) continue;
      expect(landmarksOf(c).length, c).toBeGreaterThan(0);
    }
  });

  it('玩家在圣辉城时能读到中央大陆的地标', () => {
    const here = landmarksHere(core.S!);
    expect(here.length).toBeGreaterThan(0);
    expect(here.every((x) => x.continent === '中央大陆')).toBe(true);
  });
});

describe('卡 S1 · 六星险区（§73）', () => {
  it('7 处险区，星级落在 1–6 且最高为神罚级', () => {
    const z = dangerZones();
    expect(z).toHaveLength(7);
    for (const x of z) { expect(x.stars).toBeGreaterThanOrEqual(1); expect(x.stars).toBeLessThanOrEqual(6); }
    expect(Math.max(...z.map((x) => x.stars))).toBe(6);
  });

  it('世界书点名的险区都在（神弃之地/极夜海/熔岩山脉/时空乱流…）', () => {
    const names = dangerZones().map((x) => x.name);
    for (const n of ['神弃之地', '星霜海深处', '大沙海深处', '极夜海', '熔岩山脉', '100 层以下', '时空乱流']) {
      expect(names, n).toContain(n);
    }
  });

  it('遭遇概率随星级单调上升，且封顶不超 1', () => {
    expect(zoneEncounterChance(1)).toBeLessThan(zoneEncounterChance(6));
    expect(zoneEncounterChance(6)).toBeLessThanOrEqual(0.9);
    expect(zoneEncounterChance(0)).toBeGreaterThan(0);
  });

  it('zoneById / zonesOf 可查（面板与判定共用一处）', () => {
    expect(zoneById('dz_godforsaken')?.stars).toBe(6);
    expect(zonesOf('中央大陆').some((x) => x.id === 'dz_godforsaken')).toBe(true);
  });
});

describe('卡 S1 · 气候与农时（§64/§72）', () => {
  it('七大陆都有气候细节（温度/雨量/季节）', () => {
    for (const name of WB.continents.order) {
      const it = WB.continents.items[name] as unknown as { climateDetail?: { temp: string; rain: string; seasons: string }; otherworld?: boolean };
      /* 异界无天气系统——神界恒春、魔界腐坏，那是「界况」不是「气候」。 */
      if (it.otherworld) continue;
      expect(it.climateDetail?.temp, name).toBeTruthy();
      expect(it.climateDetail?.rain, name).toBeTruthy();
      expect(it.climateDetail?.seasons, name).toBeTruthy();
    }
  });

  it('七大陆都有五段农时（地下深渊为无季节）', () => {
    for (const name of WB.continents.order) {
      const it = WB.continents.items[name] as unknown as { agri?: string[]; otherworld?: boolean };
      /* 异界不种地：农时是给凡间农业与季节封路用的。 */
      if (it.otherworld) continue;
      expect(it.agri?.length, name).toBe(5);
    }
    const under = WB.continents.items['地下深渊'] as unknown as { agri: string[] };
    expect(new Set(under.agri).size).toBe(1); // 地底无季节
  });
});

describe('卡 S1 · 季节封路（§74 · T4 建、本卡回归）', () => {
  it('北方航线冬天封路、夏天通', () => {
    const s = core.S!;
    const r = routeById('r_north')!;
    s.t = 0; // 新芽月（idx 0）落在封路窗口 [11,0,1]
    expect(seasonalBlock(r, s).blocked).toBe(true);
    s.t = 4 * 48 * 30; // 约第 5 个月（烈阳月）
    expect(seasonalBlock(r, s).blocked).toBe(false);
  });

  it('封路时 canDepart 给的是季节理由，不是旅费理由', () => {
    const s = core.S!;
    s.player.loc = 'gate';
    s.player.gold = 999999;
    s.rep.empire = 60;
    s.t = 0;
    const c = canDepart('r_north', s);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/冰封/);
  });

  it('推进到夏天后同一路线放行（回归：季节判定不粘住）', () => {
    const s = core.S!;
    s.player.loc = 'gate';
    s.player.gold = 999999;
    s.rep.empire = 60;
    advance(120 * 48); // 推到初夏
    expect(canDepart('r_north', s).ok, canDepart('r_north', s).reason).toBe(true);
  });
});

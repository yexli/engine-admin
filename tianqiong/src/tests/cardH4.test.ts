/* ============================================================
   卡 H4 · 地下城 100 层爬层：分层数据 / 入口渐进解锁 / 撤退续爬 /
   掉落物价档 / 星塔试炼镜像无伤 / 深渊层 100 钩子 / 迁移降级
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { core, rng, scheduler, bus } from '@/world';
import { newGame } from '@/world/WorldRuntime';
import { hydrate } from '@/world/WorldState';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import {
  MAX_FLOOR,
  dungeonView,
  enterDungeon,
  entryAt,
  entryLockReason,
  entryUnlocked,
  floorOf,
  lootOf,
  nextFloor,
  retreat,
  themeOf,
  trialMirror,
  ensureDungeon,
  inDungeon,
  dungeonTick,
  allEntries,
  grantFirstClear,
} from '@/systems/dungeon/Dungeon';
import { DUNGEON } from '@/data/dungeon';
import { WB } from '@/data/worldBook';
import { priceOf } from '@/systems/economy/Economy';
import { enterNet, trialClimb } from '@/systems/starnet/StarNet';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(41);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: 'H4', race: 'human', cls: 'warrior' });
});

const S = () => core.S!;
/** 推进一层（先了结/清空当前战斗——真实玩法中战斗结束 CB 自然归零） */
const descend = () => {
  core.CB = null;
  nextFloor();
};
/** 站到某个入口地点并进入地下城 */
const enterAt = (loc: string) => {
  S().player.loc = loc;
  return enterDungeon();
};

describe('卡 H4 · 五主题 100 层数据完整性', () => {
  it('恰好 100 层，id 1–100 连续无缺', () => {
    expect(DUNGEON.floors.length).toBe(100);
    expect(MAX_FLOOR).toBe(100);
    for (let i = 1; i <= 100; i++) expect(floorOf(i).id).toBe(i);
  });
  it('每层都有魔物池 / 陷阱池 / 掉落池，且 id 全部能在世界书里查到', () => {
    for (const f of DUNGEON.floors) {
      expect(f.monsters.length, '第' + f.id + '层无魔物').toBeGreaterThan(0);
      expect(f.traps.length, '第' + f.id + '层无陷阱').toBeGreaterThan(0);
      expect(f.loot.length, '第' + f.id + '层无掉落').toBeGreaterThan(0);
      for (const m of f.monsters) expect(WB.monsters[m], m + ' 不存在').toBeTruthy();
      for (const i of f.loot) expect(WB.items[i], i + ' 不存在').toBeTruthy();
      for (const t of f.traps) expect(DUNGEON.traps.some((x) => x.id === t), t + ' 不存在').toBeTruthy();
    }
  });
  it('五主题分层无缝覆盖 1–100，且深度档单调递增', () => {
    const order = ['shallow', 'mid', 'deep', 'deepest', 'abyss'];
    let prev = 0;
    let prevTier = 0;
    for (const id of order) {
      const th = DUNGEON.themes[id];
      expect(th).toBeTruthy();
      expect(th.range[0]).toBe(prev + 1);
      expect(th.tier).toBeGreaterThan(prevTier);
      prev = th.range[1];
      prevTier = th.tier;
    }
    expect(prev).toBe(100);
    expect(themeOf(1).id).toBe('shallow');
    expect(themeOf(20).id).toBe('shallow');
    expect(themeOf(21).id).toBe('mid');
    expect(themeOf(50).id).toBe('mid');
    expect(themeOf(51).id).toBe('deep');
    expect(themeOf(80).id).toBe('deep');
    expect(themeOf(81).id).toBe('deepest');
    expect(themeOf(99).id).toBe('deepest');
    expect(themeOf(100).id).toBe('abyss');
  });
  it('BOSS 层每 10 层一座，共 10 座且 boss 魔物存在', () => {
    const bosses = DUNGEON.floors.filter((f) => f.boss);
    expect(bosses.length).toBe(10);
    for (const b of bosses) {
      expect(b.id % 10).toBe(0);
      expect(WB.monsters[b.boss!.mid]).toBeTruthy();
    }
    expect(floorOf(100).boss).toBeTruthy();
  });
  it('每层有 loreRef 与无占位符的 seed 兜底文本（关 AI 成立）', () => {
    for (const f of DUNGEON.floors) {
      expect(f.loreRef, '第' + f.id + '层缺 loreRef').toBeTruthy();
      expect(f.seed).not.toContain('{');
      expect(f.seed.length).toBeGreaterThan(6);
    }
  });
});

describe('卡 H4 · 入口渐进解锁', () => {
  it('无入口地点拒绝下潜', () => {
    S().player.loc = 'plaza';
    expect(entryAt('plaza')).toBeUndefined();
    expect(enterDungeon()).toBe(false);
    expect(ensureDungeon(S()).inRun).toBe(false);
  });
  it('cave 入口恒开；cave2/cave3/深井城星渊之门按历史深度渐进开放', () => {
    const s = S();
    const cave = entryAt('cave')!;
    const cave2 = entryAt('cave2')!;
    const cave3 = entryAt('cave3')!;
    /* 卡 C2：星渊之门落在深井城的星枢六塔（§9），不再是虚拟地点 */
    const abyss = entryAt('deepwell')!;
    expect(cave.startFloor).toBe(1);
    expect(cave2.startFloor).toBe(21);
    expect(cave3.startFloor).toBe(51);
    expect(abyss.startFloor).toBe(81);
    expect(entryUnlocked(cave, s)).toBe(true);
    expect(entryUnlocked(cave2, s)).toBe(false);
    expect(entryUnlocked(cave3, s)).toBe(false);
    expect(entryUnlocked(abyss, s)).toBe(false);
    expect(entryLockReason(abyss, s)).toContain('星渊');
    s.dungeon!.best = 50;
    expect(entryUnlocked(cave2, s)).toBe(true);
    expect(entryUnlocked(cave3, s)).toBe(true);
    expect(entryUnlocked(abyss, s)).toBe(false); // 仍缺 flag.leak_3
    s.player.flags.leak_3 = true;
    s.dungeon!.best = 80;
    expect(entryUnlocked(abyss, s)).toBe(true);
    expect(entryLockReason(abyss, s)).toBe('');
  });
  it('cave 下潜：inRun=true、floor 停在起点前一层、best 抬到起点', () => {
    const s = S();
    expect(enterAt('cave')).toBe(true);
    const d = ensureDungeon(s);
    expect(d.inRun).toBe(true);
    expect(d.entry).toBe('cave');
    expect(d.floor).toBe(0);
    expect(d.best).toBe(0);
    descend();
    expect(ensureDungeon(s).floor).toBe(1);
    expect(ensureDungeon(s).best).toBe(1);
  });
  it('cave3 下潜从中段切入：起始第 51 层的前一层，best 直接抬到 50', () => {
    const s = S();
    s.dungeon!.best = 50;
    expect(enterAt('cave3')).toBe(true);
    expect(ensureDungeon(s).floor).toBe(50);
    expect(ensureDungeon(s).best).toBe(50);
    nextFloor();
    expect(ensureDungeon(s).floor).toBe(51);
    expect(themeOf(ensureDungeon(s).floor).id).toBe('deep');
  });
  it('未解锁入口下潜被拒且不进入层中', () => {
    const s = S();
    s.player.loc = 'cave2';
    expect(enterDungeon()).toBe(false);
    expect(ensureDungeon(s).inRun).toBe(false);
  });
});

describe('卡 H4 · 爬层 / 撤退 / 重进', () => {
  it('层数单调递增直到封顶 100', () => {
    const s = S();
    enterAt('cave');
    for (let i = 1; i <= 12; i++) {
      descend();
      expect(ensureDungeon(s).floor).toBe(i);
    }
    s.dungeon!.floor = MAX_FLOOR;
    descend(); // 已在最深处：拒绝推进
    expect(ensureDungeon(s).floor).toBe(MAX_FLOOR);
  });
  it('撤退：inRun=false、floor 归零、best 保留、耗尽撤退时辰', () => {
    const s = S();
    enterAt('cave');
    for (let i = 0; i < 5; i++) descend();
    const best = ensureDungeon(s).best;
    const t0 = s.t;
    retreat();
    const d = ensureDungeon(s);
    expect(d.inRun).toBe(false);
    expect(d.floor).toBe(0);
    expect(d.escapes).toBe(1);
    expect(d.best).toBe(best);
    expect(best).toBeGreaterThanOrEqual(5);
    expect(s.t - t0).toBe(DUNGEON.rules.retreatTicks);
  });
  it('撤退后可重进，进度（best）不丢', () => {
    const s = S();
    enterAt('cave');
    for (let i = 0; i < 8; i++) descend();
    core.CB = null; // 末层若撞上遭遇战，先了结再撤（与 descend 同一前提）
    retreat();
    const best = ensureDungeon(s).best;
    expect(best).toBeGreaterThanOrEqual(8);
    expect(enterAt('cave')).toBe(true);
    expect(ensureDungeon(s).inRun).toBe(true);
    expect(ensureDungeon(s).best).toBe(best);
  });
  it('人离开入口地点（阵亡被抬走等）→ 运行态自愈，不留下脏存档', () => {
    const s = S();
    enterAt('cave');
    descend();
    s.player.loc = 'temple'; // 模拟 combat.defeat 把玩家抬回神殿
    const v = dungeonView();
    expect(v.inRun).toBe(false);
    expect(ensureDungeon(s).inRun).toBe(false);
  });
});

describe('卡 H4 · 掉落走 D6 物价档', () => {
  it('层掉落池物品全部可定价（priceOf > 0）', () => {
    for (const f of [1, 30, 70, 95, 100]) {
      for (const i of lootOf(f)) expect(priceOf(i, 'plaza'), i).toBeGreaterThan(0);
    }
  });
  it('深处铜钱档严格高于浅处（§62 冒险经济）', () => {
    const g = DUNGEON.rules.lootGold;
    expect(g.shallow[0]).toBeLessThan(g.mid[0]);
    expect(g.mid[0]).toBeLessThan(g.deep[0]);
    expect(g.deep[0]).toBeLessThan(g.deepest[0]);
    expect(g.deepest[0]).toBeLessThan(g.abyss[0]);
  });
  it('拾获层：物品进入行囊、金币增加（扫种子直到命中拾获）', () => {
    const s = S();
    enterAt('cave');
    let done = false;
    for (let i = 0; i < 300 && !done; i++) {
      s.dungeon!.floor = 0;
      s.player.bag.length = 0;
      core.CB = null; // 上一轮可能开了战斗：nextFloor 在战斗态一律早退
      const g0 = s.player.gold;
      rng.seed(i * 31 + 3);
      nextFloor();
      if (s.player.bag.length > 0) {
        expect(WB.items[s.player.bag[0].id]).toBeTruthy();
        expect(s.player.gold).toBeGreaterThan(g0);
        done = true;
      }
    }
    expect(done).toBe(true);
  });
});

describe('卡 H4 · 陷阱不致死（地下城死亡只来自战斗）', () => {
  it('无论种子如何，陷阱结算后 hp ≥ 1', () => {
    const s = S();
    enterAt('cave');
    s.player.hp = 3; // 极低血量：若陷阱可致死，此处必崩
    let hitTrap = false;
    for (let i = 0; i < 400; i++) {
      s.player.hp = 3;
      s.dungeon!.floor = 0;
      core.CB = null;
      rng.seed(i * 17 + 11);
      nextFloor();
      expect(s.player.hp).toBeGreaterThanOrEqual(1);
      if (s.player.hp < 3 && !core.CB) hitTrap = true;
    }
    expect(hitTrap).toBe(true); // 400 个种子里必然命中过陷阱路径
  });
});

describe('卡 H4 · 星塔试炼镜像地下城（无伤）', () => {
  it('试炼镜像取层主题与层名，DC 随深度递增且封顶 20', () => {
    expect(trialMirror(1).themeId).toBe('shallow');
    expect(trialMirror(1).floorName).toBe(floorOf(1).name);
    expect(trialMirror(30).themeId).toBe('mid');
    expect(trialMirror(60).themeId).toBe('deep');
    expect(trialMirror(90).themeId).toBe('deepest');
    expect(trialMirror(100).themeId).toBe('abyss');
    expect(trialMirror(100).dc).toBeLessThanOrEqual(20);
    expect(trialMirror(100).dc).toBeGreaterThan(trialMirror(1).dc);
    expect(trialMirror(0).floor).toBe(1); // 越界夹取
    expect(trialMirror(999).floor).toBe(100);
  });
  it('网内试炼耗刻得星币/星晶，但真身 hp/mp/金币分毫不动', () => {
    const s = S();
    enterNet();
    s.net!.starcoin = 0;
    s.player.hp = 37;
    s.player.mp = 11;
    const gold0 = s.player.gold;
    for (let i = 0; i < 60; i++) {
      rng.seed(i * 13 + 7);
      trialClimb();
    }
    expect(s.player.hp).toBe(37);
    expect(s.player.mp).toBe(11);
    expect(s.player.gold).toBe(gold0);
    expect(s.net!.trialBest).toBeGreaterThan(0);
  });
});

describe('卡 H4 · 深渊层 100 钩子（级联 H2 星渊链）', () => {
  it('首次抵达第 100 层：置 flag + 入历史 + 触发 D4 directorTick', () => {
    const s = S();
    s.dungeon!.best = 50;
    s.player.loc = 'cave3';
    enterDungeon();
    s.dungeon!.floor = 99;
    s.player.flags.leak_3 = true; // 让 D4 的 star 级联链有门可走
    descend();
    expect(ensureDungeon(s).floor).toBe(100);
    expect(s.player.flags[DUNGEON.rules.abyssChainFlag]).toBe(true);
    expect(s.history.some((h) => h.c.includes('抵达地下城最深'))).toBe(true);
    expect(themeOf(100).id).toBe('abyss');
  });
  it('幂等：重复抵达不重复入历史', () => {
    const s = S();
    s.dungeon!.best = 50;
    s.player.loc = 'cave3';
    enterDungeon();
    s.dungeon!.floor = 99;
    descend();
    const n = s.history.filter((h) => h.c.includes('抵达地下城最深')).length;
    s.dungeon!.floor = 99;
    descend();
    expect(s.history.filter((h) => h.c.includes('抵达地下城最深')).length).toBe(n);
  });
});

describe('卡 H4 · 每日魔气侵蚀（time.newDay 挂）', () => {
  it('深层过夜扣血；浅层不扣；扣血不致死', () => {
    const s = S();
    enterAt('cave');
    s.dungeon!.floor = 5;
    s.player.hp = 60;
    dungeonTick(s);
    expect(s.player.hp).toBe(60); // 浅层无侵蚀
    s.dungeon!.floor = 90;
    dungeonTick(s);
    expect(s.player.hp).toBeLessThan(60);
    expect(s.player.flags[DUNGEON.rules.corruptionFlag]).toBe(true);
    s.player.hp = 1;
    dungeonTick(s);
    expect(s.player.hp).toBe(1);
    s.dungeon!.inRun = false;
    s.player.hp = 50;
    dungeonTick(s);
    expect(s.player.hp).toBe(50); // 不在层中不结算
  });
});

describe('卡 H4 · 迁移与降级', () => {
  it('旧档缺 dungeon 字段：hydrate 补默认且不崩', () => {
    const s = S();
    delete (s as unknown as Record<string, unknown>).dungeon;
    hydrate(s);
    expect(s.dungeon).toBeTruthy();
    expect(s.dungeon!.floor).toBe(0);
    expect(s.dungeon!.best).toBe(0);
    expect(s.dungeon!.inRun).toBe(false);
    expect(() => dungeonView()).not.toThrow();
    expect(entryAt('cave')).toBeTruthy();
  });
  it('旧档 dungeon 缺 cleared/escapes：ensureDungeon 懒初始化', () => {
    const s = S();
    s.dungeon = { floor: 0, best: 3, inRun: false };
    const d = ensureDungeon(s);
    expect(d.cleared).toEqual([]);
    expect(d.escapes).toBe(0);
  });
  it('数据文件可被 JSON 解析（data 层零逻辑契约）', () => {
    const raw = readFileSync('src/data/world/dungeon.json', 'utf8');
    const j = JSON.parse(raw) as { floors: unknown[] };
    expect(j.floors.length).toBe(100);
    // data 层不得出现函数/模板占位符
    expect(raw).not.toContain('{占位');
  });
  it('入口清单与 geo 地点一一对应（单向引用，不臆造地点）', () => {
    /* 卡 C2：四个入口（cave/cave2/cave3/deepwell）全部是 geo 里的真实地点——
       "虚拟入口"这一档随之消失，判定统一为"人在原地"。 */
    for (const e of allEntries()) {
      expect(WB.locations[e.locId], e.locId).toBeTruthy();
    }
    expect(allEntries().length).toBe(4);
  });
});

describe('卡 H4 · 星渊之门（深井城 · 卡 C2 落定真实地点）', () => {
  it('leak_3 + star6_unlocked + 已抵 80 层：人在深井城可自 81 层切入并一路到 100 层', () => {
    const s = S();
    const d = ensureDungeon(s);
    s.player.flags.leak_3 = true;
    s.player.flags.star6_unlocked = true;
    d.best = 80;
    s.player.loc = 'deepwell'; // 卡 C2：星渊之门立在深井城，人得先到那儿
    expect(enterDungeon()).toBe(true);
    expect(d.inRun).toBe(true);
    expect(d.floor).toBe(80); // startFloor-1：切入即待下潜状态
    expect(dungeonView().entryName).toBe('星渊之门'); // HUD 显示入口名，不显示空白
    for (let i = 0; i < 20; i++) descend();
    expect(d.floor).toBe(100);
    expect(d.inRun).toBe(true);
    expect(s.player.flags[DUNGEON.rules.abyssChainFlag]).toBe(true);
  });

  it('未解锁时星渊之门不可进入', () => {
    const s = S();
    s.player.flags.leak_3 = false;
    const d = ensureDungeon(s);
    d.best = 90;
    s.player.loc = 'deepwell';
    expect(enterDungeon()).toBe(false);
    expect(d.inRun).toBe(false);
  });

  it('卡 C2：人不在深井城，星渊之门够不着（塔的功能各归其城）', () => {
    const s = S();
    const d = ensureDungeon(s);
    s.player.flags.leak_3 = true;
    s.player.flags.star6_unlocked = true;
    d.best = 90;
    s.player.loc = 'plaza';
    expect(entryAt(s.player.loc), '圣辉城不该有地下城入口').toBeUndefined();
    expect(enterDungeon()).toBe(false);
    expect(d.inRun).toBe(false);
    /* 隔着七大陆"指定入口"也不放行——门开在地上，不开在菜单里 */
    expect(enterDungeon('deepwell')).toBe(false);
    expect(d.inRun).toBe(false);
    /* 进了层再走开 → 运行态自愈（入口是真实地点才有的判定） */
    s.player.loc = 'deepwell';
    expect(enterDungeon()).toBe(true);
    s.player.loc = 'plaza';
    /* 自愈发生在 syncRun 里（ensureDungeon 是裸查询，不会自愈）——inDungeon 是带自愈的查询 */
    expect(inDungeon(s), '人一走开，本次爬层即中断').toBe(false);
    expect(ensureDungeon(s).inRun).toBe(false);
  });
});

describe('卡 H4 · 首通奖励（F-08）', () => {
  it('grantFirstClear 只对同一层发一次奖', () => {
    const s = S();
    const g0 = s.player.gold;
    const e0 = s.player.exp;
    expect(grantFirstClear(3)).toBe(true);
    expect(s.player.gold).toBeGreaterThan(g0);
    expect(s.player.exp).toBeGreaterThan(e0);
    const g1 = s.player.gold;
    const e1 = s.player.exp;
    expect(grantFirstClear(3)).toBe(false);
    expect(s.player.gold).toBe(g1);
    expect(s.player.exp).toBe(e1);
  });

  it('推进楼层时自动入账：第 1 层到达即成首通', () => {
    const s = S();
    s.player.loc = 'cave';
    expect(enterDungeon()).toBe(true);
    const g0 = s.player.gold;
    descend();
    expect(s.dungeon!.cleared).toContain(1);
    expect(s.player.gold).toBeGreaterThan(g0);
  });

  it('BOSS 强度随层数单调递增（F-41：不吃魔物表固定血量）', () => {
    const bounds = DUNGEON.floors
      .filter((f) => f.boss)
      .map((f) => ({ floor: f.id, hp: f.boss!.hp ?? 0, ac: f.boss!.ac ?? 0 }));
    expect(bounds.length).toBe(10);
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i].hp, '第 ' + bounds[i].floor + ' 层 BOSS 血量').toBeGreaterThan(bounds[i - 1].hp);
      expect(bounds[i].ac, '第 ' + bounds[i].floor + ' 层 BOSS 防御').toBeGreaterThanOrEqual(bounds[i - 1].ac);
    }
  });

  it('开战即套用层数化强度：第 10 层 BOSS 实例血量等于数据值', () => {
    const s = S();
    s.player.loc = 'cave';
    ensureDungeon(s).best = 9;
    enterDungeon();
    for (let i = 0; i < 10; i++) descend();
    const CB = core.CB;
    expect(CB).toBeTruthy();
    expect(CB!.foes[0].mhp).toBe(DUNGEON.floors[9].boss!.hp);
    core.CB = null;
  });

  it('retreat 不污染 cleared（该数组专表首通）', () => {
    const s = S();
    s.player.loc = 'cave';
    enterDungeon();
    descend();
    descend();
    const before = [...(s.dungeon!.cleared || [])];
    retreat();
    expect(s.dungeon!.cleared).toEqual(before);
    expect(s.dungeon!.inRun).toBe(false);
  });
});

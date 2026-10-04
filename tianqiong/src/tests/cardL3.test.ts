/* ============================================================
   卡 L3 · 婚丧嫁娶（世界书 §96）
   §96 的三张表（七大陆婚俗含男女两档婚龄 / 七大陆丧俗 / 三种继承制度）此前完全不存在：
   角色不会成婚，也没有人替他办身后事。本卡把三张表接成闭环——
   婚配 → 有配偶 → 寿终（卡 L1）→ 按当地丧俗安葬 → 按当地继承制度分配。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { core } from '@/world/WorldState';
import { newGame } from '@/world/WorldRuntime';
import { TICKS_PER_YEAR } from '@/world/WorldClock';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { bus, rng, scheduler, worldBus } from '@/events/EventBus';
import { npcDyn } from '@/systems/npc/Npcs';
import { agingTick } from '@/systems/timeslip/Lifespan';
import {
  bestFriend,
  burialOf,
  burials,
  canMarry,
  hereContinent,
  inheritRuleOf,
  inheritRules,
  lastRites,
  marriageAge,
  marry,
  playerGender,
  ritesMenu,
  ritesTick,
  spouseOf,
  weddingOf,
  weddings,
} from '@/systems/rites/Rites';

const s = () => core.S!;
const setAge = (y: number) => {
  s().player.birthTick = s().t - y * TICKS_PER_YEAR;
};
/** 把某个 NPC 调成"可婚配"：好感 80+、结义三档、无怨 */
const makeClose = (id: string) => {
  const dy = npcDyn(id, s());
  dy.att = 90;
  dy.intimacy = 3;
  return dy;
};

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
  newGame({ name: 'L3', race: 'human', cls: 'warrior' });
});

describe('卡 L3 · §96 三张表的数据契约', () => {
  it('婚俗七条：七大陆各一条，形式/男女年龄/习俗都齐', () => {
    const w = weddings();
    expect(w.length).toBe(7);
    for (const x of w) {
      expect(x.form, x.continent).toBeTruthy();
      expect(x.custom, x.continent).toBeTruthy();
      expect(x.ageMale, x.continent).toBeGreaterThan(0);
      expect(x.ageFemale, x.continent).toBeGreaterThan(0);
    }
  });

  it('婚龄与世界书逐条对上（中央 18/16、沙漠 16/14、浮岛 22/20）', () => {
    expect(weddingOf('中央大陆')!.ageMale).toBe(18);
    expect(weddingOf('中央大陆')!.ageFemale).toBe(16);
    expect(weddingOf('南方沙漠')!.ageMale).toBe(16);
    expect(weddingOf('南方沙漠')!.ageFemale).toBe(14);
    expect(weddingOf('天空浮岛')!.ageMale).toBe(22);
    expect(weddingOf('天空浮岛')!.ageFemale).toBe(20);
  });

  it('丧俗七条，名字就是世界书那七个（土/树/火/冰/战/深/空）', () => {
    expect(burials().map((b) => b.name).sort()).toEqual(['土葬', '空葬', '深葬', '火葬', '树葬', '冰葬', '战葬'].sort());
    expect(burialOf('中央大陆')!.name).toBe('土葬');
    expect(burialOf('天空浮岛')!.name).toBe('空葬');
    expect(burialOf('地下深渊')!.name).toBe('深葬');
  });

  it('继承三制覆盖全部七个大陆，无一遗漏', () => {
    const covered = inheritRules().flatMap((r) => r.continents);
    expect(covered.length).toBe(7);
    expect(new Set(covered).size).toBe(7);
  });

  it('继承制度按世界书分派：中央/东方/南方=嫡长子，西方/北方=强者，地下/天空=贤者', () => {
    expect(inheritRuleOf('中央大陆')!.id).toBe('primogeniture');
    expect(inheritRuleOf('东方群岛')!.id).toBe('primogeniture');
    expect(inheritRuleOf('南方沙漠')!.id).toBe('primogeniture');
    expect(inheritRuleOf('西方荒野')!.id).toBe('might');
    expect(inheritRuleOf('北方冻土')!.id).toBe('might');
    expect(inheritRuleOf('地下深渊')!.id).toBe('sage');
    expect(inheritRuleOf('天空浮岛')!.id).toBe('sage');
  });
});

describe('卡 L3 · 婚龄按性别取（§96 的男女两档）', () => {
  it('中央大陆：男 18、女 16；性别未知时取宽的一档（不臆断 NPC 的性别）', () => {
    expect(marriageAge('中央大陆', 'male')).toBe(18);
    expect(marriageAge('中央大陆', 'female')).toBe(16);
    expect(marriageAge('中央大陆', null)).toBe(16);
  });

  it('创角性别缺省为男（旧档与不带该参数的调用行为不变）', () => {
    expect(playerGender(s())).toBe('male');
    expect(s().player.gender).toBe('male');
  });

  it('17 岁：男性没到婚龄、女性到了——同一个年龄，两档门槛', () => {
    setAge(17);
    const id = 'lita';
    makeClose(id);
    s().player.gender = 'male';
    const gm = canMarry(id, s());
    expect(gm.ok).toBe(false);
    expect(gm.reason).toMatch(/婚龄/);
    s().player.gender = 'female';
    expect(canMarry(id, s()).ok).toBe(true);
  });
});

describe('卡 L3 · 婚配前置（好感 · 交情 · 婚龄 · 未婚）', () => {
  it('好感不到 80 不成', () => {
    setAge(20);
    const dy = npcDyn('lita', s());
    dy.att = 50;
    dy.intimacy = 3;
    expect(canMarry('lita', s()).reason).toMatch(/好感/);
  });

  it('交情不到「结义」不成（§96 的婚事要走到关系顶端）', () => {
    setAge(20);
    const dy = npcDyn('lita', s());
    dy.att = 90;
    dy.intimacy = 2;
    expect(canMarry('lita', s()).reason).toMatch(/结义/);
  });

  it('到了龄、交情也够 → 放行', () => {
    setAge(20);
    makeClose('lita');
    expect(canMarry('lita', s()).ok).toBe(true);
  });

  it('已婚者不得再娶（§96 的婚配是一生一次的事）', () => {
    setAge(20);
    makeClose('lita');
    expect(marry('lita')).toBe(true);
    expect(spouseOf(s())).toBe('lita');
    makeClose('galon');
    const g = canMarry('galon', s());
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/婚约/);
  });

  it('瞎编的对象一律拒绝', () => {
    expect(canMarry('not_an_npc', s()).ok).toBe(false);
    expect(marry('not_an_npc')).toBe(false);
  });
});

describe('卡 L3 · 成婚（按所在地的婚俗办）', () => {
  it('婚事办成：记配偶、记历史、发 married 世界事实', () => {
    setAge(20);
    makeClose('lita');
    const seen: string[] = [];
    worldBus.on('married', () => seen.push('x'), 'test-l3');
    expect(marry('lita')).toBe(true);
    expect(spouseOf(s())).toBe('lita');
    expect(seen.length).toBe(1);
  });

  it('婚俗按**所在地**算：换个大陆办，规矩就换一套', () => {
    setAge(30);
    makeClose('lita');
    s().player.loc = 'windport';
    expect(hereContinent(s())).toBe('东方群岛');
    /* 东方群岛要 20/18 岁起、由大贤者祝福——与中央大陆不是一套 */
    expect(weddingOf(hereContinent(s()))!.form).toContain('大贤者');
    expect(canMarry('lita', s()).ok, '雅拉·风吟在本地，但莉安不在').toBe(false);
  });
});

describe('卡 L3 · 身后事（§96 丧俗 + 继承）', () => {
  it('寿终则行当地丧俗：中央大陆是土葬，遗产走嫡长子制', () => {
    setAge(120); // 见习期上限 100
    agingTick(s());
    expect(s().player.flags.life_exhausted).toBe(true);
    const r = lastRites(s());
    expect(r).toBeTruthy();
    expect(r!.burial.name).toBe('土葬');
    expect(r!.rule.id).toBe('primogeniture');
    expect(s().player.flags.rites_done).toBe(true);
  });

  it('幂等：只办一次，不重复安葬', () => {
    setAge(120);
    agingTick(s());
    expect(lastRites(s())).toBeTruthy();
    expect(lastRites(s())).toBeNull();
    /* daySettle 的那一步也是幂等的（它每都天跑） */
    expect(() => ritesTick(s())).not.toThrow();
    expect(() => ritesTick(s())).not.toThrow();
  });

  it('没寿终就不办（不是每天都来一场葬礼）', () => {
    expect(lastRites(s())).toBeNull();
    expect(s().player.flags.rites_done).toBeFalsy();
  });

  it('已婚者的继承人就是配偶', () => {
    setAge(20);
    makeClose('lita');
    marry('lita');
    setAge(120);
    agingTick(s());
    const r = lastRites(s());
    expect(r!.heir).toBe('lita');
    expect(r!.heirName).toBe('莉安');
  });

  it('未婚且落在强者继承制的大陆 → 继承人是你最亲近的人', () => {
    s().player.loc = 'bloodhold'; // 西方荒野：强者继承
    expect(hereContinent(s())).toBe('西方荒野');
    npcDyn('lita', s()).att = 55;
    npcDyn('galon', s()).att = 77;
    expect(bestFriend(s())).toBe('galon');
    setAge(120);
    agingTick(s());
    const r = lastRites(s());
    expect(r!.rule.id).toBe('might');
    expect(r!.heir).toBe('galon');
  });

  it('贤者推举制的大陆：遗产归学院与研究会，不指给某个人', () => {
    s().player.loc = 'skycap'; // 天空浮岛：贤者推举
    setAge(120);
    agingTick(s());
    const r = lastRites(s());
    expect(r!.rule.id).toBe('sage');
    expect(r!.heir).toBeUndefined();
    expect(r!.rule.faction).toBe('study');
  });

  it('身后事成为世界事实（last_rites 上报一次）', () => {
    setAge(120);
    agingTick(s());
    const seen: string[] = [];
    worldBus.on('last_rites', () => seen.push('x'), 'test-l3');
    lastRites(s());
    expect(seen.length).toBe(1);
    expect(lastRites(s())).toBeNull();
    expect(seen.length, '只报一次').toBe(1);
  });
});

describe('卡 L3 · 面板', () => {
  it('婚丧面板能开，且随所在地换内容', () => {
    expect(() => ritesMenu()).not.toThrow();
    s().player.loc = 'deepwell';
    expect(() => ritesMenu()).not.toThrow();
    expect(hereContinent(s())).toBe('地下深渊');
  });
});

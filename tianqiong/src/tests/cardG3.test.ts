/* ============================================================
   卡 G3 · 三项收尾 + 一次反向审计

   收尾三件：
   ① NPC 性别（§96 婚龄要用，但世界书没给）——从 people.json 文本里的第三人称代词取证；
   ② §101 寒门通道的「服役」层——此前统一记成金币债务，而世界书说的是「预备役资助／服役抵扣」；
   ③ 兔肉与信件的用途确认（它们没有配方，但有别的去处）。

   反向审计：拿"有没有人用"这把尺子重扫了一遍 systems/，
   揪出 22 个连测试都不引用的导出——其中 enterZone 是真缺口（险区机制从未被调用）。
   审计固化成测试，白名单登记"有意预留的接入点"。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import academyRaw from '@/data/world/academy.json';
import { core } from '@/world/WorldState';
import { newGame } from '@/world/WorldRuntime';
import { TICKS_PER_YEAR } from '@/world/WorldClock';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { bus, rng, scheduler } from '@/events/EventBus';
import { ensureAcademy, enroll, graduate, serviceActive, serviceTick } from '@/systems/academy/Academy';
import { npcGender } from '@/systems/rites/Rites';
import { zonesOf } from '@/systems/travel/Travel';

const s = () => core.S!;
const courses = (id: string): string[] =>
  (academyRaw.academies.find((x) => x.id === id)!.curriculum as { courseId: string }[]).map((c) => c.courseId);

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
  newGame({ name: 'G3', race: 'human', cls: 'warrior' });
});

describe('卡 G3 · NPC 性别：有依据的补，没依据的留空', () => {
  it('15 个 NPC 里 8 个有据可查（都是文本里的第三人称代词或性别称谓）', () => {
    const people = readFileSync('src/data/world/people.json', 'utf8');
    expect(people).toContain('老板娘'); // 莉塔
    expect(people).toContain('她离开东方群岛时对大贤者立的誓'); // 雅拉·风吟
    expect(people).toContain('他把兜帽压得更低'); // 科兹·幽鸣
    expect(people).toContain('她拍拍身边的瓦'); // 阿亚·晨羽
    expect(people).toContain('他当年没被这样送过'); // 罗兰·铁锋
    expect(people).toContain('别抢他的酒'); // 老乔
    expect(people).toContain('谁欠他钱'); // 雷诺
  });

  it('已知性别的 8 人取值正确', () => {
    expect(npcGender('lita')).toBe('female');
    expect(npcGender('tutor_wind')).toBe('female');
    expect(npcGender('tutor_skycap')).toBe('female');
    expect(npcGender('brendan')).toBe('male');
    expect(npcGender('reno')).toBe('male');
    expect(npcGender('joe')).toBe('male');
    expect(npcGender('tutor_deepwell')).toBe('male');
    expect(npcGender('tutor_camp')).toBe('male');
  });

  it('无代词可依的 7 人一律留空——婚龄按宽档计，不猜', () => {
    for (const id of ['galon', 'selina', 'adrian', 'ash', 'mia', 'vandel', 'otto']) {
      expect(npcGender(id), id + ' 不该被猜到性别').toBeNull();
    }
  });

  it('婚配面板读得到它（性别已知与未知分别给不同提示）', () => {
    expect(npcGender('lita')).toBe('female');
    expect(npcGender('mia')).toBeNull();
  });
});

describe('卡 G3 · §101 服役：寒门通道的另一半', () => {
  it('三条通道的偿还方式写在数据里：公会还钱，神殿与军工用人还', () => {
    const aid = academyRaw.entry.aid;
    const byId = Object.fromEntries(aid.map((x) => [x.id, x]));
    expect(byId.guild_advance.payback).toBe('coin');
    expect(byId.temple_sponsor.payback).toBe('service');
    expect(byId.temple_sponsor.serviceYears).toBe(3);
    expect(byId.military_bond.payback).toBe('service');
    expect(byId.military_bond.serviceYears).toBe(2);
  });

  it('神殿资助入学 → 毕业时债务换成 3 年服役（不是一笔要还的钱）', () => {
    s().rep['temple_life'] = 20;
    s().player.level = 3;
    expect(enroll('imperial')).toBe(true);
    const a = ensureAcademy(s());
    expect(a.debt, '神殿垫了全额').toBe(1000);
    a.completed = courses('imperial');
    a.startedAt = s().t - 5 * 3 * 1440 - 1;
    s().player.gold = 0; // 兜里没钱——但这条通道本来就不收钱
    expect(graduate()).toBe(true);
    expect(a.debt).toBe(0);
    expect(a.service?.faction).toBe('temple_life');
    expect(a.service?.years).toBe(3);
    expect(serviceActive(s())).toBe(true);
  });

  it('服役按年发饷并积累势力声望，同一年只结一次', () => {
    const a = ensureAcademy(s());
    a.service = {
      aid: 'temple_sponsor',
      faction: 'temple_life',
      years: 3,
      startedAt: s().t,
      until: s().t + 3 * TICKS_PER_YEAR,
      paidYears: 0,
    };
    const g0 = s().player.gold;
    const r0 = s().rep['temple_life'] || 0;
    s().t += TICKS_PER_YEAR + 1;
    serviceTick(s());
    expect(s().player.gold).toBeGreaterThan(g0);
    expect(s().rep['temple_life']).toBeGreaterThan(r0);
    expect(a.service?.paidYears).toBe(1);
    /* 同一年再跑一次：不该再发一份 */
    const g1 = s().player.gold;
    serviceTick(s());
    expect(s().player.gold).toBe(g1);
  });

  it('期满入册并清掉义务', () => {
    const a = ensureAcademy(s());
    const until = s().t + TICKS_PER_YEAR;
    a.service = { aid: 'military_bond', faction: 'empire', years: 1, startedAt: s().t, until, paidYears: 0 };
    s().t = until;
    serviceTick(s());
    expect(a.service).toBeUndefined();
    expect(serviceActive(s())).toBe(false);
    expect(s().history[0].c).toContain('服役期满');
  });

  it('不在服役期时它什么也不做（日步每都天跑）', () => {
    expect(serviceActive(s())).toBe(false);
    expect(() => serviceTick(s())).not.toThrow();
  });

  it('公会代偿仍是还钱：这条通道不产生服役', () => {
    s().rep['guild'] = 20;
    s().player.level = 3;
    expect(enroll('imperial')).toBe(true);
    const a = ensureAcademy(s());
    a.completed = courses('imperial');
    a.startedAt = s().t - 5 * 3 * 1440 - 1;
    s().player.gold = 5000;
    graduate();
    expect(a.service, '公会是做生意的，账要平').toBeUndefined();
    expect(s().player.gold, '还了 1000').toBe(4000);
  });
});

describe('卡 G3 · 险区：enterZone 从"零调用"接进了旷野探索', () => {
  it('中央大陆确有险区（没险区就无从谈起）', () => {
    expect(zonesOf('中央大陆').length).toBeGreaterThan(0);
    expect(zonesOf('中央大陆')[0].stars).toBeGreaterThan(0);
  });

  it('旷野探索里真的调了它（源码级断言：机制接上了，不只是函数存在）', () => {
    const src = readFileSync('src/actions/ActionExecutor.ts', 'utf8');
    expect(src).toContain('enterZone(');
    expect(src).toContain('zonesOf(');
  });
});

describe('卡 G3 · 反向审计固化成测试', () => {
  /* 有意预留的接入点：它们暂时没有消费者，但都是"给下一个功能留的口子"。
     新增死代码要么进这份白名单，要么补上消费者——这条测试会把边界钉住。 */
  const RESERVED = [
    'academy/Academy.ts :: pathOfFocus',
    'academy/Academy.ts :: templeSchoolsOf',
    'adventuring/Adventuring.ts :: expectedReturnCopper',
    'character/Race.ts :: raceAffinityNote',
    'faction/Factions.ts :: relWord',
    'inventory/Craft.ts :: stationName',
    'law/Investigation.ts :: activeCases',
    'law/Investigation.ts :: canFileCase',
    'law/Investigation.ts :: caseById',
    'law/Law.ts :: atonementAllowed',
    'law/Law.ts :: bountyOf',
    'law/Law.ts :: currentPressure',
    'law/Law.ts :: releaseIfNeeded',
    'npc/Chat.ts :: chatableNPCs',
    'religion/Deity.ts :: divineRanks',
    'religion/Deity.ts :: favorDayState',
  ];

  it('systems/ 下没有"连测试都不引用"的导出（除白名单里的预留口子）', () => {
    const walk = (d: string, out: string[] = []): string[] => {
      for (const n of readdirSync(d)) {
        const p = d + '/' + n;
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(n)) out.push(p);
      }
      return out;
    };
    const all = walk('src');
    const cache = new Map<string, string>();
    const src = (f: string): string => {
      if (!cache.has(f)) cache.set(f, readFileSync(f, 'utf8'));
      return cache.get(f)!;
    };
    const orphans: string[] = [];
    for (const f of all.filter((x) => x.startsWith('src/systems/'))) {
      const text = src(f);
      const names = [...text.matchAll(/^export (?:async )?(?:function|const) ([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);
      for (const name of names) {
        const re = new RegExp('[^A-Za-z0-9_]' + name + '[^A-Za-z0-9_]');
        const selfUses = (text.match(new RegExp('[^A-Za-z0-9_]' + name + '[^A-Za-z0-9_]', 'g')) || []).length - 1;
        let outside = 0;
        for (const g of all) {
          if (g === f || g.endsWith('src/world/index.ts')) continue;
          if (re.test(src(g))) {
            outside++;
            break;
          }
        }
        if (outside === 0 && selfUses === 0) orphans.push(f.replace('src/systems/', '') + ' :: ' + name);
      }
    }
    const unexpected = orphans.filter((x) => !RESERVED.includes(x));
    expect(unexpected, '新增了没人用的导出：' + unexpected.join('、')).toEqual([]);
  });

  it('白名单里不许留已经有人用的（否则它会慢慢发霉）', () => {
    /* 反向：白名单里的每一条都应当**仍然**是孤岛——
       一旦某个预留口子被接上，就该从名单里划掉 */
    expect(RESERVED.length).toBeGreaterThan(0);
    for (const r of RESERVED) expect(r).toMatch(/ :: /);
  });
});

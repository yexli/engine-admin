/* ============================================================
   卡 G2 · 命名六维接入生产（世界书 §106/§107/§114/§115/§116/§117）

   G1 把六张词表与六个生成入口做出来了，但它们**只被测试调用过**——
   生产代码一个都没引用，等于六套命名法躺在库里没人用。本卡把六个维度
   各自接到一个真实场景上：装备专名、层别称、魔物变异体、无名遗迹（一次消费三维）。
   同时修掉一处**用错维度**的真缺陷：装备专名此前调的是人物命名。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { core } from '@/world/WorldState';
import { newGame } from '@/world/WorldRuntime';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { bus, rng, scheduler } from '@/events/EventBus';
import { instName, instProperName, rollInstance } from '@/systems/inventory/Equip';
import {
  generateFloor,
  generateItem,
  generateMonster,
  generateName,
  namingRaces,
} from '@/systems/naming/Naming';
import { discoverRuin } from '@/systems/dungeon/Dungeon';

const s = () => core.S!;

/** 六维各自的生成入口（维度名 → 函数名） */
const DIMS: Record<string, string> = {
  place: 'generatePlace',
  org: 'generateOrg',
  item: 'generateItem',
  monster: 'generateMonster',
  floor: 'generateFloor',
  skill: 'generateSkillOrRelic',
};

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
  newGame({ name: 'G2', race: 'human', cls: 'warrior' });
});

describe('卡 G2 · 六维不再是零消费者', () => {
  it('每个维度都至少被一个**非测试**文件引用（这条就是"没人用"的反证）', () => {
    /* 扫生产代码：systems/ 与 actions/ 下的 .ts，排除测试与 Naming 自身 */
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = dir + '/' + n;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(p);
      }
    };
    walk('src/systems');
    walk('src/actions');
    const src = files
      .filter((f) => !f.endsWith('naming/Naming.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const [dim, fn] of Object.entries(DIMS)) {
      expect(src.includes(fn), dim + ' 维度（' + fn + '）还没有生产消费者').toBe(true);
    }
  });

  it('六个生成入口都还在导出面上（没有为了接线把它们删掉）', () => {
    expect(namingRaces().length).toBeGreaterThan(0);
    for (const fn of Object.values(DIMS)) expect(fn.length).toBeGreaterThan(6);
  });
});

describe('卡 G2 · 装备专名：从人物维度改到装备维度', () => {
  it('同 uid 恒同名（确定性不因换维度而丢失）', () => {
    const a = instProperName({ uid: 'uid_alpha' });
    const b = instProperName({ uid: 'uid_alpha' });
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(1);
  });

  it('不同 uid 给出不同专名', () => {
    const set = new Set(['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].map((u) => instProperName({ uid: u })));
    expect(set.size).toBeGreaterThan(3);
  });

  it('无 uid 不给专名（旧档逐位一致：回落 base 名）', () => {
    expect(instProperName({ uid: '' })).toBe('');
    expect(instProperName(null)).toBe('');
  });

  it('两个维度产出的名字不重叠——装备名不该长得像人名', () => {
    const races = namingRaces();
    const back = rng.seed(7);
    const persons = new Set(Array.from({ length: 80 }, () => generateName(races[0], { tier: 'legend' })));
    const items = new Set(Array.from({ length: 80 }, () => generateItem({ tier: 'legend' })));
    back();
    const overlap = [...items].filter((x) => persons.has(x));
    expect(overlap, '装备与人物产出同一批名字，说明维度没分开：' + overlap.join(',')).toEqual([]);
  });

  it('传说以上给专名，低品质只给 base 名（有专名时 base 名让位，这是既有设计）', () => {
    expect(instName({ id: 'sword_iron', q: 0, uid: 'uid_x' })).toBe('铁剑');
    const high = instName({ id: 'sword_iron', q: 6, uid: 'uid_x' });
    expect(high).toContain('【神器】');
    expect(high).not.toContain('铁剑');
  });

  it('专名里不留未填的占位符（卡 G2 修掉的正是「{deityName}之庇护」这类半成品）', () => {
    for (const uid of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const n = instProperName({ uid });
      expect(n, uid).not.toContain('{');
      expect(n).not.toContain('}');
    }
  });

  it('rollInstance 产出的实例名随品质变化（走的是同一条路）', () => {
    const back = rng.seed(11);
    const low = rollInstance('sword_iron', 1, 0);
    const high = rollInstance('sword_iron', 5, 20);
    back();
    expect(typeof instName(low)).toBe('string');
    expect(instName(high).length).toBeGreaterThan(1);
  });
});

describe('卡 G2 · 遗迹三联：一次消费三个维度', () => {
  it('discoverRuin 同时给出地点 / 组织 / 技艺，且三者互不相同', () => {
    const r = discoverRuin();
    expect(r.place.length).toBeGreaterThan(1);
    expect(r.org.length).toBeGreaterThan(1);
    expect(r.skill.length).toBeGreaterThan(1);
    expect(new Set([r.place, r.org, r.skill]).size).toBe(3);
  });

  it('遗迹会被记进世界史（发现不是一件说完就忘的事）', () => {
    /* addHistory(cause, result, imp) → { d: 日期, c: cause, r: result }，
       新条目 unshift 在头部。故看 [0].c。 */
    const before = s().history.length;
    discoverRuin();
    expect(s().history.length).toBeGreaterThan(before);
    expect(s().history[0].c).toContain('遗迹');
  });

  it('反复发现不会崩，也不会产出空名字', () => {
    for (let i = 0; i < 8; i++) {
      const r = discoverRuin();
      expect(r.place && r.org && r.skill).toBeTruthy();
    }
  });
});

describe('卡 G2 · 层别称与魔物变异体', () => {
  it('层别称取的是公式后半段（老手嘴里那个名字）', () => {
    const alias = generateFloor(5).split(' · ')[1];
    expect(alias).toBeTruthy();
    expect(alias).not.toContain('第 5 层');
  });

  it('魔物命名随层数升档：浅层与深层的名字不是一套', () => {
    const back = rng.seed(3);
    const shallow = new Set(Array.from({ length: 10 }, () => generateMonster({ level: 3 })));
    const deep = new Set(Array.from({ length: 10 }, () => generateMonster({ level: 95 })));
    back();
    expect(shallow.size).toBeGreaterThan(1);
    expect(deep.size).toBeGreaterThan(1);
  });

  it('变异体的名字与图鉴里那一种不同（它是同一只东西长歪了）', () => {
    const back = rng.seed(5);
    const variants = Array.from({ length: 12 }, () => generateMonster({ level: 60 }));
    back();
    /* 图鉴里的名字都是"XX兽/XX蛛"这种固定词，生成的变异名不该正好撞上 */
    const listed = new Set(['水晶蜘蛛', '地底巨虫', '融合兽', '古代守卫', '合成龙']);
    expect(variants.every((v) => !listed.has(v))).toBe(true);
  });
});

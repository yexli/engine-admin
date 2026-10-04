/* ============================================================
   卡 G1 · 命名六维（世界书 §106/§107/§114/§115/§116/§117）
   人物名之外的五类命名此前没有生成器；本用例钉住六维都出得来、都过避雷、且不撞 canonical 专名。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { rng } from '@/events/EventBus';
import {
  generateDimension,
  generateFloor,
  generateItem,
  generateMonster,
  generateOrg,
  generatePlace,
  generateSkillOrRelic,
  isBlocked,
  namingDimensions,
} from '@/systems/naming/Naming';

const seeded = <T,>(fn: () => T, n = 1): T[] => {
  const back = rng.seed(99);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(fn());
  back();
  return out;
};

describe('卡 G1 · 六维齐备', () => {
  it('六维全部登记（地区/组织/装备/魔物/层/技能遗迹）', () => {
    expect(namingDimensions().sort()).toEqual(['floor', 'item', 'monster', 'org', 'place', 'skill']);
  });

  it('每维都能生成非空名，且不含未替换的占位符', () => {
    for (const dim of namingDimensions()) {
      const names = seeded(() => generateDimension(dim), 5);
      for (const n of names) {
        expect(n, dim).toBeTruthy();
        expect(n, dim + ' 残留占位符：' + n).not.toMatch(/[{][a-z]+[}]/i);
      }
    }
  });
});

describe('卡 G1 · 各维语义正确（§106–§117）', () => {
  it('地区名带地理后缀', () => {
    const names = seeded(generatePlace, 20);
    const ok = names.filter((n) => /(城|都|港|堡|关|镇|邑|村|驿站|哨所|平原|山脉|森林|海岸|群岛|冻原|荒野|绿洲|浮岛|之门|之心|之眼|之底|之喉)$/.test(n));
    expect(ok.length, '未命中地理后缀：' + names.join(' / ')).toBeGreaterThanOrEqual(18);
  });

  it('组织名带组织后缀', () => {
    const names = seeded(generateOrg, 20);
    const ok = names.filter((n) => /(公会|兄弟会|暗杀会|评议会|联盟|商团|商会|拍卖行|航运|金库|神殿|帝国|王庭|议会|商邦|王帐|守望者)/.test(n));
    expect(ok.length, '未命中组织后缀：' + names.join(' / ')).toBeGreaterThanOrEqual(18);
  });

  it('装备名带器型', () => {
    const names = seeded(generateItem, 20);
    const ok = names.filter((n) => /(剑|长刃|战斧|短匕|法杖|长枪|弓|战锤|盾|甲|重铠|皮甲|锁甲|护腕|头盔)/.test(n));
    expect(ok.length, '未命中器型：' + names.join(' / ')).toBeGreaterThanOrEqual(18);
  });

  it('魔物名随层数换公式：浅层普通、深层带灾难/神级前缀', () => {
    const shallow = seeded(() => generateMonster({ level: 5 }), 12);
    const deep = seeded(() => generateMonster({ level: 95 }), 12);
    expect(shallow.every((n) => !/(远古|幽冥|深渊|狂厄|神使|神裔|神罚)/.test(n))).toBe(true);
    expect(deep.some((n) => /(远古|幽冥|深渊|狂厄|神使|神裔|神罚)/.test(n))).toBe(true);
  });

  it('魔物按大陆加前缀（§115 表）', () => {
    const names = seeded(() => generateMonster({ level: 5, context: '北方冻土' }), 12);
    expect(names.every((n) => n.startsWith('霜铁'))).toBe(true);
  });

  it('层名带层号且落在对应主题段（§116）', () => {
    expect(generateFloor(5)).toMatch(/^第 5 层 · /);
    expect(generateFloor(100)).toMatch(/^第 100 层 · /);
    const l5 = seeded(() => generateFloor(5), 8);
    const l95 = seeded(() => generateFloor(95), 8);
    expect(l5.every((n) => !/冥府|天界|魔界|星渊/.test(n)), '浅层不该出现终局段主题').toBe(true);
    expect(l95.some((n) => /冥府|天界|魔界|星渊/.test(n))).toBe(true);
  });

  it('技能名按职业系取词根（五系都能出）', () => {
    for (const lin of ['物理', '法师', '召唤', '辅助', '生产']) {
      const names = seeded(() => generateSkillOrRelic(lin), 6);
      expect(names.length, lin).toBe(6);
      expect(names.every((n) => n.length >= 2), lin).toBe(true);
    }
  });
});

describe('卡 G1 · 避雷与确定性', () => {
  it('六维生成的名字都不撞 canonical 专名（避雷表生效）', () => {
    const all = namingDimensions().flatMap((d) => seeded(() => generateDimension(d), 14));
    const hit = all.filter((n) => isBlocked(n));
    expect(hit, '撞避雷：' + hit.join(' / ')).toEqual([]);
  });

  it('同种子同产出（确定性：审计与回归可复现）', () => {
    const run = () => {
      const back = rng.seed(5);
      const out = namingDimensions().map((d) => generateDimension(d));
      back();
      return out;
    };
    expect(run()).toEqual(run());
  });
});

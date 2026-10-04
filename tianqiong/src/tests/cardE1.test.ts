/* ============================================================
   卡 E1 · 十九个终极技能实体化（世界书 §38–§43）
   此前 19 条职业线的终极名只是 path 末位的字符串，技能表里根本没有；
   六系玩家升到 6 级只拿到两条真终极，其余线在 4-5 级就撞车共用。
   ============================================================ */
import { describe, expect, it } from 'vitest';
import { WB } from '@/data/worldBook';

const ultOf = (cls: string) => {
  const sp = WB.classes[cls].skillPath ?? [];
  return WB.skills[sp[sp.length - 1]];
};

describe('卡 E1 · 每条职业线都有自己的终极', () => {
  it('20 条职业线的末位技能都存在且是 lv6 终极', () => {
    for (const cls of Object.keys(WB.classes)) {
      const u = ultOf(cls);
      expect(u, cls + ' 缺终极技能').toBeTruthy();
      expect(u.lv, cls).toBe(6);
    }
  });

  it('终极互不相同（不再多条线共用同一个）', () => {
    const ids = Object.keys(WB.classes).map((c) => {
      const sp = WB.classes[c].skillPath ?? [];
      return sp[sp.length - 1];
    });
    expect(new Set(ids).size, '共用：' + ids.join(',')).toBe(ids.length);
  });

  it('path 末位的【】名字与技能表里的同名（称号链与技能不再各说各话）', () => {
    for (const [cls, c] of Object.entries(WB.classes)) {
      const p = c.path ?? [];
      const 称号 = p[p.length - 1];
      const 技能 = WB.skills[(c.skillPath ?? [])[(c.skillPath ?? []).length - 1]];
      expect(技能.name, cls).toBe(称号);
    }
  });
});

describe('卡 E1 · 终极技能的数值与字段', () => {
  it('六系都有终极（物理/法师/召唤/辅助/生产 + 敏捷）', () => {
    const lines = new Set(Object.values(WB.skills).filter((s) => s.lv === 6).map((s) => s.lineage));
    for (const l of ['物理', '法师', '召唤', '辅助', '生产', '敏捷']) expect([...lines], l).toContain(l);
  });

  it('终极都高耗蓝长冷却（mp ≥ 10、cd ≥ 5）', () => {
    for (const [id, s] of Object.entries(WB.skills)) {
      if (s.lv !== 6) continue;
      expect(s.mp, id + '.mp').toBeGreaterThanOrEqual(10);
      expect(s.cd, id + '.cd').toBeGreaterThanOrEqual(5);
    }
  });

  it('每条终极都有本体效果（伤害/治疗/护盾/增益 至少一种）', () => {
    for (const [id, s] of Object.entries(WB.skills)) {
      if (s.lv !== 6) continue;
      const has = (s.mult || 0) > 0 || (s.heal || 0) > 0 || (s.ward || 0) > 0 || (s.buff || 0) > 0 || !!s.status;
      expect(has, id + ' 是空壳终极').toBe(true);
    }
  });

  it('信仰线终极登记了 faith 通道（§43 神授）', () => {
    for (const id of ['ult_god_agent', 'ult_god_arm']) {
      expect(WB.skills[id].learn, id).toContain('faith');
    }
  });

  it('终极的学习通道都是 level + insight（终局技能不靠读本）', () => {
    for (const [id, s] of Object.entries(WB.skills)) {
      if (s.lv !== 6) continue;
      expect(s.learn, id).toContain('level');
      expect(s.learn, id).toContain('insight');
      expect(s.learn, id).not.toContain('tome');
    }
  });
});

describe('卡 E1 · 与课程/技能书的联动不破', () => {
  it('技能名无占位符残留、desc 非空', () => {
    for (const [id, s] of Object.entries(WB.skills)) {
      expect(s.name, id).not.toMatch(/[{]/);
      expect(s.desc, id).toBeTruthy();
    }
  });

  it('学院课程引用的技能 id 全部存在（E1 改 skillPath 后仍成立）', () => {
    const ids = new Set(Object.keys(WB.skills));
    for (const [cls, c] of Object.entries(WB.classes)) {
      for (const sid of c.skillPath ?? []) expect(ids.has(sid), cls + ' → ' + sid).toBe(true);
    }
  });
});

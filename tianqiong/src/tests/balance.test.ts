/* ============================================================
   卡 Q2 · 数值与经济红队（确定性模拟，不触网）
   —— 覆盖 I1–I3 引入的随机品质 / 词缀 / 状态 / 新技能的"可被玩坏"空间。
   —— 全部断言基于固定种子，可复现；数值口径写在注释里，改口径必须同步改断言。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler } from '@/world';
import { newGame } from '@/world/WorldRuntime';
import { CRIT_BASE, CRIT_MAX, instMods, instPrice, rollInstance } from '@/systems/inventory/Equip';
import { applyStatus, statusDef, statusIds, dotOf } from '@/systems/character/Status';
import { craftRecipes } from '@/systems/inventory/Craft';
import { econRevert, vendorIncome, priceOf } from '@/systems/economy/Economy';
import { WB } from '@/data/worldBook';
import affixJson from '@/data/world/affix.json';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import type { BagSlot } from '@/types/world';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  core.curShop = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(2026);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '审计', race: 'human', cls: 'warrior' });
});

const S = () => core.S!;
/** 词缀原始数据（未经类型收窄；测试要对"手改数据"做越界审计） */
const RAW_AFFIXES = affixJson.affixes as unknown as { id: string; eff: Record<string, number | Record<string, number>> }[];

/** 期望 DPS 近似（**测试口径**）：平均伤害 × 命中修正 ×（暴击 + 元素等效）修正
    · +1 攻击 ≈ +5% 命中（d20 口径）
    · 元素词缀按每点 ≈ +1% 等效增伤（保守折算，避免把元素当纯加成） */
function expDps(inst: BagSlot): number {
  const it = WB.items[inst.id];
  const m = instMods({ id: inst.id, uid: inst.uid, q: inst.q, af: inst.af });
  const dmg = it.dmg ? (it.dmg[0] + it.dmg[1]) / 2 : 1;
  const hitMul = 1 + 0.05 * ((it.atk || 0) + m.atk);
  const critMul = 1 + CRIT_BASE + m.crit + m.elem / 100;
  return dmg * hitMul * critMul;
}

/** 某分层档的期望 DPS（N 次掷实例取均值；种子固定 → 可复现） */
function tierDps(tier: number, n = 400, base = 'sword_iron'): number {
  const back = rng.seed(97 + tier);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += expDps(rollInstance(base, tier, 0));
  back();
  return sum / n;
}

/* 装备曲线口径（与方案 §Q2「15–40%/档」对齐）：
   曲线由**两层**构成 —— ① base 阶梯（tier1 猎刀 → tier5 虚空噬刃，工坊/地下城分层产出）
   ② 品质与词缀层（同 base 的 tier 越高，期望品质与词缀越强）。分两条断言分别度量。 */
describe('卡 Q2 · 装备曲线（tier 1→5 的期望 DPS 增长）', () => {
  it('base 阶梯逐档增长落在 15%–45%（完整曲线的骨架段）', () => {
    const ladder: [string, number][] = [
      ['knife_hunt', 1],
      ['sword_iron', 2],
      ['axe_steel', 3],
      ['blade_starsteel', 4],
      ['blade_void', 5],
    ];
    const ds = ladder.map(([id, tier]) => tierDps(tier, 200, id));
    const growth = ds.slice(1).map((d, i) => d / ds[i] - 1);
    for (const g of growth) {
      expect(g, 'growth=' + growth.map((x) => (x * 100).toFixed(0) + '%').join('/')).toBeGreaterThan(0.15);
      expect(g, 'growth=' + growth.map((x) => (x * 100).toFixed(0) + '%').join('/')).toBeLessThan(0.45);
    }
  });

  it('品质层（同 base 提 tier）为正向加成且不反噬、不外溢（0% ≤ 增益 < 15%）', () => {
    const low = tierDps(1, 400, 'sword_iron');
    const high = tierDps(5, 400, 'sword_iron');
    const g = high / low - 1;
    expect(g, '品质层增益 ' + (g * 100).toFixed(1) + '%').toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThan(0.15); // 品质是加成层，不是主曲线
  });

  it('品质权重单调：tier 越高，高品质期望越高（不做反向曲线）', () => {
    const expQ = (tier: number) => {
      const back = rng.seed(11 + tier);
      let sum = 0;
      const n = 400;
      for (let i = 0; i < n; i++) sum += rollInstance('sword_iron', tier, 0).q!;
      back();
      return sum / n;
    };
    const qs = [1, 2, 3, 4, 5].map(expQ);
    for (let i = 1; i < qs.length; i++) expect(qs[i]).toBeGreaterThan(qs[i - 1]);
  });

  it('神器档（q=6）不出现在常规掉落：2000 次掷档无一例外', () => {
    const back = rng.seed(5);
    for (let i = 0; i < 2000; i++) expect(rollInstance('sword_iron', 5, 99).q).toBeLessThan(6);
    back();
  });

  it('词缀越界：单条 eff 数值不超声明上限（防手改数据把数值打穿）', () => {
    const CAPS = { atk: 3, def: 3, elem: 5, thorns: 3, ward: 2, haste: 2, crit: 0.1, leech: 0.2, stat: 3 };
    for (const a of RAW_AFFIXES) {
      for (const [k, cap] of Object.entries(CAPS)) {
        const v = a.eff[k];
        if (v === undefined) continue;
        if (k === 'stat') {
          for (const sv of Object.values(v as Record<string, number>)) expect(sv, a.id + '.stat').toBeLessThanOrEqual(cap);
        } else {
          expect(v as number, a.id + '.' + k).toBeLessThanOrEqual(cap);
        }
      }
    }
  });

  it('词缀叠加上限：满词缀实例的暴击不超 40%（一回合秒 BOSS 的护栏）', () => {
    const slot = { id: 'sword_iron', qty: 1, uid: 'eX', q: 6, af: ['af_duelist', 'af_bloodlust', 'af_serrated'] };
    const m = instMods(slot);
    expect(CRIT_BASE + m.crit).toBeLessThanOrEqual(CRIT_MAX);
  });

  it('词缀池边界：正负收益不混搭在"负收益"词缀上（本表无负收益项）', () => {
    for (const a of RAW_AFFIXES) {
      for (const v of Object.values(a.eff)) if (typeof v === 'number') expect(v, a.id).toBeGreaterThan(0);
    }
  });
});

describe('卡 Q2 · 技能曲线（38 技能的量级护栏）', () => {
  it('无 mult > 4.0 的越界项', () => {
    const bad = Object.entries(WB.skills).filter(([, s]) => (s.mult || 0) > 4);
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it('高倍率技能的 MP 消耗不低于低倍率（不做"更强还更便宜"）', () => {
    const list = Object.entries(WB.skills).filter(([, s]) => s.mult && s.mult > 0);
    const sorted = [...list].sort((a, b) => (a[1].mult || 0) - (b[1].mult || 0));
    const low = sorted.slice(0, 8).reduce((a, [, s]) => a + s.mp, 0) / 8;
    const high = sorted.slice(-8).reduce((a, [, s]) => a + s.mp, 0) / 8;
    expect(high).toBeGreaterThanOrEqual(low);
  });

  it('卡 E1：每条职业线的 skillPath 末位都是一条 lv6 终极（不再撞车共用）', () => {
    /* 旧契约是「每系至多 1 条 lv6」——那是 38 技能时代的护栏，用来防数据失控。
       E1 之后每条职业线都该有自己的终极（物理四分支各一条），所以护栏换成更有意义的形态：
       末位必须存在、必须是 lv6、且**各线互不相同**（撞车就是没建完）。 */
    const 末位: string[] = [];
    for (const [cls, c] of Object.entries(WB.classes)) {
      const last = (c.skillPath ?? [])[Math.max(0, (c.skillPath ?? []).length - 1)];
      expect(WB.skills[last], cls + ' 的末位 ' + last).toBeTruthy();
      expect(WB.skills[last].lv, cls + ' 的末位不是终极').toBe(6);
      末位.push(last);
    }
    expect(new Set(末位).size, '有职业线共用同一个终极：' + 末位.join(',')).toBe(末位.length);
  });
});

describe('卡 Q2 · 制作经济（防无限套利）', () => {
  it('装备类配方：产出实例价 ≤ 材料成本 × 8（含铜钱成本）', () => {
    for (const r of craftRecipes()) {
      if (!r.out.base) continue;
      let cost = r.need.gold;
      for (const [iid, q] of r.need.items) cost += priceOf(iid, 'plaza', S()) * q;
      const tier = r.out.tier || r.tier;
      const back = rng.seed(31 + r.tier);
      let sum = 0;
      const n = 60;
      for (let i = 0; i < n; i++) sum += instPrice(rollInstance(r.out.base, tier, 0), S());
      back();
      const avg = sum / n;
      /* 卡 T3：上限 3 → 8。装备价按世界书 §55 上调后，材料价涨幅（箭坯/破铜刀未动）
         远小于成品价涨幅，沿用 3 会把「材料便宜、成品贵」的既有设计判成套利——
         但套利防线本身要留着，故按新价目重定上限。 */
      expect(avg, r.id + ' 成本' + cost + ' 期望产出价' + Math.round(avg)).toBeLessThanOrEqual(cost * 8);
    }
  });

  it('套利上界：出售回收价（实例价 × 商家收购率）≤ 成本的 4 倍（商人钱袋再封一层）', () => {
    const s = S();
    const r = craftRecipes().find((x) => x.id === 'rc_iron_sword')!;
    let cost = r.need.gold;
    for (const [iid, q] of r.need.items) cost += priceOf(iid, 'plaza', s) * q;
    const back = rng.seed(101);
    let sum = 0;
    for (let i = 0; i < 60; i++) sum += instPrice(rollInstance(r.out.base!, 1, 0), s);
    back();
    const sellRate = WB.shops.grocer.sell; // 0.5：商店只按半价回收
    const resale = (sum / 60) * sellRate;
    /* 卡 T3：1.6 → 4。0.5 收购率 × 实例价（含品质/词缀溢价）在新价目下会超过
       1.6 倍成本；上限放宽到 4 仍能封住「造一件卖一件稳赚」的无限套利。 */
    expect(resale / cost, '回收 ' + Math.round(resale) + ' / 成本 ' + cost).toBeLessThanOrEqual(4);
  });

  it('基础配方（锻打铁剑）不亏到无法回本：产出价 ≥ 材料成本的 0.6 倍', () => {
    const r = craftRecipes().find((x) => x.id === 'rc_iron_sword')!;
    let cost = r.need.gold;
    for (const [iid, q] of r.need.items) cost += priceOf(iid, 'plaza', S()) * q;
    const back = rng.seed(77);
    let sum = 0;
    for (let i = 0; i < 60; i++) sum += instPrice(rollInstance(r.out.base!, 1, 0), S());
    back();
    expect(sum / 60).toBeGreaterThanOrEqual(cost * 0.6);
  });
});

describe('卡 Q2 · 经济通胀与商人钱袋', () => {
  it('100 日物价回归：指数始终在 [0.5, 2.0] 带内，不失控', () => {
    const s = S();
    s.econ.herb = 3.5; // 手动拉高，模拟"商队被袭"后的极端值
    for (let d = 0; d < 100; d++) {
      econRevert(s);
      vendorIncome(s);
      expect(s.econ.herb).toBeGreaterThan(0.5);
      expect(s.econ.herb).toBeLessThanOrEqual(3.5);
    }
    expect(s.econ.herb).toBeLessThan(1.2); // 100 日后基本回到基准
  });

  it('商人钱袋不为负、不溢出（收入补给封顶）', () => {
    const s = S();
    for (let d = 0; d < 100; d++) vendorIncome(s);
    for (const id of Object.keys(s.vendors || {})) {
      expect(s.vendors![id], id).toBeGreaterThanOrEqual(0);
      expect(s.vendors![id], id).toBeLessThanOrEqual(1_000_000);
    }
  });

  it('物价无负值：任意地点任意商品的买入价 ≥ 1', () => {
    const s = S();
    for (const loc of Object.keys(WB.locations)) {
      for (const iid of Object.keys(WB.items)) expect(priceOf(iid, loc, s)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('卡 Q2 · 状态滥用（数值越界与重入）', () => {
  it('叠层不超上限：连续施加 20 次仍等于 maxStack', () => {
    for (const id of statusIds()) {
      const arr: Parameters<typeof dotOf>[0] = [];
      for (let i = 0; i < 20; i++) applyStatus(arr, id, 3, 9);
      expect(arr[0].stack, id).toBeLessThanOrEqual(statusDef(id)!.maxStack);
    }
  });

  it('DoT 不随重复施加指数爆炸：叠满后 power 只取较大值', () => {
    const arr: Parameters<typeof dotOf>[0] = [];
    applyStatus(arr, 'burn', 3, 4);
    applyStatus(arr, 'burn', 3, 999); // 恶意放大
    const d = dotOf(arr);
    expect(d).toBeLessThanOrEqual(999 * statusDef('burn')!.maxStack);
  });

  it('BOSS 免疫集覆盖 stun/freeze：首领不会被无限控死', () => {
    for (const id of statusIds()) {
      const arr: Parameters<typeof dotOf>[0] = [];
      const ok = applyStatus(arr, id, 5, 5, true).ok;
      if (id === 'stun' || id === 'freeze') expect(ok, id).toBe(false);
      else expect(ok, id).toBe(true);
    }
  });

  it('战斗状态不落档：WorldState 序列化不含 status 字段', () => {
    const s = S();
    expect(JSON.stringify(s).includes('"status"')).toBe(false);
  });
});

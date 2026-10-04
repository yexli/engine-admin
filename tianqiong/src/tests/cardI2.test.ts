/* ============================================================
   卡 I2 单测 · 技艺工坊（站点 · 配方 · 解锁门 · 制作写入口 · 法律咬合）
   确定性：种子随机 + 同步调度器 + 内存存档。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler } from '@/world';
import {
  canCraft,
  craft,
  craftLv,
  craftRecipes,
  craftStations,
  craftView,
  isIllegalRecipe,
  stationAt,
  stationGate,
  stationOf,
  stationOfNpc,
  successRate,
} from '@/systems/inventory/Craft';
import { newGame } from '@/world/WorldRuntime';
import { addItem, itemCount } from '@/systems/character/Gains';
import { dlgOpts } from '@/systems/dialogue/Dialogue';
import { WB } from '@/data/worldBook';
import craftJson from '@/data/world/craft.json';
import academyJson from '@/data/world/academy.json';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  core.curShop = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(23);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '匠人', race: 'human', cls: 'warrior' });
});

const S = () => core.S!;
const R = (id: string) => craftRecipes().find((r) => r.id === id)!;
/** 把材料一次给足（测试专用，绕开采集/掉落） */
const stock = (pairs: [string, number][]) => {
  for (const [id, n] of pairs) addItem(id, n);
};

describe('卡 I2 · 站点与解锁门', () => {
  it('站点按地点/按 NPC 数据定位（零硬编码）', () => {
    expect(stationAt('market')?.id).toBe('forge');
    expect(stationAt('plaza')).toBeUndefined();
    expect(stationOfNpc('brendan')?.id).toBe('forge');
    expect(stationOf('alchemy')?.name).toBe('炼金台');
    expect(craftStations().length).toBe(3);
  });

  it('炼金台：金砂商院未结业即关闭，结业后开放', () => {
    const s = S();
    const al = stationOf('alchemy');
    expect(stationGate(al, s).open).toBe(false);
    expect(stationGate(al, s).why).toContain('金砂商院');
    s.academy!.completed.push('goldveil_y1');
    expect(stationGate(al, s).open).toBe(true);
    expect(stationGate(al, s).why).toBe('');
  });

  it('铭刻台：星枢一塔（数据 status=open）开放', () => {
    expect(stationGate(stationOf('inscribe'), S()).open).toBe(true);
  });

  it('forge 站无条件开放（布伦丹在城里）', () => {
    expect(stationGate(stationOf('forge'), S())).toEqual({ open: true, why: '' });
    expect(stationGate(undefined, S()).open).toBe(false);
  });
});

describe('卡 I2 · 技艺等级与成功率', () => {
  it('技艺等级 = 生产系 +2 + 学院工艺课结业数 + 熟练/2 + 站点加成', () => {
    const s = S();
    const st = stationOf('forge')!;
    expect(craftLv('forge', s)).toBe(0 + 0 + 0 + st.bonus); // warrior 非生产系
    s.academy!.completed.push('goldveil_y1', 'frosthold_y1'); // 两门 craft 学院课程
    expect(craftLv('forge', s)).toBe(2 + st.bonus);
    s.craft!.ranks.forge = 5;
    expect(craftLv('forge', s)).toBe(2 + Math.floor(5 / 2) + st.bonus);
  });

  it('生产系职业额外 +2（tables.json 三个生产职业已解锁）', () => {
    for (const cls of ['pr_forge', 'pr_alchemy', 'pr_inscribe']) {
      expect(WB.classes[cls].locked).toBe(false);
      const sk = WB.classes[cls].skillPath || [];
      expect(sk.every((k) => !!WB.skills[k])).toBe(true); // 不指占位 id
    }
    core.S = null;
    newGame({ name: '铁匠', race: 'human', cls: 'pr_forge' });
    const lv = craftLv('forge');
    expect(lv).toBe(2 + stationOf('forge')!.bonus);
  });

  it('成功率 = clamp(0.95 − failRate + lv×0.03, 0.35, 0.98)', () => {
    const s = S();
    const r = R('rc_iron_sword');
    const lv = craftLv(r.station, s);
    expect(successRate(r, s)).toBeCloseTo(0.95 - r.failRate + lv * 0.03, 6);
    s.craft!.ranks.forge = 9999; // 熟练碾压 → 仍封顶 0.98
    expect(successRate(r, s)).toBe(0.98);
  });
});

describe('卡 I2 · canCraft 六种拒绝理由', () => {
  it('材料不足', () => {
    const chk = canCraft(R('rc_iron_sword'), S());
    expect(chk.ok).toBe(false);
    expect(chk.why).toContain('缺材料');
  });

  it('资金不足', () => {
    const s = S();
    stock([['blade_blank', 1], ['scrap_blade', 2]]);
    s.player.gold = 10;
    const chk = canCraft(R('rc_iron_sword'), s);
    expect(chk.ok).toBe(false);
    expect(chk.why).toContain('铜钱不足');
  });

  it('技艺不足（skillMin）', () => {
    const s = S();
    stock([['star_marrow', 3], ['star_shard', 2], ['blade_blank', 1]]);
    s.player.gold = 99999;
    const chk = canCraft(R('rc_starsteel'), s); // skillMin 8
    expect(chk.ok).toBe(false);
    expect(chk.why).toContain('技艺不足');
  });

  it('学院课程门（霜锚武馆 y2）', () => {
    const s = S();
    stock([['blade_blank', 2], ['scrap_blade', 4], ['venom_gland', 1]]);
    s.player.gold = 99999;
    s.craft!.ranks.forge = 10; // 先越过技艺门槛，才能验到课程门（判定顺序：站 → 技艺 → 课程 → 文献 → 料 → 钱）
    const chk = canCraft(R('rc_steel_axe'), s);
    expect(chk.ok).toBe(false);
    expect(chk.why).toContain('霜锚武馆');
    s.academy!.completed.push('frosthold_y2');
    expect(canCraft(R('rc_steel_axe'), s).ok).toBe(true);
  });

  it('文献门（needCodex，卡 I5 未解时拒）', () => {
    const s = S();
    stock([['star_marrow', 2], ['blade_blank', 1], ['platinum', 1]]);
    s.player.gold = 99999;
    s.craft!.ranks.forge = 20;
    const chk = canCraft(R('rc_star_blade'), s);
    expect(chk.ok).toBe(false);
    expect(chk.why).toContain('文献');
    s.codex!.unlocked.push('s45');
    expect(canCraft(R('rc_star_blade'), s).ok).toBe(true);
  });

  it('站点未开放（炼金台 · 任一炼金配方）', () => {
    const s = S();
    stock([['moonherb', 4]]);
    s.player.gold = 9999;
    const chk = canCraft(R('rc_paste'), s);
    expect(chk.ok).toBe(false);
    expect(chk.why).toContain('金砂商院');
  });
});

describe('卡 I2 · craft 写入口', () => {
  it('成功：扣料 + 产出实例 + 推进时间', () => {
    const s = S();
    stock([['blade_blank', 1], ['scrap_blade', 2]]);
    /* 卡 T3：装备价按世界书 §55 上调后，配方铜钱成本随之抬高（500 → 4480），
       原值 1000 会因铜不够而不产件。给足以覆盖新成本的本金，断言仍走数据驱动。 */
    const g0 = 20000;
    s.player.gold = g0;
    const t0 = s.t;
    const restore = rng.inject(() => 0);
    craft('rc_iron_sword');
    restore();
    expect(itemCount('blade_blank', s)).toBe(0);
    expect(itemCount('scrap_blade', s)).toBe(0);
    /* 起点从字面量 1000 改为 g0：上一行的本金已随成本上调，断言若仍写死 1000
       就会与本金脱钩（这次调价正好把这个隐含耦合暴露出来）。 */
    expect(s.player.gold).toBe(g0 - R('rc_iron_sword').need.gold);
    const inst = s.player.bag.find((x) => x.id === 'sword_iron' && x.uid);
    expect(inst).toBeTruthy();
    expect(s.t).toBe(t0 + R('rc_iron_sword').ticks);
    expect(s.craft!.made.rc_iron_sword).toBe(1);
    expect(s.craft!.ranks.forge).toBe(1);
  });

  it('同种子同产出（确定性：品质与词缀一致）', () => {
    const run = () => {
      core.S = null;
      newGame({ name: '匠人', race: 'human', cls: 'warrior' });
      const s = S();
      stock([['blade_blank', 2], ['scrap_blade', 4]]);
      s.player.gold = 5000;
      rng.seed(777);
      craft('rc_iron_sword');
      return s.player.bag.filter((x) => x.uid).map((x) => x.q + ':' + (x.af || []).join(','));
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('失败：返还 50% 材料 + 装备配方产出普通品质废件', () => {
    const s = S();
    stock([['blade_blank', 2], ['scrap_blade', 4]]);
    s.player.gold = 20000; // 同前：需覆盖新配方成本才可能进入「制作中」
    const restore = rng.inject(() => 0.999); // 必定失败
    craft('rc_iron_sword');
    restore();
    /* 给 2 剑坯：扣 1 → 剩 1；返还 floor(1×0.5)=0 */
    expect(itemCount('blade_blank', s)).toBe(1);
    /* 给 4 破铜刀：扣 2 → 剩 2；返还 floor(2×0.5)=1 → 共 3 */
    expect(itemCount('scrap_blade', s)).toBe(3);
    const scrap = s.player.bag.find((x) => x.id === 'sword_iron' && x.uid);
    expect(scrap?.q).toBe(0);
    expect(scrap?.af).toEqual([]);
    expect(s.craft!.made.rc_iron_sword).toBeUndefined();
  });

  it('幂等：同刻重复提交只算一次（craft_<id>_<tick>）', () => {
    const s = S();
    stock([['blade_blank', 3], ['scrap_blade', 6]]);
    s.player.gold = 20000; // 两次制作 × 新成本 4480 需覆盖
    const restore = rng.inject(() => 0);
    craft('rc_iron_sword');
    const t1 = s.t;
    craft('rc_iron_sword'); // 第二次：t 已推进，仍应成功（不同刻）——同刻判定用键精确验证
    restore();
    expect(s.craft!.made.rc_iron_sword).toBe(2);
    /* 直接构造同刻撞键：把 recent 写回旧刻并重置 t */
    s.t = t1;
    s.craft!.recent!['craft_rc_iron_sword_' + t1] = t1;
    const before = s.craft!.made.rc_iron_sword;
    craft('rc_iron_sword');
    expect(s.craft!.made.rc_iron_sword).toBe(before); // 被幂等键拦下
  });

  it('物品产出配方走 addItem（炼金：药草膏 ×2）', () => {
    const s = S();
    s.academy!.completed.push('goldveil_y1'); // 开炼金台
    stock([['moonherb', 4]]);
    s.player.gold = 500;
    const restore = rng.inject(() => 0);
    craft('rc_paste');
    restore();
    expect(itemCount('herb_paste', s)).toBe(2);
    expect(itemCount('moonherb', s)).toBe(2);
  });

  it('未知配方 id 不崩、不改状态', () => {
    const s = S();
    const bag = s.player.bag.length;
    craft('rc_不存在');
    expect(s.player.bag.length).toBe(bag);
  });
});

describe('卡 I2 · 法律咬合（违禁配方）', () => {
  it('违禁配方表与配方数据一致', () => {
    expect(isIllegalRecipe('rc_dust_dream')).toBe(true);
    expect(isIllegalRecipe('rc_void_dagger')).toBe(true);
    expect(isIllegalRecipe('rc_paste')).toBe(false);
    expect(craftJson.illegalRecipes.length).toBe(2);
  });

  it('城内制作违禁品 → 复用既有罪名立案（不新增分级）', () => {
    const s = S();
    s.academy!.completed.push('goldveil_y1');
    s.player.loc = 'guild'; // strict 辖区
    stock([['moonherb', 3], ['venom_gland', 2]]);
    s.player.gold = 900;
    const restore = rng.inject(() => 0);
    craft('rc_dust_dream');
    restore();
    expect(s.legal!.charges).toContain('smuggling');
    expect(s.player.wanted).toBeGreaterThan(0);
  });

  it('法外之地（洞窟）制作违禁品：不立案（法律口径一致）', () => {
    const s = S();
    s.academy!.completed.push('goldveil_y1');
    s.player.loc = 'cave';
    stock([['moonherb', 3], ['venom_gland', 2]]);
    s.player.gold = 900;
    const restore = rng.inject(() => 0);
    craft('rc_dust_dream');
    restore();
    expect(s.legal!.charges).not.toContain('smuggling');
  });
});

describe('卡 I2 · 数据完整性与契约', () => {
  /* 卡 F2：把 §46–§52 的魔物掉落（12 种材料）接进工坊后，配方由 24 条扩到 36 条。
     卡 N1：批 1 的 25 件新材料一件都没留成摆设（61 条），批 2 的 18 件工具与 18 件防具
     各有出处（106 条），批 3 的 15 件大陆特产同样全部落地（125 条）。
     这不是"数据失控"——每一条新配方都对应一件此前无处可来的东西。 */
  it('149 条配方（forge 51 / alchemy 53 / inscribe 45）', () => {
    expect(craftRecipes().length).toBe(149);
    expect(craftRecipes('forge').length).toBe(51);
    expect(craftRecipes('alchemy').length).toBe(53);
    expect(craftRecipes('inscribe').length).toBe(45);
  });

  it('配方的材料与产出 id 都在世界书中存在（防幽灵引用）', () => {
    for (const r of craftRecipes()) {
      for (const [iid] of r.need.items) expect(!!WB.items[iid], r.id + ' 材料 ' + iid).toBe(true);
      if (r.out.item) expect(!!WB.items[r.out.item], r.id + ' 产出 ' + r.out.item).toBe(true);
      if (r.out.base) expect(!!WB.items[r.out.base], r.id + ' 产出 ' + r.out.base).toBe(true);
    }
  });

  it('关 AI 契约：每条配方 seed 非空且不含占位符', () => {
    for (const r of craftRecipes()) {
      expect(r.seed.length).toBeGreaterThan(6);
      expect(/\{[a-z]+\}/.test(r.seed)).toBe(false);
    }
  });

  it('G10 零代码契约：npcId 挂站的 NPC 对话里必出现进工坊选项', () => {
    for (const st of craftStations()) {
      if (!st.npcId) continue;
      const opts = dlgOpts(st.npcId);
      expect(opts.some((o) => o.a === 'craft_menu'), st.id + ' @' + st.npcId).toBe(true);
    }
  });

  it('学院课程 recipes 与工坊配方 id 双向对齐（无悬空门/无孤儿配方）', () => {
    const ids = new Set(craftRecipes().map((r) => r.id));
    let n = 0;
    for (const ac of (academyJson as unknown as { academies: { curriculum: { courseId: string; recipes?: string[] }[] }[] }).academies) {
      for (const c of ac.curriculum || []) {
        for (const rid of c.recipes || []) {
          expect(ids.has(rid), c.courseId + ' → ' + rid).toBe(true);
          n++;
        }
      }
    }
    expect(n).toBe(10); // 10 条配方由课程解锁
  });

  it('craftView：行数与站配方数一致，非法/未达标行标记正确', () => {
    const s = S();
    const v = craftView('forge', s);
    expect(v.rows.length).toBe(craftRecipes('forge').length);
    expect(v.open).toBe(true);
    expect(v.lv).toBe(craftLv('forge', s));
    expect(v.rows.every((r) => !r.ok)).toBe(true); // 白手起家：材料全缺
    expect(v.rows[0].need.length).toBeGreaterThan(0);
    expect(v.rows.every((r) => r.pct >= 35 && r.pct <= 98)).toBe(true);
    s.academy!.completed.push('goldveil_y1');
    const av = craftView('alchemy', s);
    expect(av.rows.filter((r) => r.illegal).length).toBe(1);
  });
});

/* ============================================================
   行囊面板 · 视图模型（方案 A 落地）
   ------------------------------------------------------------
   这一份测的不是像素，是四条会**静默出错**的口径：
     1) 分类优先级——违禁匕首是 wpn，先按 type 归类它就会从「违禁」栏消失；
     2) 计数与估值——件数按 qty 求和（不是条目数），0 价剧情物不进总估值；
     3) 实例计价——品质倍率与词缀溢价必须走 Equip.instPrice，不能自己乘；
     4) 动作推导——沿用 CharPanel 的既有判据，改了要在这里一起改。
   起局方式与 shop.test.ts 一致：内存存档 + 规则推演 + 定种子 + 同步调度器。
   ============================================================ */
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, core, rng, scheduler } from '@/world';
import { newGame } from '@/world/WorldRuntime';
import { MemorySaveRepository } from '@/repo';
import { setAiPort, setSavePort } from '@/plugins/PluginInterface';
import { ruleSim } from '@/ai/ruleSim';
import { addItem } from '@/systems/character/Gains';
import { addInstance } from '@/systems/inventory/Equip';
import { WB } from '@/data/worldBook';
import { BAG_CATS, bagActionOf, bagDerivedOf, bagEquipLines, bagViewOf, moveSel, sortBagRows } from '@/ui/panels/inventoryView';

beforeEach(() => {
  core.S = null;
  core.CB = null;
  bus.clear();
  setSavePort(new MemorySaveRepository());
  setAiPort(ruleSim);
  rng.seed(77);
  scheduler.inject((_ms, fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
  newGame({ name: '行囊', race: 'human', cls: 'ranger' });
});

/** 清空开局自带的物品，让每一条断言都只依赖本用例放进来的东西 */
const fresh = () => {
  const s = core.S!;
  s.player.bag = [];
  return s;
};
const view = () => bagViewOf(core.S!);
const rowOf = (id: string) => view().rows.find((r) => r.slot.id === id)!;

describe('行囊 · 分类（互斥，优先级不可交换）', () => {
  it('违禁优先于器物：违禁匕首进「违禁」，不进「器物」', () => {
    fresh();
    addItem('dagger_black', 1);
    addItem('blade_short', 1);
    expect(rowOf('dagger_black').cat).toBe('违禁');
    expect(rowOf('blade_short').cat).toBe('器物');
  });

  it('0 价物归任务、文献归卷册、消耗归补给、其余归素材', () => {
    fresh();
    addItem('letter', 1); // mat + price 0
    addItem('tome_craft', 1); // use + codexCat
    addItem('potion_moon', 1); // use
    addItem('wolf_pelt', 1); // mat
    expect(rowOf('letter').cat).toBe('任务');
    expect(rowOf('tome_craft').cat).toBe('卷册');
    expect(rowOf('potion_moon').cat).toBe('补给');
    expect(rowOf('wolf_pelt').cat).toBe('素材');
  });

  it('六个分类互斥且件数合计等于总数（同一件不会被数两次）', () => {
    fresh();
    addItem('wolf_pelt', 4);
    addItem('dust_dream', 2); // use + illegal → 违禁，不是补给
    addItem('bread', 2);
    const v = view();
    expect(v.counts.素材).toBe(4);
    expect(v.counts.违禁).toBe(2);
    expect(v.counts.补给).toBe(2);
    const sum = BAG_CATS.reduce((a, c) => a + v.counts[c], 0);
    expect(sum).toBe(v.pieces);
    expect(v.pieces).toBe(8);
  });
});

describe('行囊 · 估值与排序', () => {
  it('件数按数量求和，单价 × 数量 = 小计，0 价物不计入总估值', () => {
    fresh();
    addItem('bread', 3);
    addItem('letter', 1);
    const v = view();
    const b = rowOf('bread');
    expect(b.qty).toBe(3);
    expect(b.unit).toBeGreaterThan(0);
    expect(b.value).toBe(b.unit * 3);
    expect(rowOf('letter').priced).toBe(false);
    expect(rowOf('letter').value).toBe(0);
    expect(v.total).toBe(b.value);
  });

  it('实例按品质档溢价：神话短刃的估值远超同款普通件', () => {
    const s = fresh();
    addItem('blade_short', 1);
    const plain = rowOf('blade_short').value;
    addInstance({ id: 'blade_short', qty: 1, uid: 'eT1', q: 5, af: ['af_sharp', 'af_swift'] }, s);
    const inst = rowOf('blade_short');
    expect(inst.name).toContain('神话');
    expect(inst.color).toBe('#ff7a5c'); // affix.json · quality.colors[5]
    expect(inst.affix).toContain('锋锐');
    expect(inst.value).toBeGreaterThan(plain * 4); // 品质 ×5 再乘词缀溢价
  });

  it('类别聚合在前、同类内估值降序：行囊默认视图是「按用途翻」', () => {
    fresh();
    addItem('bread', 1);
    addItem('potion_moon', 1);
    addItem('wolf_pelt', 1);
    addItem('blade_short', 1);
    const rows = view().rows;
    const rank = (c: string) => (BAG_CATS as readonly string[]).indexOf(c);
    for (let i = 1; i < rows.length; i++) expect(rank(rows[i].cat)).toBeGreaterThanOrEqual(rank(rows[i - 1].cat));
    const supply = rows.filter((r) => r.cat === '补给').map((r) => r.value);
    for (let i = 1; i < supply.length; i++) expect(supply[i]).toBeLessThanOrEqual(supply[i - 1]);
  });
});

describe('行囊 · 排序（浮层表头可点）', () => {
  /** 放一份有明确大小关系的行囊：短刃实例 48000 > 水晶丝 2400 > 面包 40 > 剧情物 0 */
  const stock = () => {
    const s = fresh();
    addItem('bread', 2);
    addItem('crystal_silk', 2);
    addItem('letter', 1);
    addInstance({ id: 'blade_short', qty: 1, uid: 'eS1', q: 5, af: ['af_sharp'] }, s);
    return s;
  };
  const names = (sort: Parameters<typeof sortBagRows>[1], dir: 1 | -1) =>
    sortBagRows(bagViewOf(core.S!).rows, sort, dir).map((r) => r.slot.id);

  it('按估值降序：实例排在首位，0 价剧情物沉底', () => {
    stock();
    const n = names('total', -1);
    expect(n[0]).toBe('blade_short');
    expect(n[n.length - 1]).toBe('letter');
  });

  it('按估值升序：与降序恰好相反（同值时按名称回落，顺序仍确定）', () => {
    stock();
    const asc = names('total', 1);
    const desc = names('total', -1);
    expect(asc).toEqual([...desc].reverse());
  });

  it('类别键忽略方向：反向点表头不会把整个行囊翻过来', () => {
    stock();
    expect(names('cat', -1)).toEqual(names('cat', 1));
  });

  it('排序不改动行数，也不吞掉任何一件', () => {
    stock();
    const rows = bagViewOf(core.S!).rows;
    expect(sortBagRows(rows, 'price', -1).length).toBe(rows.length);
    expect(new Set(sortBagRows(rows, 'qty', 1).map((r) => r.key)).size).toBe(rows.length);
  });
});

describe('行囊 · 键盘移动（↑ ↓ Home End）', () => {
  const keys = () => bagViewOf(core.S!).rows;
  const stock = () => {
    const s = fresh();
    addItem('bread', 1);
    addItem('potion_moon', 1);
    addItem('wolf_pelt', 1);
    return s;
  };

  it('无选中时：↓ 落在第一项、↑ 落在最后一项（从两端进入）', () => {
    stock();
    const r = keys();
    expect(moveSel(r, null, 1)).toBe(r[0].key);
    expect(moveSel(r, null, -1)).toBe(r[r.length - 1].key);
  });

  it('到顶到底不循环：停住，而不是从末尾绕回来', () => {
    stock();
    const r = keys();
    expect(moveSel(r, r[0].key, -1)).toBe(r[0].key);
    expect(moveSel(r, r[r.length - 1].key, 1)).toBe(r[r.length - 1].key);
  });

  it('Home / End 直达两端', () => {
    stock();
    const r = keys();
    expect(moveSel(r, r[1].key, 'first')).toBe(r[0].key);
    expect(moveSel(r, r[0].key, 'last')).toBe(r[r.length - 1].key);
  });

  it('空列表返回 null，不抛（行囊空空时按方向键）', () => {
    fresh();
    expect(moveSel([], null, 1)).toBeNull();
    expect(moveSel([], 'e1', 'last')).toBeNull();
  });

  it('选中项已不在当前筛选里时，↓ 从第一项重新开始', () => {
    stock();
    const r = keys();
    expect(moveSel(r, '不存在的key', 1)).toBe(r[0].key);
    expect(moveSel(r, '不存在的key', -1)).toBe(r[r.length - 1].key);
  });
});

describe('行囊 · 动作推导（与 CharPanel 既有判据同源）', () => {
  it('消耗品可「使用」、文献可「研读」、武器护甲可「装备」、素材无行内动作', () => {
    expect(bagActionOf(WB.items.potion_moon)).toBe('使用');
    expect(bagActionOf(WB.items.tome_craft)).toBe('研读');
    expect(bagActionOf(WB.items.blade_short)).toBe('装备');
    expect(bagActionOf(WB.items.armor_leather)).toBe('装备');
    expect(bagActionOf(WB.items.wolf_pelt)).toBe(null);
  });

  it('违禁药物既不可使用也不可装备：它在行囊里没有动作，提示指向别处', () => {
    fresh();
    addItem('dust_dream', 1);
    const r = rowOf('dust_dream');
    expect(r.act).toBe(null);
    expect(r.illegal).toBe(true);
    expect(r.hint).toBeTruthy();
  });

  it('素材的提示说的是「在商人处出售」——出售入口不在行囊里', () => {
    fresh();
    addItem('wolf_pelt', 1);
    expect(rowOf('wolf_pelt').hint).toContain('商人');
  });
});

describe('行囊 · 装备轴与派生', () => {
  it('空槽给出占位文案，不渲染成「undefined」', () => {
    const s = fresh();
    s.player.equip = { wpn: null, arm: null, wpnIns: undefined, armIns: undefined };
    const lines = bagEquipLines(s);
    expect(lines.map((l) => l.slot)).toEqual(['武器', '护甲']);
    expect(lines[0].empty).toBe(true);
    expect(lines[0].name).toBe('空手');
    expect(lines[0].bonus).toBe('');
  });

  it('实例词缀摘要按 quality=4 的强度档聚合：沉猛+星锻 = 攻+8（1+0.15×4 取整为 2）', () => {
    const s = fresh();
    s.player.equip = {
      wpn: 'blade_starsteel',
      arm: null,
      wpnIns: { uid: 'eW', q: 4, af: ['af_heavy', 'af_duelist', 'af_starforged'] },
    };
    const w = bagEquipLines(s)[0];
    expect(w.name).toContain('传说');
    expect(w.base).toContain('基础攻击 5');
    expect(w.bonus).toContain('攻 +8');
    expect(w.bonus).toContain('暴 +6%');
  });

  it('派生三格读的是 core 的派生出口（atkB / AC / critRate），不是面板自己算', () => {
    const s = fresh();
    const der = bagDerivedOf(s);
    expect(der.map((d) => d.k)).toEqual(['攻击加值', '防御等级', '暴击率']);
    for (const d of der) expect(d.d).toBeTruthy();
    expect(der[2].v).toMatch(/^\d+%$/);
  });
});

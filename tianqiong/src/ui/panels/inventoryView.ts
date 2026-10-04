/* ============================================================
   行囊面板 · 视图模型（方案 A 落地 · outputs/背包界面-5方案/方案A-行囊.html）
   ------------------------------------------------------------
   为什么单独一个文件：分类、计数、估值、可用动作这四件事，如果写在 JSX 里，
   想验证「违禁品会不会被算进器物」「实例价有没有算上词缀溢价」就得把游戏跑起来
   用肉眼看。抽成纯函数后它们有了单测（src/tests/bagPanel.test.ts）。

   口径来源（不接受第二份实现）：
     · 单价 / 估值 → inventory/Equip.instPrice（本地价 × 品质倍率 × 词缀溢价）
     · 名称 / 词缀文本 → Equip.instName / instAffixText
     · 装备加成摘要 → Equip.instMods（全 0 = 旧档语义，无实例时摘要为空）
     · 可用动作 → 沿用 CharPanel 既有判据，命令仍只有 useItem / equipItem 两条

   分类互斥且零新增字段：违禁 > 任务 > 卷册 > 器物 > 补给 > 素材，
   全部由 ItemDef 的既有字段推导（illegal / price / codexCat / type）。
   ============================================================ */
import { WB } from '@/data/worldBook';
import type { BagSlot, ItemDef, WorldState } from '@/types/world';
import { AC, atkB, critRate, instAffixText, instMods, instName, instPrice, isInstance, qualityColor } from '@/world';
import type { InstMods } from '@/world';

/** 行囊六类（互斥）。顺序即界面上的排列顺序。 */
export type BagCat = '器物' | '补给' | '素材' | '卷册' | '任务' | '违禁';
export const BAG_CATS: readonly BagCat[] = ['器物', '补给', '素材', '卷册', '任务', '违禁'];
/** 分类条的筛选项：'全部' 是所有类别的并集，不是第七个类别 */
export type BagFilter = '全部' | BagCat;

const CAT_RANK: Record<BagCat, number> = { 器物: 0, 补给: 1, 素材: 2, 卷册: 3, 任务: 4, 违禁: 5 };

/** 行内可用动作；null = 这件东西在背包里没有动作（素材只在商店浮层里卖） */
export type BagAction = '使用' | '研读' | '装备' | null;

/**
 * 归类。优先级不可交换：
 *   1) illegal 先判——黑市的违禁匕首 type 是 wpn，但它属于「违禁」而不是「器物」；
 *      若先按 type 归类，玩家会在器物里看见一件红字的刀，违禁那一栏却是空的。
 *   2) price === 0 是任务物的既有特征（精钢剑坯 / 米娅的信件 / 星枢残片都是 0 价），
 *      比另立一个 quest 字段便宜，也不与 type=mat 冲突。
 */
export function bagCatOf(it: ItemDef): BagCat {
  if (it.illegal) return '违禁';
  if (!it.price) return '任务';
  if (it.codexCat) return '卷册';
  if (it.type === 'wpn' || it.type === 'arm') return '器物';
  if (it.type === 'use') return '补给';
  return '素材';
}

/** 动作推导：与 CharPanel 的既有判据逐字一致，改口径要同时改两处是有意为之的反例 */
export function bagActionOf(it: ItemDef): BagAction {
  if (it.type === 'wpn' || it.type === 'arm') return '装备';
  /* 卡 N1：带 eff 的消耗品与 heal 药剂同等看待——「有动作」才是它在行囊里存在的意义 */
  if (it.type === 'use' && ((it.heal || 0) > 0 || it.codexCat || (it.eff?.length ?? 0) > 0))
    return it.codexCat ? '研读' : '使用';
  return null;
}

export interface BagRow {
  slot: BagSlot;
  /** React key：实例用 uid，堆叠行用 id（与 WorldMutate 的堆叠规则同源） */
  key: string;
  name: string;
  /** 品质档颜色；非实例为空串，由组件回落到正文色 */
  color: string;
  cat: BagCat;
  q: number;
  qty: number;
  /** 本地单价（铜）；无市价时为 0 */
  unit: number;
  value: number;
  /** false = 无市价（price 基准为 0 的剧情物），不进总估值 */
  priced: boolean;
  desc: string;
  /** 实例词缀的多行文本；非实例为空串 */
  affix: string;
  act: BagAction;
  illegal: boolean;
  /** act 为 null 时的说明：不说「无动作」，说清去哪能做 */
  hint: string;
}

export function bagRowOf(x: BagSlot, s: WorldState): BagRow {
  const it = WB.items[x.id];
  const inst = isInstance(x);
  const qty = Math.max(1, Math.floor(x.qty) || 1);
  const priced = it.price > 0;
  const unit = priced ? instPrice(x, s) : 0;
  const act = bagActionOf(it);
  return {
    slot: x,
    key: x.uid || x.id,
    name: inst ? instName(x) : it.name,
    color: inst ? qualityColor(x.q) : '',
    cat: bagCatOf(it),
    q: inst ? Math.max(0, Math.floor(x.q || 0)) : -1,
    qty,
    unit,
    value: unit * qty,
    priced,
    desc: it.desc,
    affix: inst ? instAffixText(x) : '',
    act,
    illegal: !!it.illegal,
    hint: act
      ? ''
      : it.type === 'mat'
        ? '素材：在商人处出售'
        : it.utility?.length
          ? '探索地下城时自动生效'
          : '行囊里没有直接动作',
  };
}

export interface BagView {
  rows: BagRow[];
  /** 件数（qty 求和）——分类条与统计头都用它，不用条目数 */
  counts: Record<BagFilter, number>;
  pieces: number;
  /** 行囊估值（铜）：无市价物按 0 计 */
  total: number;
}

/** 表头可点的排序列（与 BagOverlay 的 <thead> 一一对应） */
export type BagSortKey = 'cat' | 'n' | 'qty' | 'price' | 'total';

const CMP: Record<BagSortKey, (a: BagRow, b: BagRow) => number> = {
  cat: (a, b) => CAT_RANK[a.cat] - CAT_RANK[b.cat],
  n: (a, b) => a.name.localeCompare(b.name, 'zh'),
  qty: (a, b) => a.qty - b.qty,
  price: (a, b) => a.unit - b.unit,
  total: (a, b) => a.value - b.value,
};

/**
 * 排序。默认（'cat'）先按类别聚合、同类内按估值降序——不用「入包顺序」做默认，
 * 因为玩家翻行囊的目的通常是「有什么能卖的 / 能用的」，入包顺序只回答「我最近捡了什么」。
 *
 * 'cat' 时忽略 dir：类别聚合是结构（器物 → 补给 → 素材…），反向排只会让每次点表头
 * 都把行囊翻个底朝天，那不是排序，是抖动。其余键按 dir 升降，同值回落到
 * 「类别 → 估值降序 → 名称」，保证渲染顺序稳定（React key 不变时不会闪）。
 */
export function sortBagRows(rows: BagRow[], sort: BagSortKey = 'cat', dir: 1 | -1 = 1): BagRow[] {
  const out = rows.slice();
  out.sort((a, b) => {
    const v = CMP[sort](a, b) * (sort === 'cat' ? 1 : dir);
    if (v) return v;
    return CAT_RANK[a.cat] - CAT_RANK[b.cat] || b.value - a.value || a.name.localeCompare(b.name, 'zh');
  });
  return out;
}

/**
 * 键盘移动选中项（浮层的 ↑ ↓ Home End）。
 * 不循环：到顶再按 ↑ 停在第一项——循环会让"翻过头"变成一种惩罚。
 * 抽成纯函数是为了能测边界（空列表 / 无选中 / 越界），这几条正好是键盘最常踩的。
 */
export function moveSel(rows: BagRow[], sel: string | null, move: 1 | -1 | 'first' | 'last'): string | null {
  if (!rows.length) return null;
  if (move === 'first') return rows[0].key;
  if (move === 'last') return rows[rows.length - 1].key;
  const i = sel ? rows.findIndex((r) => r.key === sel) : -1;
  if (i < 0) return rows[move > 0 ? 0 : rows.length - 1].key;
  return rows[Math.min(rows.length - 1, Math.max(0, i + move))].key;
}

export function bagViewOf(s: WorldState, sort: BagSortKey = 'cat', dir: 1 | -1 = 1): BagView {
  const rows = sortBagRows(s.player.bag.map((x) => bagRowOf(x, s)), sort, dir);

  const counts = { 全部: 0 } as Record<BagFilter, number>;
  for (const c of BAG_CATS) counts[c] = 0;
  let total = 0;
  for (const r of rows) {
    counts.全部 += r.qty;
    counts[r.cat] += r.qty;
    total += r.value;
  }
  return { rows, counts, pieces: counts.全部, total };
}

/* ---------------- 装备轴 ---------------- */

export interface BagEquipLine {
  slot: '武器' | '护甲';
  /** 已装备时的显示名（实例走 instName，回落 base 名），空槽给出占位文案 */
  name: string;
  color: string;
  /** 基础数值 + 说明；空槽时是提示语 */
  base: string;
  /** 实例词缀摘要（单行，显示在右侧）；无实例为空串 */
  bonus: string;
  /** 逐条词缀（每行一条，出处 Equip.instAffixText）；空槽或普通件为空数组 */
  affixes: string[];
  empty: boolean;
}

/** 实例词缀逐条：instAffixText 的契约是每行一条「名称（数值）」，这里只按行拆 */
const affixLines = (ins?: { id?: string; uid?: string; q?: number; af?: string[] } | null): string[] =>
  ins ? instAffixText(ins).split('\n').filter(Boolean) : [];

const modText = (m: InstMods): string => {
  const out: string[] = [];
  if (m.atk) out.push('攻 +' + m.atk);
  if (m.def) out.push('防 +' + m.def);
  if (m.crit) out.push('暴 +' + Math.round(m.crit * 100) + '%');
  if (m.leech) out.push('吸血 +' + Math.round(m.leech * 100) + '%');
  if (m.elem) out.push('元素 +' + m.elem);
  if (m.thorns) out.push('荆棘 +' + m.thorns);
  if (m.ward) out.push('格挡 +' + m.ward);
  if (m.haste) out.push('迅捷 +' + m.haste);
  for (const k of Object.keys(m.stat) as (keyof typeof m.stat)[]) {
    const v = m.stat[k];
    if (v) out.push(k + ' +' + v);
  }
  return out.join(' · ');
};

export function bagEquipLines(s: WorldState): BagEquipLine[] {
  const p = s.player;
  const lines: BagEquipLine[] = [];

  const wpn = p.equip.wpn ? WB.items[p.equip.wpn] : undefined;
  if (!wpn) {
    lines.push({ slot: '武器', name: '空手', color: '', base: '赤手空拳', bonus: '', affixes: [], empty: true });
  } else {
    const ins = p.equip.wpnIns;
    lines.push({
      slot: '武器',
      name: ins ? instName({ id: p.equip.wpn!, ...ins }) : wpn.name,
      color: ins ? qualityColor(ins.q) : '',
      base: '基础攻击 ' + (wpn.atk || 0) + '　' + wpn.desc,
      bonus: ins ? modText(instMods(ins)) : '',
      affixes: affixLines(ins),
      empty: false,
    });
  }

  const arm = p.equip.arm ? WB.items[p.equip.arm] : undefined;
  if (!arm) {
    lines.push({ slot: '护甲', name: '无', color: '', base: '未着甲', bonus: '', affixes: [], empty: true });
  } else {
    const ins = p.equip.armIns;
    lines.push({
      slot: '护甲',
      name: ins ? instName({ id: p.equip.arm!, ...ins }) : arm.name,
      color: ins ? qualityColor(ins.q) : '',
      base: '基础防御 ' + (arm.def || 0) + '　' + arm.desc,
      bonus: ins ? modText(instMods(ins)) : '',
      affixes: affixLines(ins),
      empty: false,
    });
  }
  return lines;
}

export interface BagDerived {
  k: string;
  v: string;
  /** tooltip：把算法写出来，玩家不必猜 18 是怎么来的 */
  d: string;
}

export function bagDerivedOf(s: WorldState): BagDerived[] {
  return [
    { k: '攻击加值', v: String(atkB(s)), d: '2 + ⌊等级/2⌋ + 主属性调整 + 武器（含词缀）' },
    { k: '防御等级', v: String(AC(s)), d: '10 + 敏捷调整 + 护甲（含词缀）+ 迅捷/格挡' },
    { k: '暴击率', v: Math.round(critRate(s) * 100) + '%', d: '基础 5% + 词缀暴击（上限 40%）' },
  ];
}

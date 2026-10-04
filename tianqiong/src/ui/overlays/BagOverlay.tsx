/* ============================================================
   行囊浮层（方案 A 落地 · outputs/行囊界面-桌面版5方案/方案A-全屏台账.html）
   ------------------------------------------------------------
   它是**装备与行囊合并后的唯一入口**：CharPanel 里那张独立的「装备」卡已删除，
   装备轴与派生三格只在这里出现一次。

   结构契约：[统计头][左列装备台账][右表物品][底部选中详情]

   交互契约（键盘是与鼠标同权的一等公民）：
     B 打开 · Esc 关闭（下层还有对话/商店浮层时让给它）· ↑↓ 移动选中 · Home/End 到两端
     Enter 对选中项执行主操作（装备 / 使用 / 研读）
     Tab 在浮层内循环（ui/useFocusTrap），关闭时焦点归还原处
   两条从设计工程准则来的约束，写在这里免得被"优化"掉：
     1) **行选中不做过渡**。↑↓ 是每秒可能按三次的动作，12ms 的 background transition
        在快速连按时会拖出残影；hover 才配过渡（它是鼠标的单次悬停）。
     2) 关闭有退场动画。开有进而关无出，会让浮层像被"掐掉"而不是被"关上"。

   为什么是独立浮层而不是 SheetHost 的一种 sheet：
     sheet 是 core 发出的事件描述符（对话/商店/抉择由 core 决定何时弹），
     行囊是纯 UI 面板——它不改变世界状态。开关放 store 的 bagOpen，与 h6Panel 同类。

   为什么不做出售/赠礼按钮：出售的权威入口是商店浮层（SheetHost.ShopBody，含
     vendor 钱袋校验与 shopSell），赠礼的权威入口是对话里的 giftPicker（按 NPC 喜恶结算）。
     在行囊里再造一份就是第二套价格口径与第二套赠礼规则。
   ============================================================ */
import { useEffect, useRef, useState } from 'react';
import type { GameCommand } from '@/types/uispec';
import { WB } from '@/data/worldBook';
import { formatMoney } from '@/systems/economy/Money';
import { clsName, world } from '@/world';
import { useGame } from '@/store/useGame';
import { useFocusTrap } from '../useFocusTrap';
import { useDesk } from '../useDesk';
import { Money } from '../Money';
import {
  BAG_CATS,
  bagDerivedOf,
  bagEquipLines,
  bagViewOf,
  moveSel,
  type BagFilter,
  type BagRow,
  type BagSortKey,
} from '../panels/inventoryView';

const SORT_LABEL: Record<BagSortKey, string> = { cat: '类别', n: '物品', qty: '数量', price: '单价', total: '估值' };
const AFFIX_RE = /^(.+?)（(.+)）$/;

/**
 * 分类与排序在**会话内**保留：关掉浮层再打开，玩家选好的"只看素材 + 按估值降序"还在。
 * 放模块级而不是 store：它不影响任何其它组件，也不该进存档。
 * 选中项不保留——那更容易变成"我明明关过它了怎么又亮着"。
 */
let memCat: BagFilter = '全部';
let memSort: BagSortKey = 'cat';
let memDir: 1 | -1 = 1;

/** 主操作：Enter 与详情区的主按钮走同一条路，避免两处判据漂移 */
function runPrimary(row: BagRow, cmd: (c: GameCommand) => void) {
  if (row.act === '装备') cmd({ type: 'equipItem', id: row.slot.id, uid: row.slot.uid });
  else if (row.act === '使用' || row.act === '研读') cmd({ type: 'useItem', id: row.slot.id });
}

export function BagOverlay() {
  const open = useGame((s) => s.bagOpen);
  const setBag = useGame((s) => s.setBag);
  const cmd = useGame((s) => s.cmd);
  /* 显式订阅世界变更计数（F-42）：不依赖"父层订阅 rev 导致整棵树重渲染"这一隐式前提 */
  useGame((s) => s.rev);
  const busy = useGame((s) => !!s.sheet || !!s.check || s.combatOpen);

  const [cat, setCat] = useState<BagFilter>(memCat);
  const [sort, setSort] = useState<BagSortKey>(memSort);
  const [dir, setDir] = useState<1 | -1>(memDir);
  const [sel, setSel] = useState<string | null>(null);
  /* 退场动画期间保持挂载：170ms 后卸载（与 CSS 的 .out 动画等长） */
  const [mounted, setMounted] = useState(open);

  const sheetRef = useRef<HTMLDivElement>(null);
  const tbRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<BagRow[]>([]);
  const selRef = useRef<string | null>(null);
  /* 键盘是与鼠标同权的一等公民，但手机上没有键盘——底部提示按端切换 */
  const isDesk = useDesk();

  useEffect(() => {
    memCat = cat;
    memSort = sort;
    memDir = dir;
  }, [cat, sort, dir]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), 170);
    return () => clearTimeout(t);
  }, [open]);

  /* active 用 open && mounted：首帧 mounted 还是 false，容器尚未进入 DOM，
     ref.current 是 null——此时开启陷阱会拿到空的可聚焦集合，Tab 于是跑到浮层背后
     （实测：连按 25 次 Tab 焦点已经出了浮层）。等容器真的挂上再启用。 */
  useFocusTrap(sheetRef, open && mounted);

  /* 全局键盘：B 开、Esc 关、↑↓/Home/End 移动选中、Enter 主操作 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      if (!open) {
        if ((e.key === 'b' || e.key === 'B') && !busy) setBag(true);
        return;
      }
      if (e.key === 'Escape') {
        /* 下层还有浮层（对话/商店）时把 Esc 让给它，否则一次按键会关掉两层 */
        if (useGame.getState().sheet) return;
        setBag(false);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const move = e.key === 'ArrowDown' ? (1 as const) : e.key === 'ArrowUp' ? (-1 as const) : e.key === 'Home' ? 'first' : 'last';
        const next = moveSel(rowsRef.current, selRef.current, move);
        if (next) setSel(next);
        return;
      }
      if (e.key === 'Enter') {
        const row = rowsRef.current.find((r) => r.key === selRef.current);
        if (!row || !row.act) return;
        const a = document.activeElement as HTMLElement | null;
        /* 只在焦点位于浮层容器或表格行时接管——焦点在"装备"按钮上时，
           Enter 该由按钮自己处理，否则会触发两次 */
        if (a === sheetRef.current || a?.tagName === 'TR') {
          e.preventDefault();
          runPrimary(row, cmd);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, setBag, cmd]);

  /* 选中项跟着走：焦点移到那一行（roving tabindex），并保证它在可视区内 */
  useEffect(() => {
    if (!open || !sel) return;
    const el = sheetRef.current?.querySelector<HTMLElement>('tbody tr.sel');
    if (!el) return;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  }, [open, sel, cat, sort, dir]);

  const S = world.query.get_world_state();
  if (!mounted || !S) return null;

  const view = bagViewOf(S, sort, dir);
  const eq = bagEquipLines(S);
  const der = bagDerivedOf(S);
  const rows = cat === '全部' ? view.rows : view.rows.filter((r) => r.cat === cat);
  const selRow = rows.find((r) => r.key === sel) ?? null;
  rowsRef.current = rows;
  selRef.current = sel;

  const pickCat = (c: BagFilter) => {
    setCat(c);
    /* 换分类即回到顶部：上一类滚到一半的位置对新的这一类没有意义 */
    tbRef.current?.scrollTo({ top: 0 });
  };

  const head = (k: BagSortKey, label: string, right = false) => (
    <th
      role="columnheader"
      aria-sort={sort === k ? (dir === 1 ? 'ascending' : 'descending') : 'none'}
      className={right ? 'r' : undefined}
      onClick={() => {
        if (k === sort) setDir(dir === 1 ? -1 : 1);
        else {
          setSort(k);
          setDir(1);
        }
      }}
    >
      {label}
      {sort === k && k !== 'cat' ? (dir === 1 ? ' ↑' : ' ↓') : ''}
    </th>
  );

  return (
    <div
      className={'bagovl' + (open ? '' : ' out')}
      role="dialog"
      aria-modal="true"
      aria-label="行囊"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setBag(false);
      }}
    >
      <div className="bagsheet" tabIndex={-1} ref={sheetRef}>
        <header className="bgs-hd">
          <span className="ic">囊</span>
          <div className="tt">
            <h2>行囊</h2>
            <div className="sb">
              {S.player.name} · {clsName(S)} · {WB.locations[S.player.loc].name}
            </div>
          </div>
          {/* 右上角曾经只放行囊估值，而它的外观（金币/银币/铜币图标）与顶栏钱包一模一样——
              于是「捡到钱之后这里的数字不动」会被读成"货币未同步"。
              实测确认：估值本身是随背包实时刷新的（3 瓶月光药剂 → 2 瓶时从 19银20铜变 16银），
              缺的是**钱包**：玩家在行囊里问的第一个问题就是「我有多少钱」。
              现在两个量各占一行且视觉分工：钱包用图标（与顶栏同源、与钱同步），
              估值用文字（"估 X" + 件数），谁也不会被当成另一个。 */}
          {/* 钱包与估值同占一行：分两行会把页头撑到 83px，而稿子里它只有 43px。
              两个量仍各自带 title，鼠标停上去能分清哪个是哪个。 */}
          <div className="val">
            <span className="n" title="身上的钱（与顶栏同源）">
              <span className="tag">持有</span>
              <Money n={S.player.gold} />
            </span>
            <span className="l" title="行囊物品按基准价的合计，随地区与品类指数浮动">
              估 {formatMoney(view.total)} · {view.pieces} 件
            </span>
          </div>
          {/* 落盘（丁·照影）：行囊没有「窗口」了，关闭键换成与页面同款的回程入口 */}
          <button className="x" aria-label="收起行囊" onClick={() => setBag(false)}>
            ← 收起
          </button>
        </header>

        <div className="bgs-bd">
          {/* 方案丁 · 装配槽：左栏按「槽」而不是按「件」组织。
              四个槽是固定的（数据层目前只有武器/护甲两个实体槽，饰品与备用先占位），
              空槽也留在那儿——玩家一眼就知道还能装什么，而不是"没显示=没有"。 */}
          <aside className="bgs-gear">
            <div className="bgs-cap">装配<em>四槽</em></div>
            <div className="bgs-slots">
              {(['武器', '护甲', '饰品', '备用'] as const).map((slotName) => {
                const l = eq.find((x) => (x.slot as string) === slotName);
                const has = !!l && !l.empty;
                return (
                  <div className={'sl' + (has ? '' : ' empt')} key={slotName}>
                    <span className="k">{slotName}</span>
                    <span className="v" style={has && l?.color ? { color: l.color } : undefined}>
                      {has ? l?.name : '空'}
                    </span>
                    {/* 基础值与词缀并进值行（不再单独起一行）：
                        稿子里槽只有「槽名 + 名称」两格，多一行会把槽高从 39px 撑到 57px。
                        信息没丢，只是不再占一整行。 */}
                    {has && (l?.base || l?.bonus || (l?.affixes.length ?? 0) > 0) && (
                      <span className="sub">
                        {l?.base}
                        {l?.bonus ? ` · ${l.bonus}` : ''}
                        {l && l.affixes.length > 0
                          ? ' · ' + l.affixes.map((a) => a.replace(AFFIX_RE, '$1 $2')).join(' · ')
                          : ''}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="bgs-der">
              {der.map((d) => (
                <div key={d.k} title={d.d}>
                  <div className="k">{d.k}</div>
                  <div className="v">{d.v}</div>
                </div>
              ))}
            </div>
          </aside>

          <section className="bgs-items">
            {/* 稿子里右栏与左栏一样有自己的区块标题（分组靠光晕，不靠边框） */}
            <div className="bgs-cap">
              行囊<em>{rows.length} 类 · {view.pieces} 件</em>
              <span className="r">估 {formatMoney(view.total)}</span>
            </div>
            <div className="bgs-bar">
              <div className="bgs-chips" role="tablist" aria-label="行囊分类">
                {(['全部', ...BAG_CATS] as BagFilter[]).map((c) => (
                  <button key={c} role="tab" data-cat={c} aria-selected={cat === c} className={cat === c ? 'on' : ''} onClick={() => pickCat(c)}>
                    {c}
                    <em>{view.counts[c]}</em>
                  </button>
                ))}
              </div>
              <div className="bgs-sort">
                共 {rows.length} 类 · 排序：{SORT_LABEL[sort]}
                {sort !== 'cat' ? (dir === 1 ? ' 升序' : ' 降序') : ''}
              </div>
            </div>

            <div className="bgs-tb" ref={tbRef}>
              <table role="grid" aria-label="行囊物品">
                <thead>
                  <tr>
                    {head('n', '物品')}
                    {head('cat', '类别')}
                    {head('qty', '数量', true)}
                    {head('total', '估值', true)}
                    <th role="columnheader">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr
                      key={r.key}
                      role="row"
                      aria-selected={r.key === sel}
                      tabIndex={r.key === sel ? 0 : -1}
                      data-iid={r.slot.id}
                      data-uid={r.slot.uid || ''}
                      data-idx={i}
                      className={(r.key === sel ? 'sel ' : '') + (r.illegal ? 'ill' : '')}
                      onClick={() => setSel(r.key === sel ? null : r.key)}
                    >
                      <td className="nm" style={r.color ? { color: r.color } : undefined}>
                        {r.name}
                        {r.illegal && <i className="flag">违禁</i>}
                      </td>
                      <td className="cat">{r.cat}</td>
                      <td className="r num">{r.qty}</td>
                      <td className="r val">{r.priced ? <Money n={r.value} /> : '—'}</td>
                      <td className="cat">{r.affix ? '实例' : r.priced ? '' : '剧情物'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && <div className="bgs-empty">{view.pieces ? '这一类空着' : '行囊空空'}</div>}
            </div>

            <div className="bgs-dt">
              {selRow ? (
                <Detail row={selRow} cmd={cmd} />
              ) : (
                <div className="ph">
                  {isDesk ? '↑↓ 选物品 · Enter 装备或使用 · 表头可排序 · Esc 关闭' : '点选物品查看详情 · 点表头排序'}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Detail({ row, cmd }: { row: BagRow; cmd: (c: GameCommand) => void }) {
  const lines = row.affix ? row.affix.split('\n') : [];
  return (
    <>
      <div className="dt-h">
        <span className="n" style={row.color ? { color: row.color } : undefined}>
          {row.name}
        </span>
        <span className="m">
          {row.cat}
          {row.illegal ? ' · 被城卫起获即记账' : ''}
        </span>
      </div>
      <div className="dt-b">
        <div className="desc">{row.desc}</div>
        {lines.length > 0 && (
          <div className="dt-af">
            {lines.map((ln, i) => {
              const m = AFFIX_RE.exec(ln);
              return (
                <div key={i}>
                  <span>{m ? m[1] : ln}</span>
                  <span>{m ? m[2] : ''}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="dt-a">
        {row.act && (
          <button className="pri" onClick={() => runPrimary(row, cmd)}>
            {row.act}
          </button>
        )}
        <span className="hint">
          单价 {row.priced ? <Money n={row.unit} /> : '无市价'}　·　{row.qty} 件 ={' '}
          {row.priced ? <Money n={row.value} /> : '不计入估值'}
          {row.hint ? '　·　' + row.hint : ''}
        </span>
      </div>
    </>
  );
}

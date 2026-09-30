/* ============================================================
   受控写入原语（引擎通用版）
   ------------------------------------------------------------
   世界状态的**唯一**写入实现点：任何系统 / AI / UI 都不直接改
   状态字段，只调原语。改写路径只有一条，才能审计、才能回放。

   与宿主游戏的分工：这里实现**信封字段**的通用原语（位置 / 旗帜 /
   背包 / 实体 / 声望 / 天气 / 状态效果 / 见闻录）；游戏自己的资源
   原语（hp/gold/exp/职业…）由宿主在合并对象里补充。两处世界观
   经 MutateOptions 注入：entryOf（实体建档，宿主可带建档副作用）
   与 stamp（见闻录时间戳）。

   为什么不做上界夹取：上限属游戏规则，引擎不越权——需要上界的
   调用方把 cap 传进来。
   ============================================================ */
import type { BagRow, EngineWorldState, EntityDynamic, LogEntry, StatusEffect } from '../types.ts';
import { clamp } from '../rng.ts';

export type LogCls = string;

export interface KernelMutate<W extends EngineWorldState> {
  /** 玩家所在地点（位置变化只此一处） */
  playerLoc(loc: string): void;
  /** 玩家 flag 的受控写入 */
  playerFlag(name: string, value?: boolean): void;
  /** 玩家背包增减：qty>0 入包并合并不带 uid 的堆叠行，qty<0 出包；返回是否真的改动过 */
  playerBag(id: string, qty: number): boolean;
  /** 实体运行时条目（惰性建档）。未开局时抛错（同 need） */
  npcEntry(id: string, s?: W): EntityDynamic;
  /** 实体好感增减，夹取到 [-100,100]，返回前后值（调用方据此决定要不要发世界事件） */
  npcAtt(id: string, delta: number): { from: number; to: number };
  /** 实体「正式见过面」标记 */
  npcMet(id: string, v?: boolean): void;
  /** 实体侧物品增减（复用玩家侧堆叠规则）。返回是否真的改动过 */
  npcBag(id: string, itemId: string, qty: number): boolean;
  /** 实体侧金钱增减，夹取到 >= 0，返回变化后的值 */
  npcGold(id: string, delta: number): number;
  /** 声望增量。未知势力键直接忽略（返回 0）；夹取到 [-100,100]，返回变化后的值 */
  rep(faction: string, delta: number): number;
  /** 天气（派生状态，只此一处可改） */
  weather(w: string): void;
  /** 状态效果挂载：同一 id 重复添加按「刷新时长 + 覆盖字段」处理，不叠成两条 */
  addEffect(owner: string, eff: StatusEffect): boolean;
  /** 状态效果移除。返回是否真的移除了 */
  removeEffect(owner: string, id: string): boolean;
  /** 见闻录追加：seq 单调递增 + 窗口上限。
      UI 的增量检测依赖 logSeq（log 长度恒定），只 push 不记 seq 会让界面停在旧状态 */
  pushLog(text: string, cls?: LogCls, s?: W): void;
  /** 追加一段章级摘要，并把归档水位推到 upto。只保留最近 keep 条 */
  appendRecap(text: string, upto: number, keep: number, s?: W): void;
  /** 把 **[seq, end] 区间**的见闻合并成一条（规则事实 → AI 正文替换）。
      返回是否真的替换了 */
  weaveLogs(seq: number, end: number, text: string, s?: W): boolean;
}

/** createMutate 的宿主钩子：把「引擎不管的游戏世界观」从外面注入 */
export interface MutateOptions<W extends EngineWorldState> {
  /**
   * 实体建档实现（缺省：引擎惰性建档 {att:0, mem:[], met:false}）。
   * 宿主注入自己的建档后，**所有实体类原语**（npcAtt/npcMet/npcBag/npcGold/
   * addEffect/removeEffect）都经它建档——注入点必须包含宿主的建档副作用
   * （如宿主的世界书关系种子投影：谁先调用谁才读得到关系网，投影必须在
   * 建档路径上一次完成，不能只覆盖对外的 npcEntry）。
   */
  entryOf?(s: W, id: string): EntityDynamic;
  /** 见闻录条目的时间戳（缺省空串）。宿主注入自己的历法格式化 */
  stamp?(s: W): string;
}

export function createMutate<W extends EngineWorldState>(need: () => W, opts: MutateOptions<W> = {}): KernelMutate<W> {
  function mutate(s: W): W {
    if (!s) throw new Error('WorldState 尚未初始化');
    return s;
  }

  function entryOf(s: W, id: string): EntityDynamic {
    if (opts.entryOf) return opts.entryOf(s, id);
    let dy = s.npcs[id];
    if (!dy) dy = s.npcs[id] = { att: 0, mem: [], met: false };
    return dy;
  }

  const api: KernelMutate<W> = {
    playerLoc(loc: string): void {
      mutate(need()).player.loc = loc;
    },

    playerFlag(name: string, value = true): void {
      mutate(need()).player.flags[name] = value;
    },

    playerBag(id: string, qty: number): boolean {
      const s = mutate(need());
      const bag: BagRow[] = s.player.bag;
      if (!qty) return false;
      if (qty > 0) {
        const it = bag.find((x) => x.id === id && !x.uid);
        if (it) it.qty += qty;
        else bag.push({ id, qty });
        return true;
      }
      const i = bag.findIndex((x) => x.id === id && !x.uid);
      if (i < 0) return false;
      bag[i].qty += qty;
      if (bag[i].qty <= 0) bag.splice(i, 1);
      return true;
    },

    npcEntry(id: string, s?: W): EntityDynamic {
      return entryOf(mutate(s ?? need()), id);
    },

    npcAtt(id: string, delta: number): { from: number; to: number } {
      const dy = entryOf(need(), id);
      const from = dy.att;
      dy.att = clamp(from + delta, -100, 100);
      return { from, to: dy.att };
    },

    npcMet(id: string, v = true): void {
      entryOf(need(), id).met = v;
    },

    npcBag(id: string, itemId: string, qty: number): boolean {
      const dy = entryOf(need(), id);
      const bag = (dy.bag = dy.bag ?? []);
      if (!qty) return false;
      if (qty > 0) {
        const it = bag.find((x) => x.id === itemId && !x.uid);
        if (it) it.qty += qty;
        else bag.push({ id: itemId, qty });
        return true;
      }
      const i = bag.findIndex((x) => x.id === itemId && !x.uid);
      if (i < 0) return false;
      bag[i].qty += qty;
      if (bag[i].qty <= 0) bag.splice(i, 1);
      return true;
    },

    npcGold(id: string, delta: number): number {
      if (!Number.isFinite(delta)) return 0;
      const dy = entryOf(need(), id);
      dy.gold = Math.max(0, (dy.gold ?? 0) + delta);
      return dy.gold;
    },

    rep(faction: string, delta: number): number {
      const s = mutate(need());
      if (!(faction in s.rep)) return 0;
      const before = s.rep[faction] || 0;
      s.rep[faction] = Math.max(-100, Math.min(100, before + delta));
      return s.rep[faction];
    },

    weather(w: string): void {
      mutate(need()).weather = w;
    },

    addEffect(owner: string, eff: StatusEffect): boolean {
      const s = mutate(need());
      const arr =
        owner === 'player'
          ? (s.player.effects = s.player.effects ?? [])
          : (entryOf(s, owner).effects = entryOf(s, owner).effects ?? []);
      const i = arr.findIndex((x) => x.id === eff.id);
      if (i >= 0) arr[i] = { ...arr[i], ...eff };
      else arr.push(eff);
      return true;
    },

    removeEffect(owner: string, id: string): boolean {
      const s = mutate(need());
      const arr = owner === 'player' ? s.player.effects : entryOf(s, owner).effects;
      if (!arr) return false;
      const i = arr.findIndex((x) => x.id === id);
      if (i < 0) return false;
      arr.splice(i, 1);
      return true;
    },

    pushLog(text: string, cls: LogCls = 'nar', s?: W): void {
      const state = mutate(s ?? need());
      const seq = (state.logSeq = (state.logSeq ?? 0) + 1);
      const entry: LogEntry = { t: opts.stamp?.(state) ?? '', text, cls, id: seq };
      state.log.push(entry);
      if (state.log.length > 70) state.log.shift();
    },

    appendRecap(text: string, upto: number, keep: number, s?: W): void {
      const state = mutate(s ?? need());
      const list = state.recap ?? (state.recap = []);
      list.push(text);
      if (list.length > keep) list.splice(0, list.length - keep);
      state.recapSeq = Math.max(state.recapSeq ?? 0, upto);
    },

    weaveLogs(seq: number, end: number, text: string, s?: W): boolean {
      const state = mutate(s ?? need());
      const arr = state.log || [];
      const i = arr.findIndex((e) => (e.id ?? 0) > seq);
      if (i < 0) return false;
      /* 本批的右边界：end 之后的第一条；找不到就是数组末尾 */
      const j = arr.findIndex((e) => (e.id ?? 0) > end);
      const del = j < 0 ? arr.length - i : j - i;
      if (del <= 0) return false;
      const batch = arr.slice(i, i + del);
      /* 玩家原话行**不参与替换**：它被织掉后玩家失去了「我说过什么」的锚点。
         正文插在区间头，保留的原话行按原顺序跟在后面。 */
      const kept = batch.filter((e) => e.cls === 'say' && e.text.startsWith('＞'));
      const first = batch[0];
      const id = (state.logSeq = (state.logSeq ?? 0) + 1);
      const woven: LogEntry = { t: first.t, text, cls: 'ai', id };
      arr.splice(i, del, ...kept, woven);
      return true;
    },
  };

  return api;
}

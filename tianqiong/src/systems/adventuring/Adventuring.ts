/* ============================================================
   卡 N1 · 冒险经济（世界书 §60–§63）
   —— 与 economy（玩家买卖）分区：这里管**宏观面**——各阶冒险者的投入产出与死亡率、
   社会阶层财富分布、各大陆产业与特产、地下城特殊兑换物。
   ============================================================ */
import raw from '@/data/world/adventuring.json';
import type { WorldState } from '@/types/world';
import { log } from '@/systems/character/Gains';
import { toast } from '@/events/EventBus';
import { GUILD_RANKS, guildRank } from '@/systems/quest/Guild';
import { confirmSheet } from '@/systems/character/Sheet';
import { formatMoney } from '@/systems/economy/Money';
import { mutate } from '@/world/WorldMutate';
import { need } from '@/world/WorldState';
import { addHistory } from '@/events/EventStore';

interface RoiRow { rank: string; invest: number; gain: number[]; margin: string; death: number }
interface WealthRow { band: string; pop: number; share: number; asset: string }
interface IndustryRow { main: string; exp: string; imp: string }
interface TokenDef { id: string; name: string; from: string; use: string }
const CFG = raw as unknown as {
  roi: RoiRow[]; wealth: WealthRow[]; industry: Record<string, IndustryRow>; tokens: TokenDef[];
};

export const roiTiers = (): RoiRow[] => CFG.roi ?? [];
export const wealthBands = (): WealthRow[] => CFG.wealth ?? [];
export const industryOf = (continent: string): IndustryRow | undefined => CFG.industry?.[continent];
export const tokenDefs = (): TokenDef[] => CFG.tokens ?? [];

/** 该阶冒险者的期望收益与死亡率（§62）：调遭遇与掉落时的参照 */
export function expectedReturn(rank: string): { invest: number; avg: number; death: number } | null {
  const r = roiTiers().find((x) => x.rank === rank);
  if (!r) return null;
  return { invest: r.invest, avg: Math.round((r.gain[0] + r.gain[1]) / 2), death: r.death };
}

/** §62 的口径：金币单位换算成铜（与全局记账一致） */
export function expectedReturnCopper(rank: string): { invest: number; avg: number } | null {
  const e = expectedReturn(rank);
  if (!e) return null;
  return { invest: e.invest * 10000, avg: e.avg * 10000 };
}

/** 玩家当前认证等级对应的期望（供面板显示"这一趟值不值"） */
export function playerReturn(s: WorldState = need()): { rank: string; invest: number; avg: number; death: number } | null {
  /* 两套命名空间：认证等级是 D/C/B/A/S（Guild.GUILD_RANKS 的权威阶序），
     roi 表用的是带「级」的档名，而且只统计到圣徒级（没有 S 行）。
     用**阶序**对齐（第 i 阶 ↔ 第 i 行），S 阶无可对之行时沿用最高档——与迁移前的行为一致；
     若改用名字匹配，S 会直接查空。此前这里手抄了一份 map，与权威表各写一份（审查 §公会等级）。 */
  const rows = roiTiers();
  if (!rows.length) return null;
  const idx = Math.min(Math.max(GUILD_RANKS.findIndex((r) => r.id === guildRank(s)), 0), rows.length - 1);
  const rank = rows[idx].rank;
  const e = expectedReturn(rank);
  return e ? { rank, ...e } : null;
}

/** 领取兑换物（§60）：本作把它们记成 flag + 计数，暂不做完整兑换商店 */
export function claimToken(tokenId: string, s: WorldState = need()): boolean {
  const t = tokenDefs().find((x) => x.id === tokenId);
  if (!t) return false;
  const key = 'tk_' + tokenId;
  /* core 必须自己拒重复：UI 把按钮置灰只是体验层，重复调用会重复记历史、重复弹「已领取」
     而物品只算一次（审查 §令牌）——与 Shop.buy 的 F-10 同一纪律。 */
  if (s.player.flags[key]) {
    toast('这枚令牌你已经领过了。', 'bad');
    return false;
  }
  mutate.playerFlag(key);
  log('你领到了一枚' + t.name + '——' + t.use + '时用得着。', 'gain', s);
  addHistory('获得' + t.name, t.from, 1);
  return true;
}

/* ============================================================
   卡 K3-UI · 冒险账本面板
   §62 的投入产出比、§63 的财富分布、§60 的地下城兑换物——这些是**参照系**，
   不进 UI 就只是数据表。面板把它们摊开，并给兑换物一个领取的入口。
   ============================================================ */

export function adventuringMenu(): void {
  const s = need();
  const v = adventuringView(s);
  const roi = v.roi
    .map((r) => r.rank + '：投入 ' + r.invest + ' 金　回收 ' + r.gain[0] + '–' + r.gain[1] + ' 金　死亡率 ' + Math.round(r.death * 100) + '%')
    .join('<br>');
  const wealth = v.wealth.map((w) => w.band + ' ' + w.pop + '% · 占财富 ' + w.share + '%').join('　·　');
  const btns: { l: string; a: string; id?: string; dg?: boolean }[] = v.tokens.map((t) => {
    const got = !!s.player.flags['tk_' + t.id];
    return { l: (got ? '（已领）' : '领取「') + t.name + (got ? '' : '」（' + t.from + '）'), a: 'ad_claim', id: t.id, dg: got };
  });
  btns.push({ l: '（退开）', a: 'close' });
  confirmSheet(
    '冒险经济 · 账本',
    planAdvice(s) + '<br><br><b>各阶投入产出（§62）</b><br>' + roi + '<br><br><b>财富分布（§63）</b><br>' + wealth,
    btns,
  );
}

export interface AdventuringView { roi: RoiRow[]; wealth: WealthRow[]; industry: Record<string, IndustryRow>; tokens: TokenDef[]; mine: ReturnType<typeof playerReturn> }
export function adventuringView(s: WorldState = need()): AdventuringView {
  return { roi: roiTiers(), wealth: wealthBands(), industry: CFG.industry ?? {}, tokens: tokenDefs(), mine: playerReturn(s) };
}

/** 面板用的一句式摘要（把 §62 的投入产出讲成人话） */
export function planAdvice(s: WorldState = need()): string {
  const m = playerReturn(s);
  if (!m) return '尚无认证记录——先去公会办一张冒险者证。';
  return '以你目前的认证（' + m.rank + '），一趟的常见投入约 ' + formatMoney(m.invest * 10000) +
    '，回收期望 ' + formatMoney(m.avg * 10000) + '，死亡率约 ' + Math.round(m.death * 100) + '%。';
}

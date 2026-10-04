/* ============================================================
   卡 R5 · 冒险者公会认证与规约（世界书 §23 / §91 / §104）
   —— 把「公会」从一个接任务的柜台，变成有等级、有抽成、有管辖边界的组织：
     · 认证等级 D/C/B/A/S ↔ 境界映射（§104 学院—公会—神殿三方关系的落点）
     · 抽成：公会委托抽 10%（§23），悬赏所得全归自己（§91 特权③）
     · 接单门槛：低于委托等级接不到（认证的存在意义）
     · 管辖：50 层以下归掘渊、与公会互认（§23 末条）
   铁律：本模块是纯判定 + 一处状态写入（认证等级存 s.player.guildRank——
        独立字段而非 flags，理由见 doCertify），不碰别的系统。
   ============================================================ */
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { toast } from '@/events/EventBus';
import { log } from '@/systems/character/Gains';
import { need } from '@/world/WorldState';
import { addHistory } from '@/events/EventStore';

export type GuildRank = 'D' | 'C' | 'B' | 'A' | 'S';

/** 认证等级 → 境界门槛（§104：公会认证 D/C/B/A/S ↔ 境界映射） */
export const GUILD_RANKS: { id: GuildRank; grade: string; minLevel: number; note: string }[] = [
  { id: 'D', grade: '见习', minLevel: 1, note: '新人，可接浅层委托' },
  { id: 'C', grade: '正式', minLevel: 3, note: '常规委托与护送' },
  { id: 'B', grade: '主教', minLevel: 4, note: '深层攻坚与要员护卫' },
  { id: 'A', grade: '圣徒', minLevel: 5, note: '高危讨伐与跨大陆任务' },
  { id: 'S', grade: '神阶', minLevel: 6, note: '传说级委托，公会亲自指派' },
];

/** 公会抽成比例（§23：抽成 10%） */
export const GUILD_CUT = 0.1;

/** 等级档定义 */
export const rankDef = (r: GuildRank) => GUILD_RANKS.find((x) => x.id === r) ?? GUILD_RANKS[0];

/** 由境界推出应有的认证等级（玩家没认证过时用它当默认值） */
export function rankByLevel(level: number): GuildRank {
  let cur: GuildRank = 'D';
  for (const r of GUILD_RANKS) if (level >= r.minLevel) cur = r.id;
  return cur;
}

/**
 * 当前认证等级。
 * 认证是**须主动取得**的资格（世界书 §104 把公会认证与学院学位、神殿祝福并列为三方资格之一），
 * 不是境界的别名——所以缺省就是最低档 D，靠 certify 往上办。
 * 踩坑记录：第一版写成「缺省按境界推算」，结果推出来的档位永远压着 certify 的下一档，
 * 认证功能变成死代码（Lv.3 已经"自动是 C 级"，谁还去办？）。
 */
export function guildRank(s: WorldState = need()): GuildRank {
  const f = (s.player as { guildRank?: string }).guildRank as GuildRank | undefined;
  return f && GUILD_RANKS.some((x) => x.id === f) ? (f as GuildRank) : 'D';
}

/**
 * 认证（晋升）：境界达标即可办，收一次性认证费。
 * 这是「公会认证」的唯一写入口，等级存 flag（存档兼容零成本）。
 */
export function certify(s: WorldState = need()): { ok: boolean; why: string; to?: GuildRank; fee?: number } {
  const cur = guildRank(s);
  const idx = GUILD_RANKS.findIndex((x) => x.id === cur);
  const next = GUILD_RANKS[idx + 1];
  if (!next) return { ok: false, why: '你已是最高认证（' + cur + ' 级）' };
  if (s.player.level < next.minLevel) {
    /* to 也要给出来：调用方（面板/菜单）要拿它显示"该办哪一档" */
    return { ok: false, why: '境界不足——认证 ' + next.id + ' 级需 Lv.' + next.minLevel + '（现为 Lv.' + s.player.level + '）', to: next.id };
  }
  const fee = 200 * next.minLevel * next.minLevel;
  if (s.player.gold < fee) return { ok: false, why: '认证费不足（需 ' + fee + ' 铜）', to: next.id, fee };
  return { ok: true, why: '', to: next.id, fee };
}

/** 认证落库（扣费 + 记账 + 留痕） */
export function doCertify(s: WorldState = need()): boolean {
  const r = certify(s);
  if (!r.ok) {
    toast('✖ ' + r.why, 'bad');
    return false;
  }
  // 费用扣减交给调用方（保持与 turnIn 同一记账口径）；这里只写等级与留痕
  /* 存独立字段而不是 flags：flags 是 boolean 语义（世界书里"是否发生过某事"），
     塞字符串进去是类型谎言，而且会让所有读 flags 的地方拿到一个"真值"却不知含义。 */
  (s.player as { guildRank?: string }).guildRank = r.to as string;
  toast('✦ 公会认证提升：' + r.to + ' 级（' + rankDef(r.to as GuildRank).note + '）', 'gain');
  log('公会的书记官在你的冒险者证上按下一枚新印——' + r.to + ' 级。', 'sys', s);
  addHistory('公会认证', '晋至 ' + r.to + ' 级', 2);
  return true;
}

/** 能否接这单委托（委托可声明 reqRank；缺省按 D 级） */
export function canAccept(questId: string, s: WorldState = need()): { ok: boolean; why: string } {
  const q = WB.quests[questId] as unknown as { reqRank?: GuildRank; name?: string } | undefined;
  if (!q) return { ok: false, why: '没有这单委托' };
  const need_ = q.reqRank;
  if (!need_) return { ok: true, why: '' };
  const have = guildRank(s);
  const oi = GUILD_RANKS.findIndex((x) => x.id === have);
  const ni = GUILD_RANKS.findIndex((x) => x.id === need_);
  if (oi >= ni) return { ok: true, why: '' };
  return { ok: false, why: '「' + (q.name || questId) + '」需 ' + need_ + ' 级认证（你为 ' + have + ' 级）' };
}

/**
 * 委托抽成（§23 抽 10%）。悬赏任务（bounty）不抽——那笔钱是雇主直接出的，
 * 公会不从中分账（§91 特权③「悬赏任务所得归自己」）。
 */
export function guildFee(gold: number, kind: 'commission' | 'bounty' = 'commission'): number {
  if (kind === 'bounty' || gold <= 0) return 0;
  return Math.round(gold * GUILD_CUT);
}

/** 一单委托的实收金额（总额 − 公会抽成）。测试与 UI 都从这里取，避免两处算法漂移。 */
export function questIncome(gold: number, questId: string): number {
  const q = WB.quests[questId] as unknown as { guildCut?: boolean } | undefined;
  if (!q?.guildCut) return gold;
  return gold - guildFee(gold, 'commission');
}

/* ---------------- 管辖边界（§23 末条 / §104 三方关系） ---------------- */

/** 该层归谁管：50 层以下归掘渊公会，以上归冒险者公会（两家互认） */
export function dungeonWarden(floor: number): 'deep' | 'guild' {
  return floor <= 50 ? 'deep' : 'guild';
}

/** 玩家能否进这一层（掘渊管辖段需要掘渊声望；公会段需公会认证） */
export function floorAccess(floor: number, s: WorldState = need()): { ok: boolean; why: string } {
  const ward = dungeonWarden(floor);
  if (ward === 'deep') {
    const rep = s.rep.deep ?? 0;
    if (rep < 0) return { ok: false, why: '掘渊的人不欢迎你（声望 ' + rep + '）——50 层以下归他们管' };
    return { ok: true, why: '' };
  }
  const g = guildRank(s);
  if (g === 'D' && floor > 60) return { ok: false, why: '深层需 C 级以上认证（现为 ' + g + ' 级）' };
  return { ok: true, why: '' };
}

/* ---------------- 视图 ---------------- */

export interface GuildView {
  rank: GuildRank;
  note: string;
  next: { id: GuildRank; minLevel: number; fee: number } | null;
  all: typeof GUILD_RANKS;
  cutPct: number;
}

export function guildView(s: WorldState = need()): GuildView {
  const cur = guildRank(s);
  const idx = GUILD_RANKS.findIndex((x) => x.id === cur);
  const next = GUILD_RANKS[idx + 1];
  return {
    rank: cur,
    note: rankDef(cur).note,
    next: next ? { id: next.id, minLevel: next.minLevel, fee: 200 * next.minLevel * next.minLevel } : null,
    all: GUILD_RANKS,
    cutPct: GUILD_CUT,
  };
}

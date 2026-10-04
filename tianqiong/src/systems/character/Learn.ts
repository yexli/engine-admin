/* ============================================================
   卡 R3 · 技能学习四通道（世界书 §44）
     师傅传授（主流）/ 技能书·卷轴（补充）/ 实战领悟（突破）/ 信仰神赐（特殊）
   —— 原来技能只有「按境界自动习得」一条路，本模块把其余三条接上引擎。
   铁律：四个入口都只读写 core 状态、都经同一套前置检查（canLearn），
   且**任何通道都不越职业线**——只能学自己职业 skillPath 里的技能。
   ============================================================ */
import { WB } from '@/data/worldBook';
import type { SkillDef, WorldState } from '@/types/world';
import { toast } from '@/events/EventBus';
import { log } from '@/systems/character/Gains';
import { need } from '@/world/WorldState';
import { addHistory } from '@/events/EventStore';

export type LearnWay = 'level' | 'mentor' | 'tome' | 'insight' | 'faith';

const WAY_NAME: Record<LearnWay, string> = {
  level: '境界自觉',
  mentor: '师傅传授',
  tome: '技能书',
  insight: '实战领悟',
  faith: '信仰神赐',
};

const skills = () => WB.skills as unknown as Record<string, SkillDef & { learn?: LearnWay[]; mentorHint?: string; insightHint?: string }>;

/** 技能声明的学习通道（缺省只有 level，保持旧档与旧数据的兼容） */
export function learnWays(skillId: string): LearnWay[] {
  const def = skills()[skillId];
  if (!def) return [];
  return def.learn && def.learn.length ? def.learn : ['level'];
}

/** 该技能能否经此通道学（通道可用 + 未学过 + 属于本职业线） */
export function canLearn(way: LearnWay, skillId: string, s: WorldState = need()): { ok: boolean; why: string } {
  const def = skills()[skillId];
  if (!def) return { ok: false, why: '没有这项技艺' };
  if (s.player.skills.includes(skillId)) return { ok: false, why: '你已会「' + def.name + '」' };
  if (!learnWays(skillId).includes(way)) return { ok: false, why: '「' + def.name + '」不经' + WAY_NAME[way] + '可得' };
  /* 越线保护：只能学本职业 skillPath 里的技能（§31 分支体系的边界） */
  const sp = WB.classes[s.player.cls]?.skillPath ?? [];
  if (!sp.includes(skillId)) return { ok: false, why: '「' + def.name + '」不在你的职业线上——换一条路得先转职' };
  return { ok: true, why: '' };
}

/** 学会（唯一写入口）：去重 + 通知 + 世界史留痕 */
export function grantSkill(skillId: string, way: LearnWay, s: WorldState = need()): boolean {
  const def = skills()[skillId];
  if (!def) return false;
  if (s.player.skills.includes(skillId)) return false;
  s.player.skills.push(skillId);
  toast('习得技能：' + def.name + '（' + WAY_NAME[way] + '）', 'gain');
  log('你把握住了「' + def.name + '」——' + WAY_NAME[way] + '的路子。', 'gain', s);
  addHistory('习得技能：' + def.name, WAY_NAME[way], 2);
  return true;
}

/* ---------------- 通道 ①：师傅传授（§44 主流方式） ---------------- */

/**
 * 师傅传授。门槛取「学费 + 境界差」：越阶的技艺师傅不教（防止跳过成长曲线）。
 * 费用按技能层数递增，走 gainGold 的既有记账口径（由调用方扣）。
 */
export function mentorLearn(skillId: string, s: WorldState = need()): { ok: boolean; why: string; fee: number } {
  const chk = canLearn('mentor', skillId, s);
  if (!chk.ok) return { ok: false, why: chk.why, fee: 0 };
  const def = skills()[skillId];
  const needLv = Math.max(1, (def.lv ?? 1) - 1); // 可以比自然习得早一阶，但要付学费
  if (s.player.level < needLv) return { ok: false, why: '境界不足——师傅不收连基础都没打稳的人（需 Lv.' + needLv + '）', fee: 0 };
  const fee = 400 * (def.lv ?? 1) * (def.lv ?? 1); // 1 阶 400 铜，6 阶 14400 铜
  if (s.player.gold < fee) return { ok: false, why: '束脩不够（需 ' + fee + ' 铜）', fee };
  return { ok: true, why: '', fee };
}

/* ---------------- 通道 ②：技能书 / 卷轴（§44 补充方式） ---------------- */

/** 某件物品能教什么（读 items[].teach）；不能教书返回 null */
export function tomeOf(itemId: string): string | null {
  const it = WB.items[itemId] as unknown as { teach?: string } | undefined;
  return it?.teach ?? null;
}

/** 读卷轴学艺的结果（不消耗物品——消耗由调用方决定，保持职责单一） */
export function readTome(itemId: string, s: WorldState = need()): { ok: boolean; why: string; skillId?: string } {
  const skillId = tomeOf(itemId);
  if (!skillId) return { ok: false, why: '这只是一份文献，不是技能书' };
  const chk = canLearn('tome', skillId, s);
  if (!chk.ok) return { ok: false, why: chk.why };
  return { ok: true, why: '', skillId };
}

/** 真正读进去（消耗物品 + 授技） */
export function studyTome(itemId: string, s: WorldState = need()): boolean {
  /* 卡 N1：没有 teach 字段的文献直接返回 false，不弹提示。
     文献本就不必是技能书（16 本地理与典籍类卷册里只有少数带技），
     对「这本书只是书」弹一条红字，等于告诉玩家他做错了什么——他没做错。
     真正学不了（已经学会 / 境界不足）才是需要提示的情况，那由下面的分支负责。 */
  if (!tomeOf(itemId)) return false;
  const r = readTome(itemId, s);
  if (!r.ok) {
    toast('✖ ' + r.why, 'bad');
    return false;
  }
  return grantSkill(r.skillId as string, 'tome', s);
}

/* ---------------- 通道 ③：实战领悟（§44 突破方式） ---------------- */

/** 每次实战胜利累加的领悟点（确定性：不掷骰，避免把战斗随机流搅乱） */
export const INSIGHT_PER_WIN = 4;

/**
 * 实战领悟：战斗胜利后累计领悟点，攒够阈值便从**本职业线的高阶技能**里
 * 挑一个尚未学会的授出。终局技能（lv≥5）因此不必靠读本，符合 §44「突破方式」。
 */
export function battleInsight(s: WorldState = need()): string | null {
  if (!s.insight) s.insight = { pts: 0, learned: [] };
  s.insight.pts += INSIGHT_PER_WIN;
  const need_ = 24; // 6 场胜利左右一次领悟
  if (s.insight.pts < need_) return null;
  const sp = WB.classes[s.player.cls]?.skillPath ?? [];
  const pool = sp.filter((id) => learnWays(id).includes('insight') && !s.player.skills.includes(id));
  if (!pool.length) {
    s.insight.pts = need_; // 已无可领悟者：把点数压在阈值上，转职后立刻能用
    return null;
  }
  /* 取本职业线里**最靠前未学**的那个：成长顺序不跳级 */
  const pick = pool.sort((a, b) => sp.indexOf(a) - sp.indexOf(b))[0];
  s.insight.pts -= need_;
  s.insight.learned.push(pick);
  grantSkill(pick, 'insight', s);
  return pick;
}

/* ---------------- 通道 ④：信仰神赐（§44 特殊方式） ---------------- */

/** 神赐的最低偏好门槛（低于此值神不理会） */
export const FAITH_NEED = 60;

/**
 * 信仰神赐：与该神偏好达标后，由神殿授出**本职业线中可经神赐**的技能。
 * 偏好门与技能门分开报错，玩家才知道该去祈祷还是该去练级。
 */
export function faithLearn(skillId: string, deityId: string, s: WorldState = need()): { ok: boolean; why: string } {
  const chk = canLearn('faith', skillId, s);
  if (!chk.ok) return chk;
  const favor = s.favor?.[deityId as keyof typeof s.favor]?.favor ?? 0;
  if (favor < FAITH_NEED) {
    return { ok: false, why: '神明尚未垂目（该神偏好 ' + Math.round(favor) + ' / ' + FAITH_NEED + '）' };
  }
  return { ok: true, why: '' };
}

/** 神赐落库（供神殿菜单调用；偏好消耗由调用方决定，本函数只管授技） */
export function divineGrant(skillId: string, deityId: string, s: WorldState = need()): boolean {
  const r = faithLearn(skillId, deityId, s);
  if (!r.ok) {
    toast('✖ ' + r.why, 'bad');
    return false;
  }
  grantSkill(skillId, 'faith', s);
  return true;
}

/* ---------------- 视图（供面板/菜单直读，零判定） ---------------- */

export interface LearnRow {
  id: string;
  name: string;
  lv: number;
  ways: LearnWay[];
  known: boolean;
  /** 本职业线里可学、但还没学的技能（按等级序） */
  learnable: boolean;
}

export function learnView(s: WorldState = need()): LearnRow[] {
  const sp = WB.classes[s.player.cls]?.skillPath ?? [];
  return sp
    .filter((id) => WB.skills[id])
    .map((id) => ({
      id,
      name: WB.skills[id].name,
      lv: WB.skills[id].lv ?? 1,
      ways: learnWays(id),
      known: s.player.skills.includes(id),
      learnable: !s.player.skills.includes(id),
    }))
    .sort((a, b) => a.lv - b.lv);
}

/** 通道中文名（供 UI 直出） */
export const wayName = (w: LearnWay): string => WAY_NAME[w];

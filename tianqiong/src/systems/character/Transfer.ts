/* ============================================================
   卡 D4 · 转职（世界书 §31 十九分支的解锁路径）
   —— 裁决：13 条 locked 分支「按等级解锁」。此前只做了数据层的 locked 标记，
   玩家没有任何路径走进去；本模块给出唯一入口：等级 + 试炼 + 费用三重门。
   铁律：转职**清空旧职业线的技能**（记入 transferLog 以便回溯），只授新职业同阶技能——
   否则多线技能会互相叠加，"职业"就失去了约束力。种族专属线由 R1 的 raceAllowsClass 把关。
   ============================================================ */
import { WB } from '@/data/worldBook';
import type { WorldState } from '@/types/world';
import { toast } from '@/events/EventBus';
import { gainExp, log } from '@/systems/character/Gains';
import { check } from '@/dice/CheckResolver';
import { raceAllowsClass } from '@/systems/character/Race';
import { need } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { addHistory } from '@/events/EventStore';

/** 转职门槛：等级 / 试炼 DC / 费用 */
export const TRANSFER_RULES = {
  minLevel: 4, // 世界书的分支是「进阶路线」，四级起才谈得上转
  baseDc: 14,
  fee: 12000, // 铜
  keepExpBonus: 60, // 转职给一笔经验，补偿重学的落差
};

export interface TransferCandidate {
  id: string;
  name: string;
  lineage: string;
  ultimate: string;
  locked: boolean;
  /** 门禁结果（缺什么） */
  blockers: string[];
  ok: boolean;
  fee: number;
}

/** 某条线对当前玩家是否可转（把全部前置一次列清，便于 UI 逐条显示） */
export function blockersOf(clsId: string, s: WorldState = need()): string[] {
  const def = WB.classes[clsId];
  if (!def) return ['没有这条职业线'];
  const out: string[] = [];
  if (clsId === s.player.cls) out.push('已是此线');
  if (s.player.level < TRANSFER_RULES.minLevel) out.push('境界不足（需 Lv.' + TRANSFER_RULES.minLevel + '）');
  if (!raceAllowsClass(s.player.race, clsId)) out.push('种族专属——' + (WB.races[s.player.race]?.name ?? '') + '不得转入');
  if (s.player.gold < TRANSFER_RULES.fee) out.push('转职费不足（需 ' + TRANSFER_RULES.fee + ' 铜）');
  if (WB.classes[clsId]?.locked) out.push('尚未开放（数据 locked）');
  return out;
}

/** 可转的分支清单（含不可转的原因） */
export function transferCandidates(s: WorldState = need()): TransferCandidate[] {
  return Object.keys(WB.classes).map((id) => {
    const def = WB.classes[id];
    const blockers = blockersOf(id, s);
    return {
      id,
      name: def.name,
      lineage: def.lineage ?? '',
      ultimate: (def.path ?? [])[(def.path ?? []).length - 1] ?? '',
      locked: !!def.locked,
      blockers,
      ok: blockers.length === 0,
      fee: TRANSFER_RULES.fee,
    };
  });
}

/**
 * 转职。三重门全过才走得通，试炼走 core 的 check（d20 + 属性），确定性可测。
 * 试炼属性取**新职业的主属性**：你想转过去，就得先证明你在这条路上站得住。
 */
export function transfer(clsId: string, s: WorldState = need()): boolean {
  const blockers = blockersOf(clsId, s);
  if (blockers.length) {
    toast('✖ 转不了：' + blockers.join('；'), 'bad');
    return false;
  }
  const def = WB.classes[clsId];
  const from = WB.classes[s.player.cls].name;
  /* 门禁与扣费之间隔着 1450ms 的检定演出（CheckResolver 走 scheduler.after）——
     回调里必须**重跑**一遍，否则这段时间里花掉的钱拦不住转职：mutate.payGold 会把
     余额夹到 0，于是 0 铜也能转职；连点两次则是两个回调都过门禁、二次扣费（审查 §转职）。
     重跑也天然挡住重复提交：第一次成功回调之后 cls 已变，blockersOf 会返回「已是此线」。 */
  check('转职试炼 · ' + def.name, def.main, TRANSFER_RULES.baseDc, (r) => {
    const again = blockersOf(clsId, s);
    if (again.length) {
      toast('✖ 转职中止：' + again.join('；'), 'bad');
      return;
    }
    if (!r.ok) {
      log('试炼未过——' + def.name + '的门槛没跨过去。路还在，只是今天不行。', 'bad', s);
      return;
    }
    /* 通过：清旧线技能 → 授新线同阶技能 → 换职业 */
    const oldPath = (WB.classes[s.player.cls].skillPath ?? []) as string[];
    const keep = s.player.skills.filter((id) => !oldPath.includes(id));
    const purged = s.player.skills.filter((id) => oldPath.includes(id));
    const newPath = (def.skillPath ?? []) as string[];
    const upTo = newPath.slice(0, Math.min(s.player.level, newPath.length));
    /* 三个字段一起走写入层（见 playerTransfer 的注释：不许只改一半） */
    mutate.playerTransfer(
      clsId,
      [...new Set([...keep, ...upTo])],
      purged.map((id) => WB.skills[id]?.name ?? id),
    );
    mutate.payGold(TRANSFER_RULES.fee);
    gainExp(TRANSFER_RULES.keepExpBonus);
    toast('✦ 转职成功：' + from + ' → ' + def.name, 'gain');
    log('你把旧的路数收进箱底，重新握起另一种活计——' + def.name + '。', 'nar', s);
    addHistory('转职', from + ' → ' + def.name, 4);
  });
  return blockers.length === 0;
}

/** 转职前的预览：会丢哪些技能、会得哪些技能（让玩家先看清代价） */
export function transferPreview(clsId: string, s: WorldState = need()): { lose: string[]; gain: string[] } {
  const oldPath = (WB.classes[s.player.cls].skillPath ?? []) as string[];
  const newPath = (WB.classes[clsId]?.skillPath ?? []) as string[];
  const lose = s.player.skills.filter((id) => oldPath.includes(id)).map((id) => WB.skills[id]?.name ?? id);
  const gain = newPath.slice(0, Math.min(s.player.level, newPath.length)).filter((id) => !s.player.skills.includes(id)).map((id) => WB.skills[id]?.name ?? id);
  return { lose, gain };
}

export interface TransferView {
  cur: { id: string; name: string; lineage: string };
  level: number;
  fee: number;
  minLevel: number;
  rows: TransferCandidate[];
}
export function transferView(s: WorldState = need()): TransferView {
  const cur = WB.classes[s.player.cls];
  return {
    cur: { id: s.player.cls, name: cur.name, lineage: cur.lineage ?? '' },
    level: s.player.level,
    fee: TRANSFER_RULES.fee,
    minLevel: TRANSFER_RULES.minLevel,
    rows: transferCandidates(s),
  };
}

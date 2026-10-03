/* ============================================================
   Proposal → Command 翻译（方案 §六：AI 影响力的确定性闸门；V2 策略围栏）
   ------------------------------------------------------------
   ProposedChange.action 必须命中内核白名单才能变成 WorldCommand；
   翻译不了的整条拒（rejectedBy='translate'），绝不猜测、绝不放行。
   白名单只收录**引擎内核规则认识**的命令——玩法语义（RPG/经济）
   由接入方经自己的规则挂载，游戏方可用 EvolutionPolicy 扩充/收紧。

   V2 双层围栏：
     translate（内核白名单）：动作引擎根本不认识 → 必拒
     policy（演化策略）：动作认识但第一阶段不允许（如创建/删除 NPC、
       修改玩家核心属性、推进时间）→ 拒，rejectedBy='policy'

   这是「AI 不得直接修改 World State」的结构实现之一：演化层对
   引擎的全部影响力 = 翻译出的 Command，经 HTTP 进引擎的 Rules 链；
   Rules 拒绝，变化就不存在。
   ============================================================ */
import type { EvolutionPolicy, ProposedChange } from './types.ts';

/** 翻译结果：command = 可进引擎的命令；拒绝时给 rejectedBy/reason */
export type TranslatedChange =
  | { ok: true; command: { type: string; actorId?: string; targetId?: string; amount?: number; text?: string; payload?: Record<string, unknown> } }
  | { ok: false; rejectedBy: 'translate' | 'policy'; reason: string };

/** 内核白名单：action → 命令 type（恒等；独立成表是为了校验与文档同一处真相） */
export const CORE_EVOLUTION_ACTIONS = [
  'move_entity',
  'update_attribute',
  'set_relation',
  'create_entity',
  'remove_entity',
  'advance_time',
  'change_weather',
] as const;

export type CoreEvolutionAction = (typeof CORE_EVOLUTION_ACTIONS)[number];

/** 缺省策略 = 内核全集（向后兼容：不传 policy 的既有调用面行为不变） */
export const FULL_CORE_POLICY: EvolutionPolicy = {
  allowedActions: CORE_EVOLUTION_ACTIONS,
  forbiddenActionsOnPlayer: [],
  maxChangesPerProposal: Number.MAX_SAFE_INTEGER,
  maxEntitiesAffected: Number.MAX_SAFE_INTEGER,
  cooldownMs: 0,
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** 单条 change → 命令（纯函数；不碰引擎）。载荷字段按内核规则的读取习惯取。 */
export function translateChange(change: ProposedChange, policy: EvolutionPolicy = FULL_CORE_POLICY): TranslatedChange {
  const p = change.payload ?? {};

  /* 第一道：策略围栏（动作认识但本阶段不允许 → 'policy'，语义比白名单更明确） */
  if (!policy.allowedActions.includes(change.action)) {
    if ((CORE_EVOLUTION_ACTIONS as readonly string[]).includes(change.action)) {
      return { ok: false, rejectedBy: 'policy', reason: `动作 '${change.action}' 在当前演化策略中被禁止（阶段围栏）` };
    }
    return { ok: false, rejectedBy: 'translate', reason: `动作 '${change.action}' 不在演化白名单中` };
  }
  if (change.targetId === 'player' && policy.forbiddenActionsOnPlayer.includes(change.action)) {
    return { ok: false, rejectedBy: 'policy', reason: `禁止对玩家核心属性执行 '${change.action}'（玩家权威归游戏，不归 AI）` };
  }

  /* 第二道：内核命令翻译 */
  switch (change.action) {
    case 'move_entity': {
      const location = str(p['location']) ?? str(p['to']);
      if (!location) return { ok: false, rejectedBy: 'translate', reason: 'move_entity 缺少 payload.location' };
      return { ok: true, command: { type: 'move_entity', targetId: change.targetId, payload: { location } } };
    }
    case 'update_attribute': {
      const key = str(p['key']);
      const value = p['value'];
      if (!key || !(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
        return { ok: false, rejectedBy: 'translate', reason: 'update_attribute 需要 payload.key 与基本类型 payload.value' };
      }
      /* 属性键级禁令（P5 · 方案 §八「禁止 AI 直接修改金币」）：对任何目标生效——
         经济/系统属性归游戏规则，AI 提案改了也会被围栏原样拒回 */
      if (policy.forbiddenAttributeKeys?.includes(key)) {
        return { ok: false, rejectedBy: 'policy', reason: `属性 '${key}' 归游戏经济/系统规则管，AI 不得直接修改（方案 §八）` };
      }
      return { ok: true, command: { type: 'update_attribute', targetId: change.targetId, payload: { key, value } } };
    }
    case 'set_relation': {
      const type = str(p['type']);
      if (!type) return { ok: false, rejectedBy: 'translate', reason: 'set_relation 缺少 payload.type' };
      const value = num(p['value']);
      return {
        ok: true,
        command: {
          type: 'set_relation',
          actorId: change.targetId,
          targetId: str(p['otherId']) ?? str(p['targetId']),
          payload: { type, ...(value !== undefined ? { value } : {}) },
        },
      };
    }
    case 'create_entity': {
      const id = str(p['id']);
      if (!id) return { ok: false, rejectedBy: 'translate', reason: 'create_entity 缺少 payload.id' };
      return {
        ok: true,
        command: {
          type: 'create_entity',
          payload: {
            id,
            ...(str(p['type']) !== undefined ? { type: str(p['type']) } : {}),
            ...(str(p['name']) !== undefined ? { name: str(p['name']) } : {}),
            ...(str(p['location']) !== undefined ? { location: str(p['location']) } : {}),
          },
        },
      };
    }
    case 'remove_entity': {
      if (!change.targetId || change.targetId === 'world') return { ok: false, rejectedBy: 'translate', reason: 'remove_entity 需要 targetId' };
      return { ok: true, command: { type: 'remove_entity', targetId: change.targetId } };
    }
    case 'advance_time': {
      const ticks = num(p['ticks']) ?? num(p['amount']);
      if (ticks === undefined || ticks < 1) return { ok: false, rejectedBy: 'translate', reason: 'advance_time 需要 payload.ticks ≥ 1' };
      return { ok: true, command: { type: 'advance_time', amount: Math.floor(ticks) } };
    }
    case 'change_weather': {
      const weather = str(p['weather']) ?? str(p['to']);
      if (!weather) return { ok: false, rejectedBy: 'translate', reason: 'change_weather 缺少 payload.weather' };
      return { ok: true, command: { type: 'change_weather', text: weather } };
    }
    default:
      return { ok: false, rejectedBy: 'translate', reason: `动作 '${change.action}' 不在演化白名单中` };
  }
}

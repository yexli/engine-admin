/* ============================================================
   骰子引擎（《插件化世界模拟架构方案》§9 / §10）
   —— 确定性规则层的唯一随机来源。铁律 §9：AI 不得生成骰子结果。
   与 CheckResolver（带演出的事件驱动检定）互补：
     DiceEngine 是纯函数计算层，CheckResolver 负责把结果演给玩家看。
   ============================================================ */
import { rng } from '@/events/EventBus';

export type CheckOutcome = 'critical_success' | 'success' | 'failure' | 'critical_failure';

export interface DiceSpec {
  count: number;
  faces: number;
}

/** 解析 '1d100' / '2d6' / '3d8' */
export function parseDice(spec: string): DiceSpec | null {
  const m = /^(\d{1,3})d(\d{1,4})$/.exec(spec.trim().toLowerCase());
  if (!m) return null;
  const count = Number(m[1]);
  const faces = Number(m[2]);
  if (count < 1 || count > 20 || faces < 2 || faces > 1000) return null;
  return { count, faces };
}

/** 掷骰明细（保留每一颗骰子，供演出与审计） */
export function rollDice(spec: DiceSpec): number[] {
  const out: number[] = [];
  for (let i = 0; i < spec.count; i++) out.push(1 + Math.floor(rng.next() * spec.faces));
  return out;
}

export function roll(spec: string): { spec: DiceSpec; rolls: number[]; total: number } | null {
  const parsed = parseDice(spec);
  if (!parsed) return null;
  const rolls = rollDice(parsed);
  return { spec: parsed, rolls, total: rolls.reduce((a, b) => a + b, 0) };
}

export interface CheckRequest {
  /** 检定类型（stealth / persuasion / …），用于日志与审计 */
  type: string;
  /** 行动者属性值 */
  attribute: number;
  /** 难度（Difficulty Class） */
  difficulty: number;
  /** 骰型，默认 '1d20'（与原型 check() 一致） */
  dice?: string;
  /** 数值修正 */
  modifier?: number;
  /** 环境修正：雨天 -1（对齐原型行为） */
  weather?: string;
  actor?: string;
  target?: string;
}

export interface CheckResult {
  type: string;
  attribute: number;
  dice: string;
  rolls: number[];
  roll: number;
  modifier: number;
  total: number;
  difficulty: number;
  result: CheckOutcome;
  /** 成功为正、失败为负的余量（§10 返回契约） */
  margin: number;
}

/**
 * 统一检定入口（§10 resolve_check）。
 * 判定次序与原型 check() 保持一致：自然满点必成；否则 total >= difficulty 为成功。
 */
export function resolveCheck(req: CheckRequest): CheckResult {
  const diceSpec = req.dice ?? '1d20';
  const parsed = parseDice(diceSpec);
  if (!parsed) throw new Error('骰型非法：' + diceSpec);
  const rolls = rollDice(parsed);
  const roll = rolls.reduce((a, b) => a + b, 0);
  const modifier = (req.modifier ?? 0) + (req.weather === '雨' ? -1 : 0);
  const total = roll + modifier;
  const natural = parsed.count === 1 ? roll : 0;

  let result: CheckOutcome;
  if (natural === parsed.faces) result = 'critical_success';
  else if (natural === 1) result = 'critical_failure';
  else result = total >= req.difficulty ? 'success' : 'failure';

  return {
    type: req.type,
    attribute: req.attribute,
    dice: diceSpec,
    rolls,
    roll,
    modifier,
    total,
    difficulty: req.difficulty,
    result,
    margin: total - req.difficulty,
  };
}

export const checkPassed = (r: CheckResult): boolean =>
  r.result === 'success' || r.result === 'critical_success';

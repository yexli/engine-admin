/* ============================================================
   内置规则装配（V1.0 · 方案 §5.3 兼容层）
   ------------------------------------------------------------
   createWorld 缺省装配 = Core 规则（coreRules）+ RPG 兼容规则
   （rpgCompatRules，§5.2 标注为 EXTENSION）。
   规则本体按归属分文件：coreRules.ts（Core）/ rpgCompat.ts
   （EXTENSION——战斗/社交/关系语义不进内核内置集的判定范围）。
   ============================================================ */
import type { WorldRule } from '../rules/Rules.ts';
import type { EngineWorldState } from '../types.ts';
import { coreRules } from '../rules/coreRules.ts';
import { rpgCompatRules } from '../rules/rpgCompat.ts';

/** 缺省内置规则集：Core 规则 + RPG 兼容规则（既有用例零改动） */
export function builtinRules<W extends EngineWorldState>(): WorldRule<W>[] {
  return [...coreRules<W>(), ...rpgCompatRules<W>()];
}

export {
  /* Core */
  moveRule,
  advanceTimeRule,
  changeWeatherRule,
  createEntityRule,
  removeEntityRule,
  updateAttributeRule,
  setRelationRule,
  moveEntityRule,
  coreRules,
} from '../rules/coreRules.ts';
export {
  /* EXTENSION（RPG 兼容） */
  attackRule,
  talkRule,
  setAttitudeRule,
  spawnEntityRule,
  rpgCompatRules,
} from '../rules/rpgCompat.ts';

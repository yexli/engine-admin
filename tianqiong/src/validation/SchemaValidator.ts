/* ============================================================
   计划结构校验（《插件化世界模拟架构方案》§16 / §42）
   —— 第一道闸：形状不对的计划一律拒绝执行，绝不「猜 AI 想做什么」。
   ============================================================ */
import type { ConsequenceAction, ConsequencePlan } from '@/execution/PlanSchema';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export type PlanCheck = { ok: true; plan: ConsequencePlan } | { ok: false; error: string };

function checkAction(raw: unknown, i: number): string | null {
  if (!isObj(raw)) return '第 ' + i + ' 条后果不是对象';
  if (!isStr(raw.action)) return '第 ' + i + ' 条后果缺少 action';
  for (const k of ['actor', 'target', 'reason', 'source', 'triggerEvent']) {
    if (raw[k] !== undefined && !isStr(raw[k])) return '第 ' + i + ' 条后果的 ' + k + ' 非字符串';
  }
  if (raw.params !== undefined && !isObj(raw.params)) return '第 ' + i + ' 条后果的 params 非对象';
  if (raw.priority !== undefined) {
    const p = raw.priority;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) return '第 ' + i + ' 条后果的 priority 越界';
  }
  return null;
}

/** 形状校验 + 归一化（priority 缺省视为 50，保持稳定排序） */
export function validatePlanShape(raw: unknown): PlanCheck {
  if (!isObj(raw)) return { ok: false, error: '计划不是对象' };
  if (!isStr(raw.planId)) return { ok: false, error: '计划缺少 planId' };
  if (!isStr(raw.triggerEvent)) return { ok: false, error: '计划缺少 triggerEvent' };
  if (!Array.isArray(raw.consequences)) return { ok: false, error: '计划缺少 consequences 数组' };
  if (raw.consequences.length === 0) return { ok: false, error: '计划不含任何后果' };
  if (raw.consequences.length > 32) return { ok: false, error: '计划后果条数超限（>32）' };
  if (raw.narrative !== undefined && typeof raw.narrative !== 'string') return { ok: false, error: 'narrative 非字符串' };

  const out: ConsequenceAction[] = [];
  for (let i = 0; i < raw.consequences.length; i++) {
    const why = checkAction(raw.consequences[i], i);
    if (why) return { ok: false, error: why };
    const a = raw.consequences[i] as ConsequenceAction;
    out.push({ ...a, priority: a.priority ?? 50 });
  }
  out.sort((x, y) => (y.priority ?? 50) - (x.priority ?? 50));
  return { ok: true, plan: { planId: raw.planId, triggerEvent: raw.triggerEvent, consequences: out, narrative: raw.narrative as string | undefined } };
}

/* ============================================================
   Consequence Planner（《插件化世界模拟架构方案》§15 / §26 / §42）
   —— 把 AI 输出收敛成严格 Consequence Plan。
   铁律 §42：解析失败 = 拒绝执行，绝不「猜 AI 想做什么」。
   铁律 §26：每条后果必须绑定 trigger_event / reason / source / target 依据。
   ============================================================ */
import { validatePlan } from '@/validation/RuleValidator';
import type { ConsequencePlan } from '@/execution/PlanSchema';
import type { ReasonerContext } from './ContextBuilder';

/**
 * 从模型自由文本中提取 JSON 计划（容忍 ```json 围栏与前后解释文字）。
 * 只认第一个完整的对象或数组片段；提取不到返回 null。
 */
const FENCE = '```';

export function extractJson(text: string): unknown | null {
  if (!text) return null;
  const fenced = new RegExp(FENCE + '(?:json)?\\s*([\\s\\S]*?)' + FENCE, 'i').exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  /* 逐字符括号配对：跳过字符串字面量，避免 reason 文案里的花括号打乱配对 */
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 解析 + 全量校验；任一步不过即返回 null（调用方据此放弃本次推演） */
export function planFrom(raw: unknown): ConsequencePlan | null {
  const v = validatePlan(raw);
  return v.ok ? v.plan : null;
}

export function planIdFor(triggerEventId: string): string {
  return 'plan_' + triggerEventId;
}

/**
 * 推演提示词（§42：自然语言解释 + 严格 JSON 计划）。
 * 只喂最小必要上下文与能力白名单，避免模型自由发挥出不存在的动作。
 */
export function plannerPrompt(ctx: ReasonerContext): string {
  const caps = ctx.capabilities.map((c) => '- ' + c.system + '：' + c.capabilities.join('、')).join('\n');
  const ents = ctx.entities
    .map((e) => {
      const extra = [e.att !== undefined ? '好感 ' + e.att : '', e.curLoc ? '位于 ' + e.curLoc : ''].filter(Boolean).join('，');
      return '- ' + e.id + '（' + e.kind + '：' + e.name + (extra ? '，' + extra : '') + '）';
    })
    .join('\n');
  const remembered = ctx.entities
    .filter((e) => e.memories?.length)
    .map((e) => e.name + ' 记得：\n' + e.memories!.join('\n'))
    .join('\n');
  const believes = ctx.entities
    .filter((e) => e.beliefs?.length)
    .map((e) => e.name + ' 相信：\n' + e.beliefs!.map((b) => '  · ' + b).join('\n'))
    .join('\n');
  const knows = ctx.entities
    .filter((e) => e.knows?.length)
    .map(
      (e) =>
        e.name +
        ' 知道：' +
        e.knows!.map((k) => k.type + (k.via === 'rumor' ? '（二手传闻，可能失真）' : '（亲眼所见）')).join('、'),
    )
    .join('\n');

  return [
    '你是世界推演器：根据已发生的事实，推导哪些实体可能受到何种影响、可能采取哪些合法行动。',
    '禁止发明剧情、禁止无依据的因果、禁止引用清单之外的实体或能力。',
    '重要：每条「知道」是那个实体的认知边界——不得让某个实体对自己不知道的事做出反应（这正是谣言与误会的来源）。',
    '',
    '触发事件：' + ctx.trigger.type + '（' + ctx.trigger.id + '，第 ' + ctx.trigger.day + ' 日，等级 L' + ctx.trigger.level + '）',
    ctx.trigger.cause ? '起因：' + ctx.trigger.cause : '',
    '地点：' + (ctx.trigger.location ?? ctx.location ?? '未知'),
    ctx.time ? '时间：' + ctx.time.month + ctx.time.date + ' 日 · ' + ctx.time.period + ' · ' + (ctx.time.weather ?? '') : '',
    '',
    '相关实体：',
    ents || '（无）',
    ctx.activeQuests.length ? '进行中的委托：' + ctx.activeQuests.join('、') : '',
    remembered ? '\n各角色记得的事：\n' + remembered : '',
    believes ? '\n各角色相信的事（行动动机来自这里，而不是世界真相）：\n' + believes : '',
    knows ? '\n各实体的认知边界（不等于世界真相）：\n' + knows : '',
    '',
    '可调用能力（只能从中选取 action）：',
    caps || '（无，直接返回空计划）',
    '',
    '只输出 JSON，形如：',
    '{"planId":"' + planIdFor(ctx.trigger.id) + '","triggerEvent":"' + ctx.trigger.id + '",',
    ' "narrative":"一句话解释推演依据",',
    ' "consequences":[{"action":"能力名","actor":"发起实体","target":"承受实体","source":"依据实体","reason":"因果依据","params":{},"priority":50}]}',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

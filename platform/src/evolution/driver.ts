/* ============================================================
   AI World Driver（方案 §四：Evolution Planner 的实现位）
   ------------------------------------------------------------
   网关驱动：上下文 → 提示词 → 能力路由 → 网关模型调用 → 解析出
   EvolutionProposal。模型只被要求「提出建议」，它拿不到任何状态
   写入口——它输出的每个字都只是提案材料，进不进世界由 Rules 说了算。

   脚本化驱动：测试/演示用的确定性假驱动——不联网、不猜，按脚本
   吐提案。它证明的是闭环纪律，不是模型智能。

   结构化输出纪律：模型回复必须是 JSON 提案。解析宽容（容忍 ```json
   围栏与前后闲话），校验严格（缺 reason/changes 或引用不存在的
   观察 ref 都算 invalid_proposal——坏提案宁可失败也不放行）。
   ============================================================ */
import type { Capability, GatewayClient } from '../types.ts';
import type { ModelRouter } from '../router/modelrouter.ts';
import { renderContextFacts } from './context.ts';
import { CORE_EVOLUTION_ACTIONS } from './commands.ts';
import { EvolutionDriverError, type EvolutionContext, type EvolutionDriver, type EvolutionProposal, type ProposedChange } from './types.ts';

/* ---------------- 网关驱动（真模型） ---------------- */

/** 网关驱动：上下文 → 能力路由 → 模型 → JSON 提案。
 *  capability 缺省 reasoning（世界推演是推理任务）。 */
export interface GatewayDriverDeps {
  gateway: GatewayClient;
  router: ModelRouter;
  maxChanges?: number;
  capability?: Capability;
}

export function gatewayDriver(deps: GatewayDriverDeps): EvolutionDriver {
  const capability = deps.capability ?? 'reasoning';
  const maxChanges = Math.max(1, Math.min(16, Math.floor(deps.maxChanges ?? 6)));
  return {
    name: `gateway:${capability}`,
    async propose(context: EvolutionContext): Promise<EvolutionProposal> {
      const selected = deps.router.select(capability);
      if (!selected) {
        throw new EvolutionDriverError(
          `能力 '${capability}' 未配置可用模型（primary/fallback 均缺失或冷却中）`,
          'model_unavailable',
        );
      }
      const facts = renderContextFacts(context);
      const system = [
        '你是世界演化驱动器（AI World Driver）。你观察一个世界的权威事实，提出「接下来世界可能发生什么」的建议。',
        '铁律：你只能建议，不能命令。你的每条建议都会被世界引擎的规则校验，非法建议会被拒绝。',
        '建议必须基于给出的事实，不得编造不存在的人/物/事件；observations 里只能引用给出的事实 id 或 "state"。',
        `输出一个 JSON 对象（不要输出 JSON 之外的任何文字），形状：`,
        `{"reason": "整体判断", "observations": [{"ref": "<事实id或state>", "kind": "event|state", "summary": "一句话"}],`,
        ` "changes": [{"targetId": "<实体id或player或world>", "action": "${CORE_EVOLUTION_ACTIONS.join('|')}", "payload": {}, "reason": "为什么"}],`,
        ` "confidence": 0~1}`,
        `changes 最多 ${maxChanges} 条。`,
      ].join('\n');
      const user = `<world-facts>\n${facts}\n</world-facts>\n请给出演化提案 JSON。`;

      let text: string | null = null;
      let lastError = '';
      for (const model of [selected.model, selected.usedFallback ? null : deps.router.route(capability).fallback]) {
        if (!model) continue;
        const res = await deps.gateway.chat(model, [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ]);
        if (res.ok) {
          text = res.text;
          break;
        }
        lastError = res.error;
      }
      if (text === null) {
        throw new EvolutionDriverError(`模型调用失败：${lastError || 'primary/fallback 均不可用'}`, 'model_unavailable');
      }
      const raw = extractJson(text);
      if (!raw) {
        throw new EvolutionDriverError('模型回复中没有可解析的 JSON 提案', 'invalid_proposal');
      }
      return normalizeProposal(raw, {
        id: `prop_${context.worldId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        worldId: context.worldId,
        model: selected.model,
        role: capability,
        maxChanges,
        knownEventIds: new Set(context.events.map((e) => e.id)),
      });
    },
  };
}

/* ---------------- 提案归一化与校验（脚本化驱动同用） ---------------- */

export interface NormalizeOptions {
  id: string;
  worldId: string;
  model?: string;
  role?: string;
  maxChanges?: number;
  /** 已知事件 id 集：observations 引用集外 id = 编造事实，直接判非法 */
  knownEventIds?: Set<string>;
}

/** 把模型/脚本给出的松散对象归一化成合法提案；结构不合法抛 EvolutionDriverError */
export function normalizeProposal(raw: unknown, opts: NormalizeOptions): EvolutionProposal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EvolutionDriverError('提案必须是 JSON 对象', 'invalid_proposal');
  }
  const r = raw as Record<string, unknown>;
  const reason = typeof r['reason'] === 'string' && r['reason'].trim() ? r['reason'].trim() : null;
  if (!reason) throw new EvolutionDriverError('提案缺少 reason（AI 的整体判断）', 'invalid_proposal');

  const rawChanges = r['changes'];
  if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
    throw new EvolutionDriverError('提案缺少非空 changes 数组', 'invalid_proposal');
  }
  const maxChanges = opts.maxChanges ?? 6;
  const changes: ProposedChange[] = [];
  for (const c of rawChanges.slice(0, maxChanges)) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new EvolutionDriverError('changes 条目必须是对象', 'invalid_proposal');
    }
    const cc = c as Record<string, unknown>;
    const targetId = typeof cc['targetId'] === 'string' ? cc['targetId'] : '';
    const action = typeof cc['action'] === 'string' ? cc['action'] : '';
    const changeReason = typeof cc['reason'] === 'string' ? cc['reason'] : '';
    if (!targetId || !action || !changeReason.trim()) {
      throw new EvolutionDriverError('change 缺少 targetId / action / reason', 'invalid_proposal');
    }
    changes.push({
      targetId,
      action,
      ...(cc['payload'] !== undefined && cc['payload'] !== null && typeof cc['payload'] === 'object' && !Array.isArray(cc['payload'])
        ? { payload: cc['payload'] as Record<string, unknown> }
        : {}),
      reason: changeReason.trim(),
    });
  }

  const known = opts.knownEventIds;
  const observations: EvolutionProposal['observations'] = [];
  const rawObs = r['observations'];
  if (rawObs !== undefined && !Array.isArray(rawObs)) {
    throw new EvolutionDriverError('observations 必须是数组', 'invalid_proposal');
  }
  for (const o of (rawObs ?? []) as unknown[]) {
    if (!o || typeof o !== 'object') continue;
    const oo = o as Record<string, unknown>;
    const ref = typeof oo['ref'] === 'string' ? oo['ref'] : '';
    if (!ref) continue;
    const kind = oo['kind'] === 'state' || ref === 'state' ? 'state' : 'event';
    if (kind === 'event' && known && !known.has(ref)) {
      throw new EvolutionDriverError(`提案引用了不存在的观察 ref：'${ref}'（编造事实）`, 'invalid_proposal');
    }
    observations.push({
      ref,
      kind,
      ...(typeof oo['summary'] === 'string' ? { summary: (oo['summary'] as string).slice(0, 200) } : { summary: '' }),
    });
  }

  const confidence = typeof r['confidence'] === 'number' && r['confidence'] >= 0 && r['confidence'] <= 1 ? r['confidence'] : undefined;
  return {
    id: opts.id,
    worldId: opts.worldId,
    reason,
    observations,
    changes,
    ...(confidence !== undefined ? { confidence } : {}),
    source: { type: 'ai', ...(opts.model ? { model: opts.model } : {}), ...(opts.role ? { role: opts.role } : {}) },
  };
}

/** 宽容取 JSON：容忍 ```json 围栏与前后闲话；取第一个平衡的 JSON 对象 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1]!, text] : [text];
  for (const c of candidates) {
    const start = c.indexOf('{');
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/* ---------------- 脚本化驱动（测试 / 演示的确定性假 AI） ---------------- */

export interface ScriptStep {
  /** 按调用顺序吐提案；脚本耗尽后抛错（测试会立刻暴露超预期调用） */
  reason: string;
  observations?: { ref: string; kind?: 'event' | 'state'; summary?: string }[];
  changes: ProposedChange[];
  confidence?: number;
}

export function createScriptedDriver(steps: ScriptStep[]): EvolutionDriver {
  let i = 0;
  return {
    name: 'scripted',
    async propose(context: EvolutionContext): Promise<EvolutionProposal> {
      const step = steps[i++];
      if (!step) throw new EvolutionDriverError('脚本化驱动已耗尽（演化调用超出脚本预期）', 'driver_error');
      const known = new Set(context.events.map((e) => e.id));
      for (const o of step.observations ?? []) {
        if (o.kind !== 'state' && o.ref && !known.has(o.ref)) {
          throw new EvolutionDriverError(`脚本引用了不存在的事件 id：${o.ref}`, 'driver_error');
        }
      }
      return {
        id: `prop_${context.worldId}_${i}`,
        worldId: context.worldId,
        reason: step.reason,
        observations: (step.observations ?? []).map((o) => ({
          ref: o.ref,
          kind: o.kind ?? 'event',
          summary: o.summary ?? '',
        })),
        changes: step.changes,
        ...(step.confidence !== undefined ? { confidence: step.confidence } : {}),
        source: { type: 'ai', model: 'scripted', role: 'world_reasoning' },
      };
    },
  };
}

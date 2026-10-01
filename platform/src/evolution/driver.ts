/* ============================================================
   AI World Driver（方案 §四：Evolution Planner 的实现位；V2 行为修正）
   ------------------------------------------------------------
   网关驱动：上下文 → 提示词 → 能力路由 → 网关模型调用 → 解析出
   EvolutionProposal。模型只被要求「提出建议」，它拿不到任何状态
   写入口——它输出的每个字都只是提案材料，进不进世界由 Rules 说了算。

   V2 修正（方案 §四：修复「自由行动强制米露回复」）：
     · 提示词明确告知：玩家行动 ≠ NPC 必须响应。玩家进酒馆，米露
       可以注意也可以没注意；玩家与老板聊天，米露可以继续自己的事。
     · changes 允许为空——「什么都不发生」是合法且常见的判断结果，
       运行时按 completed 落账，不视为失败，绝不为了"让 NPC 活起来"
       而强迫提案。
     · 动作清单来自 EvolutionPolicy（第一阶段只有 update_attribute /
       set_relation / move_entity），禁止项写进提示词。

   脚本化驱动：测试/演示用的确定性假驱动——不联网、不猜，按脚本
   吐提案。它证明的是闭环纪律，不是模型智能。

   结构化输出纪律：模型回复必须是 JSON 提案。解析宽容（容忍 ```json
   围栏与前后闲话），校验严格（缺 reason 或引用不存在的观察 ref 都算
   invalid_proposal——坏提案宁可失败也不放行；changes 空数组合法）。
   ============================================================ */
import type { Capability, GatewayClient } from '../types.ts';
import type { ModelRouter } from '../router/modelrouter.ts';
import { renderContextFacts } from './context.ts';
import { createHash } from 'node:crypto';
import { EvolutionDriverError, type EvolutionContext, type EvolutionDriver, type EvolutionPolicy, type EvolutionProposal, type ProposedChange } from './types.ts';
import { NPC_EVOLUTION_POLICY } from './types.ts';

/* ---------------- 网关驱动（真模型） ---------------- */

/** 网关驱动：上下文 → 能力路由 → 模型 → JSON 提案。
 *  capability 缺省 reasoning（世界推演是推理任务）；policy 决定提示词里
 *  的动作清单与围栏（缺省第一阶段 NPC 演化策略）。 */
export interface GatewayDriverDeps {
  gateway: GatewayClient;
  router: ModelRouter;
  maxChanges?: number;
  capability?: Capability;
  policy?: EvolutionPolicy;
}

export function gatewayDriver(deps: GatewayDriverDeps): EvolutionDriver {
  const capability = deps.capability ?? 'reasoning';
  const policy = deps.policy ?? NPC_EVOLUTION_POLICY;
  const maxChanges = Math.max(1, Math.min(16, Math.floor(deps.maxChanges ?? policy.maxChangesPerProposal)));
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
        '你是世界演化驱动器（AI World Driver）。你观察一个世界的权威事实，判断「接下来世界可能发生什么」。'
        ,
        '核心纪律：',
        '1. 玩家行动不等于 NPC 必须响应。玩家进入 NPC 所在地点，NPC 可能注意、也可能没注意；'
        + '玩家与别人交谈时，NPC 可以继续自己的事情。不要为了让世界"热闹"而编造反应。',
        '2. 你只能建议，不能命令。你的每条建议都会被世界引擎的规则与策略校验，非法建议会被拒绝。',
        '3. 如果结论是「此刻什么都不该发生」，返回空的 changes 数组——这是完全合法、且常常正确的答案。',
        '4. 建议必须基于给出的事实，不得编造不存在的人/物/事件；observations 里只能引用给出的事实 id 或 "state"。',
        '5. 你只能影响"在场实体"的细节；名册里的实体只用于理解世界，不要对它们提建议。',
        `6. 允许的动作只有：${policy.allowedActions.join(' / ')}。`
        + (policy.forbiddenActionsOnPlayer.length ? ` 禁止对玩家（targetId='player'）执行：${policy.forbiddenActionsOnPlayer.join(' / ')}——玩家属性归游戏管，不归你管。` : ''),
        '输出一个 JSON 对象（不要输出 JSON 之外的任何文字），形状：',
        '{"reason": "整体判断（为什么发生/为什么不发生）", "observations": [{"ref": "<事实id或state>", "kind": "event|state", "summary": "一句话"}],',
        ` "changes": [{"targetId": "<在场实体id>", "action": "<允许的动作>", "payload": {}, "reason": "为什么"}],`,
        ' "confidence": 0~1}',
        `changes 最多 ${maxChanges} 条，可以为空。`,
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

/** 把模型/脚本给出的松散对象归一化成合法提案；结构不合法抛 EvolutionDriverError。
 *  V2：changes 允许为空（AI 判断不发生任何事 = 合法结论）。 */
export function normalizeProposal(raw: unknown, opts: NormalizeOptions): EvolutionProposal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EvolutionDriverError('提案必须是 JSON 对象', 'invalid_proposal');
  }
  const r = raw as Record<string, unknown>;
  const reason = typeof r['reason'] === 'string' && r['reason'].trim() ? r['reason'].trim() : null;
  if (!reason) throw new EvolutionDriverError('提案缺少 reason（AI 的整体判断）', 'invalid_proposal');

  const rawChanges = r['changes'];
  if (!Array.isArray(rawChanges)) {
    throw new EvolutionDriverError('提案缺少 changes 数组（可以为空数组）', 'invalid_proposal');
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
      ...(typeof cc['changeId'] === 'string' && (cc['changeId'] as string).length <= 64 ? { changeId: cc['changeId'] as string } : {}),
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

/** 提案幂等指纹：同一世界内「相同判断 + 相同变化集」= 同一提案。
 *  用于防止 AI 重复提交相同 Proposal 导致重复 Mutation（方案 §二.3）。 */
export function proposalKey(worldId: string, proposal: EvolutionProposal): string {
  const norm = {
    worldId,
    reason: proposal.reason,
    observations: [...proposal.observations].map((o) => `${o.kind}:${o.ref}`).sort(),
    changes: proposal.changes.map((c) => ({
      t: c.targetId,
      a: c.action,
      p: JSON.stringify(c.payload ?? {}, Object.keys(c.payload ?? {}).sort()),
      r: c.reason,
    })),
  };
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 32);
}

/* ---------------- 脚本化驱动（测试 / 演示的确定性假 AI） ---------------- */

export interface ScriptStep {
  /** 按调用顺序吐提案；脚本耗尽后抛错（测试会立刻暴露超预期调用）。
   *  changes 允许为空——脚本同样可以判断「什么都不发生」。 */
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
        id: `prop_${context.worldId}_${i}_${Math.random().toString(36).slice(2, 8)}`,
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


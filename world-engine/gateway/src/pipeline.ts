/* ============================================================
   Multi-Model 编排管线（V0.7 · 方案 §65 角色图运行时化）
   ------------------------------------------------------------
   一轮任务 → 多模型按角色协作：节点 = 一次「V0.6 路由 + 出站调用」，
   DAG 描述**数据化**（JSON），本文件只跑描述——加一条协作流不改代码。

   四条纪律（路线图 W7.1–W7.4）：
   · 阶段间契约：上游产出经模板 {{nodeId}} 注入下游；output:'json'
     的节点产出必须可解析，否则该节点按失败处理（W7.2）；
   · 失败隔离：节点失败/降级只影响下游（级联跳过），兄弟分支照常跑；
     optional 节点失败不计入管线失败（W7.3）；
   · 预算熔断：deadlineMs 全管线时延上限 + maxCalls 调用次数上限，
     超限后剩余节点按『预算』降级，已产出照常交付（W7.4）；
   · AI 三禁：管线产出只是**建议**——对世界的影响永远由宿主把它
     变成 Command 后经引擎落地（§15/§45；本文件没有 mutate 可拿）。
   ============================================================ */
import type { ModelRouter } from './router.ts';
import { remoteChat } from './remote.ts';

/* ---------------- 管线描述（数据化） ---------------- */

export interface PipelineNodeSpec {
  /** 节点 id：[A-Za-z0-9_-]+（模板里以 {{id}} 引用，故不许带点） */
  id: string;
  /** §65 角色（经 V0.6 路由选模型） */
  role: string;
  /** 上游节点 id（DAG 依赖；缺省 = 无依赖，与根节点同层并行） */
  dependsOn?: string[];
  /** 系统提示（模板语法同 user） */
  system?: string;
  /** 用户提示模板：{{input.x}} 引用入参、{{nodeId}} 引用上游产出 */
  user: string;
  /** 输出契约：text（缺省）原样透传；json 必须可解析，否则节点失败 */
  output?: 'text' | 'json';
  /** 可选节点：失败不判管线失败（其下游照常级联跳过） */
  optional?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface PipelineSpec {
  id: string;
  nodes: PipelineNodeSpec[];
  /** 全管线时延预算（毫秒，W7.4）；超限后未启动的节点按『预算』降级 */
  deadlineMs?: number;
}

export class PipelineSpecError extends Error {
  constructor(message: string) {
    super('管线描述错误：' + message);
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 描述 fail-fast 校验：id 合法且唯一、依赖存在、无环、规模封顶（W7.1） */
export function parsePipelineSpec(json: unknown): PipelineSpec {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new PipelineSpecError('描述必须是一个对象 { id, nodes: [...] }');
  }
  const root = json as Record<string, unknown>;
  const id = typeof root['id'] === 'string' && ID_RE.test(root['id']) ? root['id'] : null;
  if (!id) throw new PipelineSpecError('id 必须是 1-64 位 [A-Za-z0-9_-]');
  if (!Array.isArray(root['nodes']) || root['nodes'].length === 0 || root['nodes'].length > 32) {
    throw new PipelineSpecError('nodes 必须是 1-32 个节点的数组');
  }
  const nodes: PipelineNodeSpec[] = root['nodes'].map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PipelineSpecError(`nodes[${i}] 必须是对象`);
    const b = raw as Record<string, unknown>;
    const nid = typeof b['id'] === 'string' && ID_RE.test(b['id']) ? b['id'] : null;
    if (!nid) throw new PipelineSpecError(`nodes[${i}].id 必须是 1-64 位 [A-Za-z0-9_-]`);
    const role = typeof b['role'] === 'string' && b['role'].length > 0 && b['role'].length <= 64 ? b['role'] : null;
    if (!role) throw new PipelineSpecError(`nodes[${i}].role 必须是 1-64 字符`);
    if (typeof b['user'] !== 'string' || b['user'].length === 0 || b['user'].length > 100_000) {
      throw new PipelineSpecError(`nodes[${i}].user 必须是 1-100k 字符的模板`);
    }
    if (b['system'] !== undefined && (typeof b['system'] !== 'string' || b['system'].length > 100_000)) {
      throw new PipelineSpecError(`nodes[${i}].system 超 100k 字符`);
    }
    if (b['output'] !== undefined && b['output'] !== 'text' && b['output'] !== 'json') {
      throw new PipelineSpecError(`nodes[${i}].output 只接受 'text' | 'json'`);
    }
    const out: PipelineNodeSpec = {
      id: nid,
      role,
      user: b['user'],
      output: b['output'] as 'text' | 'json' | undefined,
      optional: b['optional'] === true,
    };
    if (b['system'] !== undefined) out.system = b['system'] as string;
    if (b['dependsOn'] !== undefined) {
      if (!Array.isArray(b['dependsOn']) || b['dependsOn'].length > 8 || (b['dependsOn'] as unknown[]).some((d) => typeof d !== 'string' || !ID_RE.test(d as string))) {
        throw new PipelineSpecError(`nodes[${i}].dependsOn 必须是 ≤8 个节点 id 的数组`);
      }
      out.dependsOn = b['dependsOn'] as string[];
    }
    if (b['temperature'] !== undefined) {
      if (typeof b['temperature'] !== 'number' || !Number.isFinite(b['temperature'])) throw new PipelineSpecError(`nodes[${i}].temperature 必须是数字`);
      out.temperature = b['temperature'];
    }
    if (b['maxTokens'] !== undefined) {
      if (typeof b['maxTokens'] !== 'number' || !Number.isFinite(b['maxTokens']) || b['maxTokens'] < 1) throw new PipelineSpecError(`nodes[${i}].maxTokens 必须是正数`);
      out.maxTokens = b['maxTokens'];
    }
    return out;
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new PipelineSpecError('节点 id 重复');

  /* 依赖存在 + 无环（DFS 三色） */
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(nodes.map((n) => [n.id, WHITE]));
  const visit = (nid: string, stack: string[]): void => {
    color.set(nid, GRAY);
    for (const dep of byId.get(nid)!.dependsOn ?? []) {
      if (!byId.has(dep)) throw new PipelineSpecError(`节点 ${nid} 依赖不存在的节点 ${dep}`);
      if (color.get(dep) === GRAY) throw new PipelineSpecError(`依赖成环：${[...stack, nid, dep].join(' → ')}`);
      if (color.get(dep) === WHITE) visit(dep, [...stack, nid]);
    }
    color.set(nid, BLACK);
  };
  for (const n of nodes) if (color.get(n.id) === WHITE) visit(n.id, []);

  const spec: PipelineSpec = { id, nodes };
  if (root['deadlineMs'] !== undefined) {
    if (typeof root['deadlineMs'] !== 'number' || !Number.isFinite(root['deadlineMs']) || root['deadlineMs'] < 1) {
      throw new PipelineSpecError('deadlineMs 必须是正数（毫秒）');
    }
    spec.deadlineMs = root['deadlineMs'];
  }
  return spec;
}

/* ---------------- 运行结果（W7.2 阶段契约） ---------------- */

export interface NodeTrace {
  id: string;
  role: string;
  ok: boolean;
  modelId?: string;
  ms: number;
  why?: string;
}

export interface PipelineResult {
  /** 全部必需节点产出成功 */
  ok: boolean;
  /** 各成功节点的文本产出（id → text） */
  outputs: Record<string, string>;
  /** output:'json' 节点的解析产物（id → 对象） */
  json: Record<string, unknown>;
  /** 降级/跳过的节点与原因（W7.3） */
  degraded: { id: string; why: string }[];
  /** 逐节点轨迹（W6.5 可观测延伸） */
  trace: NodeTrace[];
  /** 是否因时延预算截断（W7.4） */
  timedOut: boolean;
}

/* ---------------- 运行器 ---------------- */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

function fillTemplate(tpl: string, nodeOutputs: Map<string, string>, input: Record<string, string>): string {
  return tpl.replace(PLACEHOLDER, (whole, ref: string) => {
    if (ref.startsWith('input.')) {
      const v = input[ref.slice(6)];
      return v === undefined ? whole : v;
    }
    const out = nodeOutputs.get(ref);
    return out === undefined ? whole : out;
  });
}

export interface PipelineOptions {
  /** 出站超时（毫秒，单节点） */
  timeoutMs?: number;
  /** 全管线模型调用次数上限（W7.4；缺省 = 节点数） */
  maxCalls?: number;
}

export function createPipeline(spec: PipelineSpec, router: ModelRouter, opts: PipelineOptions = {}): {
  run(input?: Record<string, string>): Promise<PipelineResult>;
} {
  const maxCalls = opts.maxCalls ?? spec.nodes.length;

  async function run(input: Record<string, string> = {}): Promise<PipelineResult> {
    const startedAt = Date.now();
    const outputs = new Map<string, string>();
    const json: Record<string, unknown> = {};
    const degraded: { id: string; why: string }[] = [];
    const trace: NodeTrace[] = [];
    let calls = 0;
    let timedOut = false;
    const deadline = spec.deadlineMs ? startedAt + spec.deadlineMs : Infinity;

    /* 拓扑分层：依赖全在上层的那批先跑，同层并行 */
    const done = new Set<string>();
    const pending = new Set(spec.nodes.map((n) => n.id));
    const byId = new Map(spec.nodes.map((n) => [n.id, n]));
    let requiredFailed = false;

    while (pending.size) {
      const layer = spec.nodes.filter((n) => pending.has(n.id) && (n.dependsOn ?? []).every((d) => done.has(d) || !byId.has(d)));
      if (!layer.length) break; // parsePipelineSpec 已挡环，理论不可达
      const results = await Promise.allSettled(
        layer.map(async (node) => {
          const t0 = Date.now();
          /* 预算熔断（W7.4）：时延或调用数超限 → 本节点按预算降级 */
          if (Date.now() >= deadline) {
            return { node, ok: false as const, why: '时延预算已用尽（deadlineMs）', modelId: undefined, text: undefined, ms: 0 };
          }
          if (calls >= maxCalls) {
            return { node, ok: false as const, why: '调用预算已用尽（maxCalls）', modelId: undefined, text: undefined, ms: 0 };
          }
          /* 上游完整性：依赖有未产出 → 级联跳过（W7.3） */
          const missing = (node.dependsOn ?? []).filter((d) => !outputs.has(d));
          if (missing.length) {
            return { node, ok: false as const, why: `上游未产出：${missing.join(', ')}`, modelId: undefined, text: undefined, ms: 0 };
          }
          const hit = router.route(node.role);
          if (!hit) {
            return { node, ok: false as const, why: `角色 '${node.role}' 无可用路由（回退宿主缺省）`, modelId: undefined, text: undefined, ms: 0 };
          }
          calls++;
          try {
            const user = fillTemplate(node.user, outputs, input);
            const messages = [
              ...(node.system ? [{ role: 'system' as const, content: fillTemplate(node.system, outputs, input) }] : []),
              { role: 'user' as const, content: user },
            ];
            const text = await remoteChat(hit.model, hit.apiKey, messages, {
              temperature: node.temperature,
              maxTokens: node.maxTokens,
              timeoutMs: opts.timeoutMs,
            });
            if (node.output === 'json') {
              try {
                json[node.id] = JSON.parse(text.text);
              } catch {
                return { node, ok: false as const, why: '输出不是合法 JSON（output:json 契约）', modelId: hit.model.id, text: text.text, ms: Date.now() - t0 };
              }
            }
            return { node, ok: true as const, why: undefined, modelId: hit.model.id, text: text.text, ms: Date.now() - t0 };
          } catch (e) {
            /* W7.3 失败隔离：远端错误只降级本节点（兄弟照常），由外层统一记账 */
            return { node, ok: false as const, why: e instanceof Error ? e.message : String(e), modelId: hit.model.id, text: undefined, ms: Date.now() - t0 };
          }
        }),
      );

      for (const r of results) {
        if (r.status !== 'fulfilled') continue; // 内层已捕获业务异常；此处兜底编程错误
        const { node, ok, why, modelId, text, ms } = r.value;
        trace.push({ id: node.id, role: node.role, ok, modelId, ms, why });
        if (ok && text !== undefined) {
          outputs.set(node.id, text);
        } else {
          degraded.push({ id: node.id, why: why ?? '未知原因' });
          if (Date.now() >= deadline) timedOut = true;
          if (!node.optional) requiredFailed = true;
        }
        done.add(node.id);
        pending.delete(node.id);
      }
    }

    return {
      ok: !requiredFailed,
      outputs: Object.fromEntries(outputs),
      json,
      degraded,
      trace,
      timedOut,
    };
  }

  return { run };
}

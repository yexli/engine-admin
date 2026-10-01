/** AI Gateway：管线（M2.3 起接真：只读展示 + 有界试跑，编辑器明确不做）
 *  数据源：data/pipelines.json（平台 PipelineStore，经 gateway V0.7
 *  parsePipelineSpec 校验）；试跑经受管配置的网关标签路由真实执行，
 *  时延 ≤30s / 调用数 ≤32 硬性封顶，出站校验未过的模型被剔除并留痕。
 */
import { http } from "@/utils/http";

/** 节点 = 一次「路由 + 出站调用」（gateway V0.7 PipelineNodeSpec） */
export interface PipelineNode {
  id: string;
  role: string;
  dependsOn?: string[];
  system?: string;
  user: string;
  output?: "text" | "json";
  optional?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface PipelineRow {
  id: string;
  description: string | null;
  enabled: boolean;
  deadlineMs: number | null;
  nodes: PipelineNode[];
}

export interface PipelineList {
  pipelines: PipelineRow[];
}

export const listPipelines = () => {
  return http.request<PipelineList>("get", "/control-api/v1/admin/pipelines");
};

/* ---------------- 有界试跑 ---------------- */

export interface NodeTrace {
  id: string;
  role: string;
  ok: boolean;
  modelId?: string;
  ms: number;
  why?: string;
}

export interface PipelineRunResult {
  ok: boolean;
  outputs: Record<string, string>;
  json: Record<string, unknown>;
  degraded: { id: string; why: string }[];
  trace: NodeTrace[];
  timedOut: boolean;
}

export interface PipelineTestResponse {
  ok: boolean;
  elapsedMs: number;
  timedOut: boolean;
  result: PipelineRunResult;
  excludedModels: { id: string; why: string }[];
}

export const testPipeline = (
  id: string,
  data: { input?: Record<string, string>; deadlineMs?: number; maxCalls?: number } = {}
) => {
  return http.request<PipelineTestResponse>(
    "post",
    `/control-api/v1/admin/pipelines/${encodeURIComponent(id)}/test`,
    { data }
  );
};

/* ---------------- 展示辅助 ---------------- */

/** 从模板抽取 {{input.x}} 入参键（生成试跑表单；user+system 去重） */
export function inputKeysOf(row: PipelineRow): string[] {
  const keys = new Set<string>();
  for (const n of row.nodes) {
    for (const tpl of [n.user, n.system ?? ""]) {
      for (const m of tpl.matchAll(/\{\{\s*input\.([A-Za-z0-9_-]+)\s*\}\}/g)) {
        keys.add(m[1]!);
      }
    }
  }
  return [...keys];
}

/** 输出契约标记（json 契约节点要可解析，否则节点失败） */
export function outputZh(output: string | undefined): string {
  return output === "json" ? "JSON" : "文本";
}

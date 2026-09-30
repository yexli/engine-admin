/** AI Gateway：Pipeline（第一版只做查看/启停/测试，不做 DAG 编辑器）当前 Mock */
import { http } from "@/utils/http";

export interface PipelineRow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  stages: Array<{
    type: string;
    name: string;
    config: Record<string, unknown>;
  }>;
  lastTestAt: string | null;
  lastTestStatus: string | null;
}

export const listPipelines = () => {
  return http.request<{
    success: boolean;
    data: { list: PipelineRow[]; total: number };
  }>("get", "/admin-api/gateway/pipelines");
};

export const setPipelineEnabled = (id: string, enabled: boolean) => {
  return http.request<{ success: boolean; data: PipelineRow }>(
    "put",
    `/admin-api/gateway/pipelines/${id}/enabled`,
    { data: { enabled } }
  );
};

export interface PipelineTestResult {
  ok: boolean;
  pipeline: string;
  stageResults: Array<{ stage: string; ok: boolean; ms: number }>;
  testedAt: string;
}

export const testPipeline = (id: string) => {
  return http.request<{ success: boolean; data: PipelineTestResult }>(
    "post",
    `/admin-api/gateway/pipelines/${id}/test`
  );
};

/** 记忆库嵌入模型配置（经平台鉴权代理 → memory 服务 /v1/memory/embedding-config）
 *  PUT 需 system:manage 权限；apiKey 明文只在上行出现，回包一律脱敏（hasApiKey）。
 */
import { http } from "@/utils/http";

export interface EmbeddingConfig {
  enabled: boolean;
  /** OpenAI 兼容根（不含 /embeddings） */
  endpoint: string;
  model: string;
  hasApiKey: boolean;
}

export interface EmbeddingTestResult {
  ok: boolean;
  dimension?: number;
  ms: number;
  error?: string;
}

async function failWith(e: unknown): Promise<never> {
  const err = e as {
    response?: { data?: { error?: { message?: string } | string } };
  };
  const raw = err?.response?.data?.error;
  const text = typeof raw === "string" ? raw : raw?.message;
  throw new Error(text || (e instanceof Error ? e.message : "请求失败"));
}

export async function getEmbeddingConfig(): Promise<EmbeddingConfig> {
  try {
    const out = await http.request<{ config: EmbeddingConfig }>(
      "get",
      "/control-api/v1/admin/memory/embedding-config"
    );
    return out.config;
  } catch (e) {
    return failWith(e);
  }
}

/** apiKey 语义：undefined = 沿用已存密钥；字符串 = 覆盖；null = 清除 */
export async function updateEmbeddingConfig(cfg: {
  enabled: boolean;
  endpoint: string;
  model: string;
  apiKey?: string | null;
}): Promise<EmbeddingConfig> {
  try {
    const out = await http.request<{ config: EmbeddingConfig }>(
      "put",
      "/control-api/v1/admin/memory/embedding-config",
      { data: cfg }
    );
    return out.config;
  } catch (e) {
    return failWith(e);
  }
}

export async function testEmbedding(): Promise<EmbeddingTestResult> {
  try {
    return await http.request<EmbeddingTestResult>(
      "post",
      "/control-api/v1/admin/memory/embedding-config/test"
    );
  } catch (e) {
    return failWith(e);
  }
}

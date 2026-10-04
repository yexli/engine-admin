/* ============================================================
   AI Gateway（§11/§12）：模型统一入口 + 热切换。
   配置（localStorage）→ 可用则 OpenAI 兼容适配器（DeepSeek 默认），
   否则 rule-sim；任何时刻 core 拿到的都是同一个 AiPort。
   ============================================================ */
import type { AiPort } from '@/plugins/PluginInterface';
import { setAiPort } from '@/plugins/PluginInterface';
import { ruleSim } from './ruleSim';
import { OpenAiCompatAdapter } from './openaiCompat';
import { embeddingUsable, llmUsable, loadLlmConfig, onLlmConfig, resolveEmbedding } from './llmConfig';
import { OpenAiCompatEmbedding, applyEmbeddingProvider } from './embeddingCompat';
import { aiHelpers } from './helpers';
import { embeddingProvider } from '@/memory';

let current: AiPort = ruleSim;

function rebuild() {
  const c = loadLlmConfig();
  current = llmUsable(c) ? new OpenAiCompatAdapter(c, () => aiHelpers) : ruleSim;
  setAiPort(current);
  /* 向量模型与对话模型各自独立：一个没配不影响另一个 */
  applyEmbeddingProvider(embeddingUsable(c) ? resolveEmbedding(c) : null);
}
rebuild();
onLlmConfig(rebuild);

export const gateway = {
  /** 当前 provider 标识（系统面板展示用） */
  get provider(): string {
    return current.provider;
  },
  active(): AiPort {
    return current;
  },
  hasLlm(): boolean {
    return current instanceof OpenAiCompatAdapter;
  },
  /** 配置变更后手动重建（面板保存时调用；onLlmConfig 已自动触发，此处冗余保险） */
  reload: rebuild,
  /** 连通性测试（面板按钮） */
  async test(): Promise<{ ok: boolean; ms: number; reply?: string }> {
    if (current instanceof OpenAiCompatAdapter) return current.testConnection();
    return { ok: false, ms: 0, reply: '未启用真实模型（请先填 Key 并开启）' };
  },
  /** 向量端点连通性测试（系统面板按钮；未启用时给出明确原因） */
  async testEmbedding(): Promise<{ ok: boolean; ms: number; dim?: number; reply?: string }> {
    const p = embeddingProvider();
    if (!(p instanceof OpenAiCompatEmbedding)) {
      return { ok: false, ms: 0, reply: '未启用向量模型（请先填 Key 并开启）' };
    }
    return p.testConnection();
  },
  /** 结构化推演出口：未启用真实模型时返回 null（调用方回退规则推演） */
  async ask(system: string, user: string, maxTokens = 900): Promise<string | null> {
    if (current instanceof OpenAiCompatAdapter) return current.ask(system, user, maxTokens);
    return null;
  },
  /** 直接替换适配器（测试/未来多模型场景） */
  use(p: AiPort) {
    current = p;
    setAiPort(p);
  },
};

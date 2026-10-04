/* ============================================================
   向量模型适配器（《Memory Engine 记忆系统设计方案》§11/§12/§34）
   —— 与对话模型同一套 OpenAI 兼容协议：POST {baseURL}/embeddings。
   实现 memory 层的 EmbeddingProvider 槽位；未配置时槽位为空，
   记忆检索会剔除语义项并重新归一化权重（不是降级成残废）。
   ============================================================ */
import { clearEmbeddingCache, embeddingProvider, setEmbeddingProvider, type EmbeddingProvider } from '@/memory';
import type { EmbeddingConfig } from './llmConfig';

/**
 * 失败冷却：离线 / Key 失效时不再每次白等一个超时。
 * 打包成桌面程序后这条尤其重要——单机玩家很可能长期无网，
 * 若每次推演都重试，就会在「世界该推演了」的当口卡住十几秒。
 * 冷却期内直接返回空向量，调用方照常退化成关键词召回。
 */
const COOLDOWN_MS = 60_000;
let cooldownUntil = 0;

export function embeddingCoolingDown(now = Date.now()): boolean {
  return now < cooldownUntil;
}

export function resetEmbeddingCooldown(): void {
  cooldownUntil = 0;
}

export class OpenAiCompatEmbedding implements EmbeddingProvider {
  /** 维度首调探测（不逼用户去查文档填一个数字） */
  private dim = 0;

  constructor(private cfg: EmbeddingConfig) {}

  get name(): string {
    return 'openai-emb · ' + this.cfg.model;
  }

  getDimension(): number {
    return this.dim;
  }

  /** 连通性测试：打一次最小请求，成功即回显维度 */
  async testConnection(): Promise<{ ok: boolean; ms: number; dim?: number; reply?: string }> {
    const t0 = Date.now();
    try {
      const v = await this.embed('连通性测试');
      const ms = Date.now() - t0;
      return v.length ? { ok: true, ms, dim: v.length } : { ok: false, ms, reply: '返回空向量' };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, reply: e instanceof Error ? e.message : String(e) };
    }
  }

  async embed(text: string): Promise<number[]> {
    const out = await this.embedBatch([text]);
    return out[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    if (Date.now() < cooldownUntil) return texts.map(() => []); // 冷却期内不发请求
    const ctrl = new AbortController();
    /* 超时按实测收紧：正常情况下一次 batch 往返在 1s 内（实测 3 条 529ms），
       15s 只在真正断网时才会用满——而那时玩家已经等了太久。 */
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(this.cfg.baseURL.replace(/\/$/, '') + '/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.cfg.apiKey.trim() },
        body: JSON.stringify({ model: this.cfg.model, input: texts }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = (await res.json()) as { data?: { embedding?: number[] }[] };
      const vecs = (data.data ?? []).map((d) => d.embedding ?? []);
      if (vecs[0]?.length) this.dim = vecs[0].length;
      return vecs;
    } catch {
      /* 失败返回空向量：调用方据此退回关键词检索，而不是让整条链路炸掉；
         同时进入冷却，避免离线时每次推演都白等一个超时。 */
      cooldownUntil = Date.now() + COOLDOWN_MS;
      return texts.map(() => []);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 组合根调用：按配置装配或卸载向量槽位 */
export function applyEmbeddingProvider(cfg: EmbeddingConfig | null): void {
  const next = cfg ? new OpenAiCompatEmbedding(cfg) : null;
  /* 模型变了就清缓存（审查 §向量空间）：旧向量属于另一套嵌入空间，跨空间余弦没有意义，
     而内容指纹（fp）只描述内容、对「谁算出来的」是盲的——不清就是静默污染排序。
     VectorStore 与 PluginInterface 的注释都写着「换模型后旧行必须作废」，这里是执行点。 */
  if ((next?.name ?? null) !== (embeddingProvider()?.name ?? null)) clearEmbeddingCache();
  setEmbeddingProvider(next);
}

/* ============================================================
   Embedding Provider 抽象（《Memory Engine 记忆系统设计方案》§11/§12/§34/§41）
   —— 刻意不绑定任何模型：本模块只定义槽位与可用性判定。
   Phase 2 接入具体 provider 时（OpenAI / Qwen / BGE / 本地），
   只需实现本接口并 setEmbeddingProvider，检索侧零改动。
   未注入时混合检索会剔除语义项并重新归一化（见 HybridRetriever）。
   ============================================================ */

export interface EmbeddingProvider {
  readonly name: string;
  embed(text: string): Promise<number[]> | number[];
  embedBatch?(texts: string[]): Promise<number[][]>;
  getDimension(): number;
}

let current: EmbeddingProvider | null = null;

export function setEmbeddingProvider(p: EmbeddingProvider | null): void {
  current = p;
}

export function embeddingProvider(): EmbeddingProvider | null {
  return current;
}

export function embeddingAvailable(): boolean {
  return current !== null;
}

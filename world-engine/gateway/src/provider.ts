/* ============================================================
   AI 能力提供方注册表（V0.5 · 方案 §65 六角色 / §22）
   ------------------------------------------------------------
   网关不自产智能：每个「模型名」是一个 **AI 能力通道**（intent /
   npc / reasoning / narrative / memory / embedding，§65 角色图），
   通道背后是游戏注册的提供方。OpenAI 客户端选 model='narrative'，
   就是在跟这个世界的叙事能力说话。

   提供方由宿主实现（天穹的 AiPort 通道族是第一个参照）；网关只做
   协议翻译，不认识任何厂商 SDK（§66）。没注册的通道在 /v1/models
   不出现，直接调用回 404——可诊断，不假装修好了。
   ============================================================ */

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GatewayProvider {
  /** 提供方显示名（/v1/models 的 owned_by） */
  readonly owner: string;
  /** 覆盖的通道（模型名）列表 */
  readonly models: readonly string[];
  /**
   * 补全：把 OpenAI 消息数组翻译成世界 AI 能力的调用。
   * 返回 null = 这次能力调用失败（→ 503，网关如实上报，不假装修好）。
   */
  complete(model: string, messages: ProviderMessage[]): Promise<string | null>;
  /** 流式补全（可选）：逐段经 onDelta 产出；缺省则网关用 complete 一次性回（不装流式能力的通道仍可用） */
  completeStream?(model: string, messages: ProviderMessage[], onDelta: (delta: string) => void): Promise<void>;
  /** 嵌入（可选，§65 embedding 通道）：文本 → 向量；缺省 → 501 */
  embed?(model: string, input: string[]): Promise<number[][] | null>;
}

export interface RegisteredModel {
  id: string;
  owner: string;
}

export class ProviderRegistry {
  private providers: GatewayProvider[] = [];

  register(p: GatewayProvider): void {
    this.providers.push(p);
  }

  /**
   * 整体替换提供方快照（Model Control Plane 热更新用）：
   * 一次性换掉全部注册，已解析进进行中请求的旧提供方对象不受影响。
   */
  replaceAll(providers: readonly GatewayProvider[]): void {
    this.providers = [...providers];
  }

  clear(): void {
    this.providers = [];
  }

  /** 按模型名（通道）解析提供方；未注册 → null（→ 404） */
  resolve(model: string): GatewayProvider | null {
    for (const p of this.providers) {
      if (p.models.includes(model)) return p;
    }
    return null;
  }

  listModels(): RegisteredModel[] {
    const out: RegisteredModel[] = [];
    for (const p of this.providers) {
      for (const m of p.models) {
        if (!out.some((x) => x.id === m)) out.push({ id: m, owner: p.owner });
      }
    }
    return out;
  }
}

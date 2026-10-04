/* ============================================================
   能力注册表（《插件化世界模拟架构方案》§19 / §20 / §45）
    —— 每个系统向世界注册「我能做什么」；World Reasoner 只允许
       在已注册能力的范围内提出后果计划（§16 Validator 的白名单来源）。

    两级语义（审计整改：此前 58 条能力只有 20 个执行器处理器，
    38 条「能过验证却在执行期报无处理器」——白名单在撒谎）：
      capabilities —— 系统对外声明的全部能力（面板/审计可见）
      executable   —— 其中的**可执行子集**：每一条都必须有 WorldExecutor 处理器。
                      后果计划只能引用 executable；两者的一致性由
                      tests/arch-infra.test.ts 的守卫用例钉死。
    ============================================================ */

export interface CapabilityRow {
  system: string;
  capabilities: string[];
}

const bySystem = new Map<string, Set<string>>();
const byCapability = new Map<string, string>();
/** 可执行子集（后果计划白名单） */
const executable = new Set<string>();
const execBySystem = new Map<string, Set<string>>();
/** 待接入执行器的世界后果（可见、不可驱动；接入后应提升为 executable） */
const pendingBySystem = new Map<string, Set<string>>();

export const capabilities = {
  /**
   * 注册某系统的能力清单（同名能力重复注册时以先注册者为准，保持确定性）。
   * executable 必须是 capabilities 的子集——声明了却不能执行的动作是契约漏洞。
   */
  register(system: string, caps: string[], runnable: string[] = [], pending: string[] = []): void {
    /* 热替换：先撤销本系统上一次登记的可执行标记，否则热更后旧动作会残留 */
    for (const c of execBySystem.get(system) ?? []) {
      if (byCapability.get(c) === system) executable.delete(c);
    }
    let set = bySystem.get(system);
    if (!set) {
      set = new Set<string>();
      bySystem.set(system, set);
    }
    for (const c of caps) {
      set.add(c);
      if (!byCapability.has(c)) byCapability.set(c, system);
    }
    const ex = new Set<string>();
    for (const c of runnable) {
      if (!caps.includes(c)) continue; // 未声明却标记可执行 → 忽略（一致性守卫会报）
      if (byCapability.get(c) !== system) continue; // 同名能力已被先注册者认领
      ex.add(c);
      executable.add(c);
    }
    execBySystem.set(system, ex);
    /* 待接入清单只作审计用：不进 executable，因此 Validator 与提示词都看不到它 */
    /* 已可执行的动作不进「待接入」视图：两个分类在语义上互斥，
       收口放在注册表里，消费者（面板 / 审计）不必自己再滤一遍。 */
    pendingBySystem.set(system, new Set(pending.filter((c) => caps.includes(c) && !ex.has(c))));
  },

  /**
   * 注销某系统的全部声明（热替换用）。
   * 少了它，重注册时 bySystem/byCapability 只增不减——能力清单会留住旧条目，
   * 而 executable 又按本次声明重算，两边立刻不对称（守卫只在别处才发现）。
   */
  release(system: string): void {
    const declared = execBySystem.get(system);
    for (const c of bySystem.get(system) ?? []) {
      if (byCapability.get(c) === system) byCapability.delete(c);
      if (declared?.has(c)) executable.delete(c);
    }
    bySystem.delete(system);
    execBySystem.delete(system);
    pendingBySystem.delete(system);
    /* 同名能力被别人也声明过时，先手的注销不该让这个能力变成「无主」：
       按登记顺序把认领权还给仍在声明的系统。 */
    for (const [other, set] of bySystem) {
      for (const c of set) if (!byCapability.has(c)) byCapability.set(c, other);
    }
  },

  /** 拥有该能力的系统 id（无主 → null） */
  owner(capability: string): string | null {
    return byCapability.get(capability) ?? null;
  },

  has(system: string, capability: string): boolean {
    return bySystem.get(system)?.has(capability) ?? false;
  },

  /** 该能力是否已被任何系统认领 */
  exists(capability: string): boolean {
    return byCapability.has(capability);
  },

  /**
   * 该能力能否被后果计划引用（§16/§17：必须真的有人执行它）。
   * Validator 与 World Reasoner 的上下文都以此为准。
   */
  executable(capability: string): boolean {
    return executable.has(capability);
  },

  of(system: string): string[] {
    return [...(bySystem.get(system) ?? [])];
  },

  /** 某系统的可执行动作（供一致性守卫与审计） */
  executableOf(system: string): string[] {
    return [...(execBySystem.get(system) ?? [])];
  },

  /** 全部可执行动作（扁平集） */
  executableList(): string[] {
    return [...executable];
  },

  all(): CapabilityRow[] {
    return [...bySystem.entries()].map(([system, set]) => ({ system, capabilities: [...set] }));
  },

  /** 某系统的待接入动作（审计：这些是「将来会有」的世界后果） */
  pendingOf(system: string): string[] {
    return [...(pendingBySystem.get(system) ?? [])];
  },

  /** 全部待接入动作（扁平集） */
  pendingList(): string[] {
    return [...pendingBySystem.values()].flatMap((s) => [...s]);
  },

  pendingAll(): CapabilityRow[] {
    return [...pendingBySystem.entries()]
      .map(([system, set]) => ({ system, capabilities: [...set] }))
      .filter((r) => r.capabilities.length > 0);
  },

  /** 只含可执行动作的能力总览（Reasoner 上下文用：不能让 AI 看到做不到的动作） */
  executableAll(): CapabilityRow[] {
    return [...execBySystem.entries()]
      .map(([system, set]) => ({ system, capabilities: [...set] }))
      .filter((r) => r.capabilities.length > 0);
  },

  clear(): void {
    bySystem.clear();
    byCapability.clear();
    executable.clear();
    execBySystem.clear();
    pendingBySystem.clear();
  },
};

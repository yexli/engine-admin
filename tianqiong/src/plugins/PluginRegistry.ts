/* ============================================================
   插件注册表（《插件化世界模拟架构方案》§19 / §20 / §21 / §45）
   新增系统 = 实现 WorldSystemPlugin + 注册 Capability + 订阅事件，
   而不是去改 NPC / 任务 / 经济 / 战斗 / AI Prompt 的既有分支（§45 反模式）。
   本表是 World Reasoner「可调用能力列表」的唯一来源（§14）。
   ============================================================ */
import type { WorldEvent } from '@/events/EventSchema';
import { worldBus } from '@/events/EventBus';
import { capabilities } from './CapabilityRegistry';

/**
 * §16 时空约束（二期 H-07）：某动作只在某地 / 某时段 / 某境界可做。
 * 缺省 = 不受约束——这是刻意的，避免一次性收紧所有玩法（与既有的
 * 「缺失放行」策略一致：加载的旧档不该因为新契约而变得处处受限）。
 */
export interface ActionConstraint {
  /** 允许的地点 id（比对 WorldState.player.loc）；缺省 = 不限 */
  locations?: string[];
  /** 允许的时段名（比对 sceneTime().period）；缺省 = 不限 */
  periods?: string[];
  /** 最低境界（比对 player.level）；缺省 = 不限 */
  minLevel?: number;
}

export interface WorldSystemPlugin {
  /** 系统 id（如 combat / npc / quest） */
  id: string;
  version: string;
  /** 能做什么（§20）：全部声明，面板与审计可见 */
  capabilities: string[];
  /**
   * 其中**真的能被后果计划驱动**的子集（§16/§17）：每一条都必须有 WorldExecutor 处理器。
   * 缺省为空 —— 声明了能力却没接执行器的动作不该被放行（审计整改点）。
   */
  executable?: string[];
  /** **待接入执行器**的世界后果（见 systems.ts 的分类说明）：可见、不可驱动 */
  pending?: string[];
  /** internal 能力的真实入口（能力名 → WorldRuntime 路由名），见 systems.ts 的 SystemSpec.entries */
  entries?: Record<string, string[]>;
  /** 动作的时空约束（§16）；缺省 = 不受约束 */
  constraints?: Record<string, ActionConstraint>;
  /** 订阅的世界事件类型（§21：靠事件传播，不靠点对点调用） */
  subscribes?: string[];
  /** 事件处理；幂等由 worldBus 的 processedBy 记账保证 */
  handleEvent?(event: WorldEvent): void;
}

const registry = new Map<string, WorldSystemPlugin>();
const unsubs = new Map<string, Array<() => void>>();

function unregister(id: string): boolean {
  const existed = registry.delete(id);
  for (const off of unsubs.get(id) ?? []) off();
  unsubs.delete(id);
  /* 能力声明随插件一起撤：否则注销后 exists/owner/executable 仍报旧值
     （今天无生产调用方，但这是「注销了还能过验证」的陷阱） */
  capabilities.release(id);
  return existed;
}

export const plugins = {
  /** 注册（同 id 重复注册视为热替换：先退订再登记） */
  register(p: WorldSystemPlugin): void {
    if (registry.has(p.id)) unregister(p.id);
    /* 热替换必须先注销旧的能力声明：否则「本次声明」的可执行集与
       累积的能力表会不对称（能力表只增不减，executable 却被重算） */
    capabilities.release(p.id);
    registry.set(p.id, p);
    capabilities.register(p.id, p.capabilities, p.executable ?? [], p.pending ?? []);
    if (p.handleEvent) {
      const fn = (e: WorldEvent) => p.handleEvent!(e);
      unsubs.set(p.id, (p.subscribes ?? []).map((t) => worldBus.on(t, fn, p.id)));
    }
  },

  unregister,

  get(id: string): WorldSystemPlugin | undefined {
    return registry.get(id);
  },

  has(id: string): boolean {
    return registry.has(id);
  },

  ids(): string[] {
    return [...registry.keys()];
  },

  list(): WorldSystemPlugin[] {
    return [...registry.values()];
  },

  /** §20 能力总览：{ system, capabilities }[]，供面板与审计使用（含未接执行器的声明） */
  capabilityMap(): { system: string; capabilities: string[] }[] {
    return capabilities.all();
  },

  /** §14 可调用能力列表：只含可执行动作——Reasoner 不该看到做不到的动作 */
  executableMap(): { system: string; capabilities: string[] }[] {
    return capabilities.executableAll();
  },

  /** 待接入执行器的世界后果（面板/审计用：这些是「将来会有」的动作） */
  pendingMap(): { system: string; capabilities: string[] }[] {
    return capabilities.pendingAll();
  },

  clear(): void {
    for (const id of [...registry.keys()]) unregister(id);
    registry.clear();
    capabilities.clear();
  },
};

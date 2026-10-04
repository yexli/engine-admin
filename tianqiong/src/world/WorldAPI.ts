/* ============================================================
   World API（《插件化世界模拟架构方案》§4 / §33 / §47）
   —— 游戏世界的标准操作层，不是 AI。
   查询（query.*）只读；改写的唯一入口是 command()（委托命令分发）。
   设计约束：本文件不**直接** import 任何具体系统（systems/*）。允许的依赖是，
   世界基础设施（WorldState / WorldMutate / WorldClock）+ 事件基础设施（EventStore，
   卡 J1 的世界史查询需要它）+ 插件与执行器契约（PluginRegistry / CapabilityRegistry /
   WorldExecutor）+ 世界书与契约类型。注意 dispatch 来自 WorldRuntime，而它 import 了
   全部系统——所以这里是「直接依赖」层面的干净，不是「间接」层面的；
   系统侧反向 import 门面（world.query）的只有 ai/ContextBuilder 一处。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { core, stripTies } from '@/world/WorldState';
import { mutate } from '@/world/WorldMutate';
import { dispatch } from '@/world/WorldRuntime';
import { sceneTime } from '@/world/WorldClock';
import { worldEventLog } from '@/events/EventStore';
import type { WorldEvent } from '@/events/EventSchema';
import { capabilities } from '@/plugins/CapabilityRegistry';
import { plugins } from '@/plugins/PluginRegistry';
import { worldExecutor } from '@/execution/WorldExecutor';
import type { ConsequenceAction, ConsequencePlan, ExecResult } from '@/execution/PlanSchema';
import type { GameCommand } from '@/types/uispec';
import type { CheckRecord, CombatState, StatusEffect, WorldState } from '@/types/world';
import { createQuery } from 'world-engine';

export type NpcEntry = WorldState['npcs'][string];

/** 世界时钟读数（§27：全局唯一时间，各系统不得自建时间）。
    【World Engine 抽取 · V0.2】类型与实现都来自引擎（WorldQuery），与 createWorld 门面同源。 */
export type { WorldTimeView } from 'world-engine';

/* 通用查询（get_world_state / get_time / get_weather / get_location / get_player /
   get_entities / get_entity / get_log / get_history）：引擎单一来源。
   与世界书/插件绑定的天穹查询在下方 engineQuery 之后声明。 */
const engineQuery = createQuery<WorldState>({ getState: () => core.S, clock: { sceneTime } });

export const world = {
  /* ---------------- 查询（§4.1） ---------------- */

  query: {
    /* —— 通用子集（引擎实现，见上）—— */
    ...engineQuery,

    /** 战斗态（core.CB）：战斗浮层的唯一读取入口，与 get_world_state 同性质 */
    get_combat(): CombatState | null {
      return core.CB;
    },

    get_character(id?: string): WorldState['player'] | NpcEntry | null {
      const s = core.S;
      if (!s) return null;
      return id ? (s.npcs[id] ?? null) : s.player;
    },

    get_characters(): string[] {
      return core.S ? Object.keys(core.S.npcs) : [];
    },

    get_locations(): string[] {
      return Object.keys(WB.locations);
    },

    get_relationship(id: string): NpcEntry | null {
      const s = core.S;
      if (!s) return null;
      const dy = s.npcs[id];
      if (dy) return dy;
      /* §4.1/§14：玩家尚未交互过的 NPC 没有运行时条目，但他在世界书里的客观关系仍然存在。
         返回一份带关系种子的**只读视图**，消掉「谁先调用谁才读得到关系网」的隐性顺序依赖
         （推演的一跳扩展与亲族判定此前因此常常读空：实测 5 个有种子 NPC 首次投影前全为 0 条边）。
         视图不入档——状态写入仍然只走 npcDyn / 命令通道，世界书不构成第二个事实来源。 */
      const seed = WB.npcs[id]?.rels;
      return seed ? ({ att: 0, mem: [], met: false, rels: stripTies(seed) } as NpcEntry) : null;
    },

    get_relationships(): string[] {
      return core.S ? Object.keys(core.S.npcs) : [];
    },

    get_faction(id: string): number | null {
      const s = core.S;
      if (!s) return null;
      return s.rep[id] ?? null;
    },

    get_factions(): Record<string, number> {
      return core.S?.rep ?? {};
    },

    get_inventory(): WorldState['player']['bag'] {
      return core.S?.player.bag ?? [];
    },

    get_quests(): WorldState['player']['quests'] {
      return core.S?.player.quests ?? {};
    },

    /** §4.1 get_quest：单个委托的进行状态。未接 → null；进行中 → 记录；已交付 → `stage: 'fin'` */
    get_quest(id: string): WorldState['player']['quests'][string] | null {
      return core.S?.player.quests[id] ?? null;
    },

    /**
     * §4.1 get_active_effects：当前生效的状态效果。
     * 世界级状态（`StatusEffect`）与战斗内状态（`CB.status`）是两套：
     * 前者由 add_status / remove_status 两个动词写入，后者出战斗即清空。
     * `left` 每刻由 WorldClock 递减；日边界另有一次扣减（叠加偏差见《架构规范》§9.2）。
     */
    get_active_effects(): { owner: string; effects: StatusEffect[] }[] {
      const s = core.S;
      if (!s) return [];
      const out: { owner: string; effects: StatusEffect[] }[] = [];
      if (s.player.effects?.length) out.push({ owner: 'player', effects: s.player.effects });
      for (const [id, dy] of Object.entries(s.npcs)) {
        if (dy.effects?.length) out.push({ owner: id, effects: dy.effects });
      }
      return out;
    },

    get_events(): WorldState['events'] {
      return core.S?.events ?? [];
    },

    /** §44 最近检定留痕（骰值可追溯：「这一下是怎么判的」）。
        返回类型刻意收窄为 CheckRecord[]：实现在任何分支下都返回数组，
        原先标注的 WorldState['checks'] 把可选性带了出来，逼调用方写无意义的兜底。 */
    get_recent_checks(n = 5): CheckRecord[] {
      return (core.S?.checks ?? []).slice(-n);
    },

    /**
     * 卡 J1 · 世界史：运行时事实环形缓冲（§29/§44）的最近 N 条。
     * 与落盘走同一条来源（EventStore.worldEventLog），不是第二个事实源；
     * 返回倒序由调用方决定——这里保持缓冲的原始时序，UI 想怎么翻是 UI 的事。
     */
    get_world_log(n = 60): WorldEvent[] {
      return worldEventLog.recent(n);
    },

    /**
     * 卡 J1 · 因果链：从叶子事实沿 parentId 向上追溯至根源。
     * 带宿环保护与深度上限（traceChain 内建），返回 [叶子, 父, 祖, …]。
     * id 不在缓冲里时返回空数组——UI 据此提示「已滚出缓冲」而不是伪造链路。
     */
    trace_event(id: string, depth = 12): WorldEvent[] {
      return worldEventLog.chain(id, depth);
    },

    /**
     * §20 可调用能力列表：**只含可执行动作**（World Reasoner 的上下文来源 §14）。
     * 声明了却没人执行的动作不该出现在「你能调用什么」里——那会引导模型产出必然被拒的计划。
     */
    get_capabilities(): { system: string; capabilities: string[] }[] {
      return capabilities.executableAll();
    },

    /** §20 全部声明（含 internal / 未接入执行器的）：面板与审计用，不是可调用清单 */
    get_declared_capabilities(): { system: string; capabilities: string[] }[] {
      return capabilities.all();
    },

    /** §4.1 get_world_rules：世界书静态规则表的可枚举形式（id 列表，不是计数） */
    get_world_rules(): Record<string, string[]> {
      return {
        locations: Object.keys(WB.locations),
        factions: Object.keys(WB.factions),
        races: Object.keys(WB.races),
        classes: Object.keys(WB.classes),
        skills: Object.keys(WB.skills),
        npcs: Object.keys(WB.npcs),
      };
    },

    /** 能力归属：这条能力由哪个系统负责执行（Validator 的同源判定） */
    capability_owner(capability: string): string | null {
      return capabilities.owner(capability);
    },
  },

  /** 受控写入原语：唯一的状态字段写入口（定义与取舍见文件上方） */
  mutate,

  /* ---------------- 命令（§4.2） ---------------- */

  /** 唯一的状态改写入入口。任何系统 / AI / UI 都只能经此提交命令（§18）。 */
  command(cmd: GameCommand): void {
    dispatch(cmd);
  },

  /**
   * §4.2 世界动词入口：一条动词 = 一份单条后果计划。
   * 刻意走与 AI 推演**完全相同**的通道（Validator → Executor），
   * 因此外部脚本、UI 与 AI 受同一套约束，不存在绕过验证的后门（§18）。
   * 可用的动词 = capabilities 里登记为 **effects** 的那一子集（§20）——
   * internal（玩家操作 / 战斗裁定 / 工具）不经这里，玩家侧走 command() → dispatch()。
   */
  execute(action: ConsequenceAction): ExecResult {
    return worldExecutor.execute({
      planId: 'direct_' + action.action,
      triggerEvent: action.triggerEvent ?? 'direct',
      consequences: [action],
    });
  },

  /**
   * §17：整份后果计划的统一入口。
   * 推演的产物是**多条**后果，而 execute() 只接单条世界动词——
   * 推演层因此曾直连 worldExecutor，让「世界门面」在计划通道上留了缺口。
   * 与 execute 同源：内部仍是同一个 Executor，验证与执行路径一字不改。
   */
  plan(p: ConsequencePlan): ExecResult {
    return worldExecutor.execute(p);
  },

  /* ---------------- 插件视角（§19 / §45） ---------------- */

  systems: {
    list(): string[] {
      return plugins.ids();
    },
    get: plugins.get,
    has: plugins.has,
    capabilityMap: plugins.capabilityMap,
  },
};

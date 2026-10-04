/* ============================================================
   Context Builder（《插件化世界模拟架构方案》§14 / §43）
   —— 只装配「最小必要上下文」：触发事件 + 相关实体 + 相关势力 +
      相关任务 + 必要历史 + 时间地点 + 可调用能力列表。
   绝不做 SELECT * 全量喂给 AI（§43 反面清单）。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { world } from '@/world/WorldAPI';
import { plugins } from '@/plugins/PluginRegistry';
import { perception, perceiveContext } from '@/events/Perception';
import { buildMemoryContext } from '@/memory/context/MemoryContextBuilder';
import { beliefsOf } from '@/memory/belief/BeliefSystem';
import { npcCurLoc } from '@/systems/npc/Npcs';
import { lodOfNpc } from '@/systems/npc/Lod';
import { resolveBudget, selectRelevantRelations } from '@/systems/npc/ContextProfile';
import { core } from '@/world/WorldState';
import type { NpcEntry, WorldTimeView } from '@/world/WorldAPI';
import type { WorldState } from '@/types/world';
import type { WorldEvent } from '@/events/EventSchema';

export type EntityKind = 'npc' | 'location' | 'faction' | 'item' | 'quest';

/** NPC↔NPC 关系边（结构化，供规则推演判断亲疏） */
export interface EntityTie {
  other: string;
  type: string;
  val: number;
}

export interface ContextEntity {
  id: string;
  kind: EntityKind;
  name: string;
  /** NPC 好感读数（仅 NPC 有） */
  att?: number;
  /** 该 NPC 亲历或听说过的世界事实（§8 认知边界：推演只能基于此，不能给世界真相） */
  knows?: { eventId: string; type: string; day: number; fidelity: number; via: 'witness' | 'rumor' }[];
  /** 按记忆方案 §19/§35 检索出的记忆行（已过 Token 预算与权限过滤） */
  memories?: string[];
  /**
   * §23/§39 该实体**相信**什么（记忆推导出的信念，带置信度）。
   * 行动动机来自信念而不是事实——推演必须看得到这一层，
   * 否则「某人坚信玩家有罪」和「玩家确实有罪」在 AI 眼里没有区别。
   */
  beliefs?: string[];
  /** NPC↔NPC 关系边 */
  rels?: EntityTie[];
  /** 所属势力（命案/罪案推演的依据来源） */
  faction?: string;
  /** 该实体出现的场所（NPC 动态位置） */
  curLoc?: string;
}

/** §14 输入契约：触发事件 + 相关世界状态 + 可调用能力列表 */
export interface ReasonerContext {
  trigger: {
    id: string;
    type: string;
    level: number;
    day: number;
    tick: number;
    actor?: string;
    target?: string;
    location?: string;
    cause?: string;
  };
  time: WorldTimeView | null;
  location: string | null;
  witnesses: string[];
  entities: ContextEntity[];
  factions: Record<string, number>;
  activeQuests: string[];
  /** 必要的历史事件（近若干条世界事件簿记录） */
  recentEvents: { id: string; name: string; day: number }[];
  /** §14 可调用能力列表：Reasoner 只能在这些能力范围内提后果 */
  capabilities: { system: string; capabilities: string[] }[];
}

function classify(id: string): EntityKind {
  if (WB.npcs[id]) return 'npc';
  if (WB.locations[id]) return 'location';
  if (WB.factions[id]) return 'faction';
  if (WB.items[id]) return 'item';
  return 'quest';
}

function label(id: string): string {
  const n = WB.npcs[id] as { name?: string } | undefined;
  if (n?.name) return n.name;
  const l = WB.locations[id] as { name?: string } | undefined;
  if (l?.name) return l.name;
  const f = WB.factions[id] as { name?: string } | undefined;
  if (f?.name) return f.name;
  const i = WB.items[id] as { name?: string } | undefined;
  return i?.name ?? id;
}

export interface ContextOptions {
  /** 历史事件窗口（条） */
  historyWindow?: number;
  /** 额外纳入上下文的实体（如势力 / 任务） */
  extraEntities?: string[];
}

/** 全量 NPC 的边（运行时表优先，未建档者取世界书种子）——入边扫描的输入 */
function* allNpcTies(
  s: WorldState | null,
): Generator<[string, Record<string, { type: string; val: number }> | undefined]> {
  const seen = new Set<string>();
  for (const [owner, dy] of Object.entries(s?.npcs ?? {})) {
    seen.add(owner);
    yield [owner, dy.rels];
  }
  for (const [owner, def] of Object.entries(WB.npcs)) {
    if (!seen.has(owner)) yield [owner, def.rels];
  }
}

/**
 * 由触发事件装配最小必要上下文。
 * 相关实体 = 事件参与者 + 目击者 + 事件地点 + 调用方补充的实体。
 */
export function buildContext(event: WorldEvent, opts: ContextOptions = {}): ReasonerContext {
  /* §8/§14 目击名单：事件自带的是「当事人」（被改态度的 NPC、被偷的人，无条件计入），
     其余由感知层按在场与事件显眼度判定。只取前者会让推演既看不到「有人看见了」、
     也拿不到目击者实体——Combat/Law 产生命案与罪案时刻意留空等感知层来判，
     于是 §23 的「目击者势力立案」规则连依据都凑不齐，恒定空转。
     §4 单一事实源：感知只判一次，这里读它的结论，不重新判定。 */
  const witnesses = [...new Set([...(event.witnesses ?? []), ...perception.knowers(event.id, core.S)])];
  const ids = new Set<string>();
  for (const id of [event.actor, event.target, event.location, ...witnesses, ...(opts.extraEntities ?? [])]) {
    if (id) ids.add(id);
  }

  /* §14：一跳扩展——把直接相关者之间的关系人纳入上下文。
     少了这一步，「死者的亲友会追凶」这类推演永远看不到该看到的人：
     规则推演要求实体集里存在与死者有 kin/friend 边的关系人。
     每个实体只展开前 3 条关系边，避免上下文膨胀。 */
  for (const id of [...ids]) {
    const n = world.query.get_relationship(id);
    for (const other of Object.keys(n?.rels ?? {}).slice(0, 3)) {
      if (WB.npcs[other]) ids.add(other);
    }
  }

  /* §14/§23：关系边是**有向的**（adjRel 不自动反向），所以当事人还要走一遍入边。
     出边答的是「当事人与谁有关系」，入边答的是「谁把当事人放在心上」——
     「死者的亲属会追凶」看的正是后者：otto 对 lita 的 friend 边记在 otto→lita 上，
     只扫出边就永远看不到 otto，亲族追凶规则因此凑不齐依据。
     只对当事人（actor / target）做入边：对旁观者再展开一层，拉进来的是旁观者的旁观者。 */
  for (const id of [event.actor, event.target].filter((x): x is string => !!x)) {
    let added = 0;
    for (const [owner, rels] of allNpcTies(core.S)) {
      if (added >= 3) break;
      if (owner === id || ids.has(owner) || !WB.npcs[owner]) continue;
      if (rels?.[id]) {
        ids.add(owner);
        added++;
      }
    }
  }

  /* 事件当事人：关系筛选的第一优先项（正在发生的事比陈年旧怨更该被看到） */
  const focus = new Set<string>(
    [event.actor, event.target, ...(event.witnesses ?? [])].filter((x): x is string => !!x),
  );

  const entities: ContextEntity[] = [];
  for (const id of ids) {
    const kind = classify(id);
    const row: ContextEntity = { id, kind, name: label(id) };
    if (kind === 'npc') {
      /* 上下文档位（《NPC 分级与 Context Budget 最终方案》§7–§14）：
         「他值得多少笔墨」(worldImportance) × 「此刻多大关系」(LOD) → 本次预算。
         没开局时世界不存在，LOD 无从谈起，按 L1 给中间档——不因「读档瞬间」把所有人压到最小。 */
      const st0 = core.S;
      const imp = (WB.npcs[id] as { worldImportance?: number } | undefined)?.worldImportance ?? 1;
      const budget = resolveBudget(imp, st0 ? lodOfNpc(id, st0, event.day) : 'L1', 'world_reasoner');
      const n: NpcEntry | null = world.query.get_relationship(id);
      if (n) {
        row.att = n.att;
        /* §12：关系边不再全量展开。124 人 × 人均 3.7 条边，全量塞进上下文会淹掉事件本身。 */
        row.rels = selectRelevantRelations(n.rels ?? {}, budget.relationMax, focus);
        /* 位置走 npcCurLoc（= npcAt）：物化缓存撤掉后，这里拿到的是**此刻**的地点，
           而不是「上一次 tick 时他还在哪」——AI 推演因此不再读到过期位置。 */
        row.curLoc = core.S ? (npcCurLoc(id, core.S) ?? undefined) : undefined;
        row.faction = (WB.npcs[id] as { faction?: string } | undefined)?.faction;
      }
      /* §8：把「这个 NPC 知道什么」装进上下文——没开局时世界不存在，视为一无所知。
         少了这一步，AI 就会用世界真相推演 NPC 行为，谣言与误会都无从产生。 */
      const st = core.S;
      if (kind === 'npc' && st) {
        /* §13：事件知情条数由档位给（原先是写死的 6）。
           注意预算只管「最多带几条」——**他知道什么仍是世界规则决定的**，
           降预算不会让他凭空多知道，提预算也不会。 */
        row.knows = perceiveContext(id, budget.eventKnowledge, st).map((f) => ({
          eventId: f.eventId,
          type: f.type,
          day: f.day,
          fidelity: f.fidelity,
          via: f.via,
        }));
        /* §39：Memory Retrieval → World Reasoner —— 给推演器的是「他记得什么」，
           已过 §36 权限过滤与 §35 Token 预算；查询词由事件本身构成。 */
        const q = [event.type, event.cause, event.target].filter((x): x is string => !!x).join(' ');
        row.memories = buildMemoryContext({ ownerId: id, query: q }, st, event.day, 'world_reasoner', {
          topK: budget.memoryTopK,
          tokens: budget.tokens,
        }).map((l) => l.text);
        /* 只带「够得上相信」的：低于阈值的念头不该驱动推演 */
        row.beliefs = beliefsOf(id, st)
          .filter((b) => b.confidence >= 0.4)
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 5)
          .map((b) => b.proposition + '（确信 ' + Math.round(b.confidence * 100) + '%）');
      }
    }
    entities.push(row);
  }

  const state = world.query.get_world_state();
  const activeQuests = state ? Object.keys(state.player.quests) : [];

  return {
    trigger: {
      id: event.id,
      type: event.type,
      level: event.level,
      day: event.day,
      tick: event.tick,
      actor: event.actor,
      target: event.target,
      location: event.location,
      cause: event.cause,
    },
    time: world.query.get_time(),
    location: world.query.get_location(),
    witnesses,
    entities,
    factions: world.query.get_factions(),
    activeQuests,
    recentEvents: world.query
      .get_events()
      .slice(-(opts.historyWindow ?? 5))
      .map((e) => ({ id: e.id, name: e.name, day: e.day })),
    /* §14/§20：只给**可执行**的能力清单。此前全量下发 58 条，其中 38 条
       没有执行器——等于主动引导模型产出必然被拒的动作。 */
    capabilities: plugins.executableMap(),
  };
}

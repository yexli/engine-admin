/* ============================================================
   Memory Engine 门面（《Memory Engine 记忆系统设计方案》§20/§41/§44/§48）
   —— 回答：角色知道什么、记得多清楚、从哪知道、如何遗忘。
   与感知层的分工：感知层判定「谁看见了」（事件级事实，供调查取证）；
   本模块把感知结果沉淀为**角色记忆**（可衰减 / 可强化 / 可传播 / 带情绪）。
   事件来源复用感知表而不是重新判定视线——感知只做一次，避免两套口径。
   ============================================================ */
import { WB } from '@/data/worldBook';
import lawRaw from '@/data/world/law.json';
import { worldBus } from '@/events/EventBus';
import { perception } from '@/events/Perception';
import { core } from '@/world/WorldState';
import { runLog } from '@/devlog/RunLog';
import { confidenceOf, decayRateFor, importanceOf } from './MemoryTypes';
import { findMemory, memoriesOf, memoryCount, nextMemoryId, putMemory } from './MemoryStore';
import { memoryTick } from './lifecycle/MemoryLifecycle';
import { gossipTick } from './propagation/InformationPropagation';
import { hybridRetrieve, type ScoredMemory } from './retrieval/HybridRetriever';
import { reinforce } from './lifecycle/MemoryLifecycle';
import { validateMemoryProposal } from './MemoryValidator';
import type { MemoryQuery } from './retrieval/StructuredRetriever';
import type { WorldEvent } from '@/events/EventSchema';
import type {
  EmotionType,
  Memory,
  MemorySource,
  MemoryType,
  MemoryVisibility,
  WorldState,
} from '@/types/world';

export interface CreateMemoryInput {
  ownerId: string;
  type: MemoryType;
  content: string;
  source: MemorySource;
  sourceEventId?: string;
  sourceCharacterId?: string;
  sourceMemoryId?: string;
  confidence?: number;
  importance?: number;
  /** 重要度场景键（death / crime / gift…）；缺省按记忆类型查表 */
  importanceKind?: string;
  /** §24 命题（主体|事件类型|客体）；写入时算好，供信念层在重启后依然可推导 */
  proposition?: string;
  emotion?: { type: EmotionType; weight: number };
  visibility?: MemoryVisibility;
  entities?: string[];
}

/* ---------------- 世界事件 → 记忆的翻译表 ---------------- */

/**
 * 事件类型 → 中文动词短语，与主体/客体拼成「谁对谁做了什么」。
 * 早期版本用的是「有人倒下了」这类无人称描述，行动者只躺在 entities 里，
 * 于是目击者记住的永远不是「玩家杀了商人」——§40 的因果链断在记忆这一环。
 */
const VERB_OF: Record<string, string> = {
  character_died: '杀死了',
  npc_assassinated: '暗杀了',
  crime_committed: '犯下了罪行',
  quest_completed: '交付了委托',
  large_trade: '做成一笔大买卖',
  item_crafted: '做出了东西',
  reputation_changed: '让声望起了变化',
  relationship_changed: '让人际关系起了波动',
  title_granted: '得了名号',
  abyss_breach: '见证了星渊裂隙显形',
  city_at_war: '见证了城市陷入战火',
  city_disaster: '经历了灾祸',
  npc_moved: '换了地方',
  travel_arrived: '远行抵达',
  item_stolen: '偷走了',
  faction_conflict: '见证了势力冲突',
};

/** 罪案 id → 中文罪名（事件 target 指规则表条目而非实体时用） */
const CRIME_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries((lawRaw as unknown as { crimes?: Record<string, { name?: string }> }).crimes ?? {}).map(([k, v]) => [k, v.name ?? k]),
);

/** 显示名：NPC → 怪物 → 物品 → 地点 → 罪案 → 原 id。
    §4 内容契约：绝不把内部英文码写进角色记忆——此前只覆盖前两类，
    「你犯下了罪行 petty_theft」这类内部码会直接落到 NPC 的记忆正文里。 */
const displayName = (id: string): string =>
  WB.npcs[id]?.name ??
  (WB.monsters as Record<string, { name?: string }> | undefined)?.[id]?.name ??
  (WB.items as Record<string, { name?: string }> | undefined)?.[id]?.name ??
  (WB.locations as Record<string, { name?: string }> | undefined)?.[id]?.name ??
  CRIME_NAMES[id] ??
  (WB.factions as Record<string, string> | undefined)?.[id] ??
  id;

/** target 是规则表条目而非实体的类型：动词已含宾语，再拼 target 只会写出重复罪名 */
const NON_ENTITY_TARGET = new Set(['crime_committed']);

/** cause 可能是系统内部枚举（'combat' / 'leak_crisis'）：只有中文说法才配写进角色记忆 */
const isHumanCause = (c?: string): boolean => !!c && /[\u4e00-\u9fa5]/.test(c);

function describeEvent(e: WorldEvent): string {
  const actor = e.actor === 'player' ? '你' : e.actor ? displayName(e.actor) : '';
  const verb = VERB_OF[e.type];
  const tail = isHumanCause(e.cause) ? '（' + e.cause + '）' : '';
  if (NON_ENTITY_TARGET.has(e.type)) return (actor + (verb ?? e.type) || e.type) + tail;
  const target = e.target ? displayName(e.target) : '';
  const core = verb ? actor + verb + target : [actor, e.type, target].filter(Boolean).join(' ');
  return (core || e.type) + tail;
}

const KIND_OF_EVENT: Record<string, string> = {
  character_died: 'death',
  npc_assassinated: 'kin_killed',
  crime_committed: 'crime',
  quest_completed: 'quest',
  large_trade: 'gift',
  abyss_breach: 'death',
  city_at_war: 'death',
  city_disaster: 'death',
  faction_conflict: 'crime',
  relationship_changed: 'chat',
  item_stolen: 'crime',
};

const EMOTION_OF: Record<string, EmotionType> = {
  character_died: 'fear',
  npc_assassinated: 'fear',
  crime_committed: 'anger',
  city_at_war: 'fear',
  city_disaster: 'fear',
  abyss_breach: 'fear',
  quest_completed: 'joy',
  large_trade: 'joy',
  relationship_changed: 'trust',
  title_granted: 'joy',
};

function makeMemory(input: CreateMemoryInput, s: WorldState, nowDay: number): Memory {
  const importance = input.importance ?? importanceOf(input.importanceKind ?? input.type);
  const m: Memory = {
    id: nextMemoryId(nowDay, s),
    ownerId: input.ownerId,
    type: input.type,
    content: input.content,
    source: input.source,
    sourceEventId: input.sourceEventId,
    sourceCharacterId: input.sourceCharacterId,
    sourceMemoryId: input.sourceMemoryId,
    confidence: input.confidence ?? confidenceOf(input.source),
    importance,
    emotion: input.emotion,
    createdAt: nowDay,
    lastUpdatedAt: nowDay,
    recalledCount: 0,
    decayRate: decayRateFor(importance),
    visibility: input.visibility ?? 'private',
    status: 'active',
    entities: input.entities,
    proposition: input.proposition,
  };
  putMemory(input.ownerId, m, s, nowDay);
  return m;
}

export const memoryEngine = {
  /** §4/§20：写入一条记忆（外部来源请走 propose，带验证闸） */
  create(input: CreateMemoryInput, s: WorldState, nowDay: number): Memory {
    const m = makeMemory(input, s, nowDay);
    /* §4：写入即留痕。此前记忆表在涨、日志里一条都没有，
       「NPC 为什么恨玩家」只能靠 dump 存档反推。 */
    runLog.debug('memory', '写入记忆', {
      owner: m.ownerId, type: m.type, src: m.source,
      imp: m.importance, conf: m.confidence, body: m.content,
    });
    return m;
  },

  /** §10：召回即强化 */
  recall(ownerId: string, id: string, s: WorldState, nowDay: number): Memory | undefined {
    const m = reinforce(ownerId, id, s, nowDay);
    /* §10：召回只加深印象、绝不改置信度——这条日志就是那句铁律的现场记录 */
    if (m) runLog.debug('memory', '召回强化', { owner: ownerId, id, times: m.recalledCount, body: m.content });
    return m;
  },

  /** §15/§16：混合检索 */
  retrieve(q: MemoryQuery, s: WorldState, nowDay: number): ScoredMemory[] {
    return hybridRetrieve(q, s, nowDay);
  },

  /** §37：AI / 脚本提出的记忆必须过验证闸才能落库 */
  propose(raw: unknown, s: WorldState, nowDay: number): { ok: true; memory: Memory } | { ok: false; error: string } {
    const v = validateMemoryProposal(raw);
    if (!v.ok) {
      /* §37：AI / 脚本的提案被闸门拦下——「它想写什么、为什么被拒」是安全边界的直接证据 */
      runLog.warn('memory', '记忆提案被拒', { why: v.error });
      return v;
    }
    const m = makeMemory(v.value, s, nowDay);
    runLog.info('memory', '记忆提案落库', { owner: m.ownerId, type: m.type, conf: m.confidence, body: m.content });
    return { ok: true, memory: m };
  },

  /** §9/§22/§26：日边界生命周期（归并 → 遗忘）与关系网传话 */
  tick(s: WorldState, nowDay: number): { forgotten: number; compressed: number; gossiped: number } {
    const r = memoryTick(s, nowDay);
    const gossiped = gossipTick(s, nowDay);
    /* §9/§22/§26：日边界的遗忘 / 压缩 / 传话各做了多少。空转的日子不记，避免刷屏。 */
    if (r.forgotten || r.compressed || gossiped) {
      runLog.info('memory', '日边界生命周期', {
        day: nowDay, forgotten: r.forgotten, compressed: r.compressed, beliefs: r.beliefs, gossiped,
      });
    }
    return { ...r, gossiped };
  },

  count(s: WorldState, ownerId?: string): number {
    return memoryCount(s, ownerId);
  },

  /** §20/§44：世界事件 → 相关角色的记忆（目击者取自感知表，不重复判定） */
  recordFromEvent(e: WorldEvent, s: WorldState): number {
    if (e.level === 0) return 0; // L0 内部账目无人记得
    const owners = perception.knowers(e.id, s);
    if (!owners.length) return 0;
    const content = describeEvent(e);
    const kind = KIND_OF_EVENT[e.type] ?? 'default';
    const emotionType = EMOTION_OF[e.type];
    const entities = [e.actor, e.target, e.location].filter((x): x is string => !!x);
    /* §24：命题在写入时定格——事件日志不入档，事后再查就查不到了 */
    const proposition = [e.actor ?? '-', e.type, e.target ?? '-'].join('|');
    let n = 0;
    for (const owner of owners) {
      const m = makeMemory(
        {
          ownerId: owner,
          type: 'observation',
          content,
          source: 'direct_observation',
          sourceEventId: e.id,
          importanceKind: kind,
          entities,
          proposition,
          emotion: emotionType ? { type: emotionType, weight: 0.6 } : undefined,
        },
        s,
        e.day,
      );
      /* §20/§40：谁因为哪条事件得到了哪条记忆——认知分叉的现场。每 owner 一条 debug。 */
      runLog.debug('memory', '事件落成记忆', {
        owner, evt: e.id, type: e.type, kind, imp: m.importance, body: m.content,
      });
      n++;
    }
    return n;
  },

  /** 测试/重置用：清空某角色的记忆 */
  clear(s: WorldState, ownerId?: string): void {
    /* Phase 6：分频记账必须跟着记忆一起清。留着它的话，这个 owner 重新有记忆时
       记账还停在旧日子上——新记忆要等满一个周期才第一次归并（最长 7 天的空窗）。 */
    if (ownerId) {
      delete s.memories?.[ownerId];
      delete s.memTickAt?.[ownerId];
      return;
    }
    s.memories = {};
    s.memTickAt = {};
  },

  /** 某角色的记忆（只读视图） */
  of(ownerId: string, s: WorldState): Memory[] {
    return [...memoriesOf(ownerId, s)];
  },
};

/**
 * 把 Memory Engine 挂到世界事件总线上（组合根调用一次）。
 * **顺序约束**：必须在 attachPerception 之后——它读感知表拿目击者。
 * 未挂载时记忆系统完全不参与运行，既有玩法零影响。
 */
export function attachMemoryEngine(): () => void {
  return worldBus.on(
    '*',
    (e) => {
      const s = core.S;
      if (!s) return;
      memoryEngine.recordFromEvent(e, s);
    },
    'memory-engine',
  );
}

export { findMemory };

/* ============================================================
   NPC 感知层（《插件化世界模拟架构方案》§8 / §36）
   —— 铁律：World Truth ≠ NPC Knowledge。
   世界真相（WorldState + worldEventLog）是客观的；每个 NPC 只掌握自己
   「感知到」的那部分：亲历（在场 + 察觉）或听说（谣言传播）。由此生成
   谣言、误会、调查、怀疑、证据、隐瞒与信息不对称（§8）。
   存储：感知表写入 WorldState.knowledge 并随存档持久化
   （旧档经 hydrate 补空表——「没人知道任何事」是安全的默认）。
   ============================================================ */
import { worldBus } from '@/events/EventBus';
import { sampleHit } from '@/events/Sampling';
import { presentNPCs } from '@/systems/npc/Npcs';
import { core, need } from '@/world/WorldState';
import type { WorldEvent } from './EventSchema';
import type { PerceivedFact, WorldState } from '@/types/world';

export type { PerceivedFact };

/** 每个 NPC 的感知条目上限（超限丢最旧的；记忆表另有自己的容量规则） */
const KNOWLEDGE_CAP = 40;

/**
 * 事件显眼程度：1 = 满城皆知；0 = 不进入他人感知（私事）。
 * 与「显式 witnesses」的分工：当事人（被偷的、被改变态度的）写在事件自带的
 * witnesses 里，**无条件计入**；其余在场者才按这里的分值抽样。
 */
const SUBTLETY: Record<string, number> = {
  city_at_war: 1,
  city_disaster: 1,
  ruler_died: 1,
  abyss_breach: 1,
  character_died: 0.9,
  faction_conflict: 0.9,
  travel_arrived: 0.8,
  npc_assassinated: 0.7,
  npc_moved: 0.7,
  quest_completed: 0.6,
  quest_failed: 0.6,
  item_crafted: 0.5,
  large_trade: 0.5,
  crime_committed: 0.45,
  reputation_changed: 0.25,
  title_granted: 0.3,
  item_stolen: 0.2,
  /* 好感变化是**两个人的私事**：旁人不该「目击」到别人心里的秤。
     原先给 0.1，等于让在场者以 10% 概率把私人心态记成公共事实。 */
  relationship_changed: 0,
};
const DEFAULT_SUBTLETY = 0.5;

export function subtletyOf(e: WorldEvent): number {
  return SUBTLETY[e.type] ?? DEFAULT_SUBTLETY;
}

function accountOf(e: WorldEvent, via: 'witness' | 'rumor', fidelity: number): string {
  const who = e.target ? '·' + e.target : '';
  if (via === 'witness') return e.type + who + (e.cause ? '（' + e.cause + '）' : '');
  return '听说：' + e.type + who + (fidelity >= 0.5 ? (e.cause ? '（' + e.cause + '）' : '') : '（细节不详）');
}

/** 取某 NPC 的感知槽（按需建表，保证旧档/手工档也能安全写入） */
function bucket(npcId: string, s: WorldState): PerceivedFact[] {
  if (!s.knowledge) s.knowledge = {};
  let list = s.knowledge[npcId];
  if (!list) {
    list = [];
    s.knowledge[npcId] = list;
  }
  return list;
}

export function findFact(npcId: string, eventId: string, s: WorldState = need()): PerceivedFact | undefined {
  return s.knowledge?.[npcId]?.find((f) => f.eventId === eventId);
}

/**
 * 判定本次事件的目击者（§8）：事件显式声明的 witnesses 无条件计入；
 * 其余由「在场地点的 NPC × 事件显眼度」做察觉判定（走可注入 rng，测试可复现）。
 */
export function witnessesOf(e: WorldEvent, s: WorldState = need()): string[] {
  /* L0 是内部账目（掉血、扣蓝、节律）：不该有人「目击」到它。
     更要紧的是**一次 rng 都不消耗**——这类事件每时辰都有，抽样会把主随机流
     与改造前错开一整位（症状是玩法卡数值静默漂移，测试抓不到）·二期审查 I1。 */
  if (e.level === 0) return [...(e.witnesses ?? [])];
  const loc = e.location ?? s.player.loc;
  const out = new Set<string>(e.witnesses ?? []);
  if (!loc) return [...out];
  const p = subtletyOf(e);
  for (const n of presentNPCs(loc, s)) {
    if (out.has(n.id)) continue;
    /* §8：target 是事件的**承受方**，不是旁观者。承受方是否知情由事件产生方用显式
       witnesses 声明（如 adjAtt 把被改态度的当事人写进去），不该由「在场抽样」替他决定——
       否则死者会「目击」自己的死亡，并以证词身份进入立案证据。 */
    if (n.id === e.target) continue;
    /* 改进版 §11：确定性采样替代 rng.chance——
       不消耗随机流、不受遍历顺序影响，且**改变 NPC 数量不再改变其他系统的随机结果**。 */
    if (sampleHit(s.seed ?? 0, e.id, n.id, 'witness', p)) out.add(n.id);
  }
  return [...out];
}

/** 登记一条被感知的事实（亲历优先：已听说的事实遇到亲历时升级为亲历） */
export function perceive(e: WorldEvent, npcId: string, via: 'witness' | 'rumor' = 'witness', fidelity = 1, s: WorldState = need()): void {
  const list = bucket(npcId, s);
  const prev = list.find((f) => f.eventId === e.id);
  if (prev && prev.via === 'witness') return;
  const fact: PerceivedFact = {
    eventId: e.id,
    type: e.type,
    day: e.day,
    location: e.location,
    fidelity,
    via,
    account: accountOf(e, via, fidelity),
  };
  if (prev) Object.assign(prev, fact);
  else {
    list.push(fact);
    if (list.length > KNOWLEDGE_CAP) list.shift();
  }
}

/** 事件发生后按在场关系批量登记感知；返回目击者名单 */
export function registerPerception(e: WorldEvent, s: WorldState = need()): string[] {
  if (e.level === 0) return []; // L0 内部账目无人感知
  const seen = witnessesOf(e, s);
  for (const id of seen) perceive(e, id, 'witness', 1, s);
  return seen;
}

export function knows(npcId: string, eventId: string, s: WorldState = need()): boolean {
  return !!s.knowledge?.[npcId]?.some((f) => f.eventId === eventId);
}

/** 该 NPC 知道的事实（保留登记顺序，取最近 limit 条） */
export function knownBy(npcId: string, limit = 20, s: WorldState = need()): PerceivedFact[] {
  return (s.knowledge?.[npcId] ?? []).slice(-limit);
}

/**
 * 消息传播（§8/§36）：from 把自己知道的事讲给 to。
 * 每经一手，保真度按 fidelity 衰减；衰减过低的传闻不再继续传播。
 */
export function spreadPerception(eventId: string, fromId: string, toId: string, fidelity = 0.6, s: WorldState = need()): boolean {
  const fact = findFact(fromId, eventId, s);
  if (!fact) return false;
  const next = Math.max(0, Math.min(1, fact.fidelity * fidelity));
  if (next < 0.15) return false;
  const list = bucket(toId, s);
  const prev = list.find((f) => f.eventId === eventId);
  if (prev && prev.via === 'witness') return false; // 亲眼所见不会被传闻覆盖
  const heard: PerceivedFact = {
    ...fact,
    fidelity: next,
    via: 'rumor',
    account: fact.via === 'witness' ? '听说：' + fact.account : fact.account,
  };
  if (prev) Object.assign(prev, heard);
  else list.push(heard);
  return true;
}

/** 该 NPC 视角的事实清单（喂给 AI 推演时只能给这个，不能给世界真相） */
export function perceiveContext(npcId: string, limit = 12, s: WorldState = need()): PerceivedFact[] {
  return knownBy(npcId, limit, s);
}

export const perception = {
  size(npcId?: string, s: WorldState | null = core.S): number {
    if (!s?.knowledge) return 0;
    if (npcId) return s.knowledge[npcId]?.length ?? 0;
    let n = 0;
    for (const list of Object.values(s.knowledge)) n += list.length;
    return n;
  },

  /** 某事件的所有知情者（用于「谁泄露了消息」这类调查） */
  knowers(eventId: string, s: WorldState | null = core.S): string[] {
    if (!s?.knowledge) return [];
    const out: string[] = [];
    for (const [npc, list] of Object.entries(s.knowledge)) {
      if (list.some((f) => f.eventId === eventId)) out.push(npc);
    }
    return out;
  },

  clear(s: WorldState | null = core.S): void {
    if (s) s.knowledge = {};
  },
};

/**
 * 把感知层挂到世界事件总线上（组合根调用一次）。
 * 未挂载时感知层完全不参与运行，既有玩法零影响。
 */
export function attachPerception(): () => void {
  return worldBus.on(
    '*',
    (e) => {
      const s = core.S;
      if (!s) return;
      registerPerception(e, s);
    },
    'perception',
  );
}

/* ============================================================
   信息传播（《Memory Engine 记忆系统设计方案》§22/§23）
   —— 传播不是复制，是**重新计算**：置信度按手数衰减、来源改写为「听说」、
      重要度随之走低。多手之后自然断链，谣言因此不会无限扩散。
   铁律 §23：Rumor 不允许修改 World Truth —— 本模块只写角色记忆，永不回写世界事实。
   ============================================================ */
import { WB } from '@/data/worldBook';
import { perceive } from '@/events/Perception';
import { worldEventLog } from '@/events/EventStore';
import { PROPAGATION } from '../MemoryTypes';
import { findMemory, memoriesOf, nextMemoryId, putMemory } from '../MemoryStore';
import { partsOf } from '../belief/BeliefSystem';
import type { Memory, WorldState } from '@/types/world';

/**
 * §36 权限边界：只有「秘密」与「受限内容」不会被讲给别人听。
 * `private` 是**存储上的私有**（这条记忆只属于我），不代表我不能把它讲出去——
 * 亲眼所见本来就该能转述；把 private 也堵死会让谣言系统整个瘫痪。
 */
const UNTELLABLE: ReadonlySet<string> = new Set(['secret', 'restricted']);

/** 一手传播：from 把记忆讲给 to；返回新生成的记忆（不可传播时返回 null） */
export function propagate(sourceMemoryId: string, fromId: string, toId: string, s: WorldState, nowDay: number): Memory | null {
  if (fromId === toId) return null; // 自己讲给自己：无意义，且会拿传闻覆盖亲历
  const src = findMemory(fromId, sourceMemoryId, s);
  if (!src) return null;
  if (UNTELLABLE.has(src.visibility)) return null; // §36：私密与秘密不外传
  const confidence = src.confidence * PROPAGATION.perStep;
  if (confidence < PROPAGATION.minConfidence) return null; // 传不动了
  const importance = src.importance * PROPAGATION.importanceFalloff;
  const list = memoriesOf(toId, s);
  /* §25：同一来源事实已在对方表里就不再新增。
     早期只拦「亲历」那一档，于是闭环传播（NPC↔势力）会拿同一件事的同源副本
     反复冲刷记忆表，还会让信念的置信度被「重复投递」抬起来。 */
  const existing = src.sourceEventId ? list.find((m) => m.sourceEventId === src.sourceEventId) : undefined;
  if (existing && (existing.source === 'direct_observation' || existing.confidence >= confidence)) return null;
  const heard: Memory = {
    id: nextMemoryId(nowDay, s),
    ownerId: toId,
    type: 'rumor',
    content: '听说：' + src.content,
    source: 'received_information',
    sourceMemoryId: src.id,
    sourceCharacterId: fromId,
    sourceEventId: src.sourceEventId,
    confidence,
    importance,
    emotion: src.emotion,
    createdAt: nowDay,
    lastUpdatedAt: nowDay,
    recalledCount: 0,
    decayRate: src.decayRate,
    visibility: 'private',
    status: 'active',
    entities: src.entities,
    proposition: src.proposition, // 命题随事实一起传，二手记忆同样能参与信念推导
  };
  putMemory(toId, heard, s, nowDay); // 走统一写入，容量上限与淘汰才真正生效
  /* §22 同源：调查系统读感知表、AI 推演读记忆表，只写一边会让同一个 NPC
     的认知在两处对不上（他被调查时「不知道」，被问话时却「记得」）。 */
  /* 只给 NPC 登记感知：势力不是「证人」，而调查侧直接把 knowers 当证据计入 */
  const srcEvent = src.sourceEventId ? worldEventLog.byId(src.sourceEventId) : undefined;
  /* 事实够不够记，**不该取决于事件日志还在不在**：世界史是不入档的环形缓冲，
     读档之后 byId 必然落空——早期实现因此只写记忆、不登记感知，
     同一个 NPC 于是「被问话时记得、被调查时不知道」（正是本文件想避免的分叉）。
     命题与来源事件 id 都随记忆走，够重建一条最小事实。 */
  if (WB.npcs[toId]) {
    const parts = src.proposition ? partsOf(src.proposition) : null;
    perceive(
      srcEvent ?? {
        id: src.sourceEventId ?? src.id,
        type: parts?.predicate ?? 'rumor',
        day: src.createdAt,
        tick: 0,
        level: 2,
        target: parts && parts.object !== '-' ? parts.object : undefined,
        processedBy: [],
      },
      toId,
      'rumor',
      confidence,
      s,
    );
  }
  return heard;
}

/**
 * 沿关系网扩散一轮：每个知情者告诉自己的前若干个关系人。
 * 节流是刻意的——一轮把全部记忆倒给所有关系人，既不像「偶尔闲聊」，
 * 也会让记忆表以 O(NPC × 记忆数 × 关系数) 的速度膨胀。
 */
export function spreadAlongNetwork(fromId: string, s: WorldState, nowDay: number, maxTell = 2, maxMemories = 3): number {
  const ties = Object.keys(s.npcs?.[fromId]?.rels ?? {}).slice(0, maxTell);
  if (!ties.length) return 0;
  /* 取最近记住的几件（人闲聊时讲的通常也是最近的事） */
  const mine = memoriesOf(fromId, s)
    .filter((m) => m.status === 'active')
    .slice(-maxMemories);
  let n = 0;
  for (const m of mine) {
    for (const other of ties) if (propagate(m.id, fromId, other, s, nowDay)) n++;
  }
  return n;
}

/**
 * §22 势力通道（上行）：NPC 把自己知道的告诉所属势力。
 * 势力本身就是一个记忆主体——复用同构的 memories 表，
 * 于是容量、衰减、检索这些机制不需要为它重写一遍。
 */
export function propagateToFaction(npcId: string, s: WorldState, nowDay: number, maxMemories = 3): number {
  const faction = WB.npcs[npcId]?.faction;
  if (!faction || !(faction in s.rep)) return 0;
  const mine = memoriesOf(npcId, s)
    .filter((m) => m.status === 'active')
    .slice(-maxMemories);
  let n = 0;
  for (const m of mine) if (propagate(m.id, npcId, faction, s, nowDay)) n++;
  return n;
}

/**
 * §22 势力通道（下行）：势力把集体记忆知会成员。
 * 能走这条路的只有已经进到势力记忆里的事——个人私事不会因为入了势力就变成组织情报。
 */
export function propagateFromFaction(factionId: string, s: WorldState, nowDay: number, maxTell = 3, maxMemories = 2): number {
  /* 用运行时表而不是世界书：newState 的 npcs 是空的，NPC 在玩家首次接触时才建档。
     取自世界书会为玩家从未见过的 NPC 无条件写记忆——他们并不存在于这个世界版本里。 */
  const members = Object.keys(s.npcs ?? {}).filter((id) => WB.npcs[id]?.faction === factionId);
  if (!members.length) return 0;
  const known = memoriesOf(factionId, s)
    .filter((m) => m.status === 'active')
    .slice(-maxMemories);
  let n = 0;
  for (const m of known) {
    for (const who of members.slice(0, maxTell)) if (propagate(m.id, factionId, who, s, nowDay)) n++;
  }
  return n;
}

/**
 * §22 日边界：关系网里偶尔传来消息。
 * **刻意用确定性节律而不是随机数**——这里若消耗主随机序列，
 * 会让所有依赖种子复现的既有测试集体位移。世界自己会传话，但不该扰动骰子。
 */
export function gossipTick(s: WorldState, nowDay: number, periodDays = 3): number {
  if (nowDay % periodDays !== 0) return 0;
  let n = 0;
  for (const npcId of Object.keys(s.npcs ?? {})) {
    n += spreadAlongNetwork(npcId, s, nowDay); // 点对点：关系网内
    n += propagateToFaction(npcId, s, nowDay); // 上行：个人 → 所属势力
  }
  for (const fid of Object.keys(s.rep ?? {})) n += propagateFromFaction(fid, s, nowDay); // 下行：势力 → 成员
  return n;
}

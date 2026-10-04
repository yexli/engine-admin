/* ============================================================
   记忆生命周期（《Memory Engine 记忆系统设计方案》§9/§10/§26）
   —— 衰减（时间）· 强化（被回忆）· 压缩（长期聚类成摘要）。
   三点都由世界时钟驱动，不引入第二套时间。
   ============================================================ */
import { FORGOTTEN_BELOW, decayRateFor, strengthOf } from '../MemoryTypes';
import { formBeliefs } from '../belief/BeliefSystem';
import { memoriesOf, nextMemoryId, putMemory } from '../MemoryStore';
import { LOD_PERIOD, lodOfNpc, type NpcLod } from '@/systems/npc/Lod';
import type { Memory, WorldState } from '@/types/world';

export interface DecayResult {
  forgotten: number;
}

/** 单个 owner 的逐条衰减（**唯一实现点**：全量入口与分频入口都走这里） */
function decayOwner(ownerId: string, s: WorldState, nowDay: number): number {
  let forgotten = 0;
  for (const m of s.memories?.[ownerId] ?? []) {
    if (m.status !== 'active') continue;
    if (strengthOf(m, nowDay) < FORGOTTEN_BELOW) {
      m.status = 'forgotten';
      forgotten++;
    }
  }
  return forgotten;
}

/**
 * §9 全量衰减 tick：对**每一个** owner 逐条检查（不区分层级）。
 * 分频路径（memoryTick）只跑本轮该跑的 owner；这个全量入口留给「一次到底」的调用方与用例。
 */
export function decayTick(s: WorldState, nowDay: number): DecayResult {
  let forgotten = 0;
  for (const owner of Object.keys(s.memories ?? {})) forgotten += decayOwner(owner, s, nowDay);
  return { forgotten };
}

/**
 * §10 强化：被想起的记忆更牢固。
 * **铁律：强化绝不改 confidence。** 「被想起」不等于「被证实」——把召回记到置信度上，
 * 会让一条 inference 记忆在几次顺手取用后自动变成铁证，直接击穿 §37。
 * 正确的强化 = 记下召回次数与时间；衰减时钟改以 lastRecalledAt 为锚点（见 strengthOf），
 * 反复被想起的记忆因此自然留得更久。
 */
export function reinforce(ownerId: string, id: string, s: WorldState, nowDay: number): Memory | undefined {
  const m = s.memories?.[ownerId]?.find((x) => x.id === id);
  if (!m) return undefined;
  m.recalledCount += 1;
  m.lastRecalledAt = nowDay;
  m.lastUpdatedAt = nowDay;
  if (m.status === 'forgotten') m.status = 'active';
  return m;
}


/** §26 压缩：同类型的琐碎旧记忆聚成一条摘要，原始事实仍留在事件史与感知表 */
export function compress(ownerId: string, s: WorldState, nowDay: number, minGroup = 3): number {
  const list = memoriesOf(ownerId, s);
  const groups = new Map<string, Memory[]>();
  for (const m of list) {
    if (m.status !== 'active') continue;
    if (m.importance >= 0.5) continue; // 重要记忆不参与压缩
    if (nowDay - m.createdAt < 3) continue; // 新记忆先留一段
    const arr = groups.get(m.type) ?? [];
    arr.push(m);
    groups.set(m.type, arr);
  }
  let merged = 0;
  for (const [type, arr] of groups) {
    if (arr.length < minGroup) continue;
    /* 摘要**另立一条**，不覆盖任何一条的正文：
       拿摘要改写某条的 content，等于把它的原文从记忆表里抹掉
       （记忆不像事件那样有 Event Store 兜底，抹了就真没了）。
       原条目一律降级为 archived：退出检索，但仍留在存档里。 */
    const importance = Math.max(0.5, ...arr.map((m) => m.importance));
    const summary: Memory = {
      id: nextMemoryId(nowDay, s),
      ownerId,
      type: 'knowledge',
      content: '（往事泛黄：' + arr.length + ' 件' + type + '——' + arr.slice(0, 3).map((m) => m.content).join('；') + '）',
      source: 'system_generated',
      confidence: Math.max(...arr.map((m) => m.confidence)),
      importance,
      createdAt: nowDay,
      lastUpdatedAt: nowDay,
      recalledCount: 0,
      /* 摘要提升为「长期知识」并重算衰减率，否则刚归并出的它会在下一轮衰减里立刻沉底 */
      decayRate: decayRateFor(importance),
      visibility: 'private',
      status: 'active',
    };
    for (const m of arr) m.status = 'archived';
    putMemory(ownerId, summary, s, nowDay);
    merged += arr.length;
  }
  return merged;
}

/* ---------------- Phase 6 · 记忆分级（关注度 LOD） ----------------
   成本事实：改造前 memoryTick 每天对「全部 owner × 全部记忆」跑归并 + 衰减 + 信念；
   200 NPC × 80 条 = 16000 条/天，是随 NPC 规模线性增长的第一热点。
   分级**不改任何衰减/归并语义**，只改「多久对某个 owner 跑一次」。

   Phase 4 起判据搬去了 systems/npc/Lod.ts（lodOfNpc）——「谁算相关」只有一份实现，
   记忆侧只是它的第一个消费者；这里保留 memoryLodOf 这个名字作为记忆领域的别名，
   免得记忆模块的调用方要去关心 NPC 目录结构。 */

export { LOD_PERIOD, lodOfNpc };
export type MemoryLod = NpcLod;
export const memoryLodOf = lodOfNpc;

/**
 * 分频闸门：距上次处理**已满该层周期**才到点。
 * 刻意不用 `day % period === 0`：那会把相位变成隐式契约——
 * ① 读档当天正好落在相位外，一个 L2 owner 可能白等一整轮；
 * ② 刚出现的 owner 要等到下一个整除日才第一次归并；
 * ③ 周期一改，全体 owner 的处理日集体跳变。
 * 「距上次 ≥ period」对刚出现的 owner 天然成立（缺省视为很久以前），
 * 且记账随档持久化，重启不改变节奏。
 */
export function memoryDue(ownerId: string, lod: MemoryLod, s: WorldState, nowDay: number): boolean {
  const last = s.memTickAt?.[ownerId];
  if (last === undefined) return true;
  /* 时钟回退（导入一份更早的档、手改时间）也要处理：否则这个 owner 会一直空跑到时间追上旧的记账日。
     回退时按「刚到点」放行，重新记账后节奏自然对齐新时间线。 */
  return nowDay < last || nowDay - last >= LOD_PERIOD[lod];
}

/**
 * 生命周期总入口（挂在世界时钟的日边界）。
 * **顺序契约**：先归并、后遗忘。反过来的话，衰减会把琐碎旧记忆先标成 forgotten，
 * 而 compress 只处理 active 条目 —— 于是它们永远压不到，长期只会堆积成垃圾。
 */
export function memoryTick(s: WorldState, nowDay: number): { forgotten: number; compressed: number; beliefs: number } {
  /* 本轮到点的 owner（层级只决定「多久跑一次」，不改变跑的内容） */
  const due: { owner: string; lod: MemoryLod }[] = [];
  for (const owner of Object.keys(s.memories ?? {})) {
    const lod = memoryLodOf(owner, s, nowDay);
    if (memoryDue(owner, lod, s, nowDay)) due.push({ owner, lod });
  }

  let compressed = 0;
  for (const { owner } of due) compressed += compress(owner, s, nowDay);
  let forgotten = 0;
  for (const { owner, lod } of due) {
    /* L2 只归并、不逐条衰减：没人会去检索的细碎记忆，不值得每天扫一遍强度。
       重要记忆（importance ≥ 0.5）本来就不参与压缩，也不会因这一条被清掉。 */
    if (lod === 'L2') continue;
    forgotten += decayOwner(owner, s, nowDay);
  }
  /* §24 信念随记忆重算：放在衰减之后，信念因此只基于「此刻还认得的记忆」 */
  let beliefs = 0;
  for (const { owner } of due) beliefs += formBeliefs(owner, s, nowDay);

  /* 记账放在全部处理之后：中途出错也不会把「没跑过」记成「跑过」而白等一个周期 */
  for (const { owner } of due) {
    if (!s.memTickAt) s.memTickAt = {};
    s.memTickAt[owner] = nowDay;
  }
  return { forgotten, compressed, beliefs };
}

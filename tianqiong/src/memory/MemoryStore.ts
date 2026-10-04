/* ============================================================
   记忆存储原语（《Memory Engine 记忆系统设计方案》§4/§31）
   —— 只管 WorldState.memories 上的读写与容量控制，不做业务判定。
   与感知表（WorldState.knowledge）分工见 types/world.ts 的说明。
   ============================================================ */
import { MEMORY_CAP, strengthOf } from './MemoryTypes';
import type { Memory, WorldState } from '@/types/world';

/**
 * 记忆 id（世界日 + **持久化**单调序号）。
 * 序号存在 WorldState 上而不是模块变量里：后者重启即归零，
 * 读档后同一天的新记忆会与旧记忆撞 id，recall 会静默改到旧的那条。
 */
export function nextMemoryId(day: number, s: WorldState): string {
  s.memSeq = (s.memSeq ?? 0) + 1;
  return 'mem_' + day + '_' + s.memSeq;
}

/** 某角色的全部记忆（按需建表，保证旧档/手工档也能安全写入） */
export function memoriesOf(ownerId: string, s: WorldState): Memory[] {
  if (!s.memories) s.memories = {};
  let list = s.memories[ownerId];
  if (!list) {
    list = [];
    s.memories[ownerId] = list;
  }
  return list;
}

export function allOwners(s: WorldState): string[] {
  return Object.keys(s.memories ?? {});
}

export function memoryCount(s: WorldState, ownerId?: string): number {
  if (ownerId) return s.memories?.[ownerId]?.length ?? 0;
  let n = 0;
  for (const list of Object.values(s.memories ?? {})) n += list.length;
  return n;
}

export function findMemory(ownerId: string, id: string, s: WorldState): Memory | undefined {
  return s.memories?.[ownerId]?.find((m) => m.id === id);
}

/** 写入一条记忆；超出容量上限时按强度淘汰最弱的（重要记忆衰减率为 0，天然受保护） */
export function putMemory(ownerId: string, m: Memory, s: WorldState, nowDay: number): void {
  /* 所有写入都必须走这里：容量上限只在这一个地方执行，
     绕过它直接 push 的路径（曾出现在传播侧）会让存档无限膨胀。 */
  const list = memoriesOf(ownerId, s);
  list.push(m);
  if (list.length > MEMORY_CAP) pruneMemories(ownerId, s, nowDay);
}

/** §26 容量控制：按当前强度升序淘汰（先淘汰最弱的，不论其状态） */
export function pruneMemories(ownerId: string, s: WorldState, nowDay: number): number {
  const list = s.memories?.[ownerId];
  if (!list || list.length <= MEMORY_CAP) return 0;
  const excess = list.length - MEMORY_CAP;
  const ranked = [...list].sort((a, b) => strengthOf(a, nowDay) - strengthOf(b, nowDay));
  const drop = new Set(ranked.slice(0, excess).map((m) => m.id));
  const kept = list.filter((m) => !drop.has(m.id));
  const removed = list.length - kept.length;
  s.memories![ownerId] = kept;
  return removed;
}

/** 就地更新（§10 强化 / §9 时间戳维护都走这里） */
export function updateMemory(ownerId: string, id: string, patch: Partial<Memory>, s: WorldState): Memory | undefined {
  const m = findMemory(ownerId, id, s);
  if (!m) return undefined;
  Object.assign(m, patch);
  return m;
}



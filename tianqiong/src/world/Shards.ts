/* ============================================================
   存档分片：拆分与合并（《剩余工作实施方案》§3 · 第二杠杆）
   ------------------------------------------------------------
   【World Engine 抽取】拆装算法已抽入独立引擎（对缺片回落、
   isShardedMain 判据等行为逐行等价）；本文件只保留**天穹的分片
   世界观**：哪些表随规模增长、缺片时各自的空值形状。

   两个不变量（引擎层保证，shards.test 钉住）：
     ① 缺分片 = 该表没写成功 → 归零成空表（hydrate 会再兜一遍），不整档报废；
     ② 合并后的完整档仍走 validateState 那一道路闸，分片层不另开校验。
   ============================================================ */
import type { WorldState } from '@/types/world';
import type { PortShards } from '@/plugins/PluginInterface';
import { splitShards as engineSplit, mergeShards as engineMerge, isShardedMain as engineIs } from 'world-engine';
import type { ShardFieldSpec, ShardSnapshot } from 'world-engine';

/** 进分片的五张表：它们都随 NPC / 事件规模线性增长（空值 = 引擎 mergeShards 的缺片兜底） */
export const SHARD_FIELDS: ShardFieldSpec = [
  ['npcs', () => ({})],
  ['memories', () => ({})],
  ['beliefs', () => ({})],
  ['knowledge', () => ({})],
  ['cases', () => []],
];

/**
 * 四个分片的**逻辑名**（介质内部的 id）。写入方每次都写全四个（哪怕某片是空表也写 '{}'），
 * 于是「读到的键不全」就精确等于「上一批没写完」（崩了 / 配额写满）。
 * 这条不变量是分片档的完整性判据：缺片时必须回落到旧整档，
 * 而不是把缺的那张表 merge 成空表——那不是降级，那是丢数据。
 * 注意它与「存储键」（localStorage 的 tq2_*_v1）是两套命名，别混用。
 */
export const SHARD_KEYS = ['main', 'npcs', 'mind', 'know'] as const;

/** 拆：主档 = 去掉五张增长表之后的一切。浅拷贝，不改原 state。 */
export function splitShards(s: WorldState): PortShards {
  return engineSplit(s, SHARD_FIELDS) as unknown as PortShards;
}

/** 拼：分片缺失补空表（不是「保留 undefined」——下游 hydrate 之前就有人索引这些表）。 */
export function mergeShards(p: PortShards): WorldState {
  return engineMerge<WorldState>(p as unknown as ShardSnapshot, SHARD_FIELDS);
}

/**
 * 这份主档是「分片格式」还是「旧整档」？
 * 判据用「主档里有没有 npcs」：旧整档必有（newState 与所有 hydrate 路径都保证），
 * 新主档必无（splitShards 显式删掉）。识别错会把旧档的表清空，所以这个判据
 * 必须有正反两组用例钉住（见 repo/shards.test.ts）。
 */
export function isShardedMain(main: unknown): boolean {
  return engineIs(main, 'npcs');
}

/* ============================================================
   存档分片：拆分与合并（自宿主 Shards 原样抽取，字段表参数化）
   ------------------------------------------------------------
   把「随 NPC 规模膨胀的表」与「尺寸基本恒定的表」分开存：
   主档小、每次写；增长表只在内容变了时写。
   拆装逻辑只写在这里一处：介质只负责「按 key 存取字符串」。

   两个不变量（与宿主完全一致）：
     ① 缺分片 = 该表没写成功 → 归零成空表（hydrate 会再兜一遍），不整档报废；
     ② 合并后的完整档仍走宿主的校验闸，分片层不另开校验。
   ============================================================ */
import type { EngineWorldState } from '../types.ts';

/** 拆分字段与"缺片时的空值"成对声明：映射表用 () => ({})，列表用 () => [] */
export type ShardFieldSpec = readonly (readonly [field: string, empty: () => unknown])[];

/** 分片快照：main = 摘掉增长表之后的一切；其余字段按介质自己的形状存取 */
export interface ShardSnapshot {
  main: unknown;
  [field: string]: unknown;
}

/** 拆：主档 = 去掉增长表之后的一切。浅拷贝，不改原 state。 */
export function splitShards<W extends EngineWorldState>(s: W, fields: ShardFieldSpec): ShardSnapshot {
  const main = { ...s } as Record<string, unknown>;
  const out: ShardSnapshot = { main };
  for (const [f] of fields) {
    delete main[f];
    out[f] = (s as unknown as Record<string, unknown>)[f];
  }
  return out;
}

/** 拼：分片缺失补空表（不是「保留 undefined」——下游 hydrate 之前就有人索引这些表）。
    注意这是**字段级**兜底，不是「缺片也能拼」：完整性判据由 isShardedMain 承担。 */
export function mergeShards<W extends EngineWorldState>(snapshot: ShardSnapshot, fields: ShardFieldSpec): W {
  const out = { ...(snapshot.main as Record<string, unknown>) };
  for (const [f, empty] of fields) {
    out[f] = snapshot[f] ?? empty();
  }
  return out as unknown as W;
}

/**
 * 这份主档是「分片格式」还是「旧整档」？
 * 判据用「主档里有没有标志字段」（宿主用 npcs：旧整档必有，新主档必无）。
 * 识别错会把旧档的表清空，所以这个判据必须有正反两组用例钉住。
 */
export function isShardedMain(main: unknown, absentKey = 'npcs'): boolean {
  return !!main && typeof main === 'object' && !(absentKey in (main as Record<string, unknown>));
}

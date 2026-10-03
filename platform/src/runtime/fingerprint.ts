/* ============================================================
   World Instance Fingerprint（P9 · 方案 §十二：多代世界 id 语义）
   ------------------------------------------------------------
   引擎事件 id 按世界实例从头计数（evt_1_1…）——世界重建后 id 复用，
   而消费侧的 seen 集合持久存续，会把新世界的事件判重（宁阻塞不重复
   的正确行为，但会静默吞掉新世界的触发/摄取/对齐）。

   解法：世界实例指纹 = state.seed（createWorld 时随机生成，重建即变）。
   消费型 runtime 周期性比对指纹，发现变更即重置自己的 seen/born 集合
   并如实计数——新世界自动恢复消费，无需重启平台进程。

   读的是引擎权威状态（只读），周期由各 runtime 自定（缺省每 10 轮 +
   首轮）：最坏情况一个重启的世界被吞 ≤ N×interval 的触发，随后自愈。
   ============================================================ */
import type { EngineClient } from '../types.ts';

export interface FingerprintTracker {
  /** 比对世界实例指纹；首次见到 = 记录并返回 changed:false */
  check(worldId: string): Promise<{ changed: boolean; seed?: number }>;
  /** 已记录的指纹（观测） */
  known(worldId: string): number | undefined;
  /** 忘掉一个世界的指纹（世界关闭时） */
  forget(worldId: string): void;
}

export function createFingerprintTracker(engine: EngineClient): FingerprintTracker {
  const known = new Map<string, number>();
  return {
    async check(worldId: string) {
      const res = await engine.getState(worldId);
      if (!res.ok) return { changed: false };
      const seed = (res.state as { seed?: unknown }).seed;
      if (typeof seed !== 'number') return { changed: false };
      const prev = known.get(worldId);
      known.set(worldId, seed);
      return { changed: prev !== undefined && prev !== seed, seed };
    },
    known: (worldId) => known.get(worldId),
    forget: (worldId) => known.delete(worldId),
  };
}

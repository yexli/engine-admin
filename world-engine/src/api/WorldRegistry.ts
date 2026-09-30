/* ============================================================
   World Registry（V0.9 · 方案 §42 Multi-World / DR-001 兑现）
   ------------------------------------------------------------
   一个进程多个世界：每个世界持独立的事件总线与事件 id 序号
   （createWorld isolated 作用域），互不可见——隔离不变量见
   tests/registry.test.ts。所有权（owner → worlds）与鉴权属
   部署层（V1.0）；引擎只认 worldId。

   rng / scheduler 仍为进程级共享设施（DR-001 语义：执行基础设施，
   非世界状态）；跨世界同时推进时确定性采样按「进程内交错」理解。
   ============================================================ */
import { createWorld, type CreateWorldOptions, type WorldHandle } from './WorldAPI.ts';
import type { EngineWorldState } from '../types.ts';

export class WorldRegistryError extends Error {}

export interface WorldRegistry<W extends EngineWorldState = EngineWorldState> {
  /** 创建世界（worldId 必填且唯一；强制 isolated 作用域） */
  create(opts: CreateWorldOptions<W> & { worldId: string }): WorldHandle<W>;
  get(worldId: string): WorldHandle<W> | null;
  list(): WorldHandle<W>[];
  /** 关闭世界：移出注册表（其作用域随句柄释放；持久化归宿主 SavePort） */
  close(worldId: string): boolean;
  readonly size: number;
}

export function createWorldRegistry<W extends EngineWorldState = EngineWorldState>(): WorldRegistry<W> {
  const worlds = new Map<string, WorldHandle<W>>();

  return {
    create(opts): WorldHandle<W> {
      const worldId = opts.worldId;
      if (!worldId || worlds.has(worldId)) {
        throw new WorldRegistryError(`worldId 必填且唯一：'${worldId ?? ''}' 已存在或为空`);
      }
      const handle = createWorld<W>({ ...opts, isolated: true });
      worlds.set(worldId, handle);
      return handle;
    },

    get(worldId: string): WorldHandle<W> | null {
      return worlds.get(worldId) ?? null;
    },

    list(): WorldHandle<W>[] {
      return [...worlds.values()];
    },

    close(worldId: string): boolean {
      return worlds.delete(worldId);
    },

    get size(): number {
      return worlds.size;
    },
  };
}

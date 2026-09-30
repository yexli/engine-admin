/* ============================================================
   内存持久化介质（W8.4）：测试与最小运行用。
   worldId 维度由宿主持有多实例或自建介质承担（§42）。
   ============================================================ */
import type { MemorySavePort, MemorySnapshot } from './types.ts';

export class InMemoryMemoryStorage implements MemorySavePort {
  private row: MemorySnapshot | null = null;
  load(): MemorySnapshot | null {
    return this.row;
  }
  save(snapshot: MemorySnapshot): void {
    this.row = { ...snapshot, entries: snapshot.entries.map((e) => ({ ...e })) };
  }
  clear(): void {
    this.row = null;
  }
}

/* ============================================================
   持久化端口（六边形架构）：引擎 → SavePort → 具体介质。
   引擎不认识 localStorage / SQLite / 文件——介质由宿主注入。
   分片读写是可选能力：不实现则整档往返，只是每次多写几 MB，不会出错。
   ============================================================ */
import type { EngineWorldState } from '../types.ts';

export interface SavePort<W extends EngineWorldState = EngineWorldState> {
  /** 介质标识（观测用——"存档莫名消失"多半是介质换了） */
  readonly medium?: string;
  load(): W | null;
  save(s: W): void;
  clear(): void;
  /** 落盘错误通道：宿主注入（toast / 日志），repo 层不依赖 UI */
  onError?: (msg: string) => void;
  /** 分片读写（可选：不实现则整档往返）。快照形状由介质与宿主的分片适配层约定 */
  loadShards?(): unknown;
  saveShards?(shards: unknown): void;
  /** 世界事件史（V2.4-01：append-only——事件是历史事实，普通业务不得覆盖）。
     可选：不实现则退化为内存（重启失去长期追溯——查不到，但不会出错）。
     行形状 = WorldEvent；同 id 多行按「保首次」幂等恢复（P2 卡片6：与
     总线 processedBy 守卫、state 环窗口语义统一——事实不可变），重复写入
     不制造重复事实、也不覆盖首见内容。 */
  loadWorldLog?(): unknown[] | null;
  saveWorldLog?(rows: unknown[]): void;
  /** 命令幂等账（V2.4 加固：跨重启幂等）。可选：不实现则幂等账仅存进程内。
     行形状 = { commandId, result }（首次执行结果），插入序 FIFO。 */
  loadCommandLedger?(): unknown[] | null;
  saveCommandLedger?(rows: unknown[]): void;
}

/** 内存介质：测试与最小运行用（new InMemoryWorldStorage()）。
    世界史 / 幂等账通道在内存中往返，与主档同寿命。 */
export class InMemoryWorldStorage<W extends EngineWorldState = EngineWorldState> implements SavePort<W> {
  readonly medium = 'memory';
  private row: W | null = null;
  private worldLog: unknown[] = [];
  private commandLedger: unknown[] | null = null;
  save(s: W): void {
    /* 结构化克隆一层的浅防御：引擎不要求介质做深拷贝，但内存介质至少
       别把同一个引用存进去（省得测试里改了内存态把"已落盘"也改掉） */
    this.row = { ...s };
  }
  load(): W | null {
    return this.row;
  }
  clear(): void {
    this.row = null;
    this.worldLog = [];
    this.commandLedger = null;
  }
  loadWorldLog(): unknown[] | null {
    return this.worldLog.length ? [...this.worldLog] : null;
  }
  saveWorldLog(rows: unknown[]): void {
    this.worldLog = [...rows];
  }
  loadCommandLedger(): unknown[] | null {
    return this.commandLedger && this.commandLedger.length ? [...this.commandLedger] : null;
  }
  saveCommandLedger(rows: unknown[]): void {
    this.commandLedger = [...rows];
  }
}

/* ============================================================
   文件介质 SavePort（G3 · 1.2.0 · 服务端持久化的最小产品形态）
   ------------------------------------------------------------
   单机/单进程部署把世界状态落到磁盘：createWorld({ savePort:
   new FileSavePort('./data/w-main.json') })——重启 load() 接续。

   设计纪律：
   · 引擎零依赖——只用 node:fs，不用任何存储驱动；PostgreSQL 等
     网络介质属部署层适配（实现同一 SavePort 接口，不进引擎）；
   · 写后置（write-behind）：save() 只做快照分离 + 防抖排程，真实
     写盘延后（默认 500ms）；flush() 强制落盘；进程退出钩子兜底；
   · 原子写：tmp + rename，写一半崩溃不损档；
   · 损坏不静默：档损坏时 load() 报 onError、把坏档备份为
     *.corrupt-<ts> 再返回 null——绝不用一个空世界悄悄覆盖旧档。
   ============================================================ */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EngineWorldState } from '../types.ts';
import type { SavePort } from './storage.ts';

const FLUSH_DEBOUNCE_MS = 500;

export interface FileSavePortOptions {
  /** 落盘防抖（ms）；0 = 每次 save 同步写盘 */
  debounceMs?: number;
  /** JSON 缩进（调试可读；生产建议关以省体积） */
  pretty?: boolean;
  /** 落盘错误通道（缺省 console.error） */
  onError?: (msg: string) => void;
}

export class FileSavePort<W extends EngineWorldState = EngineWorldState> implements SavePort<W> {
  readonly medium = 'file';
  onError?: (msg: string) => void;

  private pending: W | null = null;
  private pendingLog: unknown[] | null = null;
  private pendingLedger: unknown[] | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly pretty: boolean;
  /* 路径派生用 getter：类字段初始化先于构造器参数属性赋值，
     字段初始化时 filePath 还是 undefined（经典初始化序陷阱） */
  private get tmpPath(): string {
    return `${this.filePath}.tmp`;
  }
  private get logPath(): string {
    return `${this.filePath}.log.json`;
  }
  private get ledgerPath(): string {
    return `${this.filePath}.commands.json`;
  }
  private get tablesPath(): string {
    return `${this.filePath}.tables.json`;
  }
  private readonly exitHook = (): void => this.flushSync();

  constructor(
    private readonly filePath: string,
    opts: FileSavePortOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? FLUSH_DEBOUNCE_MS;
    this.pretty = opts.pretty ?? false;
    this.onError = opts.onError;
    /* 兜底：进程正常退出（exit 事件）时同步冲刷挂起的脏档 */
    process.on('exit', this.exitHook);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.flushSync();
      },
      this.debounceMs,
    );
    this.timer.unref?.();
  }

  /** 立即落盘挂起数据（优雅关闭 / 测试断言前调用） */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushSync();
  }

  private flushSync(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      if (this.pending !== null) {
        const body = JSON.stringify(this.pending, null, this.pretty ? 2 : undefined);
        writeFileSync(this.tmpPath, body, 'utf8');
        renameSync(this.tmpPath, this.filePath);
      } else {
        rmSync(this.filePath, { force: true });
      }
      if (this.pendingLog !== null) {
        const logBody = JSON.stringify(this.pendingLog, null, this.pretty ? 2 : undefined);
        writeFileSync(`${this.logPath}.tmp`, logBody, 'utf8');
        renameSync(`${this.logPath}.tmp`, this.logPath);
      }
      if (this.pendingLedger !== null) {
        const ledgerBody = JSON.stringify(this.pendingLedger, null, this.pretty ? 2 : undefined);
        writeFileSync(`${this.ledgerPath}.tmp`, ledgerBody, 'utf8');
        renameSync(`${this.ledgerPath}.tmp`, this.ledgerPath);
      }
      this.dirty = false;
    } catch (e) {
      this.onError?.(`存档落盘失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  load(): W | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as W;
      if (this.dirty) {
        /* 盘上有更旧的档，但内存里有更新的挂起态——以内存为准（不回读覆盖） */
        return this.pending;
      }
      return parsed;
    } catch (e) {
      /* 损坏档：备份留证 + 报错，返回 null。绝不静默覆盖 */
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.filePath, backup);
        this.onError?.(`存档损坏已备份：${backup}（${e instanceof Error ? e.message : String(e)}）`);
      } catch {
        this.onError?.(`存档损坏且备份失败：${this.filePath}`);
      }
      return null;
    }
  }

  save(s: W): void {
    /* 快照分离：save 之后宿主继续改内存态不影响挂起快照 */
    this.pending = JSON.parse(JSON.stringify(s)) as W;
    this.dirty = true;
    this.schedule();
  }

  clear(): void {
    this.pending = null;
    this.pendingLog = null;
    this.pendingLedger = null;
    this.dirty = true;
    this.flushSync();
    rmSync(this.logPath, { force: true });
    rmSync(this.ledgerPath, { force: true });
  }

  loadWorldLog(): unknown[] | null {
    if (!existsSync(this.logPath)) return null;
    try {
      return JSON.parse(readFileSync(this.logPath, 'utf8')) as unknown[];
    } catch {
      /* 损坏的世界史同样「不静默」：备份留证再返回 null——
         否则下一次 saveWorldLog 会把可修复的历史无声覆盖掉 */
      const backup = `${this.logPath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.logPath, backup);
        this.onError?.(`世界史损坏已备份：${backup}`);
      } catch {
        this.onError?.(`世界史损坏且备份失败：${this.logPath}`);
      }
      return null;
    }
  }

  saveWorldLog(rows: unknown[]): void {
    this.pendingLog = JSON.parse(JSON.stringify(rows)) as unknown[];
    this.dirty = true;
    this.schedule();
  }

  loadCommandLedger(): unknown[] | null {
    if (!existsSync(this.ledgerPath)) return null;
    try {
      return JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as unknown[];
    } catch {
      const backup = `${this.ledgerPath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.ledgerPath, backup);
        this.onError?.(`命令幂等账损坏已备份：${backup}`);
      } catch {
        this.onError?.(`命令幂等账损坏且备份失败：${this.ledgerPath}`);
      }
      return null;
    }
  }

  saveCommandLedger(rows: unknown[]): void {
    this.pendingLedger = JSON.parse(JSON.stringify(rows)) as unknown[];
    this.dirty = true;
    this.schedule();
  }

  /* 事件分级/通道表（P3 卡片8）：同步小文件直写（表变更低频，无防抖必要） */
  loadEventTables(): { levels: Record<string, number>; channels: Record<string, string> } | null {
    if (!existsSync(this.tablesPath)) return null;
    try {
      return JSON.parse(readFileSync(this.tablesPath, 'utf8'));
    } catch {
      this.onError?.(`事件分级/通道表损坏：${this.tablesPath}（回落缺省表）`);
      return null;
    }
  }

  saveEventTables(tables: { levels: Record<string, number>; channels: Record<string, string> }): void {
    try {
      mkdirSync(dirname(this.tablesPath), { recursive: true });
      writeFileSync(this.tablesPath, JSON.stringify(tables, null, 2), 'utf8');
    } catch (e) {
      this.onError?.(`事件分级/通道表落盘失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 释放进程退出钩子（关闭世界/测试收尾用；退出前先 flush） */
  dispose(): void {
    this.flush();
    process.removeListener('exit', this.exitHook);
  }
}

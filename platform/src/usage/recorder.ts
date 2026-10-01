/* ============================================================
   结构化用量记录面（M2.2 · ADMIN-CONSOLE-ROADMAP）
   ------------------------------------------------------------
   平台公共侧的访问与模型调用留痕 → JSONL 追加文件（量级需要再
   SQLite）：每行一条 UsageEntry，requestId 与访问日志同源，可逐条
   对账。Usage 页 / Dashboard「AI Requests」卡 / AI Calls 页共用本
   数据面。

   诚实边界：
   · 不落任何 Prompt / 响应原文（隐私边界；详情只有路由留痕）；
   · world-agent 的 tokens 是平台粗估（响应里既有口径）；
     代理透传路径拿不到上游 usage，tokens 留空，不编造；
   · 鉴权失败（401）不计入——计量面记录的是「已鉴权的使用」；
   · 写失败只报一次并停写（磁盘故障不应刷屏或拖垮请求路径）。
   ============================================================ */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** 一条用量记录（JSONL 一行） */
export interface UsageEntry {
  /** ISO 时间 */
  ts: string;
  /** 与访问日志 / x-request-id 同源，可对账 */
  requestId: string;
  /** chat = 模型调用；worlds = 世界 API 透传 */
  kind: 'chat' | 'worlds';
  keyId: string;
  tenantId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  /* ---------- chat 路由留痕 ---------- */
  /** 请求的模型名（world-agent 或物理模型 ID） */
  model?: string;
  /** world-agent 管线 / 保真代理 */
  route?: 'world-agent' | 'proxy';
  /** world-agent 任务分析出的能力 */
  capability?: string;
  /** world-agent 实际使用的模型（含 fallback 接管后） */
  modelUsed?: string;
  fallbackUsed?: boolean;
  worldId?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** tokens 为平台粗估（世界代理固定口径） */
  tokensEstimated?: boolean;
  /** 失败错误码（如 no_model_configured / upstream_error） */
  error?: string;
}

/** 公共侧写入口（protocol/server 依赖的最小接口，测试可替换） */
export interface UsageSink {
  record(entry: UsageEntry): void;
}

/** 管理面读取口 */
export interface UsageReader {
  readAll(): UsageEntry[];
}

export interface UsageRecorderOptions {
  filePath: string;
  /** 单文件轮转阈值（字节）；缺省 32 MiB，超出改名 .1 保留一代 */
  rotateBytes?: number;
}

export interface UsageRecorder extends UsageSink, UsageReader {
  /** 等待挂起的追加写完成（测试与优雅退出用） */
  flush(): Promise<void>;
}

const DEFAULT_ROTATE_BYTES = 32 * 1024 * 1024;

export function createUsageRecorder(opts: UsageRecorderOptions): UsageRecorder {
  const rotateBytes = opts.rotateBytes ?? DEFAULT_ROTATE_BYTES;
  let tail: Promise<void> = Promise.resolve();
  let broken = false;

  function append(line: string): void {
    if (broken) return;
    try {
      mkdirSync(dirname(opts.filePath), { recursive: true });
      if (existsSync(opts.filePath)) {
        const { size } = statSync(opts.filePath);
        if (size >= rotateBytes) {
          /* 保留一代：usage.jsonl → usage.jsonl.1（覆盖上一代） */
          renameSync(opts.filePath, `${opts.filePath}.1`);
        }
      }
      appendFileSync(opts.filePath, line, 'utf8');
    } catch (e) {
      broken = true;
      console.error(`[usage] 用量记录写入失败，本进程停写：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    record(entry: UsageEntry): void {
      if (broken) return;
      let line: string;
      try {
        line = `${JSON.stringify(entry)}\n`;
      } catch {
        return; /* 条目不可序列化（理论不可达）：丢弃，不影响请求路径 */
      }
      tail = tail.then(() => append(line));
    },

    readAll(): UsageEntry[] {
      const out: UsageEntry[] = [];
      for (const file of [`${opts.filePath}.1`, opts.filePath]) {
        if (!existsSync(file)) continue;
        let raw: string;
        try {
          raw = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        for (const lineText of raw.split('\n')) {
          const trimmed = lineText.trim();
          if (!trimmed) continue;
          try {
            out.push(JSON.parse(trimmed) as UsageEntry);
          } catch {
            /* 半行/坏行跳过（崩溃截断等），不让单行污染整个查询 */
          }
        }
      }
      return out;
    },

    flush(): Promise<void> {
      return tail;
    },
  };
}

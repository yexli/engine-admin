/* ============================================================
   Evolution Journal（方案 §九/§十三：因果链的落地账本）
   ------------------------------------------------------------
   每个 EvolutionRun 在账本里只有一行真相：append 是 upsert——
   tick 开始落 'running' 中间态（进程崩溃也有迹可查），finish 落
   终态原位覆盖；load 时同一 run 的后一行覆盖前一行。
   内存环形窗口 + 可选 JSONL 落盘。
   它回答的是「世界为什么发生了这个变化」——观测面只读，任何系统
   （Admin / 游戏方 / 未来审计）都从这里反向追溯。

   纪律：写失败不炸运行时（演化账本损坏不能反过来伤害世界进程），
   但失败要计数可查——不静默假装没发生过。
   ============================================================ */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import type { EvolutionRun } from './types.ts';

/** 内存窗口上限（每个世界独立计数） */
const RING_CAP = 200;

export interface FileEvolutionJournalOptions {
  /** JSONL 目录（每世界一个文件 {dir}/{worldId}.jsonl）；不传 = 仅内存 */
  dir?: string;
  /** 内存窗口上限（缺省 200） */
  ringCap?: number;
}

export function createEvolutionJournal(opts: FileEvolutionJournalOptions = {}): {
  append(run: EvolutionRun): void;
  recent(worldId: string, n?: number): EvolutionRun[];
  get(worldId: string, runId: string): EvolutionRun | null;
  /** 账本里有留痕的世界 id（内存窗口键；load 后含历史世界） */
  knownWorlds(): string[];
  /** 从磁盘装载历史（有 dir 时）；返回 { loaded, skippedCorrupt } */
  load(): { loaded: number; skippedCorrupt: number };
  /** JSONL 落盘失败累计次数（写失败不炸运行时，但必须可查） */
  writeFailures(): number;
} {
  const cap = Math.max(10, Math.floor(opts.ringCap ?? RING_CAP));
  const rings = new Map<string, EvolutionRun[]>();
  const dir = opts.dir;
  let failures = 0;

  function push(run: EvolutionRun): void {
    let ring = rings.get(run.worldId);
    if (!ring) {
      ring = [];
      rings.set(run.worldId, ring);
    }
    /* upsert：同一 run 的中间态（running）被终态原位覆盖 */
    const idx = ring.findIndex((r) => r.id === run.id);
    if (idx >= 0) {
      ring[idx] = run;
      return;
    }
    ring.push(run);
    if (ring.length > cap) ring.shift();
  }

  return {
    append(run) {
      push(run);
      if (!dir) return;
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(`${dir}/${sanitize(run.worldId)}.jsonl`, `${JSON.stringify(run)}\n`, 'utf8');
      } catch {
        /* 账本写失败不伤害世界进程（纪律见文件头）；run 仍在内存窗口可查，失败计数可查 */
        failures++;
      }
    },

    recent(worldId, n = 20) {
      const ring = rings.get(worldId) ?? [];
      return ring.slice(-Math.max(1, Math.min(n, cap))).reverse();
    },

    get(worldId, runId) {
      return (rings.get(worldId) ?? []).find((r) => r.id === runId) ?? null;
    },

    knownWorlds() {
      return [...rings.keys()];
    },

    writeFailures() {
      return failures;
    },

    load() {
      let loaded = 0;
      let skippedCorrupt = 0;
      if (!dir || !existsSync(dir)) return { loaded, skippedCorrupt };
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const worldId = f.replace(/\.jsonl$/, '');
        let raw: string;
        try {
          raw = readFileSync(`${dir}/${f}`, 'utf8');
        } catch {
          skippedCorrupt++;
          continue;
        }
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try {
            const run = JSON.parse(t) as EvolutionRun;
            /* 行归属校验：run.worldId 必须与文件名一致（防串档）；
               同一 run 的多行（running 中间态 + 终态）按 push 的 upsert 语义后行覆盖前行 */
            if (run && typeof run.id === 'string' && run.worldId === worldId) {
              push(run);
              loaded++;
            } else {
              skippedCorrupt++;
            }
          } catch {
            skippedCorrupt++;
          }
        }
      }
      return { loaded, skippedCorrupt };
    },
  };
}

/** worldId → 文件名（引擎 worldId 面向 HTTP，此处防路径穿越） */
function sanitize(worldId: string): string {
  return worldId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'world';
}

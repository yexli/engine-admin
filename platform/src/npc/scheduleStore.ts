/* ============================================================
   NPC Runtime · Schedule Store（P6 · 方案 §九：作息数据的宿主注册 + 持久化）
   ------------------------------------------------------------
   日程表是**游戏数据**（方案 §八/§九：确定性行为归 Time + Schedule +
   Rules，数据归属游戏方）——游戏方经管理面把它注册给平台，平台负责
   确定性执行（对齐循环）。Store 做三件事：内存真相、JSON 文件持久化、
   载入；不解释日程内容，不知道任何 NPC 名字。

   纪律：写盘失败不炸进程（与演化账本同姿态），但计数可查。
   ============================================================ */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NpcScheduleTable } from './schedule.ts';

export interface ScheduleStoreOptions {
  /** 持久化文件路径；不传 = 仅内存 */
  filePath?: string;
}

export interface ScheduleStore {
  /** 注册/覆盖一个世界的日程表（整表覆盖，游戏方是它的唯一作者） */
  set(worldId: string, table: NpcScheduleTable): void;
  get(worldId: string): NpcScheduleTable | null;
  delete(worldId: string): boolean;
  worlds(): string[];
  /** 从磁盘装载（有 filePath 时）；返回 { loaded, skippedCorrupt } */
  load(): { loaded: number; skippedCorrupt: number };
  writeFailures(): number;
}

/** 日程表形状校验：实体 id 非空、slot 为数、from<to、location 非空；坏条目剔除 */
export function sanitizeScheduleTable(raw: unknown): NpcScheduleTable | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: NpcScheduleTable = {};
  let kept = 0;
  for (const [npcId, slots] of Object.entries(raw as Record<string, unknown>)) {
    if (!npcId || npcId.length > 128 || !Array.isArray(slots)) continue;
    const clean: NpcScheduleTable[string] = [];
    for (const slot of slots.slice(0, 48)) {
      if (!slot || typeof slot !== 'object') continue;
      const s = slot as Record<string, unknown>;
      const from = typeof s['from'] === 'number' && Number.isFinite(s['from']) ? Math.floor(s['from']) : Number.NaN;
      const to = typeof s['to'] === 'number' && Number.isFinite(s['to']) ? Math.ceil(s['to']) : Number.NaN;
      const location = typeof s['location'] === 'string' && s['location'].length > 0 && s['location'].length <= 128 ? s['location'] : undefined;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > 48 || !location) continue;
      clean.push({ from, to, location });
    }
    if (clean.length) {
      out[npcId] = clean;
      kept++;
    }
  }
  return kept > 0 ? out : null;
}

export function createScheduleStore(opts: ScheduleStoreOptions = {}): ScheduleStore {
  const filePath = opts.filePath;
  const tables = new Map<string, NpcScheduleTable>();
  let failures = 0;

  function persist(): void {
    if (!filePath) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      const payload: Record<string, NpcScheduleTable> = {};
      for (const [k, v] of tables) payload[k] = v;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, filePath); /* 原子写：tmp + rename */
    } catch {
      failures++; /* 写失败不炸进程；内存真相仍在，计数可查 */
    }
  }

  return {
    set(worldId, table) {
      tables.set(worldId, table);
      persist();
    },
    get(worldId) {
      return tables.get(worldId) ?? null;
    },
    delete(worldId) {
      const had = tables.delete(worldId);
      if (had) persist();
      return had;
    },
    worlds: () => [...tables.keys()],
    load() {
      let loaded = 0;
      let skippedCorrupt = 0;
      if (!filePath || !existsSync(filePath)) return { loaded, skippedCorrupt };
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [worldId, table] of Object.entries(raw as Record<string, unknown>)) {
            const clean = sanitizeScheduleTable(table);
            if (clean) {
              tables.set(worldId, clean);
              loaded++;
            } else {
              skippedCorrupt++;
            }
          }
        } else {
          skippedCorrupt++;
        }
      } catch {
        skippedCorrupt++;
      }
      return { loaded, skippedCorrupt };
    },
    writeFailures: () => failures,
  };
}

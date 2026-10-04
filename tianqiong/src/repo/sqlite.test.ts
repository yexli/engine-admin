/* SqliteRepository：写穿队列（快照合并）+ 内存镜像 + 错误可见（F-20） */
import { describe, expect, it } from 'vitest';
import { SqliteRepository, type SqlDb } from './sqlite';
import type { WorldState } from '@/types/world';

function fakeDb(log: string[]) {
  const db: SqlDb = {
    execute: async (sql) => {
      log.push(sql.slice(0, 20));
    },
    select: async <T>() => [] as T,
  };
  return db;
}

const s0 = { ver: 1, player: { gold: 100 } } as unknown as WorldState;

describe('SqliteRepository', () => {
  it('save 立即更新镜像并可同步读取；flush 后落库完成', async () => {
    const log: string[] = [];
    const repo = new SqliteRepository(fakeDb(log));
    expect(repo.load()).toBeNull();
    repo.save(s0);
    expect(repo.load()).toBe(s0); // 内存镜像即时可读（同步契约）
    await repo.flush();
    expect(log.length).toBe(1);
    expect(log[0]).toContain('INSERT INTO saves');
  });

  it('连续 save 合并为一次落库，写的是最后一次快照（F-20）', async () => {
    const rows: unknown[][] = [];
    const db: SqlDb = {
      execute: async (_sql, args) => {
        rows.push(args || []);
      },
      select: async <T>() => [] as T,
    };
    const repo = new SqliteRepository(db);
    repo.save({ ...s0, ver: 2 } as WorldState);
    repo.save({ ...s0, ver: 3 } as WorldState);
    repo.save({ ...s0, ver: 4 } as WorldState);
    await repo.flush();
    expect(rows.length).toBe(1); // 一条操作链只 UPSERT 一次
    expect(rows[0][1]).toBe(4); // ver 取最后一次
    expect(String(rows[0][3])).toContain('"ver":4');
  });

  it('写失败可见：lastError 非空、onError 报一次、脏标记保留待重试（F-20）', async () => {
    let calls = 0;
    let broken = true;
    const db: SqlDb = {
      execute: async () => {
        calls++;
        if (broken) throw new Error('disk full');
      },
      select: async <T>() => [] as T,
    };
    const msgs: string[] = [];
    const repo = new SqliteRepository(db);
    repo.onError = (m) => msgs.push(m);
    repo.save(s0);
    await repo.flush();
    expect(repo.errorState()).toContain('disk full');
    expect(msgs.length).toBe(1); // 30s 节流：同一次故障不刷屏

    broken = false;
    await repo.flush(); // 脏数据自动重试
    expect(repo.errorState()).toBeNull();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('clear 抹除镜像并删除行', async () => {
    const log: string[] = [];
    const repo = new SqliteRepository(fakeDb(log));
    repo.save(s0);
    repo.clear();
    expect(repo.load()).toBeNull();
    await repo.flush();
    expect(log.some((x) => x.startsWith('DELETE FROM'))).toBe(true);
  });
});

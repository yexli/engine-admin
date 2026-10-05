/* P2 卡片4：Journal get 磁盘回退——超窗 run 因果链不断裂 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvolutionJournal } from '../src/evolution/journal.ts';
import type { EvolutionRun } from '../src/evolution/types.ts';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'evolution-journal-'));
}

function run(worldId: string, i: number): EvolutionRun {
  return {
    id: `evo_${worldId}_${i}`,
    worldId,
    startedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    status: 'completed',
    trigger: 'admin',
    observationWindow: { eventCount: 5 },
    eventIds: [`evt_${i}`],
  };
}

describe('Evolution Journal 磁盘回退（P2 卡片4）', () => {
  it('超窗 run 经磁盘回退可查（get 不返回 null）', () => {
    const dir = tmpDir();
    const j = createEvolutionJournal({ dir, ringCap: 5 }); /* 实现下限 10 → 环容量 10 */
    j.load();
    for (let i = 0; i < 15; i++) j.append(run('w1', i)); /* 前 5 条被挤出环 */
    expect(j.recent('w1', 20)).toHaveLength(10); /* 环内只剩最近 10 条 */
    expect(j.get('w1', 'evo_w1_0')).not.toBeNull(); /* 磁盘回退命中 */
    expect(j.get('w1', 'evo_w1_0')!.status).toBe('completed');
    expect(j.get('w1', 'evo_w1_14')!.id).toBe('evo_w1_14'); /* 环内热路径不受影响 */
    rmSync(dir, { recursive: true, force: true });
  });

  it('磁盘回退取终态行（同 run 的 running 中间态被终态覆盖）', () => {
    const dir = tmpDir();
    const j = createEvolutionJournal({ dir, ringCap: 3 });
    j.load();
    const r = { ...run('w1', 0), status: 'running' as const };
    j.append(r);
    j.append({ ...r, status: 'partially_applied' as const, finishedAt: new Date().toISOString() }); /* 同 id 终态 */
    for (let i = 1; i < 12; i++) j.append(run('w1', i)); /* 挤出环 */
    expect(j.get('w1', 'evo_w1_0')!.status).toBe('partially_applied');
    rmSync(dir, { recursive: true, force: true });
  });

  it('磁盘回退结果缓存（第二次 get 结果一致）', () => {
    const dir = tmpDir();
    const j = createEvolutionJournal({ dir, ringCap: 2 });
    j.load();
    for (let i = 0; i < 12; i++) j.append(run('w1', i));
    const first = j.get('w1', 'evo_w1_0');
    const second = j.get('w1', 'evo_w1_0');
    expect(second).toEqual(first); /* 缓存命中，不重复读文件 */
    rmSync(dir, { recursive: true, force: true });
  });

  it('无 dir 配置时超窗 get 仍返回 null（向后兼容）', () => {
    const j = createEvolutionJournal({ ringCap: 2 }); /* 环容量 10 */
    for (let i = 0; i < 15; i++) j.append(run('w1', i));
    expect(j.get('w1', 'evo_w1_0')).toBeNull(); /* 已挤出环且无磁盘通道 */
    expect(j.get('w1', 'evo_w1_14')).not.toBeNull();
  });

  it('未知 runId / 未知世界 → null（磁盘回退不误报）', () => {
    const dir = tmpDir();
    const j = createEvolutionJournal({ dir, ringCap: 5 });
    j.load();
    j.append(run('w1', 0));
    expect(j.get('w1', 'evo_nope')).toBeNull();
    expect(j.get('w2', 'evo_w1_0')).toBeNull(); /* worldId 不匹配（防串档） */
    rmSync(dir, { recursive: true, force: true });
  });
});

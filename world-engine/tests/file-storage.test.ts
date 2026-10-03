/* G3 · FileSavePort：文件介质持久化——原子写 / 防抖 / 重启接续 / 损坏不静默覆盖 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorld } from '../src/index';
import { FileSavePort } from '../src/state/fileStorage.ts';

const dirs: string[] = [];
const tempFile = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'we-filesave-'));
  dirs.push(dir);
  return join(dir, name);
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('G3 · FileSavePort', () => {
  it('save→flush 落盘；新实例 load 接续（重启语义）；防抖期内不写盘', async () => {
    const path = tempFile('w.json');
    const port = new FileSavePort(path, { debounceMs: 60_000 }); /* 防抖拉满：不 flush 就不该有文件 */
    port.save({ tick: 1, day: 1 } as never);
    expect(existsSync(path)).toBe(false);

    port.flush();
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ tick: 1 });

    /* "重启"：新实例从盘上读回 */
    const reborn = new FileSavePort(path);
    expect(reborn.load()).toMatchObject({ tick: 1 });
    reborn.dispose();
    port.dispose();
  });

  it('createWorld 装配：落档→重启→时间接续；元数据随档往返', async () => {
    const path = tempFile('world.json');
    const port = new FileSavePort(path, { debounceMs: 50_000 });
    const first = createWorld({ worldId: 'w-disk', savePort: port });
    const before = first.query.get_time()!.tick;
    first.advanceTime(7);
    (first.getState() as { metadata?: unknown }).metadata = { name: '盘上世界' };
    first.container.flushSave(); /* 引擎侧：绕过节流窗口立即打包存档 */
    port.flush(); /* 介质侧：把挂起快照写盘（写后置，不赌防抖定时器） */

    /* "重启"：载入编排是宿主职责（正典模式）——读档 → 新世界 → 注入容器 */
    const saved = port.load();
    expect(saved).not.toBeNull();
    const reborn = createWorld({ worldId: 'w-disk', savePort: port });
    reborn.container.core.S = saved!;
    expect(reborn.query.get_time()!.tick).toBe(before + 7); /* 推进不丢 */
    expect((reborn.getState() as { metadata?: { name?: string } }).metadata?.name).toBe('盘上世界');
  });

  it('损坏档：备份 *.corrupt-<ts>、报 onError、返回 null（不静默覆盖）', () => {
    const path = tempFile('broken.json');
    writeFileSync(path, '{ this is not json', 'utf8');
    const errors: string[] = [];
    const port = new FileSavePort(path, { onError: (m) => errors.push(m) });

    expect(port.load()).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    const backup = errors[0]!.match(/备份：(.+?)（/)?.[1] ?? '';
    expect(backup).toContain('.corrupt-');
    expect(existsSync(backup)).toBe(true);

    /* 后续 save 写的是新档，坏档备份仍在 */
    port.save({ tick: 9 } as never);
    port.flush();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ tick: 9 });
    expect(existsSync(backup)).toBe(true);
    port.dispose();
  });

  it('clear 删档；dispose 冲刷挂起数据并摘除退出钩子；原子写不留 tmp', () => {
    const path = tempFile('w2.json');
    const port = new FileSavePort(path, { debounceMs: 60_000 });
    port.save({ tick: 2 } as never);
    port.dispose(); /* dispose 内部 flush */
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);

    port.clear();
    expect(existsSync(path)).toBe(false);

    const before = process.listenerCount('exit');
    const p2 = new FileSavePort(tempFile('w3.json'));
    expect(process.listenerCount('exit')).toBe(before + 1);
    p2.dispose();
    expect(process.listenerCount('exit')).toBe(before);
  });
});

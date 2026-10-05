/* KeyStore 单测：创建/验证/撤销/过期/持久化 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore, hashKey, normalizePermissions } from '../src/keys/keystore.ts';

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-keys-'));
  return join(dir, name);
}

describe('KeyStore', () => {
  it('创建 → 验证往返；明文不出现在落盘文件里', () => {
    const file = tmpFile('keys.json');
    const store = new KeyStore(file);
    const { record, plaintext } = store.create({ name: 'demo' });

    expect(plaintext.startsWith('sk-world-')).toBe(true);
    expect(record.keyHash).toBe(hashKey(plaintext));
    expect(record.tenantId).toBe('default');

    store.flush();
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(plaintext);
    expect(raw).toContain(record.keyHash);

    expect(store.verify(plaintext)?.id).toBe(record.id);
  });

  it('未知密钥 / 删除 / 过期 → verify 返回 null', () => {
    const file = tmpFile('keys.json');
    let now = 1_000_000;
    const store = new KeyStore(file, undefined, () => now);

    expect(store.verify('sk-world-nope')).toBeNull();

    const { plaintext, record } = store.create({
      name: 'expiring',
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    expect(store.verify(plaintext)?.id).toBe(record.id);

    now += 61_000;
    expect(store.verify(plaintext)).toBeNull(); // 过期

    const { plaintext: p2, record: r2 } = store.create({ name: 'to-delete' });
    expect(store.verify(p2)).not.toBeNull();
    expect(store.remove(r2.id)).toBe(true);
    expect(store.remove(r2.id)).toBe(false); // 幂等：已不存在
    expect(store.verify(p2)).toBeNull(); // 删除（硬删，哈希已移除）
    expect(store.list().some((k) => k.id === r2.id)).toBe(false);
    rmSync(file, { force: true });
  });

  it('权限规范化：未知项过滤；空 → 默认全量', () => {
    expect(normalizePermissions(['chat:completions', 'hack:root'])).toEqual(['chat:completions']);
    expect(normalizePermissions(undefined).sort()).toEqual(
      ['chat:completions', 'embeddings', 'worlds:read', 'worlds:write'].sort(),
    );
  });

  it('持久化往返：新实例读同一文件可验证', () => {
    const file = tmpFile('keys.json');
    const a = new KeyStore(file);
    const { plaintext } = a.create({ name: 'persist' });
    a.flush();

    const b = new KeyStore(file);
    expect(b.verify(plaintext)?.name).toBe('persist');
    rmSync(file, { force: true });
  });

  it('setExpiresAt：设置后立即失效、清除后恢复；未知 id → false（M2.1）', () => {
    const file = tmpFile('keys.json');
    let now = 1_000_000;
    const store = new KeyStore(file, undefined, () => now);
    const { plaintext, record } = store.create({ name: 'exp' });

    expect(store.setExpiresAt('key-nope', new Date(now).toISOString())).toBe(false);
    expect(store.setExpiresAt(record.id, new Date(now + 1_000).toISOString())).toBe(true);
    now += 2_000;
    expect(store.verify(plaintext)).toBeNull(); // 已过期

    expect(store.setExpiresAt(record.id, null)).toBe(true);
    expect(store.verify(plaintext)?.name).toBe('exp'); // 清除后恢复
    rmSync(file, { force: true });
  });

  it('bootstrap 主密钥可验证且不落盘', () => {
    const file = tmpFile('keys.json');
    const store = new KeyStore(file, 'sk-world-master');
    expect(store.verify('sk-world-master')?.id).toBe('bootstrap');
    const { plaintext } = store.create({ name: 'regular' }); // 触发一次真实落盘
    store.flush();
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('sk-world-master');
    expect(raw).toContain(hashKey(plaintext));
    rmSync(file, { force: true });
  });

  it('exit 钩子兜底（P2 卡片2）：防抖窗口内 kill 不丢数据', () => {
    const file = tmpFile('keys-exit.json');
    const store = new KeyStore(file);
    const { plaintext } = store.create({ name: 'crash-window' });
    /* 防抖窗口内不 flush：此刻文件尚无该 key */
    expect(() => readFileSync(file, 'utf8')).toThrow();
    /* 进程退出事件触发钩子 → 同步落盘 */
    process.emit('exit', 0);
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain(hashKey(plaintext));
    const store2 = new KeyStore(file);
    expect(store2.verify(plaintext)?.name).toBe('crash-window');
    store2.dispose();
    rmSync(file, { force: true });
  });

  it('dispose 释放钩子后 exit 不再触发 flush；dispose 本身落盘', () => {
    const file = tmpFile('keys-dispose.json');
    let flushed = 0;
    const store = new KeyStore(file, undefined, () => Date.now(), () => {
      flushed++;
    });
    store.create({ name: 'before-dispose' });
    store.dispose(); // 释放钩子并同步落盘一次
    const afterDispose = flushed;
    expect(afterDispose).toBeGreaterThan(0);
    store.create({ name: 'after-dispose' });
    process.emit('exit', 0); // 钩子已移除：不再冲刷
    expect(flushed).toBe(afterDispose);
    rmSync(file, { force: true });
  });
});

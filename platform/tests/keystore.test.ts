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
    expect(record.status).toBe('active');
    expect(record.tenantId).toBe('default');

    store.flush();
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(plaintext);
    expect(raw).toContain(record.keyHash);

    expect(store.verify(plaintext)?.id).toBe(record.id);
  });

  it('未知密钥 / 撤销 / 过期 → verify 返回 null', () => {
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

    const { plaintext: p2 } = store.create({ name: 'to-revoke' });
    expect(store.verify(p2)).not.toBeNull();
    const rec = store.list().find((k) => k.name === 'to-revoke');
    expect(rec && store.revoke(rec.id)).toBe(true);
    expect(store.verify(p2)).toBeNull(); // 撤销
    rmSync(file, { force: true });
  });

  it('权限规范化：未知项过滤；空 → 默认全量', () => {
    expect(normalizePermissions(['chat:completions', 'hack:root'])).toEqual(['chat:completions']);
    expect(normalizePermissions(undefined).sort()).toEqual(
      ['chat:completions', 'worlds:read', 'worlds:write'].sort(),
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
});

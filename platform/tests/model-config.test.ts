/* ============================================================
   Task 1 测试：ModelConfigStore + SecretStore
   ------------------------------------------------------------
   覆盖：损坏文件拒绝、revision 冲突、重复/悬挂引用、禁用模型路由、
   缺失凭证、免密本地供应商、脱敏投影、URL 策略、原子写与备份、
   密钥加密往返与明文不出盘。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigCorruptError,
  ModelConfigStore,
  RevisionConflictError,
  redactConfig,
  validateEndpointUrl,
} from '../src/admin/model-config.ts';
import type { EndpointPolicy, ModelConfig } from '../src/admin/model-config.ts';
import { SecretStore } from '../src/admin/secrets.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  store: ModelConfigStore;
  secrets: SecretStore;
  configPath: string;
}

function harness(policy: EndpointPolicy = { allowLoopback: true }): Harness {
  const configPath = join(dir, 'model-config.json');
  const secrets = new SecretStore(join(dir, 'secrets.json'), 'test-master-key-0123456789');
  const store = new ModelConfigStore({ filePath: configPath, secrets, endpointPolicy: policy });
  store.load();
  return { store, secrets, configPath };
}

/** 构造一个完整可提交的候选：供应商（禁用、密钥型）+ 模型（禁用） */
function candidateWithModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    providers: [
      { id: 'prov-ds', name: 'deepseek', endpoint: 'https://api.deepseek.com/v1', auth: { kind: 'secret' }, enabled: false },
    ],
    models: [
      { id: 'mdl-ds-chat', providerId: 'prov-ds', wireModel: 'deepseek-chat', tags: ['fast', 'cheap'], enabled: false },
    ],
    routes: {
      roleplay: { primary: null, fallback: null },
      narrative: { primary: null, fallback: null },
      reasoning: { primary: null, fallback: null },
      fast: { primary: null, fallback: null },
      cheap: { primary: null, fallback: null },
      memory: { primary: null, fallback: null },
    },
    ...overrides,
  };
}

/* 思考强度（M5 后特性）：厂商按 wireModel 检测；档位不支持 422、合法往返 */
describe('ModelConfigStore · thinking 字段', () => {
  it('合法档位往返（glm + medium）；不支持的档位 422（glm + high）；非法值 422', () => {
    const h = harness();

    const ok = h.store.commit(
      candidateWithModel({
        models: [
          {
            id: 'mdl-glm',
            providerId: 'prov-ds',
            wireModel: 'glm-4.6',
            tags: ['fast'],
            enabled: false,
            thinking: 'medium',
          },
        ],
      }),
      0,
    );
    expect(ok.models[0]!.thinking).toBe('medium');
    /* 往返：文件重载后仍保留 */
    const h2 = harness();
    writeFileSync(h2.configPath, readFileSync(h.configPath, 'utf8'));
    h2.store.load();
    expect(h2.store.current().models[0]!.thinking).toBe('medium');

    const unsupported = () =>
      h.store.commit(
        candidateWithModel({
          models: [
            { id: 'mdl-glm', providerId: 'prov-ds', wireModel: 'glm-4.6', tags: ['fast'], enabled: false, thinking: 'high' },
          ],
        }),
        h.store.current().revision,
      );
    expect(unsupported).toThrowError(/不被厂商/);

    const badLevel = () =>
      h.store.commit(
        candidateWithModel({
          models: [
            { id: 'mdl-glm', providerId: 'prov-ds', wireModel: 'glm-4.6', tags: ['fast'], enabled: false, thinking: 'ultra' },
          ],
        }),
        h.store.current().revision,
      );
    expect(badLevel).toThrowError(/off\/low\/medium\/high/);
  });
});

describe('SecretStore（AES-256-GCM 加密存储）', () => {
  it('put → resolve 往返一致；落盘文件不含明文', () => {
    const secrets = new SecretStore(join(dir, 'secrets.json'), 'master-key-abcdef');
    const id = secrets.put('sk-upstream-秘密值-123456');
    expect(id).toMatch(/^sec-/);
    expect(secrets.resolve(id)).toBe('sk-upstream-秘密值-123456');

    const raw = readFileSync(join(dir, 'secrets.json'), 'utf8');
    expect(raw).not.toContain('sk-upstream-秘密值');
  });

  it('每次 put 产生新 id，旧 id 仍可解析（回滚依据）', () => {
    const secrets = new SecretStore(join(dir, 'secrets.json'), 'master-key-abcdef');
    const id1 = secrets.put('first-secret');
    const id2 = secrets.put('second-secret');
    expect(id1).not.toBe(id2);
    expect(secrets.resolve(id1)).toBe('first-secret');
    expect(secrets.resolve(id2)).toBe('second-secret');
  });

  it('未知 id → null；错误主密钥 → 显式报错（不含明文）', () => {
    const secrets = new SecretStore(join(dir, 'secrets.json'), 'master-key-abcdef');
    const id = secrets.put('value-1');
    expect(secrets.resolve('sec-nonexistent')).toBeNull();

    const other = new SecretStore(join(dir, 'secrets.json'), 'wrong-master-key');
    expect(() => other.resolve(id)).toThrow(/主密钥/);
  });

  it('缺失/空主密钥 → 构造即失败（受管启动 fail-fast）', () => {
    expect(() => new SecretStore(join(dir, 's.json'), '')).toThrow(/主密钥/);
    expect(() => new SecretStore(join(dir, 's.json'), '   ')).toThrow(/主密钥/);
  });

  it('密钥文件损坏 → 拒绝加载而非静默重建', () => {
    const path = join(dir, 'secrets.json');
    writeFileSync(path, '{ not json', 'utf8');
    expect(() => new SecretStore(path, 'master-key-abcdef')).toThrow(ConfigCorruptError);
  });

  it('重启后（新实例）仍可解析', () => {
    const path = join(dir, 'secrets.json');
    const first = new SecretStore(path, 'master-key-abcdef');
    const id = first.put('persist-me');
    const second = new SecretStore(path, 'master-key-abcdef');
    expect(second.resolve(id)).toBe('persist-me');
  });
});

describe('validateEndpointUrl（特权输入：上游端点校验）', () => {
  const base: EndpointPolicy = { allowLoopback: true };

  it('接受 http/https；拒绝其他协议、凭据、fragment', () => {
    expect(validateEndpointUrl('https://api.deepseek.com/v1', base).protocol).toBe('https:');
    expect(validateEndpointUrl('http://127.0.0.1:11434/v1', base).hostname).toBe('127.0.0.1');
    expect(() => validateEndpointUrl('ftp://api.example.com', base)).toThrow();
    expect(() => validateEndpointUrl('https://u:p@api.example.com/v1', base)).toThrow(/凭据/);
    expect(() => validateEndpointUrl('https://api.example.com/v1#frag', base)).toThrow(/fragment/i);
    expect(() => validateEndpointUrl('not a url', base)).toThrow();
  });

  it('环回/内网地址缺省拒绝，allowLoopback 显式放行', () => {
    const strict: EndpointPolicy = {};
    expect(() => validateEndpointUrl('http://localhost:11434/v1', strict)).toThrow(/环回|内网|私有/);
    expect(() => validateEndpointUrl('http://192.168.1.10/v1', strict)).toThrow();
    expect(() => validateEndpointUrl('http://127.0.0.1:8123/v1', strict)).toThrow();
    expect(() => validateEndpointUrl('http://127.0.0.1:8123/v1', { allowLoopback: true })).not.toThrow();
  });

  it('host 允许列表：名单内放行（含显式放行的本地推理服务器），名单外拒绝', () => {
    const policy: EndpointPolicy = { allowedHosts: ['api.deepseek.com', '127.0.0.1'] };
    expect(() => validateEndpointUrl('https://api.deepseek.com/v1', policy)).not.toThrow();
    expect(() => validateEndpointUrl('http://127.0.0.1:11434/v1', policy)).not.toThrow();
    expect(() => validateEndpointUrl('https://api.openai.com/v1', policy)).toThrow(/允许列表/);
  });
});

describe('ModelConfigStore（版本化配置 + 原子替换）', () => {
  it('首次 load 初始化空配置：revision 0、六能力路由全 null', () => {
    const { store, configPath } = harness();
    const cfg = store.current();
    expect(cfg.revision).toBe(0);
    expect(cfg.providers).toEqual([]);
    expect(cfg.routes.roleplay).toEqual({ primary: null, fallback: null });
    expect(cfg.routes.memory).toEqual({ primary: null, fallback: null });
    expect(existsSync(configPath)).toBe(true);
  });

  it('损坏配置文件 → load 抛错，不静默回退到想象中的演示模型', () => {
    const configPath = join(dir, 'model-config.json');
    writeFileSync(configPath, '{{{ broken', 'utf8');
    const secrets = new SecretStore(join(dir, 'secrets.json'), 'master-key-abcdef');
    const store = new ModelConfigStore({ filePath: configPath, secrets });
    expect(() => store.load()).toThrow(ConfigCorruptError);
  });

  it('合法提交：密钥引用合并、revision 前进、磁盘无明文凭证', () => {
    const h = harness();
    const committed = h.store.commit(candidateWithModel(), 0);
    expect(committed.revision).toBe(1);

    /* 上传凭证（独立写路径）后启用供应商与模型并指派路由 */
    const withCred = h.store.setProviderCredential('prov-ds', 'sk-real-secret-999');
    expect(withCred.revision).toBe(2);

    const next = candidateWithModel({
      providers: [
        { id: 'prov-ds', name: 'deepseek', endpoint: 'https://api.deepseek.com/v1', auth: { kind: 'secret' }, enabled: true },
      ],
      models: [
        { id: 'mdl-ds-chat', providerId: 'prov-ds', wireModel: 'deepseek-chat', tags: ['fast', 'cheap'], enabled: true },
      ],
      routes: {
        roleplay: { primary: null, fallback: null },
        narrative: { primary: 'mdl-ds-chat', fallback: null },
        reasoning: { primary: null, fallback: null },
        fast: { primary: 'mdl-ds-chat', fallback: null },
        cheap: { primary: 'mdl-ds-chat', fallback: null },
        memory: { primary: null, fallback: null },
      },
    });
    const committed2 = h.store.commit(next, 2);
    expect(committed2.revision).toBe(3);
    expect(committed2.providers[0]!.auth).toMatchObject({ kind: 'secret' });
    expect((committed2.providers[0]!.auth as { secretId?: string }).secretId).toMatch(/^sec-/);

    const raw = readFileSync(h.configPath, 'utf8');
    expect(raw).not.toContain('sk-real-secret-999');
    expect(raw).toContain('sec-');

    /* 重新 load：凭证引用仍可解析 */
    const reloaded = new ModelConfigStore({
      filePath: h.configPath,
      secrets: new SecretStore(join(dir, 'secrets.json'), 'test-master-key-0123456789'),
      endpointPolicy: { allowLoopback: true },
    });
    reloaded.load();
    expect(reloaded.current().revision).toBe(3);
  });

  it('revision 冲突（If-Match 失败）→ 抛错且磁盘与快照不变', () => {
    const h = harness();
    h.store.commit(candidateWithModel(), 0);
    const before = readFileSync(h.configPath, 'utf8');

    expect(() => h.store.commit(candidateWithModel(), 0)).toThrow(RevisionConflictError);
    expect(readFileSync(h.configPath, 'utf8')).toBe(before);
    expect(h.store.current().revision).toBe(1);
  });

  it('校验失败 → 原子性：活动快照与磁盘都不变', () => {
    const h = harness();
    const good = candidateWithModel();
    h.store.commit(good, 0);
    const before = readFileSync(h.configPath, 'utf8');

    const bad = candidateWithModel({ providers: [{ id: 'prov-x', name: 'x', endpoint: 'ftp://bad', auth: { kind: 'none' }, enabled: false }] });
    expect(() => h.store.commit(bad, 1)).toThrow(/endpoint/);
    expect(readFileSync(h.configPath, 'utf8')).toBe(before);
    expect(h.store.current().providers[0]!.id).toBe('prov-ds');
  });

  it('重复模型 ID、悬挂引用（模型→供应商、路由→模型）被拒绝', () => {
    const h = harness();
    const dup = candidateWithModel({
      models: [
        { id: 'mdl-a', providerId: 'prov-ds', wireModel: 'x', tags: ['fast'], enabled: false },
        { id: 'mdl-a', providerId: 'prov-ds', wireModel: 'y', tags: ['fast'], enabled: false },
      ],
    });
    expect(() => h.store.commit(dup, 0)).toThrow(/重复/);

    const danglingProvider = candidateWithModel({
      models: [{ id: 'mdl-a', providerId: 'prov-ghost', wireModel: 'x', tags: ['fast'], enabled: false }],
    });
    expect(() => h.store.commit(danglingProvider, 0)).toThrow(/prov-ghost/);

    const danglingRoute = candidateWithModel({
      routes: {
        roleplay: { primary: 'mdl-ghost', fallback: null },
        narrative: { primary: null, fallback: null },
        reasoning: { primary: null, fallback: null },
        fast: { primary: null, fallback: null },
        cheap: { primary: null, fallback: null },
        memory: { primary: null, fallback: null },
      },
    });
    expect(() => h.store.commit(danglingRoute, 0)).toThrow(/mdl-ghost/);
  });

  it('路由指向禁用模型被拒绝；缺凭证的启用供应商被拒绝；新供应商可先建禁用态', () => {
    const h = harness();
    h.store.commit(candidateWithModel(), 0);
    h.store.setProviderCredential('prov-ds', 'sk-have-cred');
    const rev = (): number => h.store.current().revision;

    /* 提交时模型仍是禁用态，但路由指向它 → 拒绝 */
    const routeToDisabled = candidateWithModel({
      routes: {
        roleplay: { primary: 'mdl-ds-chat', fallback: null },
        narrative: { primary: null, fallback: null },
        reasoning: { primary: null, fallback: null },
        fast: { primary: null, fallback: null },
        cheap: { primary: null, fallback: null },
        memory: { primary: null, fallback: null },
      },
    });
    expect(() => h.store.commit(routeToDisabled, rev())).toThrow(/禁用/);

    /* 启用供应商但还没有凭证（candidate 携带的 secretId 应被忽略）→ 拒绝 */
    const enabledWithoutCred = candidateWithModel({
      providers: [
        { id: 'prov-fresh', name: 'fresh', endpoint: 'https://api.example.com/v1', auth: { kind: 'secret', secretId: 'sec-forged' }, enabled: true },
      ],
      models: [],
    });
    expect(() => h.store.commit(enabledWithoutCred, rev())).toThrow(/凭证/);

    /* 新供应商禁用态 + 无凭证 → 允许（先建档后补密钥的工作流） */
    expect(() => h.store.commit(candidateWithModel(), rev())).not.toThrow();
  });

  it('提交时忽略传入的 secretId，保留既有密钥引用（防伪造）', () => {
    const h = harness();
    h.store.commit(candidateWithModel(), 0);
    h.store.setProviderCredential('prov-ds', 'sk-keep-me');
    const before = h.store.current().providers[0]!.auth as { secretId?: string };

    const forged = candidateWithModel({
      providers: [
        { id: 'prov-ds', name: 'deepseek', endpoint: 'https://api.deepseek.com/v1', auth: { kind: 'secret', secretId: 'sec-attacker' }, enabled: false },
      ],
    });
    const committed = h.store.commit(forged, h.store.current().revision);
    expect((committed.providers[0]!.auth as { secretId?: string }).secretId).toBe(before.secretId);
    expect((committed.providers[0]!.auth as { secretId?: string }).secretId).not.toBe('sec-attacker');
  });

  it('免密本地供应商（auth none + 环回端点）可直接启用', () => {
    const h = harness();
    const local = candidateWithModel({
      providers: [
        { id: 'prov-local', name: 'ollama', endpoint: 'http://127.0.0.1:11434/v1', auth: { kind: 'none' }, enabled: true },
      ],
      models: [{ id: 'mdl-qwen', providerId: 'prov-local', wireModel: 'qwen3:8b', tags: ['fast'], enabled: true }],
    });
    const committed = h.store.commit(local, 0);
    expect(committed.providers[0]!.auth).toEqual({ kind: 'none' });
  });

  it('上次 revision 备份可用（回滚依据），旧密钥版本仍可解析', () => {
    const h = harness();
    h.store.commit(candidateWithModel(), 0); /* rev1：无凭证 */
    h.store.setProviderCredential('prov-ds', 'sk-have-cred'); /* rev2：凭证 A */
    const firstAuth = h.store.current().providers[0]!.auth as { secretId?: string };

    const updated = candidateWithModel({
      models: [{ id: 'mdl-ds-chat', providerId: 'prov-ds', wireModel: 'deepseek-chat', tags: ['narrative'], enabled: false }],
    });
    h.store.commit(updated, h.store.current().revision); /* rev3：引用合并保留 A */
    expect(h.store.current().revision).toBe(3);

    const bak = JSON.parse(readFileSync(`${h.configPath}.bak`, 'utf8')) as ModelConfig;
    expect(bak.revision).toBe(2);
    expect(bak.models[0]!.tags).toEqual(['fast', 'cheap']);

    /* 换新凭证后，旧凭证引用仍可解析 → 可整体回滚到旧版本 */
    h.store.setProviderCredential('prov-ds', 'sk-v2-credential'); /* rev4：凭证 B */
    const secondAuth = h.store.current().providers[0]!.auth as { secretId?: string };
    expect(secondAuth.secretId).not.toBe(firstAuth.secretId);
    expect(h.secrets.resolve(firstAuth.secretId!)).toBe('sk-have-cred');
  });

  it('脱敏投影：auth 收缩为 {kind, hasCredential}，绝不出现 secretId', () => {
    const h = harness();
    h.store.commit(candidateWithModel(), 0);
    h.store.setProviderCredential('prov-ds', 'sk-view-test');

    const view = redactConfig(h.store.current());
    const text = JSON.stringify(view);
    expect(text).not.toContain('secretId');
    expect(text).not.toContain('sk-view-test');
    const p = view.providers[0]!;
    expect(p.auth).toEqual({ kind: 'secret', hasCredential: true });

    const noneProvider = candidateWithModel({
      providers: [{ id: 'prov-none', name: 'n', endpoint: 'http://127.0.0.1:9/v1', auth: { kind: 'none' }, enabled: false }],
      models: [],
    });
    h.store.commit(noneProvider, h.store.current().revision);
    const view2 = redactConfig(h.store.current());
    expect(view2.providers.find((x) => x.id === 'prov-none')!.auth).toEqual({ kind: 'none', hasCredential: false });
  });

  it('模型标签必须是 Gateway 既有标签词表；路由六能力键齐全', () => {
    const h = harness();
    const badTag = candidateWithModel({
      models: [{ id: 'mdl-t', providerId: 'prov-ds', wireModel: 'x', tags: ['telepathy'], enabled: false }],
    });
    expect(() => h.store.commit(badTag, 0)).toThrow(/标签/);

    const missingKey = candidateWithModel();
    delete (missingKey.routes as Record<string, unknown>).memory;
    expect(() => h.store.commit(missingKey, 0)).toThrow(/memory/);
  });

  it('mkdir：数据目录不存在时自动创建', () => {
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const configPath = join(nested, 'model-config.json');
    const secrets = new SecretStore(join(nested, 'secrets.json'), 'master-key-abcdef');
    const store = new ModelConfigStore({ filePath: configPath, secrets });
    store.load();
    expect(store.current().revision).toBe(0);
  });
});

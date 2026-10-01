/* ============================================================
   模型配置存储（Model Control Plane · Task 1）
   ------------------------------------------------------------
   平台拥有的一份版本化配置文档（providers / models / routes）：
   · validate：纯校验（URL 策略、引用完整性、启用一致性、密钥可用性）；
   · commit：If-Match revision 冲突检测 → 密钥引用合并（忽略提交方
     携带的 secretId，防伪造）→ 同目录临时文件 + rename 原子替换 →
     保留上一版本 .bak（回滚依据）→ 换活动快照；
   · setProviderCredential：独立凭证写路径——新加密记录 + 新引用，
     推进 revision；旧引用保留可解析（回滚）。
   落盘 JSON 只含 secretId 引用，绝无上游凭证明文。
   ============================================================ */
import { existsSync, readFileSync } from 'node:fs';
import { CAPABILITY_TAGS } from 'world-gateway';
import type { Capability } from '../types.ts';
import { atomicWrite, SecretStore } from './secrets.ts';
import { ConfigCorruptError, ConfigValidationError, RevisionConflictError } from './errors.ts';
import { THINKING_LEVELS, detectVendor, isThinkingLevel, vendorSupportsLevel, thinkingMeta, type ThinkingLevel } from './vendors.ts';

export { ConfigCorruptError, ConfigValidationError, RevisionConflictError } from './errors.ts';

/** 托管路由的六个能力键（= Platform Capability 联合；与 docs 方案一致） */
export const MANAGED_CAPABILITIES = [
  'roleplay',
  'narrative',
  'reasoning',
  'fast',
  'cheap',
  'memory',
] as const satisfies readonly Capability[];
export type ManagedCapability = (typeof MANAGED_CAPABILITIES)[number];

/** 模型标签词表 = world-gateway 既有 CAPABILITY_TAGS（防两处漂移） */
export const ALLOWED_TAGS: readonly string[] = CAPABILITY_TAGS;

export const MAX_PROVIDERS = 64;
export const MAX_MODELS = 256;

export type ProviderAuth = { kind: 'secret'; secretId?: string } | { kind: 'none' };

export interface ModelConfigProvider {
  id: string;
  name: string;
  /** OpenAI 兼容 base URL（不含 /chat/completions） */
  endpoint: string;
  auth: ProviderAuth;
  enabled: boolean;
}

export interface ModelConfigModel {
  /** 稳定内部 ID（路由引用它，非上游 wire 名） */
  id: string;
  providerId: string;
  /** 出站时发送的上游模型串 */
  wireModel: string;
  tags: string[];
  enabled: boolean;
  /** 思考强度（可选；出站由厂商适配器翻译成各家请求字段，见 admin/vendors.ts） */
  thinking?: ThinkingLevel;
}

export interface CapabilityRouteValue {
  primary: string | null;
  fallback: string | null;
}

export interface ModelConfig {
  version: 1;
  revision: number;
  providers: ModelConfigProvider[];
  models: ModelConfigModel[];
  routes: Record<ManagedCapability, CapabilityRouteValue>;
}

/* ---------------- 脱敏投影（GET 响应形状；绝无 secretId） ---------------- */

export interface RedactedAuth {
  kind: 'secret' | 'none';
  hasCredential: boolean;
}

export interface RedactedProvider {
  id: string;
  name: string;
  endpoint: string;
  auth: RedactedAuth;
  enabled: boolean;
}

export interface ThinkingMeta {
  levels: ThinkingLevel[];
  vendors: {
    id: string;
    label: string;
    /** wireModel 前缀（前端本地检测用） */
    match: string[];
    levels: ThinkingLevel[];
    hints: Partial<Record<ThinkingLevel, string>>;
  }[];
}

export interface RedactedModelConfig {
  version: 1;
  revision: number;
  providers: RedactedProvider[];
  models: ModelConfigModel[];
  routes: Record<ManagedCapability, CapabilityRouteValue>;
  /** 思考强度元数据（服务端下发 → 前端零改动扩展） */
  thinking: ThinkingMeta;
}

export function redactConfig(config: ModelConfig): RedactedModelConfig {
  return {
    version: 1,
    revision: config.revision,
    providers: config.providers.map((p) => ({
      id: p.id,
      name: p.name,
      endpoint: p.endpoint,
      enabled: p.enabled,
      auth: {
        kind: p.auth.kind,
        hasCredential: p.auth.kind === 'secret' && typeof p.auth.secretId === 'string' && p.auth.secretId.length > 0,
      },
    })),
    models: config.models,
    routes: config.routes,
    thinking: thinkingMeta(),
  };
}

/* ---------------- 上游端点 URL 策略（特权输入） ---------------- */

export interface EndpointPolicy {
  /** 允许的上游主机名（大小写不敏感；支持 "*.suffix" 通配）；空/缺省 = 不限主机 */
  allowedHosts?: readonly string[];
  /** 是否允许环回/私有网段端点（本地推理服务器：ollama/vLLM/llama.cpp）；缺省 false */
  allowLoopback?: boolean;
}

/** 判断主机名是否环回/私有网段（SSRF 面；精确 IP 策略在出站时再校验 DNS） */
export function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  /* IPv4（含 IPv6 映射 ::ffff:a.b.c.d） */
  const v4 = host.match(/^(::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = [v4[2], v4[3], v4[4], v4[5]].map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = o as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  /* IPv6：环回 / 链路本地 fe80::/10 / 唯一本地 fc00::/7 / 未指定 */
  if (host === '::1' || host === '::' || host.startsWith('fe8') || host.startsWith('fe9') ||
      host.startsWith('fea') || host.startsWith('feb') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  return false;
}

function hostAllowedInList(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === '') return false;
    if (entry === '*') return true;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); /* ".suffix" */
      return host === suffix.slice(1) || host.endsWith(suffix);
    }
    return host === entry;
  });
}

/**
 * 校验上游端点 URL：仅 http/https、拒绝内嵌凭据与 fragment、
 * 可选主机允许列表；环回/私有地址需显式放行（或列入允许列表）。
 * 校验失败抛 Error（原因文本可直接呈给管理员）。
 */
export function validateEndpointUrl(endpoint: string, policy: EndpointPolicy = {}): URL {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new Error(`endpoint 不是合法 URL（收到 ${endpoint.slice(0, 80)}）`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`endpoint 仅接受 http/https，收到 '${u.protocol}'`);
  }
  if (u.username || u.password) {
    throw new Error('endpoint 不得内嵌用户凭据（user:pass@host）——请用凭证写接口单独提交');
  }
  if (u.hash) {
    throw new Error('endpoint 不得包含 fragment（#...）');
  }
  if (u.hostname === '') {
    throw new Error('endpoint 缺少主机名');
  }
  const list = policy.allowedHosts?.filter((s) => s.trim() !== '') ?? [];
  if (list.length > 0 && !hostAllowedInList(u.hostname, list)) {
    throw new Error(`endpoint 主机 '${u.hostname}' 不在允许列表内（PLATFORM_UPSTREAM_HOST_ALLOWLIST）`);
  }
  if (isLoopbackOrPrivateHostname(u.hostname) && !policy.allowLoopback && !hostAllowedInList(u.hostname, list)) {
    throw new Error(`endpoint 指向环回/私有地址 '${u.hostname}'：本地推理服务器需显式允许（allowLoopback 或主机允许列表）`);
  }
  return u;
}

/* ---------------- 存储实现 ---------------- */

export interface ModelConfigStoreOptions {
  filePath: string;
  secrets: SecretStore;
  endpointPolicy?: EndpointPolicy;
  now?: () => number;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function emptyConfig(): ModelConfig {
  const routes = {} as Record<ManagedCapability, CapabilityRouteValue>;
  for (const c of MANAGED_CAPABILITIES) routes[c] = { primary: null, fallback: null };
  return { version: 1, revision: 0, providers: [], models: [], routes };
}

export class ModelConfigStore {
  private snapshot: ModelConfig = emptyConfig();

  constructor(private readonly opts: ModelConfigStoreOptions) {}

  /** 从磁盘加载为活动快照；文件缺失 → 初始化空配置并落盘；损坏 → 抛错拒绝 */
  load(): ModelConfig {
    if (!existsSync(this.opts.filePath)) {
      this.snapshot = emptyConfig();
      this.persist(this.snapshot, { backup: false });
      return this.snapshot;
    }
    let parsed: ModelConfig;
    try {
      parsed = JSON.parse(readFileSync(this.opts.filePath, 'utf8')) as ModelConfig;
    } catch {
      throw new ConfigCorruptError(`模型配置文件损坏，无法解析：${this.opts.filePath}`);
    }
    assertShape(parsed, this.opts.filePath);
    this.snapshot = parsed;
    return this.snapshot;
  }

  /** 活动快照（已提交的最新配置） */
  current(): ModelConfig {
    return this.snapshot;
  }

  /**
   * 校验候选（可含 UI 回传的 hasCredential / secretId —— 一律剥离后重算）。
   * 通过返回规范化配置（不含 revision / secret 引用——引用在 commit 时合并）。
   */
  validate(candidate: unknown): Omit<ModelConfig, 'revision'> {
    return parseCandidate(candidate, this.opts.endpointPolicy ?? {});
  }

  /**
   * 提交新配置：If-Match 冲突检测 → 校验 → 密钥引用按 providerId 合并 →
   * 原子落盘（保留上一版本 .bak）→ 换活动快照。任何失败不改变磁盘与快照。
   */
  commit(candidate: unknown, expectedRevision: number): ModelConfig {
    if (!Number.isInteger(expectedRevision) || expectedRevision !== this.snapshot.revision) {
      throw new RevisionConflictError(expectedRevision, this.snapshot.revision);
    }
    const parsed = parseCandidate(candidate, this.opts.endpointPolicy ?? {});
    const merged: Omit<ModelConfig, 'revision'> = {
      version: 1,
      providers: parsed.providers.map((p) => {
        if (p.auth.kind !== 'secret') return p;
        const prev = this.snapshot.providers.find((x) => x.id === p.id);
        const carried = prev?.auth.kind === 'secret' ? prev.auth.secretId : undefined;
        return carried ? { ...p, auth: { kind: 'secret', secretId: carried } } : p;
      }),
      models: parsed.models,
      routes: parsed.routes,
    };
    assertCredentialsUsable(merged, this.opts.secrets);
    const next: ModelConfig = { ...merged, revision: this.snapshot.revision + 1 };
    this.persist(next, { backup: true });
    this.snapshot = next;
    return next;
  }

  /**
   * 独立凭证写路径：加密存储新值 + 把新 secretId 挂到 provider 引用上，
   * 推进 revision。旧引用保留（secrets 追加式）→ 可整体回滚。
   */
  setProviderCredential(providerId: string, value: string): ModelConfig {
    const provider = this.snapshot.providers.find((p) => p.id === providerId);
    if (!provider) {
      throw new ConfigValidationError([`供应商不存在：${providerId}`]);
    }
    const secretId = this.opts.secrets.put(value);
    const next: ModelConfig = JSON.parse(JSON.stringify(this.snapshot)) as ModelConfig;
    next.providers = next.providers.map((p) =>
      p.id === providerId ? { ...p, auth: { kind: 'secret', secretId } } : p,
    );
    next.revision = this.snapshot.revision + 1;
    this.persist(next, { backup: true });
    this.snapshot = next;
    return next;
  }

  /** 上一版本备份（无备份 → null）；回滚流程（Task 5）用它恢复 */
  previousBackup(): ModelConfig | null {
    const bakPath = `${this.opts.filePath}.bak`;
    if (!existsSync(bakPath)) return null;
    try {
      return JSON.parse(readFileSync(bakPath, 'utf8')) as ModelConfig;
    } catch {
      return null;
    }
  }

  /** 恢复备份为当前配置（revision 继续前进，历史不丢失；失败不动快照） */
  rollbackToBackup(expectedRevision: number): ModelConfig {
    const bak = this.previousBackup();
    if (!bak) throw new ConfigValidationError(['没有可回滚的上一版本备份']);
    return this.commit({ ...bak, version: 1 }, expectedRevision);
  }

  private persist(config: ModelConfig, opts: { backup: boolean }): void {
    if (opts.backup && existsSync(this.opts.filePath)) {
      const prev = readFileSync(this.opts.filePath, 'utf8');
      atomicWrite(`${this.opts.filePath}.bak`, prev);
    }
    atomicWrite(this.opts.filePath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

/* ---------------- 解析与校验 ---------------- */

function assertShape(parsed: ModelConfig, filePath: string): void {
  if (
    !parsed || typeof parsed !== 'object' ||
    parsed.version !== 1 ||
    !Number.isInteger(parsed.revision) || parsed.revision < 0 ||
    !Array.isArray(parsed.providers) ||
    !Array.isArray(parsed.models) ||
    !parsed.routes
  ) {
    throw new ConfigCorruptError(`模型配置文件形状不识别：${filePath}`);
  }
  for (const c of MANAGED_CAPABILITIES) {
    const r = parsed.routes[c];
    if (!r || typeof r !== 'object' || !('primary' in r) || !('fallback' in r)) {
      throw new ConfigCorruptError(`模型配置缺少能力路由 '${c}'：${filePath}`);
    }
  }
}

function parseCandidate(
  candidate: unknown,
  policy: EndpointPolicy,
): Omit<ModelConfig, 'revision'> {
  const issues: string[] = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ConfigValidationError(['配置必须是一个 JSON 对象']);
  }
  const root = candidate as Record<string, unknown>;
  if (root['version'] !== 1) {
    issues.push('version 必须是 1');
  }

  /* providers */
  const rawProviders = root['providers'];
  if (!Array.isArray(rawProviders)) issues.push('providers 必须是数组');
  const providers: ModelConfigProvider[] = [];
  const providerIds = new Set<string>();
  const providerList = Array.isArray(rawProviders) ? rawProviders : [];
  if (providerList.length > MAX_PROVIDERS) issues.push(`providers 上限 ${MAX_PROVIDERS}`);
  providerList.forEach((raw, i) => {
    const label = `providers[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push(`${label} 必须是对象`);
      return;
    }
    const b = raw as Record<string, unknown>;
    const id = typeof b['id'] === 'string' ? b['id'] : '';
    if (!ID_PATTERN.test(id)) issues.push(`${label}.id 必须匹配 ${ID_PATTERN.source}`);
    else if (providerIds.has(id)) issues.push(`${label}.id 重复：'${id}'`);
    else providerIds.add(id);

    const name = typeof b['name'] === 'string' ? b['name'] : '';
    if (name.length < 1 || name.length > 64) issues.push(`${label}.name 必须是 1-64 字符`);

    let endpoint = '';
    if (typeof b['endpoint'] !== 'string' || b['endpoint'].length === 0 || b['endpoint'].length > 512) {
      issues.push(`${label}.endpoint 必须是 1-512 字符字符串`);
    } else {
      endpoint = b['endpoint'];
      try {
        validateEndpointUrl(endpoint, policy);
      } catch (e) {
        issues.push(`${label}.endpoint ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    let auth: ProviderAuth = { kind: 'none' };
    const rawAuth = b['auth'];
    if (!rawAuth || typeof rawAuth !== 'object' || Array.isArray(rawAuth)) {
      issues.push(`${label}.auth 必须是对象（{kind:'secret'} 或 {kind:'none'}）`);
    } else {
      const kind = (rawAuth as Record<string, unknown>)['kind'];
      if (kind === 'none') auth = { kind: 'none' };
      else if (kind === 'secret') auth = { kind: 'secret' }; /* secretId/hasCredential 一律剥离，commit 时合并 */
      else issues.push(`${label}.auth.kind 必须是 'secret' 或 'none'`);
    }

    if (typeof b['enabled'] !== 'boolean') issues.push(`${label}.enabled 必须是布尔值`);
    providers.push({ id, name, endpoint, auth, enabled: b['enabled'] === true });
  });

  /* models */
  const rawModels = root['models'];
  if (!Array.isArray(rawModels)) issues.push('models 必须是数组');
  const models: ModelConfigModel[] = [];
  const modelIds = new Set<string>();
  const modelList = Array.isArray(rawModels) ? rawModels : [];
  if (modelList.length > MAX_MODELS) issues.push(`models 上限 ${MAX_MODELS}`);
  modelList.forEach((raw, i) => {
    const label = `models[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push(`${label} 必须是对象`);
      return;
    }
    const b = raw as Record<string, unknown>;
    const id = typeof b['id'] === 'string' ? b['id'] : '';
    if (!ID_PATTERN.test(id)) issues.push(`${label}.id 必须匹配 ${ID_PATTERN.source}`);
    else if (modelIds.has(id)) issues.push(`${label}.id 重复：'${id}'`);
    else modelIds.add(id);

    const providerId = typeof b['providerId'] === 'string' ? b['providerId'] : '';
    if (!providerIds.has(providerId)) {
      issues.push(`${label}.providerId 引用不存在的供应商：'${providerId || '(空)'}'`);
    }

    const wireModel = typeof b['wireModel'] === 'string' ? b['wireModel'] : '';
    if (wireModel.length < 1 || wireModel.length > 128) {
      issues.push(`${label}.wireModel 必须是 1-128 字符（出站上游模型名）`);
    }

    const rawTags = b['tags'];
    if (!Array.isArray(rawTags) || rawTags.length === 0) {
      issues.push(`${label}.tags 必须是非空数组（词表：${ALLOWED_TAGS.join('/')}）`);
    } else {
      for (const t of rawTags) {
        if (typeof t !== 'string' || !ALLOWED_TAGS.includes(t)) {
          issues.push(`${label}.tags 含未知标签 '${String(t).slice(0, 32)}'（词表：${ALLOWED_TAGS.join('/')}）`);
        }
      }
    }

    if (typeof b['enabled'] !== 'boolean') issues.push(`${label}.enabled 必须是布尔值`);

    /* 思考强度（可选；厂商按 wireModel 前缀检测，档位不支持即 422——诚实拒绝） */
    let thinking: ThinkingLevel | undefined;
    if (b['thinking'] !== undefined && b['thinking'] !== null) {
      if (!isThinkingLevel(b['thinking'])) {
        issues.push(`${label}.thinking 必须是 ${THINKING_LEVELS.join('/')} 之一`);
      } else {
        const profile = detectVendor(wireModel);
        if (!vendorSupportsLevel(profile.id, b['thinking'])) {
          issues.push(
            `${label}.thinking='${b['thinking']}' 不被厂商「${profile.label}」支持（支持：${profile.levels.join('/')}）`,
          );
        } else {
          thinking = b['thinking'];
        }
      }
    }

    models.push({
      id,
      providerId,
      wireModel,
      tags: Array.isArray(rawTags) ? rawTags.filter((t): t is string => typeof t === 'string') : [],
      enabled: b['enabled'] === true,
      ...(thinking ? { thinking } : {}),
    });
  });

  /* 启用一致性：启用模型 ⇔ 启用供应商 */
  const providerById = new Map(providers.filter((p) => p.id).map((p) => [p.id, p]));
  for (const m of models) {
    if (!m.id || !modelIds.has(m.id)) continue;
    if (m.enabled) {
      const p = providerById.get(m.providerId);
      if (p && !p.enabled) {
        issues.push(`models: '${m.id}' 已启用但其供应商 '${m.providerId}' 处于禁用状态`);
      }
    }
  }

  /* routes：六能力键齐全；引用存在且启用的模型 */
  const rawRoutes = root['routes'];
  if (!rawRoutes || typeof rawRoutes !== 'object' || Array.isArray(rawRoutes)) {
    issues.push('routes 必须是对象');
  } else {
    const rb = rawRoutes as Record<string, unknown>;
    const modelById = new Map(models.filter((m) => m.id).map((m) => [m.id, m]));
    for (const cap of MANAGED_CAPABILITIES) {
      const entry = rb[cap];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        issues.push(`routes.${cap} 缺失（必须提供全部六能力键）`);
        continue;
      }
      const eb = entry as Record<string, unknown>;
      const slot = (v: unknown, what: string): string | null => {
        if (v === null || v === undefined || v === '') return null;
        if (typeof v !== 'string') {
          issues.push(`routes.${cap}.${what} 必须是模型 ID 或 null`);
          return null;
        }
        const m = modelById.get(v);
        if (!m) issues.push(`routes.${cap}.${what} 引用不存在的模型：'${v}'`);
        else if (!m.enabled) issues.push(`routes.${cap}.${what} 引用了禁用模型：'${v}'（路由只允许启用的模型）`);
        return v;
      };
      slot(eb['primary'], 'primary');
      slot(eb['fallback'], 'fallback');
    }
    for (const key of Object.keys(rb)) {
      if (!(MANAGED_CAPABILITIES as readonly string[]).includes(key)) {
        issues.push(`routes 含未知能力键 '${key}'（只允许：${MANAGED_CAPABILITIES.join('/')}）`);
      }
    }
  }

  if (issues.length > 0) throw new ConfigValidationError(issues);
  return { version: 1, providers, models, routes: finalizeRoutes(root) };
}

/** parseCandidate 已逐键校验；这里仅组装（不重复报错） */
function finalizeRoutes(root: Record<string, unknown>): Record<ManagedCapability, CapabilityRouteValue> {
  const rb = (root['routes'] ?? {}) as Record<string, unknown>;
  const routes = {} as Record<ManagedCapability, CapabilityRouteValue>;
  for (const cap of MANAGED_CAPABILITIES) {
    const eb = (rb[cap] ?? {}) as Record<string, unknown>;
    const slot = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
    routes[cap] = { primary: slot(eb['primary']), fallback: slot(eb['fallback']) };
  }
  return routes;
}

/** 启用的密钥型供应商必须已有可解密凭证 */
function assertCredentialsUsable(config: Omit<ModelConfig, 'revision'>, secrets: SecretStore): void {
  const issues: string[] = [];
  for (const p of config.providers) {
    if (!p.enabled || p.auth.kind !== 'secret') continue;
    const secretId = p.auth.secretId;
    if (!secretId) {
      issues.push(`供应商 '${p.id}' 已启用但尚无凭证：请先通过凭证接口上传（新供应商应保持禁用直到凭证就绪）`);
      continue;
    }
    try {
      if (secrets.resolve(secretId) === null) {
        issues.push(`供应商 '${p.id}' 的凭证引用不存在：${secretId}`);
      }
    } catch (e) {
      issues.push(`供应商 '${p.id}' 的凭证不可用（无法解密）：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (issues.length > 0) throw new ConfigValidationError(issues);
}

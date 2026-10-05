/* ============================================================
   受管运行时（Model Control Plane · Task 2）
   ------------------------------------------------------------
   一个进程内组合 受管 Gateway + 受管 Platform：
   · 配置写入（apply / applyCredential）成功后原子替换双侧快照——
     Gateway 换提供方注册表（物理模型 ID 视图），Platform 换六能力
     路由；进行中的请求持有旧快照跑完，不中断；
   · 出站前执行可注入的目标校验（URL 策略 + DNS 解析策略，
     防 rebinding 到内网）；
   · 无配置时诚实地 503 no_model_configured（Platform 既有语义），
     不注册任何演示模型。
   旧独立 Gateway/Platform 入口不受影响（run-platform.mjs 照旧）。
   ============================================================ */
import { lookup } from 'node:dns/promises';
import type {
  CapabilityTag,
  GatewayProvider,
  GatewayServer,
  ModelRef,
  PipelineResult,
  PipelineSpec,
  ProviderMessage,
} from 'world-gateway';
import { createModelRouter, createPipeline, remoteChat, remoteChatStream, remoteEmbeddings, RemoteModelError, startGatewayServer } from 'world-gateway';
import type { Capability } from '../types.ts';
import type { EngineClient } from '../types.ts';
import type { KeyStore } from '../keys/keystore.ts';
import { ModelRouter } from '../router/modelrouter.ts';
import type { UsageSink } from '../usage/recorder.ts';
import { createEmbeddingsClient } from '../upstream/embeddings.ts';
import { createGatewayClient } from '../upstream/gateway.ts';
import { startPlatformServer, type PlatformServer } from '../http/server.ts';
import type { EndpointPolicy, ManagedCapability, ModelConfig, ModelConfigStore } from './model-config.ts';
import { MANAGED_CAPABILITIES, isLoopbackOrPrivateHostname, validateEndpointUrl } from './model-config.ts';
import { thinkingOutbound } from './vendors.ts';
import type { SecretStore } from './secrets.ts';

/* ---------------- 出站目标校验（特权输入的第二道闸） ---------------- */

export interface OutboundValidator {
  (url: URL): Promise<void>;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * 缺省出站校验：URL 语法/允许列表/环回策略 + DNS 解析策略——
 * 主机名必须解析成功，且解析出的地址不得是环回/私有网段
 * （除非显式 allowLoopback），防「公网域名 → 127.0.0.1」的 rebinding。
 */
export function defaultOutboundValidator(policy: EndpointPolicy, resolveTimeoutMs = 5000): OutboundValidator {
  return async (url) => {
    validateEndpointUrl(url.toString(), policy);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    /* IP 字面量：validateEndpointUrl 已按策略裁定，无需解析 */
    if (/^(\d{1,3})(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return;
    let addrs: { address: string; family: number }[];
    try {
      addrs = await withTimeout(lookup(host, { all: true }), resolveTimeoutMs, `上游主机 ${host} 解析`);
    } catch (e) {
      throw new Error(`上游主机 ${host} 解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
    if (addrs.length === 0) {
      throw new Error(`上游主机 ${host} 没有任何解析记录`);
    }
    if (policy.allowLoopback) return;
    for (const a of addrs) {
      if (isLoopbackOrPrivateHostname(a.address)) {
        throw new Error(`上游主机 ${host} 解析到环回/私有地址 ${a.address}，被出站策略拒绝（如确为本地推理服务器，请显式允许环回）`);
      }
    }
  };
}

/* ---------------- 托管提供方（配置 → Gateway 快照） ---------------- */

/** 结构化上游错误：code 随网关 503 透传，Platform 据此区分配置错误与瞬时故障 */
export class ManagedUpstreamError extends Error {
  constructor(
    message: string,
    public readonly code: 'upstream_credential_rejected' | 'upstream_failure',
  ) {
    super(message);
  }
}

function toManagedError(e: unknown): ManagedUpstreamError {
  if (e instanceof RemoteModelError) {
    if (e.kind === 'auth') {
      return new ManagedUpstreamError(e.message, 'upstream_credential_rejected');
    }
    return new ManagedUpstreamError(e.message, 'upstream_failure');
  }
  return new ManagedUpstreamError(e instanceof Error ? e.message : String(e), 'upstream_failure');
}

export interface ManagedProviderOptions {
  secrets: SecretStore;
  outboundValidator: OutboundValidator;
  /** 出站超时（毫秒） */
  timeoutMs: number;
}

interface ResolvedTarget {
  endpoint: URL;
  apiKey: string;
  wireModel: string;
}

function toModelRef(modelId: string, t: ResolvedTarget): ModelRef {
  /* apiKeyRef 仅满足类型（env 名不会被使用——密钥直接内联传入） */
  return { id: modelId, endpoint: t.endpoint.toString(), apiKeyRef: { env: 'MANAGED_INLINE_KEY' }, tags: [], wireModel: t.wireModel };
}

/** 解析模型 → 出站目标；null = 模型/供应商不在配置中或被禁用（→ 网关 404/503 语义） */
export function resolveModelTarget(
  config: ModelConfig,
  secrets: SecretStore,
  modelId: string,
  opts: { requireEnabled: boolean },
): ResolvedTarget | null {
  const m = config.models.find((x) => x.id === modelId);
  if (!m || (opts.requireEnabled && !m.enabled)) return null;
  const p = config.providers.find((x) => x.id === m.providerId);
  if (!p) return null;
  if (opts.requireEnabled && !p.enabled) return null;
  let apiKey = '';
  if (p.auth.kind === 'secret') {
    if (!p.auth.secretId) return null;
    try {
      apiKey = secrets.resolve(p.auth.secretId) ?? '';
    } catch {
      return null; /* 凭证不可解密 → 视作未就绪；诚实错误在 probe/请求路径上报 */
    }
    if (apiKey === '') return null;
  }
  try {
    return { endpoint: new URL(p.endpoint), apiKey, wireModel: m.wireModel };
  } catch {
    return null;
  }
}

/** 由已提交配置构建 Gateway 提供方快照（models = 启用的物理模型 ID） */
export function buildManagedProvider(config: ModelConfig, opts: ManagedProviderOptions): GatewayProvider {
  return {
    owner: 'managed-model-control',
    models: config.models.filter((m) => m.enabled).map((m) => m.id),

    async complete(model: string, messages: ProviderMessage[]): Promise<string | null> {
      const t = resolveModelTarget(config, opts.secrets, model, { requireEnabled: true });
      if (!t) return null;
      await opts.outboundValidator(t.endpoint);
      const thinking = thinkingOutboundFor(config, model);
      try {
        return (
          await remoteChat(toModelRef(model, t), t.apiKey, messages, {
            timeoutMs: opts.timeoutMs,
            ...(thinking ? { extraPayload: thinking.extra, modelOverride: thinking.modelOverride } : {}),
          })
        ).text;
      } catch (e) {
        throw toManagedError(e);
      }
    },

    async completeStream(model: string, messages: ProviderMessage[], onDelta: (delta: string) => void): Promise<void> {
      const t = resolveModelTarget(config, opts.secrets, model, { requireEnabled: true });
      if (!t) throw new ManagedUpstreamError(`模型 '${model}' 不在当前启用的模型配置中`, 'upstream_failure');
      await opts.outboundValidator(t.endpoint);
      const thinking = thinkingOutboundFor(config, model);
      try {
        await remoteChatStream(toModelRef(model, t), t.apiKey, messages, onDelta, {
          timeoutMs: opts.timeoutMs,
          ...(thinking ? { extraPayload: thinking.extra, modelOverride: thinking.modelOverride } : {}),
        });
      } catch (e) {
        throw toManagedError(e);
      }
    },
    /* embed（P8 · 方案 §十一：embedding 能力通道）：与 chat 同纪律——
       解析模型目标 → 出站校验 → 调上游。模型未配置/禁用 → 抛错（网关归一 503）。 */
    async embed(model: string, input: string[]): Promise<number[][]> {
      const t = resolveModelTarget(config, opts.secrets, model, { requireEnabled: true });
      if (!t) throw new ManagedUpstreamError(`模型 '${model}' 不在当前启用的模型配置中`, 'upstream_failure');
      await opts.outboundValidator(t.endpoint);
      try {
        return await remoteEmbeddings(toModelRef(model, t), t.apiKey, input);
      } catch (e) {
        throw toManagedError(e);
      }
    },
  };
}

/** 模型思考强度 → 出站载荷（厂商适配；未配置/不支持 → null） */
function thinkingOutboundFor(config: ModelConfig, modelId: string) {
  const m = config.models.find((x) => x.id === modelId);
  if (!m?.thinking) return null;
  return thinkingOutbound(m.thinking, m.wireModel);
}

/** 配置路由 → Platform 路由快照（防御性：悬空/禁用引用置 null，绝不假装可用） */
function sanitizeRoutes(config: ModelConfig): Partial<Record<Capability, { primary: string | null; fallback: string | null }>> {
  const enabled = new Set(config.models.filter((m) => m.enabled).map((m) => m.id));
  const out: Partial<Record<Capability, { primary: string | null; fallback: string | null }>> = {};
  for (const cap of MANAGED_CAPABILITIES) {
    const r = config.routes[cap];
    out[cap] = {
      primary: r?.primary && enabled.has(r.primary) ? r.primary : null,
      fallback: r?.fallback && enabled.has(r.fallback) ? r.fallback : null,
    };
  }
  return out;
}

/* ---------------- 受管运行时 ---------------- */

export interface ManagedRuntimeOptions {
  configStore: ModelConfigStore;
  secrets: SecretStore;
  keys: KeyStore;
  engine: EngineClient;
  /** 私有管理监听的服务端令牌（Task 3 的 admin listener 使用） */
  adminToken: string;
  endpointPolicy: EndpointPolicy;
  /** 受管 Gateway 监听端口（缺省 0 = 自动分配；仅绑 127.0.0.1） */
  gatewayPort?: number;
  /** 受管 Platform 公共端口（缺省 0 = 自动分配） */
  platformPort?: number;
  /** 受管 Platform 公共监听地址（缺省 127.0.0.1；容器部署传 0.0.0.0） */
  host?: string;
  /** 出站上游超时（毫秒，缺省 60s） */
  upstreamTimeoutMs?: number;
  /** 出站目标校验（缺省 defaultOutboundValidator；测试注入） */
  outboundValidator?: OutboundValidator;
  /** 结构化用量记录（M2.2；透传给平台公共侧，缺省不计量） */
  usage?: UsageSink;
  accessLog?: boolean;
  corsAllowOrigin?: string;
  /** 世界创建成功回调（P2 卡片5）：透传平台协议层——装配方动态纳管（MemoryRuntime.addWorld 等） */
  onWorldCreated?: (worldId: string) => void;
}

export interface ProbeResult {
  ok: boolean;
  modelId: string | null;
  elapsedMs: number;
  /** 截断清洗后的上游回复（短）；失败时为 null */
  reply: string | null;
  /** 失败分类码：no_model_configured / no_credential / upstream_credential_rejected / upstream_failure */
  code: string | null;
  message: string | null;
  /** embedding 语义探测的实测维度（chat 探测无此值） */
  dimension?: number;
}

export interface ManagedRuntime {
  readonly gatewayUrl: string;
  readonly platformUrl: string;
  /** 引擎客户端（M4.1 可观测聚合用：/v1/worlds、/events 只读） */
  readonly engine: EngineClient;
  /** 能力路由器（演化运行时等扩展按能力选模型用；只读代理，replaceRoutes 仍归本运行时） */
  readonly router: ModelRouter;
  /** 当前活动配置快照 */
  readonly config: ModelConfig;
  /** 提交新配置并原子替换双侧快照；冲突/校验失败抛错且不换快照 */
  apply(candidate: unknown, expectedRevision: number): ModelConfig;
  /** 凭证写入（新加密记录 + 新引用）并热替换快照 */
  applyCredential(providerId: string, value: string): ModelConfig;
  /** 回滚到上一版本备份（revision 继续前进）并热替换快照 */
  rollback(expectedRevision: number): ModelConfig;
  /** 有界测试调用：对已存模型按其配置端点与 wireModel 发一次小请求 */
  probeModel(modelId: string): Promise<ProbeResult>;
  /** 有界测试调用：只用该能力当前生效的 primary 路由 */
  probeCapability(capability: ManagedCapability): Promise<ProbeResult>;
  /** embedding 语义探测：embed(['ping']) 实测并返回维度（chat ping 对嵌入模型是假测试） */
  probeEmbedding(modelId: string): Promise<ProbeResult>;
  /**
   * 管线有界试跑（M2.3）：按当前生效配置桥接网关标签路由（物理模型
   * 视图），出站校验未通过的模型被剔除并留痕；deadline/maxCalls 被
   * 硬性封顶。只服务管理台试跑，不进入公共请求路径。
   */
  runPipelineSpec(
    spec: PipelineSpec,
    run: { input?: Record<string, string>; deadlineMs?: number; maxCalls?: number },
  ): Promise<{ result: PipelineResult; excludedModels: { id: string; why: string }[] }>;
  close(): Promise<void>;
}

export async function startManagedRuntime(opts: ManagedRuntimeOptions): Promise<ManagedRuntime> {
  const gateway: GatewayServer = await startGatewayServer({ port: opts.gatewayPort ?? 0, host: '127.0.0.1' });
  const router = new ModelRouter(null);
  const validator = opts.outboundValidator ?? defaultOutboundValidator(opts.endpointPolicy);
  const timeoutMs = opts.upstreamTimeoutMs ?? 60_000;
  const providerOpts: ManagedProviderOptions = {
    secrets: opts.secrets,
    outboundValidator: validator,
    timeoutMs,
  };
  const platform: PlatformServer = await startPlatformServer({
    keys: opts.keys,
    engine: opts.engine,
    gateway: createGatewayClient({ baseUrl: gateway.url }),
    router,
    /* Embedding 统一治理：公共 POST /v1/embeddings 与 run-managed 的记忆钩子
       共用同一 Router 实例（冷却状态共享）与网关嵌入通道 */
    embeddings: createEmbeddingsClient({ baseUrl: gateway.url, timeoutMs }),
    port: opts.platformPort ?? 0,
    host: opts.host ?? '127.0.0.1',
    accessLog: opts.accessLog ?? true,
    corsAllowOrigin: opts.corsAllowOrigin ?? '*',
    usage: opts.usage,
    ...(opts.onWorldCreated ? { onWorldCreated: opts.onWorldCreated } : {}),
  });

  function swapTo(config: ModelConfig): void {
    gateway.replaceProviders([buildManagedProvider(config, providerOpts)]);
    router.replaceRoutes(sanitizeRoutes(config));
  }

  /* 启动即按已提交配置装配双侧快照（空配置 → 无模型 → 诚实 503） */
  swapTo(opts.configStore.current());

  async function probe(modelId: string | null): Promise<ProbeResult> {
    const started = Date.now();
    if (!modelId) {
      return { ok: false, modelId: null, elapsedMs: 0, reply: null, code: 'no_model_configured', message: '该能力未配置 primary 模型' };
    }
    const config = opts.configStore.current();
    const m = config.models.find((x) => x.id === modelId);
    if (!m) {
      return { ok: false, modelId, elapsedMs: 0, reply: null, code: 'model_not_found', message: `模型 '${modelId}' 不在配置中` };
    }
    const p = config.providers.find((x) => x.id === m.providerId);
    if (!p) {
      return { ok: false, modelId, elapsedMs: 0, reply: null, code: 'provider_not_found', message: `模型 '${modelId}' 的供应商不存在` };
    }
    if (p.auth.kind === 'secret' && !p.auth.secretId) {
      return { ok: false, modelId, elapsedMs: 0, reply: null, code: 'no_credential', message: `供应商 '${p.id}' 尚未上传凭证` };
    }
    const t = resolveModelTarget(config, opts.secrets, modelId, { requireEnabled: false });
    if (!t) {
      return { ok: false, modelId, elapsedMs: 0, reply: null, code: 'not_resolvable', message: `模型 '${modelId}' 无法解析出可用出站目标（供应商禁用/凭证不可解密/端点非法）` };
    }
    try {
      await validator(t.endpoint);
      const out = await remoteChat(toModelRef(modelId, t), t.apiKey, [{ role: 'user', content: 'ping：只需回复 pong' }], {
        timeoutMs: Math.min(timeoutMs, 30_000),
        maxTokens: 16,
      });
      return { ok: true, modelId, elapsedMs: Date.now() - started, reply: out.text.slice(0, 200), code: null, message: null };
    } catch (e) {
      const me = toManagedError(e);
      return {
        ok: false,
        modelId,
        elapsedMs: Date.now() - started,
        reply: null,
        code: me.code === 'upstream_credential_rejected' ? 'upstream_credential_rejected' : 'upstream_failure',
        message: me.message,
      };
    }
  }

  /** embedding 语义探测：embed(['ping']) 实测并返回维度（模型解析失败如实报错） */
  async function probeEmbedding(modelId: string | null): Promise<ProbeResult> {
    const started = Date.now();
    if (!modelId) {
      return { ok: false, modelId: null, elapsedMs: 0, reply: null, code: 'no_model_configured', message: "能力 'embedding' 未配置 primary 模型" };
    }
    const config = opts.configStore.current();
    const m = config.models.find((x) => x.id === modelId);
    if (!m) {
      return { ok: false, modelId, elapsedMs: 0, reply: null, code: 'model_not_found', message: `模型 '${modelId}' 不在配置中` };
    }
    const p = config.providers.find((x) => x.id === m.providerId);
    if (!p) {
      return { ok: false, modelId, elapsedMs: 0, reply: null, code: 'provider_not_found', message: `模型 '${modelId}' 的供应商不存在` };
    }
    if (p.auth.kind === 'secret' && !p.auth.secretId) {
      return { ok: false, modelId, elapsedMs: 0, reply: null, code: 'no_credential', message: `供应商 '${p.id}' 尚未上传凭证` };
    }
    const t = resolveModelTarget(config, opts.secrets, modelId, { requireEnabled: false });
    if (!t) {
      return { ok: false, modelId, elapsedMs: 0, reply: null, code: 'not_resolvable', message: `模型 '${modelId}' 无法解析出可用出站目标（供应商禁用/凭证不可解密/端点非法）` };
    }
    try {
      await validator(t.endpoint);
      const vectors = await remoteEmbeddings(toModelRef(modelId, t), t.apiKey, ['ping'], {
        timeoutMs: Math.min(timeoutMs, 30_000),
      });
      return {
        ok: true,
        modelId,
        elapsedMs: Date.now() - started,
        reply: null,
        code: null,
        message: null,
        dimension: vectors[0]?.length ?? 0,
      };
    } catch (e) {
      const me = toManagedError(e);
      return {
        ok: false,
        modelId,
        elapsedMs: Date.now() - started,
        reply: null,
        code: me.code === 'upstream_credential_rejected' ? 'upstream_credential_rejected' : 'upstream_failure',
        message: me.message,
      };
    }
  }

  return {
    get gatewayUrl() {
      return gateway.url;
    },
    get platformUrl() {
      return platform.url;
    },
    get engine() {
      return opts.engine;
    },
    get router() {
      return router;
    },
    get config() {
      return opts.configStore.current();
    },
    apply(candidate: unknown, expectedRevision: number): ModelConfig {
      const committed = opts.configStore.commit(candidate, expectedRevision);
      swapTo(committed);
      return committed;
    },
    applyCredential(providerId: string, value: string): ModelConfig {
      const committed = opts.configStore.setProviderCredential(providerId, value);
      swapTo(committed);
      return committed;
    },
    rollback(expectedRevision: number): ModelConfig {
      const restored = opts.configStore.rollbackToBackup(expectedRevision);
      swapTo(restored);
      return restored;
    },
    probeModel: (modelId: string) => probe(modelId),
    probeCapability: (capability: ManagedCapability) => {
      const r = opts.configStore.current().routes[capability];
      return probe(r?.primary ?? null);
    },
    probeEmbedding: (modelId: string) => probeEmbedding(modelId),
    runPipelineSpec: async (spec, run) => {
      /* 桥接：受管配置（物理模型 + 加密凭证）→ 网关标签路由快照。
         每个启用模型先过出站校验（与 world-agent 同一道闸），未过者
         剔除并留痕——试跑绝不绕过 SSRF 策略。 */
      const config = opts.configStore.current();
      const keyById = new Map<string, string>();
      const models: ModelRef[] = [];
      const excludedModels: { id: string; why: string }[] = [];
      for (const m of config.models) {
        if (!m.enabled) {
          excludedModels.push({ id: m.id, why: '模型已禁用' });
          continue;
        }
        const t = resolveModelTarget(config, opts.secrets, m.id, { requireEnabled: true });
        if (!t) {
          excludedModels.push({ id: m.id, why: '无法解析出站目标（供应商禁用/凭证缺失或不可解密/端点非法）' });
          continue;
        }
        try {
          await validator(t.endpoint);
        } catch (e) {
          excludedModels.push({ id: m.id, why: `出站校验失败：${e instanceof Error ? e.message : String(e)}` });
          continue;
        }
        keyById.set(m.id, t.apiKey);
        models.push({
          id: m.id,
          endpoint: t.endpoint.toString(),
          apiKeyRef: { env: m.id },
          tags: m.tags as CapabilityTag[],
          wireModel: m.wireModel,
        });
      }
      const pipelineRouter = createModelRouter({ models }, { resolveEnv: (env) => keyById.get(env) });

      /* 有界封顶：时延 ≤30s、调用数 ≤ 节点数（执行器缺省语义）且 ≤32 */
      const DEADLINE_CAP_MS = 30_000;
      const bounded: PipelineSpec = {
        ...spec,
        deadlineMs: Math.min(spec.deadlineMs ?? DEADLINE_CAP_MS, run.deadlineMs ?? DEADLINE_CAP_MS, DEADLINE_CAP_MS),
      };
      const result = await createPipeline(bounded, pipelineRouter, {
        timeoutMs: Math.min(timeoutMs, 30_000),
        maxCalls: Math.min(spec.nodes.length, run.maxCalls ?? spec.nodes.length, 32),
      }).run(run.input ?? {});
      return { result, excludedModels };
    },
    async close(): Promise<void> {
      await platform.close();
      await gateway.close();
    },
  };
}

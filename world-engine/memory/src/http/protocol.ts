/* ============================================================
   Memory HTTP 协议适配器（M1.1 · G7）
   ------------------------------------------------------------
   模式同 world-engine/src/http：纯路由协议——输入已解析的
   { method, path, query, body }，输出 { status, body }，不碰
   socket、不碰 JSON 字符串，可无网络全量测试。

   本包只读事实、绝不直接写世界状态（§16 铁律不变）；HTTP 层
   同样只暴露**只读 + 检索**面（M1 是只读数据面，删除/写入不设）。
   多个 MemoryEngine 实例 = 多个 store（宿主按 world/用途分库），
   由宿主在组合根喂事实（worldBus.on('*') → ingestFact）。

   路由（ADMIN-API-GAP G7 建议接口）：
     GET  /v1/memory/stores                         store 清单与统计
     GET  /v1/memory/records                        记录分页筛选
         ?store=&entity=&type=&q=&page=&pageSize=&includeForgotten=
     POST /v1/memory/retrieval                      检索调试（真实评分）
         { query, store?, entity?, topK?, day?, includeForgotten? }
     GET  /v1/memory/embedding                      向量通道与检索统计
     GET  /v1/memory/embedding-config               嵌入模型配置（脱敏视图）[宿主回调]
     PUT  /v1/memory/embedding-config               更新并热应用 [宿主回调]
         { enabled, endpoint, model, apiKey? }
     POST /v1/memory/embedding-config/test          连通性实测 embed(["ping"])

   诚实原则：createdAt 只对新条目存在（旧快照缺省 → null）；
   embedding 统计覆盖「经本 HTTP 服务的检索调用」，引擎内嵌的
   向量钩子调用细节在无插桩时不可观测，不编造数字。
   配置端点只做白名单校验与路由——校验通过后的热应用（setEmbed）、
   持久化与连通性实测由宿主回调承担；**apiKey 明文不出服务**
   （GET/PUT 响应一律 hasApiKey 布尔）。本服务无鉴权，写入端点应由
   部署层（如平台的鉴权代理）对 外防护。
   ============================================================ */
import type { MemoryEngine } from '../engine.ts';
import type { MemoryEntry } from '../types.ts';

/** 已解析的 HTTP 请求（与引擎 http 同形状） */
export interface HttpRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

/** 待序列化的 HTTP 响应 */
export interface HttpResponse {
  status: number;
  body: unknown;
}

/** 宿主注册的 store（一个 MemoryEngine 实例 = 一个 store） */
export interface MemoryStoreInit {
  /** store 名（路由与筛选键；建议与用途同名，如 world-events / npc-personas） */
  name: string;
  engine: MemoryEngine;
  description?: string;
  /** 向量通道描述（引擎内 EmbedHook 是否注入、维度多少——由宿主声明） */
  embed?: { name?: string; dimension?: number };
}

export interface MemoryHttpInit {
  stores: MemoryStoreInit[];
  /**
   * 嵌入模型配置回调（0.8.2；缺省未装配 → 配置端点 404 not_configured）。
   * 协议层只做白名单校验与路由：校验通过后交给宿主 apply 热应用
   * （setEmbed + 持久化 + 更新 store 的 embed 通道声明）。
   */
  embeddingConfig?: {
    /** 当前生效配置（脱敏视图：无 apiKey 明文） */
    get(): EmbeddingConfigView;
    /**
     * 应用新配置（字段已过白名单）。宿主负责：构建/替换 EmbedHook
     * （engine.setEmbed）、持久化、更新各 store 的 embed 通道声明。
     * 非法业务组合抛 Error → 400。
     */
    apply(cfg: { enabled: boolean; endpoint: string; model: string; apiKey?: string | null }): EmbeddingConfigView;
    /** 连通性实测：embed(["ping"])；未启用/未配置时 ok=false 并带原因 */
    test(): Promise<{ ok: boolean; dimension?: number; ms: number; error?: string }>;
  };
}

/** 嵌入模型配置（脱敏视图；apiKey 永不明文） */
export interface EmbeddingConfigView {
  enabled: boolean;
  /** OpenAI 兼容根（不含 /embeddings） */
  endpoint: string;
  model: string;
  hasApiKey: boolean;
}

/* ---------------- 载荷净化（白名单重建，纪律同引擎 http） ---------------- */

const MAX_STR = (n: number) => (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= n ? v : undefined;

const clampInt = (v: string | undefined, dflt: number, lo: number, hi: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
};

/** store 记录行（管理台视图；字段与 MemoryEntry 对齐而非编造） */
export interface MemoryRecordRow {
  id: string;
  store: string;
  /** 记忆的主人（ownerId） */
  entity: string;
  /** 类别（MemoryEntry.kind） */
  type: string;
  content: string;
  importance: number;
  confidence: number;
  /** 世界日（与宿主时钟同源） */
  day: number;
  /** 摄取路径：witness / rumor / self */
  via: string;
  entities: string[];
  recallCount: number;
  lastRecalledDay?: number;
  /** ISO 8601；旧快照条目无此字段 → null（诚实缺省，不编时间） */
  createdAt: string | null;
  forgotten: boolean;
}

function toRow(store: string, e: MemoryEntry): MemoryRecordRow {
  return {
    id: e.id,
    store,
    entity: e.ownerId,
    type: e.kind,
    content: e.text,
    importance: e.importance,
    confidence: e.confidence,
    day: e.day,
    via: e.via,
    entities: e.entities,
    recallCount: e.recallCount,
    ...(e.lastRecalledDay !== undefined ? { lastRecalledDay: e.lastRecalledDay } : {}),
    createdAt: e.createdAt ?? null,
    forgotten: e.forgotten === true,
  };
}

/** 创建 Memory HTTP 协议适配器。 */
export function createMemoryHttp(init: MemoryHttpInit): {
  handle(req: HttpRequest): Promise<HttpResponse> | HttpResponse;
} {
  const stores = new Map<string, MemoryStoreInit>();
  for (const s of init.stores) stores.set(s.name, s);
  /* 检索统计（经本服务的调用；诚实口径，见文件头） */
  const retrievalStats = { total: 0, last24h: 0, totalMs: 0, failures: 0 };
  const recent24h: number[] = [];
  const now = () => Date.now();

  function storeOf(name: string | undefined): MemoryStoreInit | null {
    if (!name) return init.stores[0] ?? null; // 缺省第一个 store
    return stores.get(name) ?? null;
  }

  async function handle(req: HttpRequest): Promise<HttpResponse> {
    const method = req.method.toUpperCase();
    const segments = req.path.replace(/\/+$/, '').split('/').filter(Boolean);

    if (segments[0] !== 'v1' || segments[1] !== 'memory') {
      return { status: 404, body: { error: 'no such route', path: req.path } };
    }
    const leaf = segments[2];

    /* ---------- GET /v1/memory/stores ---------- */
    if (leaf === 'stores' && segments.length === 3) {
      if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };
      return {
        status: 200,
        body: {
          stores: init.stores.map((s) => {
            const stats = s.engine.stats();
            return {
              id: s.name,
              name: s.name,
              /** 本包为进程内纯库；持久化介质由宿主 SavePort 决定 */
              provider: 'local',
              dimension: s.embed?.dimension ?? 0,
              documentCount: stats.total,
              status: 'healthy',
              description: s.description ?? '',
              stats,
              embed: { attached: !!s.embed, ...(s.embed?.name ? { name: s.embed.name } : {}), ...(s.embed?.dimension ? { dimension: s.embed.dimension } : {}) },
            };
          }),
        },
      };
    }

    /* ---------- GET /v1/memory/records ---------- */
    if (leaf === 'records' && segments.length === 3) {
      if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };
      const store = storeOf(req.query?.['store']);
      if (!store) return { status: 404, body: { error: 'no such store', store: req.query?.['store'] ?? '' } };

      const entity = MAX_STR(128)(req.query?.['entity']);
      const type = MAX_STR(64)(req.query?.['type']);
      const q = MAX_STR(256)(req.query?.['q'])?.toLowerCase();
      const page = clampInt(req.query?.['page'], 1, 1, 100_000);
      const pageSize = clampInt(req.query?.['pageSize'], 20, 1, 200);
      const includeForgotten = req.query?.['includeForgotten'] === 'true';

      let list = [...store.engine.all()].reverse(); // 新 → 旧（摄取序）
      if (!includeForgotten) list = list.filter((e) => !e.forgotten);
      if (entity) list = list.filter((e) => e.ownerId === entity);
      if (type) list = list.filter((e) => e.kind === type);
      if (q) list = list.filter((e) => e.text.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q));

      return {
        status: 200,
        body: {
          total: list.length,
          page,
          pageSize,
          list: list.slice((page - 1) * pageSize, page * pageSize).map((e) => toRow(store.name, e)),
        },
      };
    }

    /* ---------- POST /v1/memory/retrieval ---------- */
    if (leaf === 'retrieval' && segments.length === 3) {
      if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
      const b = (req.body ?? {}) as Record<string, unknown>;
      const query = MAX_STR(512)(b['query']);
      if (!query) return { status: 400, body: { error: 'body must include a short string "query"' } };
      const store = storeOf(MAX_STR(64)(b['store']));
      if (!store) return { status: 404, body: { error: 'no such store', store: String(b['store'] ?? '') } };
      const entity = MAX_STR(128)(b['entity']);
      const topK = typeof b['topK'] === 'number' && Number.isFinite(b['topK']) ? Math.min(50, Math.max(1, Math.floor(b['topK']))) : 10;
      const day = typeof b['day'] === 'number' && Number.isFinite(b['day']) && b['day'] >= 0 ? Math.floor(b['day']) : 0;
      const includeForgotten = b['includeForgotten'] === true;

      const started = now();
      retrievalStats.total++;
      recent24h.push(started);
      try {
        /* 引擎召回按 owner 过滤；未指定 entity 时按 store 内全部 owner 聚合
           （同一评分公式，跨 owner 分数可比），再按分数取 topK */
        const owners = entity
          ? [entity]
          : [...new Set([...store.engine.all()].map((e) => e.ownerId))];
        const perOwner = await Promise.all(
          owners.map((owner) => store.engine.recallScored(owner, query, { limit: topK, day, includeForgotten })),
        );
        const hits = perOwner
          .flat()
          .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
          .slice(0, topK);
        const took = now() - started;
        retrievalStats.totalMs += took;
        return {
          status: 200,
          body: {
            query,
            store: store.name,
            entity: entity ?? null,
            took,
            results: hits.map(({ entry, score }) => ({
              id: entry.id,
              content: entry.text,
              score,
              via: entry.via,
              confidence: entry.confidence,
              importance: entry.importance,
              day: entry.day,
              metadata: { owner: entry.ownerId, kind: entry.kind, entities: entry.entities, recallCount: entry.recallCount },
            })),
          },
        };
      } catch (err) {
        retrievalStats.failures++;
        return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    }

    /* ---------- GET /v1/memory/embedding ---------- */
    if (leaf === 'embedding' && segments.length === 3) {
      if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };
      const cutoff = now() - 24 * 3600_000;
      while (recent24h.length && recent24h[0] < cutoff) recent24h.shift();
      return {
        status: 200,
        body: {
          channels: init.stores.map((s) => ({
            store: s.name,
            attached: !!s.embed,
            ...(s.embed?.name ? { name: s.embed.name } : {}),
            ...(s.embed?.dimension ? { dimension: s.embed.dimension } : {}),
          })),
          /* 检索调用统计（经本 HTTP 服务；引擎内嵌向量调用细节不编造） */
          stats: {
            total: retrievalStats.total,
            last24h: recent24h.length,
            avgLatencyMs: retrievalStats.total ? Math.round(retrievalStats.totalMs / retrievalStats.total) : 0,
            failureRate: retrievalStats.total ? Number((retrievalStats.failures / retrievalStats.total).toFixed(4)) : 0,
          },
        },
      };
    }

    /* ---------- 嵌入模型配置（0.8.2；宿主回调承担应用/持久化/实测） ---------- */
    if (leaf === 'embedding-config') {
      if (!init.embeddingConfig) {
        return { status: 404, body: { error: 'not configured：本服务未装配嵌入模型配置回调' } };
      }
      if (segments.length !== 3 && !(segments.length === 4 && segments[3] === 'test' && method === 'POST')) {
        return { status: 404, body: { error: 'no such resource' } };
      }

      if (method === 'GET') {
        return { status: 200, body: { config: init.embeddingConfig.get() } };
      }

      if (method === 'PUT') {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const endpoint = MAX_STR(256)(b['endpoint']);
        const model = MAX_STR(128)(b['model']);
        if (typeof b['enabled'] !== 'boolean') return { status: 400, body: { error: 'enabled 必须是布尔' } };
        if (b['enabled'] && !endpoint) return { status: 400, body: { error: '启用时 endpoint 必填（OpenAI 兼容根，1-256 字符）' } };
        if (b['enabled'] && !model) return { status: 400, body: { error: '启用时 model 必填（1-128 字符）' } };
        if (endpoint && !/^https?:\/\//.test(endpoint)) return { status: 400, body: { error: 'endpoint 必须是 http/https URL' } };
        const apiKeyRaw = b['apiKey'];
        if (apiKeyRaw !== undefined && apiKeyRaw !== null && (typeof apiKeyRaw !== 'string' || apiKeyRaw.length > 4096)) {
          return { status: 400, body: { error: 'apiKey 必须是 ≤4096 字符的字符串或 null（null/缺省 = 不修改已存密钥）' } };
        }
        try {
          const config = init.embeddingConfig.apply({
            enabled: b['enabled'] as boolean,
            endpoint: endpoint ?? '',
            model: model ?? '',
            apiKey: (apiKeyRaw as string | null | undefined) ?? undefined,
          });
          return { status: 200, body: { config } };
        } catch (e) {
          return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
        }
      }

      if (method === 'POST' && segments.length === 4 && segments[3] === 'test') {
        const out = await init.embeddingConfig.test();
        return { status: 200, body: out };
      }

      return { status: 405, body: { error: 'method not allowed' } };
    }

    return { status: 404, body: { error: 'no such resource' } };
  }

  return { handle };
}

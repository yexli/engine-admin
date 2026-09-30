// AI Gateway 管理 Mock
// 当前 Gateway 仅有 OpenAI 兼容代理 /v1/chat/completions，管理面无 API。
// 数据形状为管理后台目标契约，真实化接口见 docs/ADMIN-API-GAP.md
import { defineFakeRoute } from "vite-plugin-fake-server/client";
import { minutesAgo, paginate } from "./_utils";

let mockKeySeq = 1000;

const providers = [
  { id: "prov-openai", name: "openai", type: "openai-compatible", endpoint: "https://api.openai.com/v1", status: "online", models: ["gpt-4o", "gpt-4o-mini", "text-embedding-3-small"], lastCheckAt: minutesAgo(3), latencyMs: 182 },
  { id: "prov-anthropic", name: "anthropic", type: "anthropic", endpoint: "https://api.anthropic.com", status: "online", models: ["claude-sonnet-4-5", "claude-haiku-4-5"], lastCheckAt: minutesAgo(3), latencyMs: 240 },
  { id: "prov-deepseek", name: "deepseek", type: "openai-compatible", endpoint: "https://api.deepseek.com/v1", status: "online", models: ["deepseek-chat", "deepseek-reasoner"], lastCheckAt: minutesAgo(4), latencyMs: 310 },
  { id: "prov-local", name: "local-ollama", type: "openai-compatible", endpoint: "http://127.0.0.1:11434/v1", status: "offline", models: ["qwen3:8b", "nomic-embed-text"], lastCheckAt: minutesAgo(52), latencyMs: null }
];

const models = [
  { id: "mdl-gpt4o", name: "gpt-4o", provider: "openai", capabilities: ["reasoning", "roleplay", "narrative"], status: "enabled", contextWindow: 128000, pricing: { input: 2.5, output: 10, currency: "USD/1M" } },
  { id: "mdl-gpt4o-mini", name: "gpt-4o-mini", provider: "openai", capabilities: ["fast", "cheap"], status: "enabled", contextWindow: 128000, pricing: { input: 0.15, output: 0.6, currency: "USD/1M" } },
  { id: "mdl-embed3", name: "text-embedding-3-small", provider: "openai", capabilities: ["embedding"], status: "enabled", contextWindow: 8191, pricing: { input: 0.02, output: 0, currency: "USD/1M" } },
  { id: "mdl-sonnet", name: "claude-sonnet-4-5", provider: "anthropic", capabilities: ["reasoning", "roleplay", "narrative"], status: "enabled", contextWindow: 200000, pricing: { input: 3, output: 15, currency: "USD/1M" } },
  { id: "mdl-haiku", name: "claude-haiku-4-5", provider: "anthropic", capabilities: ["fast", "cheap"], status: "enabled", contextWindow: 200000, pricing: { input: 1, output: 5, currency: "USD/1M" } },
  { id: "mdl-ds-chat", name: "deepseek-chat", provider: "deepseek", capabilities: ["fast", "cheap", "narrative"], status: "enabled", contextWindow: 64000, pricing: { input: 0.27, output: 1.1, currency: "USD/1M" } },
  { id: "mdl-ds-reasoner", name: "deepseek-reasoner", provider: "deepseek", capabilities: ["reasoning"], status: "enabled", contextWindow: 64000, pricing: { input: 0.55, output: 2.19, currency: "USD/1M" } },
  { id: "mdl-qwen-local", name: "qwen3:8b", provider: "local-ollama", capabilities: ["fast", "cheap", "memory"], status: "disabled", contextWindow: 32768, pricing: { input: 0, output: 0, currency: "USD/1M" } },
  { id: "mdl-nomic", name: "nomic-embed-text", provider: "local-ollama", capabilities: ["embedding"], status: "disabled", contextWindow: 8192, pricing: { input: 0, output: 0, currency: "USD/1M" } }
];

const routerEntries = [
  { id: "rt-roleplay", capability: "roleplay", primary: "gpt-4o", fallback: "claude-sonnet-4-5", priority: 1, budgetPerDay: 10, status: "enabled" },
  { id: "rt-narrative", capability: "narrative", primary: "claude-sonnet-4-5", fallback: "gpt-4o", priority: 1, budgetPerDay: 8, status: "enabled" },
  { id: "rt-reasoning", capability: "reasoning", primary: "deepseek-reasoner", fallback: "gpt-4o", priority: 2, budgetPerDay: 5, status: "enabled" },
  { id: "rt-fast", capability: "fast", primary: "gpt-4o-mini", fallback: "deepseek-chat", priority: 1, budgetPerDay: 3, status: "enabled" },
  { id: "rt-cheap", capability: "cheap", primary: "deepseek-chat", fallback: "gpt-4o-mini", priority: 2, budgetPerDay: 2, status: "enabled" },
  { id: "rt-memory", capability: "memory", primary: "gpt-4o-mini", fallback: null, priority: 1, budgetPerDay: 1, status: "enabled" },
  { id: "rt-embedding", capability: "embedding", primary: "text-embedding-3-small", fallback: "nomic-embed-text", priority: 1, budgetPerDay: 1, status: "enabled" }
];

const pipelines = [
  {
    id: "pl-narrative",
    name: "narrative-pipeline",
    description: "世界事实 → 叙事生成主链路",
    enabled: true,
    stages: [
      { type: "context", name: "collect-world-context", config: { maxEvents: 20, includeState: true } },
      { type: "prompt", name: "render-template", config: { template: "narrative-v1" } },
      { type: "model", name: "router-call", config: { capability: "narrative" } },
      { type: "postprocess", name: "sanitize", config: { maxLength: 4000 } }
    ],
    lastTestAt: minutesAgo(30),
    lastTestStatus: "passed"
  },
  {
    id: "pl-memory-extract",
    name: "memory-extraction",
    description: "从对话中抽取长期记忆并写入 Memory Store",
    enabled: true,
    stages: [
      { type: "context", name: "collect-dialog", config: { window: 12 } },
      { type: "model", name: "router-call", config: { capability: "memory" } },
      { type: "postprocess", name: "parse-memories", config: { maxItems: 8 } },
      { type: "persist", name: "memory-write", config: { store: "main" } }
    ],
    lastTestAt: minutesAgo(120),
    lastTestStatus: "passed"
  },
  {
    id: "pl-npc-reply",
    name: "npc-reply",
    description: "NPC 对话回复链路（含态度与记忆检索）",
    enabled: false,
    stages: [
      { type: "context", name: "memory-retrieval", config: { topK: 5 } },
      { type: "prompt", name: "render-persona", config: { persona: "npc-v1" } },
      { type: "model", name: "router-call", config: { capability: "roleplay" } }
    ],
    lastTestAt: null,
    lastTestStatus: null
  }
];

const apiKeys = [
  { id: "key-admin-default", name: "admin-default", owner: "admin", maskedKey: "sk-****************92af", createdAt: minutesAgo(43200), lastUsedAt: minutesAgo(2), status: "active", permissions: ["chat:completions"] },
  { id: "key-world-runner", name: "world-runner", owner: "operator", maskedKey: "wrun-****************7c31", createdAt: minutesAgo(20160), lastUsedAt: minutesAgo(35), status: "active", permissions: ["chat:completions", "embedding"] },
  { id: "key-dev-sandbox", name: "dev-sandbox", owner: "operator", maskedKey: "sand-****************04d2", createdAt: minutesAgo(10080), lastUsedAt: minutesAgo(2880), status: "disabled", permissions: ["chat:completions"] },
  { id: "key-legacy", name: "legacy-2025", owner: "admin", maskedKey: "lgcy-****************ff08", createdAt: minutesAgo(105120), lastUsedAt: minutesAgo(44640), status: "revoked", permissions: [] }
];

const usageRows = Array.from({ length: 87 }, (_, i) => {
  const modelSets = [
    { model: "gpt-4o", provider: "openai", pt: 1800 + (i * 37) % 2200, ct: 300 + (i * 53) % 700 },
    { model: "claude-sonnet-4-5", provider: "anthropic", pt: 2400 + (i * 29) % 3000, ct: 420 + (i * 41) % 900 },
    { model: "gpt-4o-mini", provider: "openai", pt: 900 + (i * 19) % 1200, ct: 150 + (i * 23) % 400 },
    { model: "deepseek-chat", provider: "deepseek", pt: 1500 + (i * 31) % 1800, ct: 260 + (i * 43) % 500 }
  ];
  const m = modelSets[i % modelSets.length];
  const worlds = ["w-main", "w-test", "w-arena"];
  const status = i % 17 === 0 ? "error" : "success";
  return {
    id: `usg-${String(8700 - i)}`,
    time: minutesAgo(i * 17 + 2),
    model: m.model,
    provider: m.provider,
    worldId: worlds[i % worlds.length],
    capability: ["roleplay", "narrative", "fast", "memory"][i % 4],
    promptTokens: m.pt,
    completionTokens: status === "error" ? 0 : m.ct,
    totalTokens: m.pt + (status === "error" ? 0 : m.ct),
    latencyMs: 350 + (i * 97) % 2600,
    cost: Number((((m.pt / 1e6) * 2.5) + ((status === "error" ? 0 : m.ct) / 1e6) * 10).toFixed(4)),
    status
  };
});

export default defineFakeRoute([
  {
    url: "/admin-api/gateway/providers",
    method: "get",
    response: ({ query }) => {
      let list = providers;
      if (query.status) list = list.filter(p => p.status === query.status);
      return { success: true, data: paginate(list, query) };
    }
  },
  {
    url: "/admin-api/gateway/providers/:id/check",
    method: "post",
    response: ({ params }) => {
      const p = providers.find(x => x.id === params.id);
      if (p) {
        p.lastCheckAt = new Date().toISOString();
        p.status = p.id === "prov-local" ? "offline" : "online";
      }
      return { success: true, data: p };
    }
  },
  {
    url: "/admin-api/gateway/models",
    method: "get",
    response: ({ query }) => {
      let list = models;
      if (query.provider) list = list.filter(m => m.provider === query.provider);
      if (query.capability) list = list.filter(m => m.capabilities.includes(query.capability as string));
      if (query.status) list = list.filter(m => m.status === query.status);
      return { success: true, data: paginate(list, query) };
    }
  },
  {
    url: "/admin-api/gateway/router",
    method: "get",
    response: () => ({ success: true, data: { list: routerEntries, total: routerEntries.length } })
  },
  {
    url: "/admin-api/gateway/router",
    method: "post",
    response: ({ body }) => {
      const entry = { id: `rt-${Date.now()}`, status: "enabled", ...body };
      routerEntries.push(entry);
      return { success: true, data: entry };
    }
  },
  {
    url: "/admin-api/gateway/router/:id",
    method: "put",
    response: ({ body, params }) => {
      const idx = routerEntries.findIndex(r => r.id === params.id);
      if (idx >= 0) routerEntries[idx] = { ...routerEntries[idx], ...body };
      return { success: true, data: routerEntries[idx] };
    }
  },
  {
    url: "/admin-api/gateway/router/:id",
    method: "delete",
    response: ({ params }) => {
      const idx = routerEntries.findIndex(r => r.id === params.id);
      if (idx >= 0) routerEntries.splice(idx, 1);
      return { success: true, data: null };
    }
  },
  {
    url: "/admin-api/gateway/router/:id/test",
    method: "post",
    response: ({ params }) => {
      const r = routerEntries.find(x => x.id === params.id);
      return {
        success: true,
        data: {
          ok: r?.primary !== null,
          model: r?.primary,
          latencyMs: 400 + Math.floor(Math.random() * 900),
          reply: "（测试回复）路由链路可用。",
          testedAt: new Date().toISOString()
        }
      };
    }
  },
  {
    url: "/admin-api/gateway/pipelines",
    method: "get",
    response: () => ({ success: true, data: { list: pipelines, total: pipelines.length } })
  },
  {
    url: "/admin-api/gateway/pipelines/:id/enabled",
    method: "put",
    response: ({ body, params }) => {
      const p = pipelines.find(x => x.id === params.id);
      if (p) p.enabled = !!body.enabled;
      return { success: true, data: p };
    }
  },
  {
    url: "/admin-api/gateway/pipelines/:id/test",
    method: "post",
    response: ({ params }) => {
      const p = pipelines.find(x => x.id === params.id);
      if (p) {
        p.lastTestAt = new Date().toISOString();
        p.lastTestStatus = "passed";
      }
      return {
        success: true,
        data: {
          ok: true,
          pipeline: params.id,
          stageResults: (p?.stages ?? []).map(s => ({ stage: s.name, ok: true, ms: 40 + Math.floor(Math.random() * 300) })),
          testedAt: new Date().toISOString()
        }
      };
    }
  },
  {
    url: "/admin-api/gateway/keys",
    method: "get",
    response: ({ query }) => {
      let list = apiKeys;
      if (query.status) list = list.filter(k => k.status === query.status);
      return { success: true, data: paginate(list, query) };
    }
  },
  {
    url: "/admin-api/gateway/keys",
    method: "post",
    response: ({ body }) => {
      // 只在创建响应里返回一次 mock 明文 Key（非加密随机，真实部署由后端生成），之后仅存脱敏形式
      const seq = (mockKeySeq++).toString(36).padStart(4, "0");
      const plain = `mock-sk-${Date.now().toString(36)}-${seq}`;
      const key = {
        id: `key-${Date.now()}`,
        name: body.name ?? "unnamed",
        owner: body.owner ?? "admin",
        maskedKey: `${plain.slice(0, 7)}****************${plain.slice(-4)}`,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        status: "active",
        permissions: body.permissions ?? ["chat:completions"]
      };
      apiKeys.unshift(key);
      return { success: true, data: { ...key, plainKey: plain } };
    }
  },
  {
    url: "/admin-api/gateway/keys/:id",
    method: "put",
    response: ({ body, params }) => {
      const k = apiKeys.find(x => x.id === params.id);
      if (k && body.status) k.status = body.status;
      return { success: true, data: k };
    }
  },
  {
    url: "/admin-api/gateway/keys/:id/regenerate",
    method: "post",
    response: ({ params }) => {
      const seq = (mockKeySeq++).toString(36).padStart(4, "0");
      const plain = `mock-sk-${Date.now().toString(36)}-${seq}`;
      const k = apiKeys.find(x => x.id === params.id);
      if (k) {
        k.maskedKey = `${plain.slice(0, 7)}****************${plain.slice(-4)}`;
        k.lastUsedAt = null;
        k.status = "active";
      }
      return { success: true, data: { ...k, plainKey: plain } };
    }
  },
  {
    url: "/admin-api/gateway/usage",
    method: "get",
    response: ({ query }) => {
      let list = usageRows;
      if (query.model) list = list.filter(r => r.model === query.model);
      if (query.provider) list = list.filter(r => r.provider === query.provider);
      if (query.worldId) list = list.filter(r => r.worldId === query.worldId);
      if (query.status) list = list.filter(r => r.status === query.status);
      const totalTokens = list.reduce((s, r) => s + r.totalTokens, 0);
      const totalCost = Number(list.reduce((s, r) => s + r.cost, 0).toFixed(4));
      const ok = list.filter(r => r.status === "success").length;
      return {
        success: true,
        data: {
          summary: { requests: list.length, totalTokens, totalCost, successRate: list.length ? Number(((ok / list.length) * 100).toFixed(1)) : 0 },
          ...paginate(list, query)
        }
      };
    }
  }
]);

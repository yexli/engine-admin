// Observability Mock：平台级 Logs / AI Calls / Errors / 全局事件流
// 真实化时建议由 World Platform 聚合各服务日志后提供查询 API（见 ADMIN-API-GAP.md）
import { defineFakeRoute } from "vite-plugin-fake-server/client";
import { minutesAgo, paginate } from "./_utils";

const SERVICES = ["world-engine", "ai-gateway", "memory", "admin-api"];
const LEVELS = ["debug", "info", "info", "warn", "info", "error", "debug", "info"];
const LOG_MSGS = [
  "world tick advanced",
  "command accepted: advance_time",
  "event emitted: npc_attitude_shift",
  "state snapshot persisted",
  "slow query on relations index (82ms)",
  "retry scheduled event evt-2291 (attempt 2)",
  "memory embedding upstream timeout, fallback engaged",
  "event delivered to 3 subscribers"
];

const logs = Array.from({ length: 120 }, (_, i) => ({
  id: `log-${String(12000 - i)}`,
  time: minutesAgo(i * 3 + 1),
  level: LEVELS[i % LEVELS.length],
  service: SERVICES[i % SERVICES.length],
  worldId: i % 3 === 0 ? "w-main" : i % 3 === 1 ? "w-test" : null,
  requestId: `req-${(987000 + i * 13).toString(16)}`,
  message: LOG_MSGS[i % LOG_MSGS.length]
}));

const MODELS = [
  { model: "gpt-4o", provider: "openai" },
  { model: "claude-sonnet-4-5", provider: "anthropic" },
  { model: "gpt-4o-mini", provider: "openai" },
  { model: "deepseek-reasoner", provider: "deepseek" }
];

const aiCalls = Array.from({ length: 90 }, (_, i) => {
  const m = MODELS[i % MODELS.length];
  const failed = i % 11 === 0;
  return {
    id: `aic-${String(9100 - i)}`,
    time: minutesAgo(i * 11 + 2),
    model: m.model,
    provider: m.provider,
    worldId: ["w-main", "w-test", "w-arena"][i % 3],
    capability: ["roleplay", "narrative", "fast", "reasoning"][i % 4],
    latencyMs: failed ? 10000 : 380 + (i * 83) % 2900,
    promptTokens: 800 + (i * 29) % 2600,
    completionTokens: failed ? 0 : 120 + (i * 37) % 800,
    status: failed ? "error" : "success",
    error: failed ? "upstream timeout after 10000ms" : null,
    promptPreview: "（详情中查看，默认不展示完整 Prompt）",
    prompt: `你是一个世界叙事引擎。请根据以下世界事实生成叙事段落：\n<世界事实>\n- npc_attitude_shift: blacksmith -> player (from -10 to 15)\n- time_advanced: 12 ticks\n</世界事实>\n要求：第三人称、120 字以内。`,
    response: failed ? null : "夜色渐深，铁匠收起了锤子。他看着眼前这位旅人，敌意消散了几分……"
  };
});

const ERRORS = [
  { type: "UpstreamTimeout", message: "AI provider timeout after 10000ms (openai/gpt-4o)" },
  { type: "CommandRejected", message: "move_failed: 目的地不存在" },
  { type: "StorageWriteFailed", message: "save port flush failed: SQLITE_BUSY" },
  { type: "ProviderOffline", message: "provider local-ollama unreachable (ECONNREFUSED)" },
  { type: "EventDeadLetter", message: "event evt-2291 exceeded max retries and moved to dead letters" }
];

const errors = Array.from({ length: 24 }, (_, i) => {
  const e = ERRORS[i % ERRORS.length];
  return {
    id: `err-${String(2400 - i)}`,
    time: minutesAgo(i * 47 + 8),
    service: SERVICES[i % SERVICES.length],
    worldId: i % 2 === 0 ? "w-main" : "w-test",
    type: e.type,
    message: e.message,
    status: i % 5 === 0 ? "open" : i % 5 === 1 ? "acknowledged" : "resolved",
    stack: i % 5 === 0 ? "Error: upstream timeout\n    at RemoteProvider.chat (remote.ts:88)\n    at Router.call (router.ts:41)" : null
  };
});

const EVENT_TYPES = [
  "time_advanced", "player_moved", "npc_attitude_shift", "entity_created",
  "relation_set", "weather_changed", "talk_started", "attack_succeeded",
  "entity_moved", "npc_spawned"
];

const eventStream = Array.from({ length: 80 }, (_, i) => ({
  id: `evt-${String(5800 - i)}`,
  time: minutesAgo(i * 7 + 1),
  type: EVENT_TYPES[i % EVENT_TYPES.length],
  worldId: ["w-main", "w-test", "w-arena"][i % 3],
  actor: i % 3 === 0 ? "player" : `npc-${["blacksmith", "guard", "innkeeper"][i % 3]}`,
  target: i % 4 === 0 ? null : ["npc-blacksmith", "forest", "tavern", "player"][i % 4],
  level: [0, 1, 2, 1, 3][i % 5],
  status: i % 13 === 0 ? "dead-letter" : "delivered"
}));

export default defineFakeRoute([
  {
    url: "/admin-api/observability/logs",
    method: "get",
    response: ({ query }) => {
      let list = logs;
      if (query.level) list = list.filter(l => l.level === query.level);
      if (query.service) list = list.filter(l => l.service === query.service);
      if (query.worldId) list = list.filter(l => l.worldId === query.worldId);
      if (query.keyword) list = list.filter(l => l.message.includes(query.keyword as string));
      return { success: true, data: paginate(list, query) };
    }
  },
  {
    url: "/admin-api/observability/ai-calls",
    method: "get",
    response: ({ query }) => {
      let list = aiCalls;
      if (query.model) list = list.filter(c => c.model === query.model);
      if (query.provider) list = list.filter(c => c.provider === query.provider);
      if (query.worldId) list = list.filter(c => c.worldId === query.worldId);
      if (query.status) list = list.filter(c => c.status === query.status);
      return { success: true, data: paginate(list, query) };
    }
  },
  {
    url: "/admin-api/observability/errors",
    method: "get",
    response: ({ query }) => {
      let list = errors;
      if (query.status) list = list.filter(e => e.status === query.status);
      if (query.service) list = list.filter(e => e.service === query.service);
      if (query.type) list = list.filter(e => e.type.includes(query.type as string));
      return { success: true, data: paginate(list, query) };
    }
  },
  {
    url: "/admin-api/observability/errors/:id/status",
    method: "put",
    response: ({ body, params }) => {
      const e = errors.find(x => x.id === params.id);
      if (e && body.status) e.status = body.status;
      return { success: true, data: e };
    }
  },
  {
    url: "/admin-api/observability/events",
    method: "get",
    response: ({ query }) => {
      let list = eventStream;
      if (query.type) list = list.filter(e => e.type.includes(query.type as string));
      if (query.worldId) list = list.filter(e => e.worldId === query.worldId);
      if (query.status) list = list.filter(e => e.status === query.status);
      return { success: true, data: paginate(list, query) };
    }
  }
]);

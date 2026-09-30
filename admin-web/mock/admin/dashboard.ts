// Dashboard 总览 Mock（聚合层数据；Worlds/Entities 来自真实引擎，其余为平台聚合口径）
// 真实化时建议由 World Platform 提供 /v1/overview 聚合接口（见 ADMIN-API-GAP.md）
import { defineFakeRoute } from "vite-plugin-fake-server/client";

export default defineFakeRoute([
  {
    url: "/admin-api/dashboard/overview",
    method: "get",
    response: () => ({
      success: true,
      data: {
        stats: {
          worlds: 3,
          activeWorlds: 2,
          entities: 47,
          eventsPerMin: 36,
          aiRequests24h: 412,
          memoryRecords: 10118
        },
        // 近 12 小时事件/AI 调用活动（每点 1 小时）
        activity: {
          hours: Array.from({ length: 12 }, (_, i) => {
            const d = new Date(Date.now() - (11 - i) * 3600_000);
            return `${String(d.getHours()).padStart(2, "0")}:00`;
          }),
          events: [18, 24, 21, 30, 42, 38, 27, 33, 45, 51, 39, 36],
          aiCalls: [12, 15, 11, 19, 26, 22, 17, 21, 30, 35, 28, 25]
        },
        aiUsage24h: {
          costUsd: 6.42,
          tokens: 1_284_000,
          successRate: 97.8,
          byProvider: [
            { provider: "openai", requests: 198 },
            { provider: "anthropic", requests: 131 },
            { provider: "deepseek", requests: 79 },
            { provider: "local-ollama", requests: 4 }
          ]
        },
        recentErrors: [
          { id: "err-2400", time: new Date(Date.now() - 8 * 60_000).toISOString(), type: "UpstreamTimeout", message: "AI provider timeout after 10000ms (openai/gpt-4o)", status: "open" },
          { id: "err-2397", time: new Date(Date.now() - 47 * 60_000).toISOString(), type: "EventDeadLetter", message: "event evt-2291 exceeded max retries", status: "acknowledged" },
          { id: "err-2394", time: new Date(Date.now() - 95 * 60_000).toISOString(), type: "ProviderOffline", message: "provider local-ollama unreachable", status: "open" }
        ]
      }
    })
  }
]);
